-- =============================================================================
-- WBS 9-1：アプリ内の横断セマンティック検索（投影と検索の入口）
--
-- 根拠: v13 §9 #31（ベクトル基盤は Supabase 内の pgvector。2026-09-11 限定改訂）、
--       `CONSOLIDATED_DECISIONS.md` §17-6 #5・#6（検索時スコープ・PII 検出）・§25-3、
--       `0100`（`public.knowledge_chunks` ／ `rag` スキーマ）・`0102`（`rag.search_knowledge()`・
--       `rag.scan_for_index()`）、`WBS_Phase1.md` `9-1`。
--
-- ── なぜ `public` にラッパを置くのか ────────────────────────────────────
--
-- `0100` は `rag` スキーマを **Supabase の Exposed schemas へ追加しない**ことを要件にしている
-- （システムアーキテクチャ.md 前線2「PostgREST が公開するスキーマを絞る」）。
-- したがって `rag.search_knowledge()` は **PostgREST 経由では呼べない**。
-- アプリから呼ぶ入口を `public` へ1本だけ出し、**EXECUTE は `service_role` のみ**に絞る。
--
-- ⚠️ **`rag` を Exposed schemas へ足して解決してはならない。** 足すと `rag` の全関数が
--    Data API の射程に入り、GRANT の設定ミス1つで Tier 3（属性×行動）まで露出する。
--    公開するのは「入口1本」であって「スキーマ」ではない。
--
-- ── なぜ投影が2段階（走査 → 埋め込み）なのか ──────────────────────────
--
-- 埋め込みの計算は外部 API（Gemini）で行うため DB の中では完結しない。一方 `0100` の
-- `ck_chunk_embedding_requires_scan` は「走査を通っていないチャンクは embedding を持てない」
-- と定めている。そこで
--
--   ① `upsert_knowledge_chunk()` … 走査して**伏字化後のテキストだけ**を保存し、
--      「埋め込みが必要か」と**埋め込むべきテキスト**を返す（embedding は触らない）
--   ② アプリが①の戻り値のテキストを埋め込む
--   ③ `set_knowledge_chunk_embedding()` … ベクトルだけを後から付ける
--
-- の順にする。★ **②で埋め込むのは①が返した伏字化後のテキストである。** 生テキストを
-- 埋め込むと、本文は伏字なのにベクトルだけが PII を含む状態になり、近傍検索から復元されうる。
-- =============================================================================


-- =============================================================================
-- ① 検索の入口（`rag.search_knowledge()` の薄いラッパ）
--
--   ★ **条件を足さない。** スコープ（Tier・公開範囲・削除追随・走査状態）は `0102` の
--   関数に固定してある。ここで条件を書くと「2箇所にスコープがある」状態になり、
--   片方だけ直したときに広い方が勝つ。渡すのはチャネルと件数だけである。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.search_knowledge(
  p_query_embedding extensions.vector(768),
  p_channel         text,
  p_limit           integer DEFAULT 10
)
RETURNS TABLE (
  chunk_id     uuid,
  tier         smallint,
  source_type  text,
  source_id    uuid,
  content_type text,
  chunk_text   text,
  similarity   double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT * FROM rag.search_knowledge(p_query_embedding, p_channel, p_limit);
END;
$$;

COMMENT ON FUNCTION public.search_knowledge(extensions.vector, text, integer) IS
  'WBS 9-1 がアプリから呼ぶ検索の入口。rag.search_knowledge() の薄いラッパであり、'
  '★ スコープの条件を1つも足さない（スコープの正本は 0102 の関数側）。'
  'rag スキーマは PostgREST へ公開しないため、公開するのは本関数1本だけである。';

REVOKE EXECUTE ON FUNCTION public.search_knowledge(extensions.vector, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.search_knowledge(extensions.vector, text, integer)
  TO service_role;


-- =============================================================================
-- ② 投影（各マスタ → `knowledge_chunks`）の第1段：走査して本文を保存する
--
--   `source_type` の4値（media / morning_meeting / work_log / quest）だけを受ける。
--   `0100` の CHECK と同じ値域であり、**運営メモ・会員の連絡先は投影元に無い**
--   （§17-6 #6 の「危うい情報」は伏字化以前に索引へ入らない）。
--
--   ★ 差分検知で API 課金を抑える（`0100` の `content_hash` の目的）。
--     本文が変わっていなくて embedding も付いていれば `needs_embedding = false` を返す。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.upsert_knowledge_chunk(
  p_source_type  text,
  p_source_id    uuid,
  p_chunk_index  integer,
  p_content_type text,
  p_chunk_text   text,
  p_content_hash text,
  p_tier         smallint,
  p_target_role  text DEFAULT 'core_member',
  p_visibility   text DEFAULT '公開',
  p_category_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  chunk_id        uuid,
  scan_status     text,
  pii_hit_count   integer,
  -- ★ 埋め込むべきテキスト。**伏字化後**である。呼び出し側は生テキストを埋め込んではならない。
  text_to_embed   text,
  needs_embedding boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scan        RECORD;
  v_existing    RECORD;
  v_exportable  boolean;
  v_chunk_id    uuid;
  v_needs       boolean;
BEGIN
  IF p_chunk_text IS NULL OR btrim(p_chunk_text) = '' THEN
    RAISE EXCEPTION '本文が空のチャンクは索引に入れない' USING ERRCODE = '23502';
  END IF;

  -- 走査は必ず通す。ここを呼び出し側に任せると「呼び忘れたチャンク」が生まれる。
  SELECT * INTO v_scan FROM rag.scan_for_index(p_chunk_text);

  -- LINE へ出せるのは Tier 1・走査通過・公開のみ（`0100` の ck_chunk_export_tier1_only ＋
  -- `0102` の LINE 経路の条件と同じ判断。**どちらか片方でも崩れたら false** にする）。
  v_exportable := (p_tier = 1
                   AND v_scan.scan_status IN ('clean', 'redacted')
                   AND p_visibility = '公開');

  SELECT c.chunk_id, c.content_hash, (c.embedding IS NOT NULL) AS has_embedding
    INTO v_existing
  FROM   public.knowledge_chunks c
  WHERE  c.source_type = p_source_type
    AND  c.source_id   = p_source_id
    AND  c.chunk_index = p_chunk_index;

  IF v_existing.chunk_id IS NULL THEN
    INSERT INTO public.knowledge_chunks
      (tier, source_type, source_id, chunk_index, content_type, category_id, target_role,
       chunk_text, content_hash, pii_scan_status, pii_hit_count, scanned_at,
       visibility, exportable_to_line, source_deleted, indexed_at)
    VALUES
      (p_tier, p_source_type, p_source_id, p_chunk_index, p_content_type, p_category_id,
       p_target_role, v_scan.redacted_text, p_content_hash, v_scan.scan_status,
       v_scan.hit_count, now(), p_visibility, v_exportable, false, now())
    RETURNING public.knowledge_chunks.chunk_id INTO v_chunk_id;

    v_needs := (v_scan.scan_status <> 'blocked');
  ELSE
    v_chunk_id := v_existing.chunk_id;

    -- ★ 走査状態を先に落とす。`blocked` へ落ちるときに embedding が残っていると
    --   ck_chunk_embedding_requires_scan に違反するため、同じ UPDATE で NULL にする。
    UPDATE public.knowledge_chunks c
    SET    tier            = p_tier,
           content_type    = p_content_type,
           category_id     = p_category_id,
           target_role     = p_target_role,
           chunk_text      = v_scan.redacted_text,
           content_hash    = p_content_hash,
           pii_scan_status = v_scan.scan_status,
           pii_hit_count   = v_scan.hit_count,
           scanned_at      = now(),
           visibility      = p_visibility,
           exportable_to_line = v_exportable,
           -- 再投影は「元が生きている」ことの証でもあるので削除追随を解く
           source_deleted  = false,
           indexed_at      = now(),
           embedding       = CASE WHEN v_scan.scan_status = 'blocked' THEN NULL
                                  ELSE c.embedding END,
           embedding_model = CASE WHEN v_scan.scan_status = 'blocked' THEN NULL
                                  ELSE c.embedding_model END,
           updated_at      = now()
    WHERE  c.chunk_id = v_chunk_id;

    -- 本文が変わっていなくて embedding も付いているなら埋め込み直さない（API 課金の抑制）。
    v_needs := (v_scan.scan_status <> 'blocked')
               AND (v_existing.content_hash IS DISTINCT FROM p_content_hash
                    OR NOT v_existing.has_embedding);
  END IF;

  RETURN QUERY SELECT
    v_chunk_id,
    v_scan.scan_status,
    v_scan.hit_count,
    -- `blocked` のときはテキストを返さない。埋め込んではいけないものを手元へ渡さない。
    CASE WHEN v_scan.scan_status = 'blocked' THEN NULL ELSE v_scan.redacted_text END,
    v_needs;
END;
$$;

COMMENT ON FUNCTION public.upsert_knowledge_chunk IS
  '投影の第1段（WBS 9-1）。走査を必ず通し、★ 伏字化後のテキストだけを保存する。'
  '戻り値の text_to_embed も伏字化後であり、呼び出し側は生テキストを埋め込んではならない。'
  'blocked のときは text_to_embed を返さず、embedding も落とす（0100 の CHECK と噛み合わせる）。';

REVOKE EXECUTE ON FUNCTION public.upsert_knowledge_chunk(
  text, uuid, integer, text, text, text, smallint, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_knowledge_chunk(
  text, uuid, integer, text, text, text, smallint, text, text, uuid) TO service_role;


-- =============================================================================
-- ③ 投影の第2段：埋め込みだけを後から付ける
--
--   ★ 走査を通っていないチャンクへは付けない。`0100` の CHECK でも弾かれるが、
--     ここで明示的に拒否して**理由が読めるエラー**にする（CHECK 違反のメッセージは
--     「どの前提が崩れたか」を運用者に伝えない）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_knowledge_chunk_embedding(
  p_chunk_id        uuid,
  p_embedding       extensions.vector(768),
  p_embedding_model text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_embedding IS NULL OR p_embedding_model IS NULL THEN
    RAISE EXCEPTION 'ベクトルとモデル名は対で渡す' USING ERRCODE = '23502';
  END IF;

  SELECT c.pii_scan_status INTO v_status
  FROM   public.knowledge_chunks c
  WHERE  c.chunk_id = p_chunk_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN false;
  END IF;

  IF v_status NOT IN ('clean', 'redacted') THEN
    RAISE EXCEPTION '走査を通っていないチャンクには埋め込みを付けられない（状態: %）', v_status
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.knowledge_chunks c
  SET    embedding       = p_embedding,
         embedding_model = p_embedding_model,
         indexed_at      = now(),
         updated_at      = now()
  WHERE  c.chunk_id = p_chunk_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.set_knowledge_chunk_embedding(uuid, extensions.vector, text) IS
  '投影の第2段（WBS 9-1）。走査を通ったチャンクにだけ埋め込みを付ける。'
  'pending / blocked には 42501 で拒否する（0100 の CHECK と同じ前提を、読めるエラーで返す）。';

REVOKE EXECUTE ON FUNCTION public.set_knowledge_chunk_embedding(uuid, extensions.vector, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_knowledge_chunk_embedding(uuid, extensions.vector, text)
  TO service_role;


-- =============================================================================
-- ④ 削除追随
--
--   運営が消した写真・取り消した議事録が検索に出続けないようにする（`0100` の `source_deleted`）。
--   ★ **行を消さない。** 消すと「消えたこと」が追えなくなり、再投影のたびに同じ判断を
--     やり直すことになる。`0102` の検索は `source_deleted = false` だけを返す。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mark_knowledge_source_deleted(
  p_source_type text,
  p_source_id   uuid,
  p_deleted     boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.knowledge_chunks c
  SET    source_deleted = p_deleted,
         updated_at     = now()
  WHERE  c.source_type = p_source_type
    AND  c.source_id   = p_source_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.mark_knowledge_source_deleted(text, uuid, boolean) IS
  '投影元が消えた／戻ったことを索引へ反映する（WBS 9-1）。★ 行は消さずフラグで倒す。';

REVOKE EXECUTE ON FUNCTION public.mark_knowledge_source_deleted(text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_knowledge_source_deleted(text, uuid, boolean)
  TO service_role;
