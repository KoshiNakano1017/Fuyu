-- =============================================================================
-- WBS 2-1b：ログイン導線の DB 側（システム操作者 ＋ 招待台帳）
--
-- 根拠: v13 §5.2.6（会員のログイン方式：メールOTP）／§9 #64
--       Issue #39 の 2026-09-15 オーナー決定（論点①〜③）
--
-- ここで作るもの:
--   ① システム操作者を表す members 行（決定B）
--   ② member_invitations（経路B の監査台帳）
--
-- ここで作らないもの:
--   - member_invitations の RLS ポリシー本体 → WBS 2-2
--     （0001_members_schema.sql が他テーブルのポリシーを 2-2 へ送っている前例に揃える）
--   - ログイン OTP のレート制限 → Supabase Auth の既定に委ねる（論点③＝A）
-- =============================================================================


-- =============================================================================
-- ① システム操作者（決定B ／ Issue #39 論点①）
--
-- **なぜ必要か。** 初回ログインでは members.auth_user_id へ auth.users.id を入れるが、
-- 0003 のガードトリガーがこれを阻む。経路をたどると:
--
--   1. 本人はまだ auth_user_id が NULL なので、current_operator_id() の経路①
--      （auth.uid() で members を引く）では自分を特定できず NULL になる
--   2. operator_id が NULL だと「操作者を特定できない権限列の変更」として拒否される
--
-- 選択肢は3つあった。
--   A: 自己サービスの初回結合を実装しない（完了条件を落とすことになる）
--   B: システム操作者を表す members 行を用意する  ← 採用
--   C: ガードトリガーを改訂して本人の初回結合だけ通す
--
-- **C を採らない理由**が決め手だった。DB物理設計 §6-6b は
-- 「service_role は RLS も GRANT も迂回するため、**必ず発火する関門はトリガーだけ**」
-- と定めている。最後の関門に「本人なら通る」という穴を開けると、
-- service_role を握った経路がそこを通れてしまう。
--
-- **この行は「人」ではない。** 次の3点で、決して利用者になれないようにする。
--   - auth_user_id を NULL のままにする（ログインの入口が無い）
--   - account_status = 'withdrawn'（active でないため本人ポリシーの対象外）
--   - role = 'guest'（最小権限。ガードは operator の EXISTS しか見ないので、
--     ここに admin を置く必要はまったく無い）
-- =============================================================================

-- member_id を固定値にするのは、アプリ側が起動時に検索せず参照できるようにするため。
-- 検索にすると「見つからなければ作る」経路が要り、そこが新しい穴になる。
INSERT INTO public.members (
  member_id, auth_user_id, legacy_member_no, nickname,
  member_type, role, account_status
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  NULL,                     -- ★ ログインの入口を持たせない
  NULL,
  'システム（自動処理）',
  'ゲスト',
  'guest',                  -- ★ 最小権限。ガードは EXISTS しか見ない
  'withdrawn'               -- ★ active でないため本人ポリシーの対象外
)
ON CONFLICT (member_id) DO NOTHING;

COMMENT ON TABLE public.members IS
  '会員マスタ。member_id = 00000000-0000-0000-0000-000000000001 は'
  'システム操作者であり人ではない（WBS 2-1b ／ v13 §5.2.6）。'
  '初回ログインの auth_user_id 結合で app.operator_id として申告する。';


-- =============================================================================
-- ② member_invitations：経路B（運営が個別にアカウント作成リンクを送る）の監査台帳
--
-- v13 §5.2.6 の danger が必須としている4項目を、DB 側で受け止める。
--   1. 送信操作を admin / core_member に限定      → RLS（WBS 2-2）＋ アプリ側の認可
--   2. 誰が・いつ・どの会員へ・どのアドレスへ送ったか → 本テーブルの列
--   3. リンクに有効期限                            → expires_at
--   4. 既に active な会員には送れない               → 送信時にアプリ側で検査
--
-- **なぜ専用テーブルか**（Issue #39 論点② ＝ A）。
-- DB物理設計 §6-6b⑤ の note が「汎用監査ログとの正本関係の確定は本書のスコープ外・要確認」
-- と明記している。汎用監査ログを先に作ると、その正本論争を 2-1b が抱え込む。
-- member_role_changes と同じ「専用テーブル」方針に揃えるほうが、決着済みの形に乗れる。
-- =============================================================================

CREATE TABLE public.member_invitations (
  invitation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 誰へ送ったか。会員が消えても監査記録は残す必要があるため ON DELETE は既定（NO ACTION）。
  member_id      uuid NOT NULL REFERENCES public.members (member_id),

  -- どのアドレスへ送ったか。**これが監査の核心**である。
  -- 経路B の事故は「宛先を誤って他人にアカウントを渡す」ことなので、
  -- 「どの会員へ」と「どのアドレスへ」が対で残らないと、誤送信を追跡できない。
  sent_to_email  text NOT NULL
                   CONSTRAINT chk_invitations_email_present
                   CHECK (btrim(sent_to_email) <> ''),

  -- 誰が送ったか。運営の操作なので members を指す。
  sent_by        uuid NOT NULL REFERENCES public.members (member_id),

  sent_at        timestamptz NOT NULL DEFAULT now(),

  -- 有効期限（2026-09-15 オーナー決定：24時間）。
  -- ⚠️ 当初 72時間で決定したが、Supabase の Email OTP Expiration は
  --    86,400秒（24時間）超をダッシュボードで設定できないため 24時間へ訂正した。
  --    値はアプリ側の定数と対で持つ（src/lib/auth/invitations.ts）。
  expires_at     timestamptz NOT NULL,

  -- 消費（リンクが開かれてアカウントが作られた）日時。未消費なら NULL。
  -- 誤送信に気づいた時点で「まだ開かれていないか」を照会できるようにするため、
  -- 期限とセットで残す（2026-09-15 オーナー指示の補償条件）。
  consumed_at    timestamptz,

  CONSTRAINT chk_invitations_expires_after_sent CHECK (expires_at > sent_at),
  CONSTRAINT chk_invitations_consumed_after_sent
    CHECK (consumed_at IS NULL OR consumed_at >= sent_at)
);

-- 「この会員に未消費の招待が残っているか」を引く経路。再送の判断に使う。
CREATE INDEX ix_invitations_member ON public.member_invitations (member_id, sent_at DESC);

COMMENT ON TABLE public.member_invitations IS
  '経路B（運営が個別にアカウント作成リンクを送る）の監査台帳。'
  'v13 §5.2.6 の danger が必須とする「誰が・いつ・どの会員へ・どのアドレスへ」を残す。';


-- =============================================================================
-- RLS：有効化までを 2-1b で行い、ポリシー本体は 2-2 へ送る
--
-- 0001_members_schema.sql が members / member_profiles_private / member_role_changes
-- で取った形と同じ。**有効化だけしてポリシーを置かない状態は「全拒否」**であり、
-- 安全側に倒れている（誤って全公開になることはない）。
-- =============================================================================

ALTER TABLE public.member_invitations ENABLE ROW LEVEL SECURITY;

-- anon には触らせない（2026-09-05 決定「前線2：anon 権限を原則ゼロ」）。
REVOKE ALL ON public.member_invitations FROM PUBLIC;
REVOKE ALL ON public.member_invitations FROM anon;


-- =============================================================================
-- ③ bind_member_auth_user：初回ログインの結合を1トランザクションで行う
--
-- **なぜ関数にするのか。** ガードトリガーは `current_setting('app.operator_id')`
-- を読む。これはトランザクションローカル（set_config の第3引数が true）なので、
-- `set_config` と `UPDATE` が**同じトランザクションに居なければ届かない**。
-- supabase-js から2回に分けて呼ぶと別トランザクションになり、
-- 申告が消えてガードに拒否される。
--
-- **なぜ SECURITY DEFINER か。** service_role から呼ぶため本来は不要だが、
-- search_path を固定して関数内の名前解決を確定させる意味がある
-- （0002・0003 と同じ作法）。
--
-- **誰が呼べるか。** service_role だけ。authenticated から呼べると、
-- 「操作者を自由に申告して権限列を書き換える」入口そのものになる。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.bind_member_auth_user(
  p_member_id    uuid,
  p_auth_user_id uuid,
  p_operator_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- ガードトリガーへ操作者を申告する。第3引数 true でトランザクションローカル。
  PERFORM set_config('app.operator_id', p_operator_id::text, true);

  UPDATE public.members
  SET    auth_user_id   = p_auth_user_id,
         account_status = 'active'
  WHERE  member_id      = p_member_id
    AND  auth_user_id   IS NULL;   -- ★ 既に結合済みの行は触らない（付け替えの防止）

  IF NOT FOUND THEN
    RAISE EXCEPTION '結合対象が見つからない（既に auth_user_id が入っている可能性）: %', p_member_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 既定では PUBLIC に EXECUTE が付く。認証済み利用者から呼べると
-- 「操作者を自由に申告して権限列を書き換える」入口になるため、必ず剥がす。
REVOKE EXECUTE ON FUNCTION public.bind_member_auth_user(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bind_member_auth_user(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bind_member_auth_user(uuid, uuid, uuid) FROM authenticated;
