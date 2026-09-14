-- =============================================================================
-- 0003_members_guard_triggers.sql
--
-- 「自分自身の権限は、誰も変更できない」を DB 側で強制するトリガー。WBS 2-1。
--
-- 根拠: DB物理設計.md §6-6b③（権限列のガードトリガー）／§6-6b⑤（role 変更の監査記録）、
--       会員データモデル_ユーザーテーブル定義.md §5.2a、正本 v13 §7「★ 権限変更履歴」。
--
-- ⚠️ なぜ列単位 GRANT や RLS ではなくトリガーなのか:
--    service_role は BYPASSRLS を持ち、テーブル権限も全開であるため、ポリシーにも列単位 GRANT にも
--    一切引っかからない。「自分を admin にする」処理を1本書けば通ってしまう。
--    **service_role でも必ず発火する関門はトリガーだけである**（§6-6b の danger）。
--
-- ⚠️ 本トリガーは BEFORE UPDATE のみであり INSERT には掛からない。
--    したがって最初の admin は移行スクリプトの INSERT で作る（ブートストラップ／§6-6b③ の important）。
--    その運用ルール（誰が・どう記録するか）は docs/operations/ 側の論点であり本パッケージの範囲外。
-- =============================================================================


-- =============================================================================
-- 1. 権限列のガード（BEFORE UPDATE ON members）
-- =============================================================================

CREATE OR REPLACE FUNCTION public.members_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER               -- authenticated セッションから発火した際に members を RLS 越しに読まないため
SET search_path = ''
AS $$
DECLARE
  operator_id   uuid;
  change_reason text;
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id THEN
    RAISE EXCEPTION 'member_id は変更できない' USING ERRCODE = '42501';
  END IF;

  -- 権限に関わる列が1つも変わっていなければ何もしない（nickname 更新等の通常経路を素通りさせる）
  IF     NEW.role           IS NOT DISTINCT FROM OLD.role
     AND NEW.auth_user_id   IS NOT DISTINCT FROM OLD.auth_user_id
     AND NEW.account_status IS NOT DISTINCT FROM OLD.account_status
     AND NEW.member_type    IS NOT DISTINCT FROM OLD.member_type
  THEN
    RETURN NEW;
  END IF;

  operator_id := public.current_operator_id();

  -- ★ 安全側の既定：操作者を特定できない権限列の変更は拒否する
  IF operator_id IS NULL THEN
    RAISE EXCEPTION
      '操作者を特定できないため members の権限列を変更できない。service_role 経由の場合は '
      'set_config(''app.operator_id'', <操作者のmember_id>, true) を先に実行すること'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.members m WHERE m.member_id = operator_id) THEN
    RAISE EXCEPTION '申告された操作者 % が members に存在しない', operator_id USING ERRCODE = '42501';
  END IF;

  -- ① role：自分自身の role は誰も変更できない（2026-09-05 オーナー決定）
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF operator_id = OLD.member_id THEN
      RAISE EXCEPTION '自分自身の role は変更できない（% → %）', OLD.role, NEW.role
        USING ERRCODE = '42501';
    END IF;

    change_reason := nullif(btrim(coalesce(current_setting('app.change_reason', true), '')), '');
    IF change_reason IS NULL THEN
      RAISE EXCEPTION
        'role の変更には理由が必須。set_config(''app.change_reason'', <理由>, true) を先に実行すること'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ② auth_user_id：本人ポリシーの根拠そのもの（§5.2a）。自己変更は常に拒否し、付け替えも禁止する
  IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
    IF operator_id = OLD.member_id THEN
      RAISE EXCEPTION '自分自身の auth_user_id は変更できない' USING ERRCODE = '42501';
    END IF;
    IF OLD.auth_user_id IS NOT NULL THEN
      RAISE EXCEPTION '確定済みの auth_user_id は付け替えられない（名寄せの解除は運営手順による）'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ③ account_status：自己変更は退会だけを許す。自力での active 化を禁止する
  IF NEW.account_status IS DISTINCT FROM OLD.account_status
     AND operator_id = OLD.member_id
     AND NOT (OLD.account_status = 'active' AND NEW.account_status = 'withdrawn')
  THEN
    RAISE EXCEPTION '自分自身の account_status は退会（active → withdrawn）以外に変更できない（% → %）',
      OLD.account_status, NEW.account_status USING ERRCODE = '42501';
  END IF;

  -- ④ member_type：立場の自己申告を禁止する
  IF NEW.member_type IS DISTINCT FROM OLD.member_type AND operator_id = OLD.member_id THEN
    RAISE EXCEPTION '自分自身の member_type は変更できない' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_members_guard_privileged_columns
  BEFORE UPDATE ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION public.members_guard_privileged_columns();


-- =============================================================================
-- 2. role 変更の監査記録（AFTER UPDATE OF role ON members）
--
--   記録はアプリの善意ではなくトリガーで行う。アプリが書き忘れても記録が残らなければ意味がない。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.members_log_role_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- operator_id と reason は BEFORE トリガー（1.）が非NULLを保証済み
  INSERT INTO public.member_role_changes (member_id, old_role, new_role, operator_id, reason)
  VALUES (OLD.member_id, OLD.role, NEW.role,
          public.current_operator_id(),
          btrim(current_setting('app.change_reason', true)));
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_members_log_role_change
  AFTER UPDATE OF role ON public.members
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.members_log_role_change();
