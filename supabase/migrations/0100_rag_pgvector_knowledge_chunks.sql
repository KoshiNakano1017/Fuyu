-- =============================================================================
-- 0100_rag_pgvector_knowledge_chunks.sql
--
-- アプリ内の横断セマンティック検索基盤（pgvector）と、その個人情報ガード。
--
-- 根拠:
--   - CONSOLIDATED_DECISIONS.md §1「Supabase は有料プランで運用する」(2026-09-08)
--     … 本設計を不採用としていた「無料枠 DB 500MB」制約が解消された
--   - v13 §9 #31 … 「本体は独自ベクトル基盤を持たない」の限定改訂が前提（★オーナー決定待ち）
--   - CONSOLIDATED_DECISIONS.md §15 (2026-09-03)
--     … 投入パイプライン側の機械的ガードが必須（方式未決）＝ 本ファイル §3 がその回答案
--   - DB物理設計.md §6-2 / §6-6 / §6-7 … RLS・GRANT・デフォルト拒否の既定作法に従う
--
-- ⚠️ 前提となるマイグレーション（本ファイルより前に適用されている必要がある）:
--     public.members / public.member_profiles_private / public.work_categories
--     … いずれも WBS 2-1（テーブル定義）の成果物。2026-09-09 時点で **未作成**。
--     本ファイル単独では適用できない。採番 0100 は 0001〜0099 をベーススキーマ用に
--     空けておくためのもので、確定した連番ではない（CLAUDE.md §4.5）。
--
-- ⚠️ スコープ: Phase 2。Phase 1 では「列とフックを先に用意する」目的でのみ適用する
--     （media_assets が ai_caption 等で採っているのと同じ方針。後から足すと全件再解析になる）。
-- =============================================================================


-- =============================================================================
-- 1. 拡張とスキーマ
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Tier 3（属性×行動の相関）と PII ガード関数を置く非公開スキーマ。
--
-- ⚠️ Supabase ダッシュボードの Settings > API > Exposed schemas へ **追加しないこと**。
--    追加しなければ PostgREST から到達不能になり、GRANT の設定ミスがあっても
--    Data API 経由では露出しない（システムアーキテクチャ.md 前線2
--    「PostgREST が公開するスキーマを絞る」の適用）。
--    これが「UI から名前・生年月日を問われても答えられない」ことの構造的な担保である。
CREATE SCHEMA IF NOT EXISTS rag;

REVOKE ALL   ON SCHEMA rag FROM PUBLIC, anon, authenticated;
GRANT  USAGE ON SCHEMA rag TO service_role;

-- 今後 rag スキーマへ足すテーブルにも自動で適用する
-- （「新テーブルを作ったら全開だった」を防ぐ・DB物理設計.md §6-6 と同じ趣旨）
ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA rag REVOKE ALL ON ROUTINES  FROM anon, authenticated;

COMMENT ON SCHEMA rag IS
  'ベクトル検索の内部スキーマ。PostgREST の Exposed schemas へ追加してはならない。'
  'Tier 3（属性×行動の特徴量）と PII ガード関数のみを置く。';


-- =============================================================================
-- 2. Tier 1 / Tier 2 — 検索インデックス
--
--   Tier 1: 一般知識（レシピ・道具・FAQ）。LINE 側へ移送可能
--   Tier 2: 個人に紐づく実績（写真キャプション・議事録・作業ログ）。アプリ管理者のみ
--   Tier 3: 属性×行動の相関 → 本表には入れない（§4 の rag.member_behavior_features へ隔離）
-- =============================================================================

CREATE TABLE public.knowledge_chunks (
  chunk_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  tier            smallint NOT NULL CHECK (tier IN (1, 2)),

  -- ▼ 投影元。真実の源は各マスタであり、本表は投影（検索インデックス）にすぎない。
  --    line-rag-bot が recipes_/tools_ と knowledge_ を分離しているのと同じ構造。
  --    混ぜると 1 フィールド直すだけで埋め込みが壊れる。
  source_type     text    NOT NULL CHECK (source_type IN
                    ('media', 'morning_meeting', 'work_log', 'quest')),
  source_id       uuid    NOT NULL,
  chunk_index     integer NOT NULL DEFAULT 0,

  -- ▼ 共通チャンク契約。line-rag-bot の knowledge_{tenant} と同一の意味論にする。
  --    Phase 2 の移送を「フィールド対応だけ」で済ませるための取り決め。
  content_type    text NOT NULL,   -- Firestore 側 metadata.type に対応
  category_id     uuid REFERENCES public.work_categories(category_id),
  agent_type      text,
  target_role     text NOT NULL DEFAULT 'core_member'
                    CHECK (target_role IN ('guest', 'member', 'core_member', 'admin')),

  -- ▼ 本文とベクトル
  --    chunk_text には匿名化【後】のテキストのみを入れる。生テキストは元テーブルに置いたまま。
  chunk_text      text NOT NULL,
  -- 次元を 768 に固定するのは line-rag-bot（gemini-embedding-001 / 768次元）と
  -- ベクトル空間を一致させるため。異なる次元・モデルにすると移送時に全件再埋め込みになる。
  -- また pgvector の HNSW は 2000 次元までのため 3072 次元は索引を張れない。
  embedding       vector(768),
  embedding_model text,
  content_hash    text NOT NULL,   -- 差分検知。無変更なら再埋め込みしない（API 課金の抑制）

  -- ▼ PII ガード（§3）
  pii_scan_status text NOT NULL DEFAULT 'pending'
                    CHECK (pii_scan_status IN ('pending', 'clean', 'redacted', 'blocked')),
  -- 件数のみ保存する。検出した値そのものは保存しない
  -- （automation/agents/review-privacy.md「指摘そのものが漏洩経路になる」と同じ理由）
  pii_hit_count   integer NOT NULL DEFAULT 0,
  scanned_at      timestamptz,

  -- ▼ ライフサイクル
  visibility      text NOT NULL DEFAULT '公開'
                    CHECK (visibility IN ('公開', '運営のみ')),
  -- media_assets.deleted_at（論理削除・運営措置による非表示化も同経路）への追随。
  -- 追随しないと、運営が消した写真が管理者検索に出続ける。
  source_deleted  boolean NOT NULL DEFAULT false,
  exportable_to_line boolean NOT NULL DEFAULT false,
  indexed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_knowledge_chunk_source
    UNIQUE (source_type, source_id, chunk_index),

  -- ▼ ガードを手続きではなく制約にする。
  --    「スキャン関数を呼び忘れた」状態を DB が拒否するため、実装者の注意力に依存しない。
  CONSTRAINT ck_chunk_embedding_requires_scan
    CHECK (embedding IS NULL OR pii_scan_status IN ('clean', 'redacted')),
  CONSTRAINT ck_chunk_model_paired
    CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  -- LINE へ出せるのは Tier 1 かつスキャン通過のみ。Tier 2 は構造的に出せない。
  CONSTRAINT ck_chunk_export_tier1_only
    CHECK (exportable_to_line = false
           OR (tier = 1 AND pii_scan_status IN ('clean', 'redacted')))
);

COMMENT ON TABLE public.knowledge_chunks IS
  'アプリ内横断セマンティック検索の索引（Tier 1/2）。各マスタからの投影であってマスタではない。'
  'chunk_text は匿名化後のテキストのみ。生テキストを入れてはならない。'
  'Tier 3（属性×行動）は本表ではなく rag.member_behavior_features へ隔離する。';

COMMENT ON COLUMN public.knowledge_chunks.embedding IS
  '768次元固定。line-rag-bot（gemini-embedding-001 / 768次元）とベクトル空間を一致させ、'
  'Phase 2 の移送で再埋め込みを不要にするため。';

COMMENT ON COLUMN public.knowledge_chunks.embedding_model IS
  '埋め込みモデル名。モデル変更時に「どの行が旧モデルか」を特定できないと'
  '全件再埋め込みの管理が不能になるため必須。';

COMMENT ON COLUMN public.knowledge_chunks.pii_hit_count IS
  '既知氏名の検出件数のみ。検出した値そのものは保存しない。';

-- ANN 索引。削除済みを索引から外す部分インデックスにすることで、
-- 検索クエリ側に source_deleted = false を書かせる強制力も持たせる。
CREATE INDEX ix_chunks_ann ON public.knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WHERE source_deleted = false;

CREATE INDEX ix_chunks_source ON public.knowledge_chunks (source_type, source_id);

CREATE INDEX ix_chunks_export ON public.knowledge_chunks (tier, exportable_to_line)
  WHERE exportable_to_line = true;

-- 人間レビュー待ち（姓のみヒット等）の抽出用
CREATE INDEX ix_chunks_needs_review ON public.knowledge_chunks (pii_scan_status)
  WHERE pii_scan_status IN ('pending', 'blocked');


-- =============================================================================
-- 3. PII ガード
--
--   日本語の氏名は gitleaks も pre-commit のパスガードも検出できない
--   （CLAUDE.md §3.1・automation/agents/review-privacy.md）。
--   ただし本件は実名の母集団が 370〜1000 名と有限で member_profiles_private に
--   全件揃っているため、汎用 NER ではなく既知集合との照合で足りる。
-- =============================================================================

-- 既知氏名を表示名へ伏字化する。
-- SECURITY DEFINER で PII を読むが、氏名そのものは戻り値に含めない。
--
-- 判定ルール:
--   ① 姓＋名の完全一致（全角スペース有無・カナ）      → 自動置換
--   ② 姓または名 ＋ 敬称                              → 自動置換（人物指示が明確なため）
--   ③ 姓のみ（敬称なし）                              → 置換せず needs_review を立てる
--      … 地名・一般語と区別できないため。review-privacy の「迷ったら止める」に倣う。
CREATE OR REPLACE FUNCTION rag.redact_known_names(p_text text)
RETURNS TABLE (redacted_text text, hit_count integer, needs_review boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''          -- search_path 乗っ取りの防止（SECURITY DEFINER の必須作法）
AS $$
DECLARE
  v_text   text    := p_text;
  v_before text;
  v_hits   integer := 0;
  v_review boolean := false;
  v_h      text;
  -- 正規表現を使わず replace() で処理する。氏名にメタ文字が入った際の
  -- エスケープ漏れを構造的に避けるため。
  v_honorifics constant text[] := ARRAY['さん', 'サン', 'くん', 'クン', 'ちゃん',
                                        '様', 'さま', '親方', '氏'];
  r RECORD;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN QUERY SELECT p_text, 0, false;
    RETURN;
  END IF;

  FOR r IN
    SELECT p.full_name,
           p.full_name_kana,
           split_part(p.full_name, '　', 1) AS surname,      -- 実データは姓名を全角スペース区切り
           split_part(p.full_name, '　', 2) AS given_name,
           -- 置換先は v_member_public と同じ表示名規則
           -- （会員データモデル §5.2c の不可侵ルール：full_name へフォールバックしない）
           COALESCE(
             NULLIF(btrim(m.nickname), ''),
             (CASE WHEN m.member_type = 'ゲスト' THEN 'ゲスト#' ELSE '街人#' END)
               || COALESCE(m.legacy_member_no, left(m.member_id::text, 8))
           ) AS display_name
    FROM   public.member_profiles_private p
    JOIN   public.members m ON m.member_id = p.member_id
  LOOP
    -- ① 姓＋名の完全一致
    v_before := v_text;
    v_text := replace(v_text, r.full_name, r.display_name);
    IF position('　' IN r.full_name) > 0 THEN
      v_text := replace(v_text, replace(r.full_name, '　', ''),  r.display_name);
      v_text := replace(v_text, replace(r.full_name, '　', ' '), r.display_name);
    END IF;
    IF r.full_name_kana IS NOT NULL AND btrim(r.full_name_kana) <> '' THEN
      v_text := replace(v_text, r.full_name_kana, r.display_name);
    END IF;

    -- ② 姓／名 ＋ 敬称
    FOREACH v_h IN ARRAY v_honorifics LOOP
      IF r.surname <> '' THEN
        v_text := replace(v_text, r.surname || v_h, r.display_name);
      END IF;
      IF r.given_name <> '' THEN
        v_text := replace(v_text, r.given_name || v_h, r.display_name);
      END IF;
    END LOOP;

    IF v_text IS DISTINCT FROM v_before THEN
      v_hits := v_hits + 1;
    END IF;

    -- ③ 敬称なしの姓が残っている場合は自動置換せず人間レビューへ。
    --    1文字の姓は誤検出が多すぎるため対象外とする。
    IF r.surname <> '' AND length(r.surname) >= 2
       AND position(r.surname IN v_text) > 0 THEN
      v_review := true;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_text, v_hits, v_review;
END;
$$;

COMMENT ON FUNCTION rag.redact_known_names(text) IS
  '既知会員名を表示名へ伏字化する。埋め込み生成の【前】に必ず通す。'
  '戻り値に氏名そのものを含めない。';


-- 生成済みの回答をユーザーへ返す【前】の最終チェック。
-- 「個人情報は答えないで」というプロンプト指示は隔離手段として機能しないため
-- （旧 RAGシステム仕様「情報隔離はプロンプトで行わない」）、出力を機械的に走査して止める。
CREATE OR REPLACE FUNCTION rag.contains_known_names(p_text text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.member_profiles_private p
    WHERE  p_text IS NOT NULL
      AND  ( position(p.full_name IN p_text) > 0
          OR position(replace(p.full_name, '　', '') IN p_text) > 0
          OR (p.full_name_kana IS NOT NULL
              AND btrim(p.full_name_kana) <> ''
              AND position(p.full_name_kana IN p_text) > 0) )
  );
$$;

COMMENT ON FUNCTION rag.contains_known_names(text) IS
  'LLM 生成結果に既知会員名が含まれるかを判定する。true ならユーザーへ返さずエスカレーションへ回す。';

-- ガード関数はサーバサイド専用。anon / authenticated から呼ばせない。
REVOKE EXECUTE ON FUNCTION rag.redact_known_names(text)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rag.contains_known_names(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION rag.redact_known_names(text)   TO service_role;
GRANT  EXECUTE ON FUNCTION rag.contains_known_names(text) TO service_role;


-- =============================================================================
-- 4. Tier 3 — 属性×行動の特徴量（会話 UI から到達不能）
--
--   「属性と行動の相関は学習させたいが、名前や生年月日は答えられると困る」への回答。
--   答えないのではなく、**データとして存在させない**。
-- =============================================================================

CREATE TABLE rag.member_behavior_features (
  member_id       uuid PRIMARY KEY
                    REFERENCES public.members(member_id) ON DELETE CASCADE,

  -- ▼ 不変条件: 本表を生成するクエリは member_profiles_private を JOIN してはならない。
  --    誕生年月は age_bracket へ丸めた時点で復元不能になる（birth_ym を持たない）。
  age_bracket     text CHECK (age_bracket IN
                    ('10s','20s','30s','40s','50s','60s','70s+','unknown')),
  tenure_months   integer,
  role            text NOT NULL,
  member_type     text NOT NULL,
  skill_tags      text[] NOT NULL DEFAULT '{}',
  quest_category_counts jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"農業":12,"建築":3}
  visit_pattern         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"dow":[2,4],"season":"summer"}

  -- 埋め込み元の特徴文。氏名・生年月日・住所・連絡先を含めてはならない。
  feature_text    text NOT NULL,
  embedding       vector(768),
  embedding_model text,
  computed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_behavior_model_paired
    CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);

COMMENT ON TABLE rag.member_behavior_features IS
  'Tier 3。属性×行動の相関分析・推薦専用。会話検索のコードから参照してはならない。'
  'member_profiles_private を JOIN して生成しないこと（氏名・誕生年月を持ち込まない）。';

CREATE INDEX ix_behavior_ann ON rag.member_behavior_features
  USING hnsw (embedding vector_cosine_ops);


-- 再識別（k-匿名性）の防波堤。
-- 370〜1000 名規模では属性の組み合わせ自体が個人を特定するため、
-- 集計出力は必ず本ビューを経由させ、小さすぎるコホートを行ごと出さない。
CREATE OR REPLACE VIEW rag.v_cohort_stats AS
SELECT f.age_bracket,
       f.member_type,
       s.skill_tag,
       count(*)              AS cohort_size,
       avg(f.tenure_months)  AS avg_tenure_months
FROM   rag.member_behavior_features f
CROSS JOIN LATERAL unnest(
         CASE WHEN cardinality(f.skill_tags) = 0
              THEN ARRAY[NULL]::text[]
              ELSE f.skill_tags
         END) AS s(skill_tag)
GROUP  BY 1, 2, 3
HAVING count(*) >= 5;   -- ★ k匿名性 k=5。この下限を下げてはならない

COMMENT ON VIEW rag.v_cohort_stats IS
  '属性×行動の集計。k匿名性 k=5 を HAVING で強制する。'
  '5名未満のコホートは行ごと出さない（小規模コミュニティでの再識別を防ぐため）。';


-- =============================================================================
-- 5. updated_at の自動更新
--   ベーススキーマ側に同等の関数が存在する可能性があるため、
--   衝突を避けて rag スキーマ内に独自名で定義する。
-- =============================================================================

CREATE OR REPLACE FUNCTION rag.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_knowledge_chunks_touch
  BEFORE UPDATE ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION rag.touch_updated_at();


-- =============================================================================
-- 6. RLS とデフォルト拒否（DB物理設計.md §6-7）
--
--   両表ともポリシーを 1 本も定義しない ＝ 全拒否。
--   到達できるのは service_role のみ。
--
--   authenticated 向けのポリシーを書かないのは設計上の選択であって手抜きではない。
--   ベクトル検索には検索クエリの埋め込みが必要で、それには Embedding API キーが要る。
--   キーはサーバ側にしか置けない（CLAUDE.md §3.2）ため、検索は必ず Server Action を通る。
--   結果として:
--     - 前線1: 検索が必ず Vercel を通るため Vercel WAF 配下に入る
--     - 前線2: anon にも authenticated にも GRANT しないため「anon 権限ゼロ」を崩さない
--   なお service_role は BYPASSRLS のため、実質の関門は API設計.md §1 のアプリ層認可になる
--   （DB物理設計.md §6-6 ③ の注記と同じ理解）。
-- =============================================================================

ALTER TABLE public.knowledge_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.member_behavior_features ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 7. GRANT（DB物理設計.md §6-6）
--
-- ⚠️ §6-6 の ALTER DEFAULT PRIVILEGES は anon しか対象にしていない。
--    Supabase は新規テーブルへ authenticated の既定権限を与えるため、
--    下の明示 REVOKE を省くと本表が authenticated から丸見えになる。
--    （§6-6 側へ authenticated を追加する改訂も別途提案済み）
-- =============================================================================

REVOKE ALL ON public.knowledge_chunks      FROM anon, authenticated;
REVOKE ALL ON rag.member_behavior_features FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.knowledge_chunks      TO service_role;
GRANT SELECT, INSERT, UPDATE ON rag.member_behavior_features TO service_role;
GRANT SELECT                 ON rag.v_cohort_stats           TO service_role;

-- DELETE は与えない。投影の失効は source_deleted フラグで表す
-- （DB物理設計.md §1「物理削除の原則禁止」と整合させ、削除の事実を追跡可能にする）。


-- =============================================================================
-- ロールバック（適用を戻す場合の手順。実行はしない）
-- =============================================================================
-- DROP TRIGGER  IF EXISTS trg_knowledge_chunks_touch ON public.knowledge_chunks;
-- DROP VIEW     IF EXISTS rag.v_cohort_stats;
-- DROP TABLE    IF EXISTS rag.member_behavior_features;
-- DROP TABLE    IF EXISTS public.knowledge_chunks;
-- DROP FUNCTION IF EXISTS rag.touch_updated_at();
-- DROP FUNCTION IF EXISTS rag.contains_known_names(text);
-- DROP FUNCTION IF EXISTS rag.redact_known_names(text);
-- DROP SCHEMA   IF EXISTS rag;
-- -- vector 拡張は他機能が使う可能性があるため落とさない
