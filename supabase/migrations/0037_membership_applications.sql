-- =============================================================================
-- 0037_membership_applications.sql — 街人登録申込（申請〜決済〜承認の運営フロー）
--
--   WBS  : 12-2（申請〜決済〜承認フロー）／Issue #110
--          12-1（ロック中クエストの施錠表示・登録モーダル）の申請確定先
--   根拠 : 正本 v13 §5.10.1〜§5.10.7 ／ §7「★ 街人登録申込」／ §6 権限マトリクス、
--          `DB物理設計.md` §3-5・§6-1 #16・§6-3 の PII-B テンプレート
--   含む : membership_applications のスキーマ・制約・索引・遷移ガード・RLS・GRANT
--   含まない（WBS 12-3「特典付与処理」の範囲）:
--          ・承認時の `role` 昇格（guest → member）
--          ・宿泊券4枚の付与（`stay_ticket_transactions` への起票）
--          ・登録キャッシュバックの自動起票（`eumo_grants` の `registration_cashback`）
--          → 本表は「いつ昇格・付与したか」を記録する列だけを持ち、起票そのものは行わない
--   含まない（運用ジョブの範囲）:
--          ・14日経過で `保留` へ自動遷移（v13 §5.10.4。Cloud Scheduler 側の仕事）
--
-- ── 決済はアプリ外で完結する ──────────────────────────────────────────
--
-- v13 §5.10.4 の原則。本表が持つのは**申請から承認までの運営フローの記録**であり、
-- 決済トランザクションそのものは保持しない。したがって「入金の検知」は列に現れず、
-- 成立条件は**管理者の承認操作**（`approved_at`）1点である。
--
-- ── `DB物理設計.md` §3-5 の DDL に6列を足している ─────────────────────
--
-- `CLAUDE.md` §1.1 により正本 v13 が勝つ。同節の DDL は正本 §7 の次の項目を落としている。
--
--   ① `payment_method` ／ `paid_at` ／ `received_by`
--      §5.10.7（2026-08-25 決定・§9 #52）が「`街人登録申込` へ追加する」と明記した3列。
--      **これが無いと現金で受け取ったときの記録先が無い**（管理者が承認を押すだけで、
--      何で払われたかが残らない）。§5.10.7 がまさにこの欠落を理由に起票された改訂である
--   ② `rejection_reason`（却下理由）— §5.10.4「却下する場合は理由を入力し」
--   ③ `stay_tickets_granted_at`（宿泊券付与日時）— §7 の項目一覧に明記
--   ④ `plan_id` — §7「付与数は `membership_plans` マスタから取得し、コードに直書きしない」を
--      構造で守るための外部キー。§3-5 の DDL は `billed_amount_yen integer DEFAULT 30000` と
--      **金額を直書き**しており、正本の「直書き禁止」と食い違っていた。
--      本表では `plan_id` を正とし、金額・泊数は**トリガーがプランから写す**（下記④）
--
-- `DB物理設計.md` 側は本マイグレーションと同じ作業の中で追随させる（CLAUDE.md §7.0.1）。
--
-- ── 「登録種別」を独立した列にしない ──────────────────────────────────
--
-- 正本 §7 は項目として「登録種別」を挙げるが、Phase 1 の値は `街人` 1種のみであり
-- （§5.10.3 の確認画面が「登録種別（街人）」と固定表示する）、1値しか取らない列は
-- 実装の分岐を生まないまま誤入力の余地だけを作る。実務上の「種別」は**どのプランで
-- 登録するか**であり、それは `plan_id`（`membership_plans.plan_code`）が表している。
-- Phase 2 で街人以外の登録種別が増えたら、そのとき列を足す。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.membership_applications (
  application_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  member_id            uuid NOT NULL REFERENCES public.members (member_id),

  -- どのプランで申し込んだか。金額・付与泊数・キャッシュバック額の出どころ（v13 §7）。
  -- ★ NULL で INSERT すると、トリガーが「現行の登録導線のプラン」を入れる（下記④）。
  --    `NOT NULL` は BEFORE トリガーの後に評価されるため、この形で両立する。
  plan_id              uuid NOT NULL REFERENCES public.membership_plans (plan_id),

  applied_at           timestamptz NOT NULL DEFAULT now(),

  -- ★ プランから写した値（トリガーが上書きする）。申込時点の条件を後から追えるようにするため、
  --    プランを参照するだけでなく**申込側にも凍結して持つ**（プランの改定で過去の申込が動かない）。
  billed_amount_yen    integer NOT NULL
                         CONSTRAINT chk_membership_app_amount_non_negative
                         CHECK (billed_amount_yen >= 0),
  granted_nights       integer NOT NULL
                         CONSTRAINT chk_membership_app_nights_non_negative
                         CHECK (granted_nights >= 0),

  status               text NOT NULL DEFAULT '申込中'
                         CONSTRAINT chk_membership_app_status
                         CHECK (status IN ('申込中', 'QR送付済み', '承認済み', '却下', '保留')),

  -- ── 入金QRトークン（2026-09-10 確定 ／ 精算QR〈0019・7-3〉と同一規格）──────
  --   base64url(gen_random_bytes(32)) ＝ 256bit。**平文は保存しない**（sha256 の16進のみ）。
  --   TTL は発行から7日（入金を挟むため精算QRの24時間より長い／v13 §5.6・非機能 F-1）。
  qr_token_hash        text UNIQUE,
  qr_issued_by         uuid REFERENCES public.members (member_id),
  qr_issued_at         timestamptz,
  qr_delivery_channel  text CONSTRAINT chk_membership_app_qr_channel
                         CHECK (qr_delivery_channel IN ('line', 'in_app', 'in_person')),
  qr_expires_at        timestamptz,
  -- 単回使用。承認確定・現金への切替で失効させる（§5.10.7 の二重受領防止）
  qr_consumed_at       timestamptz,

  -- ── 決済手段（v13 §5.10.7 ／ §9 #52）────────────────────────────────
  --   ★ `credit_card` は CHECK に入れない。Phase 2（決済代行の選定・加盟店審査とセット）であり、
  --     受け皿だけ先に開けると「記録はできるが決済経路が無い」申込を作れてしまう。
  --     Phase 2 で ALTER して値を足す（そのとき決済代行の取引ID列も同時に要る／§7）。
  payment_method       text CONSTRAINT chk_membership_app_payment_method
                         CHECK (payment_method IN ('settlement_qr', 'cash', 'uii_qr')),
  paid_at              timestamptz,
  -- 現金受領者。§5.10.7「現金受領は受領者と受領日時を必須入力とする」
  received_by          uuid REFERENCES public.members (member_id),
  -- 入金確認者。§5.10.4 Step 5 の操作者でもある（Step 5 は「確認して完了する」1操作）
  payment_confirmed_by uuid REFERENCES public.members (member_id),

  -- ── 承認・昇格・付与 ────────────────────────────────────────────────
  approved_at             timestamptz,
  role_upgraded_at        timestamptz,
  stay_tickets_granted_at timestamptz,
  rejection_reason        text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- QR を「発行した」と言うなら、誰がいつ発行し、いつ切れるかが揃っていなければならない。
  -- 期限が無い QR は失効しない QR であり、7日の TTL が意味を失う。
  CONSTRAINT chk_membership_app_qr_complete CHECK (
    qr_token_hash IS NULL
    OR (qr_issued_by IS NOT NULL AND qr_issued_at IS NOT NULL AND qr_expires_at IS NOT NULL)
  ),

  -- 送付経路だけが残り、トークンが無い状態を作らない（何を送ったのか追えなくなる）
  CONSTRAINT chk_membership_app_qr_channel_needs_token CHECK (
    qr_delivery_channel IS NULL OR qr_token_hash IS NOT NULL
  ),

  -- ★ 現金と QR の二重受領を構造的に防ぐ（v13 §5.10.7）。
  --   現金を選んだ申込に**生きている QR** が残っていてはならない。
  --   運用としては「発行済みなら失効させる」であり、失効＝`qr_consumed_at` が入った状態。
  CONSTRAINT chk_membership_app_cash_has_no_live_qr CHECK (
    payment_method <> 'cash'
    OR qr_token_hash IS NULL
    OR qr_consumed_at IS NOT NULL
  ),

  -- 現金を受け取ったなら受領者が要る（§5.10.7「誰が受け取ったかを追える状態にする」）
  CONSTRAINT chk_membership_app_cash_needs_receiver CHECK (
    payment_method <> 'cash' OR paid_at IS NULL OR received_by IS NOT NULL
  ),

  -- ★ 承認済みを名乗るなら、手段・受領日時・確認者・承認日時が揃っていること。
  --   ここが緩いと「何で払われたか分からないまま昇格した会員」が作れる。
  CONSTRAINT chk_membership_app_approved_complete CHECK (
    status <> '承認済み'
    OR (approved_at IS NOT NULL
        AND payment_method IS NOT NULL
        AND paid_at IS NOT NULL
        AND payment_confirmed_by IS NOT NULL)
  ),

  -- 却下は理由必須（§5.10.4）。空白文字だけの理由も弾く（`0017` の差戻し理由と同じ扱い）
  CONSTRAINT chk_membership_app_rejected_needs_reason CHECK (
    status <> '却下' OR btrim(coalesce(rejection_reason, '')) <> ''
  ),

  -- 「QR送付済み」はトークンが実在して初めて名乗れる状態である
  CONSTRAINT chk_membership_app_qr_sent_has_token CHECK (
    status <> 'QR送付済み' OR qr_token_hash IS NOT NULL
  )
);

COMMENT ON TABLE public.membership_applications IS
  '街人登録申込（v13 §5.10）。決済はアプリ外（QR・現金・Uii QR）で完結するため、'
  '決済トランザクションそのものは保持しない。本表は申請〜承認までの運営フローの記録である。';

COMMENT ON COLUMN public.membership_applications.plan_id IS
  '申込プラン。金額・付与泊数・キャッシュバック額の出どころ（v13 §7「コードに直書きしない」）。'
  'NULL で INSERT するとトリガーが is_current_signup_plan = true のプランを入れる。';

COMMENT ON COLUMN public.membership_applications.billed_amount_yen IS
  'プランの年会費額を申込時点で凍結した値。トリガーが plan から写すため、申込側からは指定できない。';

COMMENT ON COLUMN public.membership_applications.granted_nights IS
  'プランの付与宿泊券枚数を申込時点で凍結した値。付与そのものは WBS 12-3 が行う。';

COMMENT ON COLUMN public.membership_applications.qr_token_hash IS
  '入金QRトークンの sha256（16進）。★ 平文は保存しない（2026-09-10 A案 ／ 精算QRと同一規格）。';

COMMENT ON COLUMN public.membership_applications.payment_method IS
  'settlement_qr（精算QR・eumo）／cash（現金）／uii_qr（Uii・eumoQR）。'
  'クレジットカードは Phase 2 のため CHECK に含めない（v13 §5.10.7・§9 #52）。';

COMMENT ON COLUMN public.membership_applications.received_by IS
  '現金受領者。payment_method = cash で受領済み（paid_at あり）のとき必須（v13 §5.10.7）。';

COMMENT ON COLUMN public.membership_applications.role_upgraded_at IS
  'guest → member の昇格日時。昇格処理そのものは WBS 12-3 の範囲であり、本表は記録先にすぎない。';


-- =============================================================================
-- ② 索引
-- =============================================================================

CREATE INDEX IF NOT EXISTS ix_membership_app_member
  ON public.membership_applications (member_id);

CREATE INDEX IF NOT EXISTS ix_membership_app_status
  ON public.membership_applications (status);

-- ★ 二重申請の防止（v13 §5.10.3「同一ユーザーの申込中レコードが既に存在する場合は
--   新規作成せず既存を表示する」）。**アプリ側の分岐だけに任せない。**
--   同時に2回タップされた場合、アプリの存在チェックは両方すり抜ける（時間差が無い）。
--   終了状態（承認済み・却下）は対象外にする。却下後の再申請と、
--   将来の更新（会員権の期間満了後の再登録）を塞がないため。
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_app_active_per_member
  ON public.membership_applications (member_id)
  WHERE status IN ('申込中', 'QR送付済み', '保留');

-- 申請の滞留検出（v13 §5.10.4「一定期間〈例：14日〉承認されない申込は保留へ」）。
-- 期間の判定はアプリ／ジョブ側で行う（`eumo_grants` の滞留検出と同じ形）。
CREATE INDEX IF NOT EXISTS ix_membership_app_stale
  ON public.membership_applications (applied_at)
  WHERE status IN ('申込中', 'QR送付済み');


-- =============================================================================
-- ③ RLS（`DB物理設計.md` §6-1 #16・§6-3 の PII-B テンプレート）
--
--   テンプレートからの差分は1点のみ: **staff 版を `is_admin()` に置換**する。
--   申請一覧は admin のみ（v13 §6）であり、`core_member` には開けない。
--
--   本人には**自分の申込だけ**を開ける。ゲストが「運営からの案内をお待ちください」
--   （§5.10.1 の申請中画面）を自分で確認できる必要があるため。
-- =============================================================================

ALTER TABLE public.membership_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY membership_app_select_self ON public.membership_applications
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY membership_app_select_admin ON public.membership_applications
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_admin()) );

-- ★ 本人が申請を INSERT する（§6-1 #16「本人が申請 INSERT。QR発行・承認は admin」）。
--   ゲスト（role = 'guest'）が通る経路であるため、ここを staff に絞ってはならない。
--   本人が書けるのは「申し込んだ」という事実だけで、QR・承認・金額はトリガーが弾く（④）。
CREATE POLICY membership_app_insert_self ON public.membership_applications
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id()) );

-- 運営による代理申請（対面での登録受付）。
CREATE POLICY membership_app_insert_admin ON public.membership_applications
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_admin()) );

-- QR発行・入金確認・承認・却下はすべて admin の UPDATE（§5.10.4 Step 3〜5）。
-- 本人に UPDATE を開けない。開けると RLS は列を絞れないため、
-- 本人が自分の申込を `承認済み` にできてしまう（＝無償で昇格できる）。
CREATE POLICY membership_app_update_admin ON public.membership_applications
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_admin()) )
  WITH CHECK ( (SELECT public.is_admin()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。申請の証跡を消させない（§1-3 論理削除）。


-- =============================================================================
-- ④ 遷移ガード（トリガー）
--
-- > [!danger] なぜ RLS ではなくトリガーで守るのか
-- > `0017` の同節と同じ理由である。**`service_role` は RLS も GRANT も迂回する。**
-- > サーバ側が1箇所でも `createAdminSupabaseClient()` で UPDATE すれば、
-- > 「承認は admin のみ」は素通りする。加えて RLS は**列を絞れない**ため、
-- > 本人 INSERT を開けた時点で `billed_amount_yen`・`status`・`approved_at` が射程に入る。
-- > 「0円で申し込んで自分で承認済みにする」を止められるのはトリガーだけである。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.membership_applications_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role      text := public.current_actor_role();
  -- 操作者。`current_actor_role()` と同じ2経路（ログインセッション／service_role の申告）で引く。
  -- 片方だけを見ると、service_role 経由の申請で本人チェックが素通りする。
  actor_member_id uuid := coalesce(public.current_member_id(), public.current_operator_id());
  plan            public.membership_plans;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- ── プランの確定（正本 §7「コードに直書きしない」を構造で守る）──────────
    IF NEW.plan_id IS NULL OR coalesce(actor_role, '') <> 'admin' THEN
      -- 申込者本人の経路では**プランを選ばせない**。新規の街人登録導線が引くプランは
      -- 1つだけである（v13 §5.10.2 ／ `0016` の `is_current_signup_plan`）。
      -- ここを申込側の入力に委ねると、金額の安いプランを名乗って申し込める。
      SELECT p.* INTO plan
      FROM   public.membership_plans p
      WHERE  p.is_current_signup_plan
      LIMIT  1;

      IF plan.plan_id IS NULL THEN
        RAISE EXCEPTION '現行の街人登録プラン（is_current_signup_plan）が1件も無い'
          USING ERRCODE = '23502';
      END IF;
    ELSE
      SELECT p.* INTO plan
      FROM   public.membership_plans p
      WHERE  p.plan_id = NEW.plan_id;

      IF plan.plan_id IS NULL THEN
        RAISE EXCEPTION '指定されたプランが membership_plans に無い'
          USING ERRCODE = '23503';
      END IF;
    END IF;

    NEW.plan_id           := plan.plan_id;
    -- ★ 申込側が何を送ってきても、金額と泊数はプランから写した値で上書きする
    NEW.billed_amount_yen := plan.annual_fee_yen;
    NEW.granted_nights    := plan.granted_stay_nights;

    -- ── 本人経路の制限 ────────────────────────────────────────────────
    IF coalesce(actor_role, '') <> 'admin' THEN
      IF actor_member_id IS NULL OR NEW.member_id <> actor_member_id THEN
        RAISE EXCEPTION '他人の街人登録を申請できない（v13 §5.10.3）'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.status <> '申込中' THEN
        RAISE EXCEPTION '申請は「申込中」で作る。状態の先送りは運営の操作である（v13 §5.10.4）'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.qr_token_hash IS NOT NULL
         OR NEW.payment_method IS NOT NULL
         OR NEW.paid_at IS NOT NULL
         OR NEW.approved_at IS NOT NULL
         OR NEW.role_upgraded_at IS NOT NULL
         OR NEW.stay_tickets_granted_at IS NOT NULL
         OR NEW.payment_confirmed_by IS NOT NULL
         OR NEW.received_by IS NOT NULL THEN
        RAISE EXCEPTION 'QR・決済・承認の各列は運営だけが書ける（v13 §5.10.4 Step 3〜5）'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- ── UPDATE ────────────────────────────────────────────────────────────
  IF NEW.member_id <> OLD.member_id THEN
    RAISE EXCEPTION '申請者を付け替えられない（監査の連続性が切れる）'
      USING ERRCODE = '42501';
  END IF;

  -- 終了状態からは動かさない。承認・却下の取り消しは新しい申請として行う
  -- （§5.10.5 の昇格・付与が済んだ後に巻き戻すと、付与の二重計上が起きる）。
  IF OLD.status IN ('承認済み', '却下') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION '承認済み・却下の申請は状態を変更できない（v13 §5.10.5）'
      USING ERRCODE = '42501';
  END IF;

  -- QR発行・入金確認・承認・却下は admin のみ（v13 §6「申請一覧は admin」）。
  -- `is_admin()` ではなく `current_actor_role()` を見るのは、service_role 経路
  -- （`auth.uid()` が NULL）でも判定を効かせるため（0017 と同じ）。
  IF coalesce(actor_role, '') <> 'admin' THEN
    RAISE EXCEPTION '街人登録申請の審査・QR発行・承認は管理者のみが行える（v13 §6）'
      USING ERRCODE = '42501';
  END IF;

  -- ★ 現金へ切り替えたら、発行済みの QR を失効させる（v13 §5.10.7）。
  --   CHECK 制約で「現金 ＋ 生きた QR」を禁じているため、ここで落とさないと
  --   運営は先に QR を手で失効させない限り現金へ切り替えられない。
  --   運用の手数を増やさず、二重受領を防ぐ側に倒す。
  IF NEW.payment_method = 'cash' AND NEW.qr_token_hash IS NOT NULL
     AND NEW.qr_consumed_at IS NULL THEN
    NEW.qr_consumed_at := now();
  END IF;

  -- 承認の確定で QR を単回使用として閉じる（2026-09-10 A案）
  IF NEW.status = '承認済み' AND NEW.qr_token_hash IS NOT NULL
     AND NEW.qr_consumed_at IS NULL THEN
    NEW.qr_consumed_at := now();
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.membership_applications_guard() IS
  '街人登録申込のガード。①金額・泊数をプランから写す ②本人経路では申込中しか作らせない '
  '③QR・決済・承認列は admin だけが書ける ④現金へ切替・承認確定で QR を失効させる。';

CREATE TRIGGER trg_membership_applications_guard
  BEFORE INSERT OR UPDATE ON public.membership_applications
  FOR EACH ROW EXECUTE FUNCTION public.membership_applications_guard();


-- =============================================================================
-- ⑤ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.membership_applications FROM anon, authenticated;

GRANT SELECT         ON public.membership_applications TO authenticated;
GRANT INSERT, UPDATE ON public.membership_applications TO authenticated;  -- 行は RLS、列はトリガー
