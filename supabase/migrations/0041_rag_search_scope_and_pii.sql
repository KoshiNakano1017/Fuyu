-- =============================================================================
-- 0041_rag_search_scope_and_pii.sql — 検索時スコープを DB 層へ固定し、PII 検出を連絡先へ広げる
--
--   WBS  : 1-6（pgvector有効化・RAG基盤 ／ 2026-09-25 オーナー決定 A ＝ `1-6` を DB 層に閉じる）
--   根拠 : `CONSOLIDATED_DECISIONS.md` §17-6 #5（検索時スコープ）・#6（PII 検出の拡張）、
--          §16-2 #61（**判定軸はロールではなくチャネル**。`target_role` を見た時点で
--          非推奨として退けた案 b になる）、v13 §5.7・§5.11.2、`0100`（基盤）
--   含む : `rag.search_knowledge()`（スコープ強制つき検索）／
--          `rag.redact_contact_info()`・`rag.scan_for_index()`（PII 検出の拡張）
--
-- ── なぜ「アプリ側のフィルタ」ではなく DB の関数なのか（決定 A の理由）──────
--
-- `0100` は `knowledge_chunks` を **`service_role` だけに GRANT** している（RLS はポリシー0本＝
-- authenticated からは常に0行）。つまり検索はサーバ側から `service_role` で行うため、
-- **スコープの絞り込みがアプリのコードに依存する**。呼び出しを1箇所書き忘れた瞬間に
-- Tier 2（個人に紐づく実績）が LINE 経路へ出る。
--
-- 関数に閉じると、**呼び出し側はチャネルを渡すことしかできない**。
-- 「うっかり広く引く」経路が構造的に無くなる（§17-6 #5 の「RLS／ビューで表現する」の実装）。
--
-- ── 判定軸はチャネルであってロールではない ────────────────────────────
--
-- §16-2 #61 の確定事項。`target_role` を見て絞ると、
-- 「LINE から admin として問い合わせたら個人情報が返る」設計になり得る。
-- **LINE 経路では Tier 2 を1行も返さない**（引数が `'line'` のとき索引ごと絞る）。
-- =============================================================================


-- =============================================================================
-- ① 連絡先の伏字化（§17-6 #6）
--
--   `0100` の `redact_known_names()` は**既知氏名のみ**を見る。
--   `QUESTIONS.md` が「危うい情報」として挙げるうち、**メール・電話・郵便番号**は
--   正規表現で機械的に落とせる（氏名と違い、母集団を持たなくても検出できる）。
--
--   ⚠️ **金額は伏字化しない。** レシピの分量・道具の値段まで壊れ、検索が役に立たなくなる。
--   金額の非開示は「chunk_text へ報酬額・請求額を投影しない」という**投影側の規律**で守る
--   （`quests.reward_uii` は `0012` で列単位 GRANT を張って直接読ませない扱いにしてある）。
--
--   ⚠️ **住所も伏字化しない。** 「〇〇町」は拠点の説明にも使う一般語であり、
--   機械的に落とすと施設紹介・道順の知識が失われる。住所を含む表は
--   `member_profiles_private`（PII-A）であり、そもそも投影元（`source_type` の4値）に入っていない。
-- =============================================================================

CREATE OR REPLACE FUNCTION rag.redact_contact_info(p_text text)
RETURNS TABLE (redacted_text text, hit_count integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_text  text    := p_text;
  v_hits  integer := 0;
  v_before text;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN QUERY SELECT p_text, 0;
    RETURN;
  END IF;

  -- メールアドレス。ローカル部に記号が入る形（`a.b+c@example.jp`）も拾う。
  v_before := v_text;
  v_text := regexp_replace(v_text, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}',
                           '［メールアドレス］', 'g');
  IF v_text IS DISTINCT FROM v_before THEN v_hits := v_hits + 1; END IF;

  -- ★ **電話番号を先に処理する。** 逆順にすると `090-1234-5678` の先頭
  --   （`090-1234` ＝ 3桁 ＋ ハイフン ＋ 4桁）が郵便番号として落ち、`-5678` が残る
  --   （実測で踏んだ）。国内の電話番号は必ず 0 で始まるので、その形だけを拾う。
  v_before := v_text;
  v_text := regexp_replace(v_text, '0[0-9]{1,4}[-‐－(]?[0-9]{1,4}[-‐－)]?[0-9]{3,4}',
                           '［電話番号］', 'g');
  IF v_text IS DISTINCT FROM v_before THEN v_hits := v_hits + 1; END IF;

  -- 郵便番号は **`〒` を必須**にする。裸の `123-4567` は電話の断片・型番・日付と
  -- 区別できず、機械的に落とすと本文が壊れる（「迷ったら落とさない」）。
  v_before := v_text;
  v_text := regexp_replace(v_text, '〒[[:space:]]*[0-9]{3}[-‐－]?[0-9]{4}', '［郵便番号］', 'g');
  IF v_text IS DISTINCT FROM v_before THEN v_hits := v_hits + 1; END IF;

  RETURN QUERY SELECT v_text, v_hits;
END;
$$;

COMMENT ON FUNCTION rag.redact_contact_info(text) IS
  'メール・電話・郵便番号を伏字化する（§17-6 #6）。★ 金額と住所は落とさない — '
  'レシピの分量や拠点の説明まで壊れ、検索が役に立たなくなる。'
  '金額の非開示は投影側の規律（chunk_text へ入れない）で守る。';

REVOKE EXECUTE ON FUNCTION rag.redact_contact_info(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION rag.redact_contact_info(text) TO service_role;


-- =============================================================================
-- ② 索引へ入れる前の走査（氏名 ＋ 連絡先をまとめて通す）
--
--   ★ **呼ぶ順番に意味がある。** 氏名 → 連絡先の順で通す。
--   逆にすると `山田太郎 <taro@example.jp>` の形で氏名側の完全一致が崩れることがある
--   （メールを先に伏字化すると氏名の直後の文字列が変わり、敬称判定の当たりが変わる）。
--
--   戻り値に検出値そのものを含めない（件数だけ）。`0100` の方針と同じで、
--   「指摘そのものが漏洩経路になる」ことを避けるためである。
-- =============================================================================

CREATE OR REPLACE FUNCTION rag.scan_for_index(p_text text)
RETURNS TABLE (redacted_text text, hit_count integer, scan_status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_names   RECORD;
  v_contact RECORD;
  v_hits    integer;
BEGIN
  SELECT * INTO v_names FROM rag.redact_known_names(p_text);
  SELECT * INTO v_contact FROM rag.redact_contact_info(v_names.redacted_text);

  v_hits := coalesce(v_names.hit_count, 0) + coalesce(v_contact.hit_count, 0);

  RETURN QUERY SELECT
    v_contact.redacted_text,
    v_hits,
    CASE
      -- 敬称なしの姓が残る＝地名・一般語と区別できない。**自動で通さず人間の確認へ**
      -- （`0100` の ③ と同じ判断。`blocked` は索引へ入れられない＝埋め込みを持てない）。
      WHEN v_names.needs_review THEN 'blocked'
      WHEN v_hits > 0           THEN 'redacted'
      ELSE 'clean'
    END;
END;
$$;

COMMENT ON FUNCTION rag.scan_for_index(text) IS
  '索引へ入れる前の PII 走査（氏名 ＋ 連絡先）。戻り値は伏字化後のテキスト・件数・状態のみで、'
  '検出した値そのものは返さない。★ 姓のみが残る場合は blocked（人間の確認へ回す）。';

REVOKE EXECUTE ON FUNCTION rag.scan_for_index(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION rag.scan_for_index(text) TO service_role;


-- =============================================================================
-- ③ 検索（スコープを DB 層で強制する ／ §17-6 #5）
--
--   ★ **呼び出し側が渡せるのはチャネルだけ**である。Tier・公開範囲・削除状態・
--   スキャン状態の条件はここに固定してあり、アプリ側から緩められない。
-- =============================================================================

--   ⚠️ `vector` 型と `<=>` 演算子は `extensions` スキーマに居る（`0013` が移した）。
--   本関数は `search_path = ''` で動くため、**型も演算子もスキーマ修飾が要る**
--   （修飾を忘れると `operator does not exist: vector <=> vector` で落ちる。実測で踏んだ）。
CREATE OR REPLACE FUNCTION rag.search_knowledge(
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
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
BEGIN
  IF p_channel NOT IN ('app', 'line') THEN
    -- 知らないチャネルは**広い方へ倒さない**。増えるときは明示的に足す。
    RAISE EXCEPTION '未知のチャネルでは検索できない: %', p_channel USING ERRCODE = '22023';
  END IF;

  IF p_query_embedding IS NULL THEN
    RAISE EXCEPTION '検索ベクトルが無い' USING ERRCODE = '23502';
  END IF;

  RETURN QUERY
  SELECT c.chunk_id,
         c.tier,
         c.source_type,
         c.source_id,
         c.content_type,
         c.chunk_text,
         -- コサイン距離（0 が最も近い）を類似度へ直す。呼び出し側で式を再発明させない。
         (1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding))::double precision
           AS similarity
  FROM   public.knowledge_chunks c
  WHERE  c.embedding IS NOT NULL
    -- 削除・非表示の追随（運営が消した写真が検索に出続けない ／ `0100` の `source_deleted`）
    AND  c.source_deleted = false
    -- スキャンを通っていないチャンクは返さない（`pending` / `blocked` を除く）
    AND  c.pii_scan_status IN ('clean', 'redacted')
    -- ★ チャネルによる絞り込み（§16-2 #61：ロールでは判定しない）
    AND  (
           p_channel = 'app'
           OR (p_channel = 'line' AND c.tier = 1 AND c.exportable_to_line = true)
         )
    -- LINE 経路には「運営のみ」を1行も出さない
    AND  (p_channel <> 'line' OR c.visibility = '公開')
  ORDER  BY c.embedding OPERATOR(extensions.<=>) p_query_embedding
  LIMIT  v_limit;
END;
$$;

COMMENT ON FUNCTION rag.search_knowledge(extensions.vector, text, integer) IS
  '横断セマンティック検索（WBS 9-1 が呼ぶ入口 ／ §17-6 #5）。'
  '★ スコープ（Tier・公開範囲・削除状態・スキャン状態）は本関数に固定してあり、'
  '呼び出し側が渡せるのはチャネルだけである。LINE 経路は Tier 1 かつ書き出し許可のみ。'
  '判定軸はチャネルであってロールではない（§16-2 #61）。';

REVOKE EXECUTE ON FUNCTION rag.search_knowledge(extensions.vector, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION rag.search_knowledge(extensions.vector, text, integer) TO service_role;
