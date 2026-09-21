-- =============================================================================
-- 0024_import_jobs.sql — 会員データ取込の二重取込防止
--
--   WBS  : 10-2（名寄せロジック）／Issue #111
--   根拠 : v13 §8（再実行安全性）、`DB物理設計.md` §3-14・§6-1 #7
--   含む : import_jobs のスキーマ・部分ユニーク索引・RLS・GRANT
--
-- ── なぜ会員単位の照合では解けないのか ──────────────────────────────
--
-- v13 §8 が求めているのは「**同一ファイルの二重取込で重複会員を生成しない**」ことである。
-- これは**ファイル単位の話であり、会員単位の照合では解けない**
-- （照合は「似た人が居る」ことしか言えず、「このファイルはもう入れた」は言えない）。
--
-- 本体は下の部分ユニーク索引である。内容ハッシュを鍵にするので
-- **ファイル名を変えても回避できず**、移行時（`is_verified` が全件 false）でも確実に効く。
-- ここが `contact_info` による照合との決定的な違いである（§3-14）。
--
-- ⚠️ `member_import_links`（取込ジョブと会員行の対応）は本書にも本リポジトリにも DDL が無い。
--    `QUESTIONS.md`「[2026-09-21] Phase 1 に必要な4テーブルの DDL が本リポジトリに存在しない」
--    で確認中のため、**本マイグレーションには含めない**。
--
-- 🚫 取込の検証は合成フィクスチャで行う。実名370名のファイルをリポジトリへ持ち込まない
--    （CLAUDE.md §7.1）。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.import_jobs (
  job_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_file_name   text NOT NULL
                       CONSTRAINT chk_import_job_file_name_present
                       CHECK (btrim(source_file_name) <> ''),

  -- ★ 内容ハッシュ。ファイル名の変更では回避できない
  source_file_sha256 text NOT NULL
                       CONSTRAINT chk_import_job_sha256_format
                       CHECK (source_file_sha256 ~ '^[0-9a-f]{64}$'),

  row_count          integer NOT NULL
                       CONSTRAINT chk_import_job_row_count_non_negative
                       CHECK (row_count >= 0),

  status             text NOT NULL DEFAULT 'previewing'
                       CONSTRAINT chk_import_job_status
                       CHECK (status IN ('previewing', 'committed', 'rolled_back')),

  operator_id        uuid REFERENCES public.members (member_id) ON DELETE SET NULL,
  started_at         timestamptz NOT NULL DEFAULT now(),
  committed_at       timestamptz,

  -- 「取り込んだ」と名乗るなら、いつ確定したかが要る。
  -- 空のまま committed になれると、下の一意索引が守る対象の意味が曖昧になる
  CONSTRAINT chk_import_job_committed_complete CHECK (
    (status = 'committed') = (committed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.import_jobs IS
  '会員データ取込のジョブ台帳（v13 §8 の再実行安全性）。'
  '同一内容のファイルを2回コミットできないことが本表の存在理由である。';
COMMENT ON COLUMN public.import_jobs.source_file_sha256 IS
  'ファイル内容の sha256（16進64桁）。ファイル名の変更では回避できない。'
  '1バイトでも違えば別ハッシュになるため、修正版ファイルの取込は正しく通る';

-- ★ 同一内容のファイルを2回コミットできない。これが v13 §8 の再実行安全性の本体。
--   `status` を条件に含めるのは、プレビューして差し戻した（rolled_back）ファイルを
--   修正せず再挑戦する運用を殺さないため。
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_job_committed_file
  ON public.import_jobs (source_file_sha256)
  WHERE status = 'committed';


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 #7：PII-B、`admin` のみ／実体は service_role）
--
--   ★ **ポリシーを1つも作らない。** RLS を有効にしてポリシーが無い表は全拒否になる。
--     取込はサーバ側のバッチ処理であり、ブラウザから触る経路を作らない。
--     取込元ファイル名・照合根拠は PII-B であり、一覧に出す画面も Phase 1 には無い。
--
--   ⚠️ 画面から参照したくなったら、**ここにポリシーを足す前に**
--      「誰に何を見せるか」を §6 の区分に照らして決めること。
-- =============================================================================

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- ③ GRANT（§6-6②）
--
--   anon・authenticated いずれにも与えない。RLS の全拒否と GRANT の剥奪を二重に置く。
-- =============================================================================

REVOKE ALL ON public.import_jobs FROM anon, authenticated;
