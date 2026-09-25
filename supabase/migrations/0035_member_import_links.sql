-- =============================================================================
-- 0035_member_import_links.sql — 取込ジョブと会員行の対応
--
--   QUESTIONS.md「[2026-09-21] Phase 1 に必要な4テーブルの DDL が本リポジトリに存在しない」
--   選択肢 B（Vault 側に既存定義が無いため、`DB物理設計.md` の記述から新規に起こす）を
--   2026-09-24 オーナー決定で採用。**この1表だけは Vault 側 `01_schema.sql` に定義が存在しない**
--   （member_identifiers／member_notes／uii_transactions とは経緯が異なる）。
--
--   根拠: `DB物理設計.md` §3-14（`import_jobs` との対応関係）・§6-1 #7（PII-B。
--          取込元ファイル名・照合根拠。**admin のみ・実体は service_role**）
--   含む : member_import_links のスキーマ・RLS・GRANT
--
-- ── 設計方針（0024_import_jobs.sql と同型にした理由）────────────────────
--   `DB物理設計.md` §6-1 の一覧表は本表の可視性を2箇所で異なる書き方をしている
--   （#7「PII-B・adminのみ」／#35「非PIIだがadmin/core_member」）。
--   実装済みの `import_jobs`（0024）は前者（#7）の解釈を採り、**ポリシーを1つも作らず
--   authenticated からは全拒否**にしている（取込は画面を持たないサーバ側バッチのため）。
--   本表は `import_jobs` と1対多で対になる取込処理の内部データであり、
--   単独で画面から参照される想定も無いため、**同じ解釈・同じ形**に揃えた。
--   将来 admin 向けの取込結果一覧画面を作る場合は、その時点で SELECT ポリシーを追加すること。
--
-- 🚫 実データは持ち込まない。取込の検証は合成フィクスチャで行う（CLAUDE.md §7.1）。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_import_links (
  link_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  job_id       uuid NOT NULL REFERENCES public.import_jobs (job_id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES public.members (member_id) ON DELETE CASCADE,

  -- 名寄せの照合根拠。自由記述にするのは、判定方法が
  -- 「検証済み識別子の完全一致」「氏名＋生年月の突合」「人手判断」など複数あり、
  -- Phase 1 時点でこれを固定の enum に決め切る根拠が正本に無いため（過剰設計を避ける）。
  match_basis  text NOT NULL
                 CONSTRAINT chk_member_import_links_basis_present
                 CHECK (btrim(match_basis) <> ''),

  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_import_links IS
  '取込ジョブ（import_jobs）と会員行（members）の対応（PII-B）。DB物理設計.md §3-14・§6-1 #7。'
  '同一ジョブが同一会員へ二重に対応を作らないよう (job_id, member_id) を一意にする。';
COMMENT ON COLUMN public.member_import_links.match_basis IS
  '名寄せの照合根拠を自由記述で残す（例: 検証済みメール一致／氏名＋生年月の突合／人手判断）。';

-- 同一ジョブ×同一会員の対応行を二重に作らない。
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_import_links_job_member
  ON public.member_import_links (job_id, member_id);

CREATE INDEX IF NOT EXISTS ix_member_import_links_member ON public.member_import_links (member_id);


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 #7：PII-B・admin のみ／実体は service_role）
--
--   ★ `import_jobs`（0024）と同じ判断：ポリシーを1つも作らない。
--     取込はサーバ側バッチであり、ブラウザから触る経路を作らない。
--     一覧に出す画面も Phase 1 には無い。
-- =============================================================================

ALTER TABLE public.member_import_links ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- ③ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.member_import_links FROM anon, authenticated;
