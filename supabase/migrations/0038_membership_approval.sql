-- =============================================================================
-- 0038_membership_approval.sql — 街人登録の承認（昇格 ＋ 宿泊券付与 ＋ キャッシュバック起票）
--
--   WBS  : 12-2（申請〜決済〜承認フロー ／ Step 5）・12-3（特典付与処理）
--   根拠 : 正本 v13 §5.10.4（Step 5 の承認操作をもって登録成立）・§5.10.5（完了処理）、
--          §5.8.5（付与は宿泊日数調整ログへ残す）・§5.3.1（給付は eumo_grants で追跡）、
--          `DB物理設計.md` §6-6b（権限列の変更は操作者の申告が要る）
--   含む : `approve_membership_application()` の RPC 1本
--
-- ── なぜアプリ側の4回の書き込みではなく RPC 1本なのか ────────────────────
--
-- 承認は**4つの書き込みが全部そろって初めて意味を持つ**（v13 §5.10.5）。
--
--   ① 申請を `承認済み` にする（承認日時・入金確認者）
--   ② `members.role` を `guest` → `member` へ上げる
--   ③ 宿泊券を `granted_nights` 泊付与する（`stay_ticket_transactions`）
--   ④ 登録キャッシュバックを `未送付` で起票する（`eumo_grants`）
--
-- これをアプリから4回に分けて呼ぶと、途中で落ちた時に
-- **「権限は上がったが宿泊券が無い」「付与はされたが申請が申込中のまま」**が残る。
-- 後者は二重承認で**宿泊券とキャッシュバックの二重付与**に直結する（金銭価値を持つ）。
-- 1トランザクションに閉じれば、落ちたときは何も起きていない状態へ戻る。
--
-- ── もう1つの理由：操作者の申告は同じトランザクションでなければ届かない ──────
--
-- `0003` のガードは `members.role` の変更に **`app.operator_id` と `app.change_reason`**
-- の申告を要求する（`0004` の `bind_member_auth_user()` と同じ事情）。
-- supabase-js から `set_config` と `UPDATE` を別に呼ぶと**別トランザクション**になり、
-- 申告が消えてガードに拒否される。したがって昇格を伴う処理は関数側に置くしかない。
--
-- ── 誰が呼べるか ────────────────────────────────────────────────────
--
-- **`service_role` だけ**。`authenticated` から呼べると「操作者を自由に申告して
-- 自分を昇格させる」入口そのものになる（`0004` と同じ理由で EXECUTE を剥がす）。
-- 呼び出し側（Server Action）が admin であることを判定し、`p_operator_id` に
-- その admin を渡す。関数はその申告が admin のものかを**自分でも確かめる**。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.approve_membership_application(
  p_application_id uuid,
  p_operator_id    uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app          public.membership_applications;
  plan         public.membership_plans;
  operator_role text;
  target_role   text;
BEGIN
  -- ── 0. 操作者の検証（v13 §6「申請一覧は admin」）──────────────────────
  SELECT m.role INTO operator_role
  FROM   public.members m
  WHERE  m.member_id = p_operator_id;

  IF operator_role IS NULL THEN
    RAISE EXCEPTION '申告された操作者 % が members に存在しない', p_operator_id
      USING ERRCODE = '42501';
  END IF;

  IF operator_role <> 'admin' THEN
    RAISE EXCEPTION '街人登録の承認は管理者のみが行える（v13 §6）' USING ERRCODE = '42501';
  END IF;

  -- ── 1. 申請を取る（同じ行への同時承認を止める）────────────────────────
  --   ★ `FOR UPDATE` で行を押さえる。二重承認は「宿泊券とキャッシュバックの二重付与」
  --   に直結するため、アプリ側の存在チェックだけでは足りない。
  SELECT * INTO app
  FROM   public.membership_applications
  WHERE  application_id = p_application_id
  FOR UPDATE;

  IF app.application_id IS NULL THEN
    RAISE EXCEPTION '対象の申請が見つからない: %', p_application_id USING ERRCODE = 'P0002';
  END IF;

  IF app.status = '承認済み' THEN
    -- 冪等にはしない。**黙って成功を返すと二重承認に気づけない**（付与は取り消せない）。
    RAISE EXCEPTION 'この申請は既に承認済みである' USING ERRCODE = '42501';
  END IF;

  IF app.status = '却下' THEN
    RAISE EXCEPTION '却下済みの申請は承認できない' USING ERRCODE = '42501';
  END IF;

  IF app.payment_method IS NULL OR app.paid_at IS NULL THEN
    -- v13 §5.10.4「現金は受領記録、QRは入金確認が承認の前提になる」。
    RAISE EXCEPTION '決済手段と受領日時を記録してから承認すること（v13 §5.10.4）'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO plan
  FROM   public.membership_plans
  WHERE  plan_id = app.plan_id;

  -- ── 2. 申請を承認済みにする（§5.10.4 Step 5）─────────────────────────
  --   `0037` のガードトリガーが admin 以外の UPDATE を拒否するため、
  --   ここでも申告した操作者が admin であることが二重に効く。
  PERFORM set_config('app.operator_id', p_operator_id::text, true);

  UPDATE public.membership_applications
  SET    status               = '承認済み',
         approved_at          = now(),
         payment_confirmed_by = coalesce(payment_confirmed_by, p_operator_id),
         role_upgraded_at     = now(),
         stay_tickets_granted_at = now()
  WHERE  application_id = p_application_id;

  -- ── 3. 昇格（§5.10.5 ①）──────────────────────────────────────────
  --   ★ ゲストのときだけ上げる。既に `member` 以上の会員を書き換えない
  --   （運営が誤って自分や既存会員の申請を承認しても権限が下がらない）。
  SELECT m.role INTO target_role
  FROM   public.members m
  WHERE  m.member_id = app.member_id;

  IF target_role = 'guest' THEN
    -- `0003` のガードが要求する2つの申告。理由は監査台帳
    -- （`member_role_changes`）へそのまま残る（同マイグレーションの AFTER トリガー）。
    PERFORM set_config('app.change_reason',
                       '街人登録の承認（申請 ' || p_application_id::text || '）', true);

    UPDATE public.members
    SET    role = 'member'
    WHERE  member_id = app.member_id;
  END IF;

  -- ── 4. 宿泊券の付与（§5.10.5 ② ／ 種別は「街人登録による付与」）────────
  --   ★ 枚数は `membership_plans` から取る（v13 §7「コードに直書きしない」）。
  --   0 泊のプランでは行を作らない（`0016` の CHECK が 0 を弾くため）。
  IF coalesce(plan.granted_stay_nights, 0) > 0 THEN
    INSERT INTO public.stay_ticket_transactions
      (member_id, tx_type, nights, reason, operator_id)
    VALUES
      (app.member_id, 'plan_grant', plan.granted_stay_nights,
       '街人登録による付与（' || coalesce(plan.display_name, '') || '）', p_operator_id);
  END IF;

  -- ── 5. 登録キャッシュバックの起票（§5.10.5 ② の 2026-08-29 改訂 ／ §5.3.1）──
  --   ★ **発行そのものはしない。** `未送付`（＝発行依頼）で積み、運営が eumo で発行して
  --   `送付済` → `受領確認済` と進める。単位は uii（円ではない ／ §9 #51）。
  IF coalesce(plan.first_cashback_uii, 0) > 0 THEN
    INSERT INTO public.eumo_grants
      (member_id, amount_uii, grant_type, purpose, status)
    VALUES
      (app.member_id, plan.first_cashback_uii, 'registration_cashback',
       '街人登録キャッシュバック（' || coalesce(plan.display_name, '') || '）', '未送付');
  END IF;
END;
$$;

COMMENT ON FUNCTION public.approve_membership_application(uuid, uuid) IS
  '街人登録の承認（v13 §5.10.4 Step 5・§5.10.5）。申請の承認・role 昇格・宿泊券付与・'
  'キャッシュバック起票を1トランザクションで行う。★ 分割すると「権限は上がったが宿泊券が無い」'
  '「申込中のまま付与済み」が残り、後者は二重付与に直結する。service_role からのみ呼べる。';

-- 既定では PUBLIC に EXECUTE が付く。認証済み利用者から呼べると
-- 「操作者を自由に申告して自分を昇格させる」入口になるため、必ず剥がす（`0004` と同じ）。
REVOKE EXECUTE ON FUNCTION public.approve_membership_application(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_membership_application(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_membership_application(uuid, uuid) FROM authenticated;
