-- =============================================================================
-- 0033_member_notes.sql — 運営メモ
--
--   QUESTIONS.md「[2026-09-21] Phase 1 に必要な4テーブルの DDL が本リポジトリに存在しない」
--   選択肢 A（Vault 側 `01_schema.sql` の既存 DDL を正として転記）を 2026-09-24 オーナー決定で採用。
--
--   根拠: `DB物理設計.md` §2 の表・§6-1 #4（PII-A。`core_only` → admin/core_member、
--          `admin_only` → admin のみ。**本人も読めない**）
--   含む : member_notes のスキーマ・RLS・GRANT
--
-- ⚠️ Vault 側スキーマからの転記であり、実データは持ち込まない（CLAUDE.md §7.1）。
--    Vault 版は `updated_at` を持たない＝運営メモは**追記専用**（訂正は新しい行を足す）。
--    この設計をそのまま踏襲する（`stay_ticket_transactions`〔0016〕と同じ理由）。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_notes (
  note_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES public.members (member_id) ON DELETE CASCADE,

  body       text NOT NULL
               CONSTRAINT chk_member_notes_body_present
               CHECK (btrim(body) <> ''),

  -- core_only  = admin・core_member が読める
  -- admin_only = admin だけが読める（人事・懲戒級の機微メモを core_member からも隠す経路）
  visibility text NOT NULL DEFAULT 'core_only'
               CONSTRAINT chk_member_notes_visibility
               CHECK (visibility IN ('core_only', 'admin_only')),

  author_id  uuid REFERENCES public.members (member_id),

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_notes IS
  '運営メモ（PII-A）。DB物理設計.md §6-1 #4。visibility=admin_only の行は admin にしか見えず、'
  '本人にも core_member にも見せない。追記専用（訂正は新しい行を足す。既存行は書き換えない）。';
COMMENT ON COLUMN public.member_notes.visibility IS
  'core_only=admin/core_memberが読める、admin_only=adminのみ。本人は visibility に関わらず読めない。';

CREATE INDEX IF NOT EXISTS ix_member_notes_member ON public.member_notes (member_id, created_at DESC);


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 #4）
--
--   ⚠️ 本人向けの `_select_self` を作らない。運営メモは本人に見せない設計であるため
--      （§2 の原則・Vault 側コメント）、他のPIIテーブルと違いここだけは意図的に非対称にする。
-- =============================================================================

ALTER TABLE public.member_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_notes_select_core ON public.member_notes
  FOR SELECT TO authenticated
  USING ( visibility = 'core_only' AND (SELECT public.is_staff()) );

CREATE POLICY member_notes_select_admin_only ON public.member_notes
  FOR SELECT TO authenticated
  USING ( visibility = 'admin_only' AND (SELECT public.is_admin()) );

-- ★ INSERT は staff のみ。本人・一般会員には書かせない。
CREATE POLICY member_notes_insert_staff ON public.member_notes
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- UPDATE / DELETE：ポリシーを作らない ＝ 全拒否（追記専用。訂正は新しい行を足す）。


-- =============================================================================
-- ③ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.member_notes FROM anon, authenticated;

GRANT SELECT, INSERT ON public.member_notes TO authenticated;  -- UPDATE/DELETE は与えない
