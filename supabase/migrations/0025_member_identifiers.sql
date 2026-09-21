-- =============================================================================
-- 0025_member_identifiers.sql — 会員の連絡先（名寄せキー）
--
--   WBS  : 10-2（名寄せロジック）／Issue #112・#115
--   根拠 : v13 §5.8.3（名寄せの初回紐付けには本人確認が要る）・§7、
--          `DB物理設計.md` §2 の表・§5.3（`uq_identifier_verified`）・§6-1 #2
--   含む : member_identifiers のスキーマ・部分ユニーク索引・RLS・GRANT
--
-- ── 2026-09-21 オーナー決定 ──────────────────────────────────────
--
-- 「**連絡先はユーザーテーブルにして、宿泊テーブルには持たない。外部キーでつなぐ**」
--
-- したがって公開予約（`/reserve`）で受け取る氏名・電話・メールは `check_ins` に
-- 列を生やさず、**会員側のこの表に入れる**。`check_ins.member_id` が既に
-- `members` への外部キーなので、予約から連絡先へはその経路で辿る。
--
-- ⚠️ `DB物理設計.md` §2 は本表をテーブルとして列挙していたが **DDL が存在しなかった**
--    （`QUESTIONS.md`「[2026-09-21] Phase 1 に必要な4テーブルの DDL が本リポジトリに存在しない」）。
--    本マイグレーションが初出である。列構成は §2 の記述（「名寄せキー（email/phone/line/discord）。
--    検証済み識別子のみ `(kind, value)` 一意。未検証は重複許容」）と §5.3 の
--    `uq_identifier_verified ... WHERE is_verified = true` に合わせた。
--
-- ── なぜ「検証済みだけ」一意なのか ────────────────────────────────
--
-- 移行時は全件が未検証（`is_verified = false`）で入る。ここで無条件に一意を張ると、
-- **同じアドレスが複数の会員行に現れる実データを1件も取り込めない**（それが名寄せの対象である）。
-- 一方、本人確認を通った識別子が2人に紐づくことは起きてはならない。
-- 部分ユニークはこの2つを同時に満たす唯一の形である（§5.3）。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
--
--   ⚠️ **PII-B**（`DB物理設計.md` §6-1 #2）。`member_profiles_private` と同じ保護区分。
--      個人情報カラムを表示用カラムと同じ行に置かない方針（§2 の原則7）に従い、
--      `members` へ列を足すのではなく別表にする。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_identifiers (
  identifier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES public.members (member_id) ON DELETE CASCADE,

  kind          text NOT NULL
                  CONSTRAINT chk_member_identifier_kind
                  CHECK (kind IN ('email', 'phone', 'line', 'discord')),

  -- 生の連絡先。照合用の正規化値は下の `value_normalized` に持つ
  value         text NOT NULL
                  CONSTRAINT chk_member_identifier_value_present
                  CHECK (btrim(value) <> ''),

  -- ★ 照合はこちらで行う。大文字小文字・前後の空白の違いで同一人物を取りこぼさないため。
  --   生成列にするのは、アプリ側が正規化を忘れても必ず揃うようにするためである。
  value_normalized text GENERATED ALWAYS AS (lower(btrim(value))) STORED,

  -- 本人確認を通ったか。公開予約の OTP（`reservation_otps`）を通ったメールは true になる
  is_verified   boolean NOT NULL DEFAULT false,
  verified_at   timestamptz,

  -- 氏名はここに持たない。`member_profiles_private.full_name` が持つ（§2 の原則7）。
  -- 本表が持つのは「連絡が取れる手段」だけである
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_member_identifier_verified_has_time
    CHECK ((is_verified = false) OR verified_at IS NOT NULL)
);

COMMENT ON TABLE public.member_identifiers IS
  '会員の連絡先（名寄せキー）。PII-B。2026-09-21 オーナー決定により、'
  '予約時の連絡先は check_ins に持たず本表へ入れ、check_ins.member_id の外部キーで辿る。';
COMMENT ON COLUMN public.member_identifiers.value_normalized IS
  '照合用に小文字化・前後空白除去した値。生成列にしてアプリ側の正規化漏れを防ぐ';
COMMENT ON COLUMN public.member_identifiers.is_verified IS
  '本人確認済みか。移行時は全件 false で入る。検証済みのみ一意（uq_identifier_verified）';

-- ★ 検証済みの識別子は1人にしか紐づかない。未検証は重複を許す（§5.3）
CREATE UNIQUE INDEX IF NOT EXISTS uq_identifier_verified
  ON public.member_identifiers (kind, value_normalized)
  WHERE is_verified = true;

-- 名寄せの照合経路（未検証も含めて「似た人が居る」を探す）
CREATE INDEX IF NOT EXISTS ix_member_identifier_lookup
  ON public.member_identifiers (kind, value_normalized);

CREATE INDEX IF NOT EXISTS ix_member_identifier_member
  ON public.member_identifiers (member_id);


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 #2：PII-B ／ `member_profiles_private` と同じ扱い）
--
--   本人と staff だけ。連絡先は他の会員から見えてはならない（v13 §5.9）。
--   書き込みは staff のみ。**本人に UPDATE を許さない**のは、
--   `is_verified` を自分で true にできてしまうと名寄せの一意性が意味を失うためである。
-- =============================================================================

ALTER TABLE public.member_identifiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_identifiers_select_self ON public.member_identifiers
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY member_identifiers_select_staff ON public.member_identifiers
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY member_identifiers_insert_staff ON public.member_identifiers
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY member_identifiers_update_staff ON public.member_identifiers
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_staff()) )
  WITH CHECK ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。
--   連絡先を消すと名寄せの根拠が消える。退会時の扱いは members 側の
--   ON DELETE CASCADE に委ねる（§6-9 の退会後の匿名化の論点は未決のまま）。


-- =============================================================================
-- ③ GRANT（§6-6②）
--
--   ⚠️ 公開予約（未ログイン）からの登録は **service_role 経由**である。
--      `anon` には何も与えない（0015・0022 と同じ方針）。
-- =============================================================================

REVOKE ALL ON public.member_identifiers FROM anon, authenticated;

GRANT SELECT         ON public.member_identifiers TO authenticated;
GRANT INSERT, UPDATE ON public.member_identifiers TO authenticated;  -- 行は RLS で staff のみ
