-- =============================================================================
-- 0001_members_schema.sql
--
-- 会員マスタ（`members`）と、そこから切り出した個人情報（`member_profiles_private`）、
-- 権限変更履歴（`member_role_changes`）のベーススキーマ。WBS 2-1。
--
-- 根拠:
--   - 会員データモデル_ユーザーテーブル定義.md §5.2（列表）／§5.2a（auth_user_id と account_status）
--     ／§5.2b（個人情報の分離）／§5.9（権限変更履歴）
--   - DB物理設計.md §6-6b⑤（member_role_changes の DDL と CHECK）／§6-7（デフォルト拒否）
--   - 正本 v13 §2（role 5値・member_type 4値・アカウント状態3値）／§7（PII の別テーブル分離）
--
-- ⚠️ `role`（権限）と `member_type`（立場）の値域は **正本 v13 §2 を採る**。
--    会員データモデル §5.2 の列表は 4値/3値だが、矛盾時は正本が勝つ（CLAUDE.md §1.1）。
--    2026-09-14 のオーナー回答（論点2＝5値・論点3＝4値）も正本側である。
--
-- スコープ外（本ファイルで書かないもの）:
--   - RLS ポリシー本体（CREATE POLICY）と anon / authenticated / service_role の GRANT・REVOKE … WBS 2-2
--   - v_member_public ビューと display_name の表示規則 … WBS 2-3 / 5-1
--   - full_name_normalized（生成列）と normalize_person_name() … WBS 10-1
--     （2026-09-14 オーナー回答 論点4＝今回は入れない）
--   - 集計キャッシュ3列の再計算トリガー … WBS 3-4
--
-- 採番: 0100 が「0001〜0099 をベーススキーマ用に空けておく」と明記しているため先頭から採る。
-- =============================================================================


-- =============================================================================
-- 1. members（会員マスタ）
--
--   氏名・カナ・住所・出身地・誕生年月は本表に置かない（v13 §7 の A案）。
--   RLS は行にしか効かないため、保護対象を別の行へ移すことで
--   「ポリシー1本で個人情報が閉じる」状態を作っている（会員データモデル §5.2b）。
-- =============================================================================

CREATE TABLE public.members (
  member_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RLS の本人ポリシー（auth.uid() との突合）が根拠にする唯一の列。
  -- NULL = アプリ未登録（街人ではあるが Supabase Auth のアカウントを持たない／§5.2a）。
  -- UNIQUE なのは、1つの Auth アカウントが2会員へ紐づくと名寄せ事故がそのまま
  -- 他人の宿泊券・Uii 残高の乗っ取りになるため（v13 §5.8.3）。
  -- ON DELETE 句は付けない（会員データモデル §5.2a の DDL 断片どおり）。既定の NO ACTION により、
  -- 会員へ結合済みの Auth ユーザーは削除できない。
  auth_user_id      uuid UNIQUE REFERENCES auth.users (id),

  -- 街びと `f` 列の会員番号。親方衆は `OYA-` 接頭辞で番号空間を分ける（§6.2）
  legacy_member_no  text UNIQUE,

  -- ⚠️ 未設定時に full_name へフォールバックしてはならない（§5.2c の不可侵ルール）
  nickname          text,

  -- 立場。**認可には一切使わない**（v13 §2）。認可の根拠は role のみ（v13 §5.9.3）
  member_type       text NOT NULL
                      CONSTRAINT chk_members_member_type
                      CHECK (member_type IN ('親方', '街人（コア）', '街人（一般）', 'ゲスト')),

  -- 認可の唯一の根拠。自分自身の role は誰も変更できない（0003 のガードトリガー）
  role              text NOT NULL
                      CONSTRAINT chk_members_role
                      CHECK (role IN ('admin', 'core_member', 'member', 'guest', 'custom')),

  -- アカウント状態。auth_user_id との対応は §5.2a の表を正とする
  account_status    text NOT NULL
                      CONSTRAINT chk_members_account_status
                      CHECK (account_status IN ('pre_registered', 'active', 'withdrawn')),

  oyakata_star_flag boolean NOT NULL DEFAULT false,
  skills            text[],
  certifications    text[],
  earned_xp         integer NOT NULL DEFAULT 0,

  -- 集計キャッシュ3列。正本は取引明細であり、直接 UPDATE は禁止（§1-1・v13 §9 #25）。
  -- DB 側での強制（専用ガードトリガー・DB物理設計 §6-6b④）は取引明細側の WBS 3-4 で入れる
  stay_tickets      integer NOT NULL DEFAULT 0,
  total_stay_days   integer NOT NULL DEFAULT 0,
  uii_balance       integer NOT NULL DEFAULT 0,

  last_visited_on   date,
  line_joined       boolean NOT NULL DEFAULT false,
  discord_joined    boolean NOT NULL DEFAULT false,
  imported_from     text,
  imported_at       timestamptz,
  invite_code       text UNIQUE,
  linked_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.members IS
  '会員マスタ。個人情報（氏名・カナ・住所・出身地・誕生年月）は member_profiles_private へ分離してある。'
  '戻してはならない（戻すと列単位マスキングが再び必要になる／2026-09-05 A案・v13 §7）';

COMMENT ON COLUMN public.members.member_type IS
  '立場（親方／街人（コア）／街人（一般）／ゲスト）。認可には一切使わない（v13 §2）';

COMMENT ON COLUMN public.members.role IS
  '権限ロール。認可の唯一の根拠（v13 §5.9.3）。自分自身の role は誰も変更できない（DB物理設計 §6-6b③①）';

COMMENT ON COLUMN public.members.auth_user_id IS
  'Supabase Auth のユーザーID。NULL = アプリ未登録。RLS の本人ポリシーはこの列だけを根拠にする（§5.2a）';


-- =============================================================================
-- 2. member_profiles_private（個人情報）
--
--   1対1なのに別テーブルにしている理由は正規化ではなく認可である（会員データモデル §5.2b）。
-- =============================================================================

CREATE TABLE public.member_profiles_private (
  -- PK 兼 FK ＝ 1対1。会員行を消したら個人情報も必ず消える
  member_id      uuid PRIMARY KEY
                   REFERENCES public.members (member_id) ON DELETE CASCADE,
  full_name      text NOT NULL,
  full_name_kana text,
  -- 会員の現在の住所。旅館業法の法定名簿ではない（名簿は lodging_register_entries の当時値／§5.8）
  address        text,
  hometown       text,
  birth_ym       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_profiles_private IS
  '個人情報（氏名・カナ・住所・出身地・誕生年月）。行単位RLSで本人と admin/core_member のみに限定する。'
  'members 側へ戻してはならない（戻すと列単位マスキングが再び必要になる／2026-09-05 A案）';

-- ⚠️ 生成列 full_name_normalized と、その索引（ix_member_profiles_name_norm 系）は本パッケージでは作らない。
--    照合キーの正規化関数 normalize_person_name() が名寄せ（WBS 10-1）側の成果物であり、
--    2026-09-14 のオーナー回答（論点4）で今回の範囲から外れたため。


-- =============================================================================
-- 3. member_role_changes（権限変更履歴）
--
--   DDL の正は DB物理設計 §6-6b⑤。書き込むのは 0003 の AFTER トリガー1本だけ。
-- =============================================================================

CREATE TABLE public.member_role_changes (
  change_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid        NOT NULL REFERENCES public.members (member_id) ON DELETE RESTRICT,
  old_role    text        NOT NULL,
  new_role    text        NOT NULL,
  operator_id uuid        NOT NULL REFERENCES public.members (member_id) ON DELETE RESTRICT,
  reason      text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_role_actually_changed CHECK (old_role <> new_role),
  -- 自己変更はトリガーで拒否されるため記録として存在しえない。制約でも二重に表明しておく
  CONSTRAINT chk_not_self_change       CHECK (member_id <> operator_id),
  CONSTRAINT chk_reason_not_blank      CHECK (btrim(reason) <> '')
);

CREATE INDEX ix_role_changes_member ON public.member_role_changes (member_id, changed_at DESC);

COMMENT ON TABLE public.member_role_changes IS
  '権限ロールの変更履歴。トリガー（trg_members_log_role_change）だけが書き込む。'
  'ON DELETE RESTRICT は、会員行の物理削除そのものを止める役割も兼ねる（DB物理設計 §1-3）';


-- =============================================================================
-- 4. RLS の有効化（デフォルト拒否／DB物理設計 §6-7）
--
--   ポリシー未定義＝全拒否。CREATE POLICY と GRANT の本体は WBS 2-2 で入れる。
--   ⚠️ members に FORCE ROW LEVEL SECURITY を付けてはならない。付けると SECURITY DEFINER の
--      ヘルパ関数にも RLS が適用され、members のポリシー → is_staff() → … と再帰して
--      42P17（infinite recursion）で全クエリが落ちる（DB物理設計 §6-2① の danger）。
-- =============================================================================

ALTER TABLE public.members                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_profiles_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_role_changes     ENABLE ROW LEVEL SECURITY;
