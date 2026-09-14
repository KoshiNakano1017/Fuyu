-- =============================================================================
-- 0002_members_auth_helpers.sql
--
-- RLS ヘルパ関数（行の可視性を判定する）と、操作者特定関数（誰が操作したかを判定する）。
-- WBS 2-1。
--
-- 根拠: DB物理設計.md §6-2①（ヘルパ関数4本と EXECUTE の限定）／§6-3（方式選定）
--       ／§6-6b②（current_operator_id()）、正本 v13 §5.9.3（認可は role のみで判定する）。
--
-- いずれも SECURITY DEFINER ＋ `SET search_path = ''` で定義する。
-- search_path を空にするのは乗っ取り防止の必須作法（§6-3）であり、
-- その代わり関数本体のオブジェクト参照はすべてスキーマ修飾する。
--
-- ⚠️ ポリシー本体（CREATE POLICY）は WBS 2-2。本ファイルは関数と実行権限だけを置く。
-- =============================================================================


-- 現在のセッションに対応する members.member_id を返す。未登録・退会済みなら NULL。
CREATE OR REPLACE FUNCTION public.current_member_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.member_id
  FROM   public.members m
  WHERE  m.auth_user_id = auth.uid()
    AND  m.account_status <> 'withdrawn'
$$;

-- 現在のセッションの role（members.role）を返す。v13 §5.9.3：認可は role のみで判定する。
CREATE OR REPLACE FUNCTION public.current_member_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.role
  FROM   public.members m
  WHERE  m.auth_user_id = auth.uid()
    AND  m.account_status <> 'withdrawn'
$$;

CREATE OR REPLACE FUNCTION public.is_staff()      -- admin または core_member
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.current_member_role() IN ('admin', 'core_member') $$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.current_member_role() = 'admin' $$;


-- =============================================================================
-- 操作者の特定（DB物理設計 §6-6b②）
--
--   current_member_id() と分けてあるのは目的が違うため。
--   あちらは「行が見えるか」を判定するので退会済みを除外するが、
--   こちらは「誰が操作したか」を記録・判定するので account_status で絞らない。
--   兼用すると、片方の都合で条件を変えたときに他方が壊れる。
-- =============================================================================

-- 操作者を特定する。特定できなければ NULL を返す（拒否の判断は呼び出し側で行う）。
CREATE OR REPLACE FUNCTION public.current_operator_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  session_operator  uuid;
  declared_operator uuid;
BEGIN
  -- 経路①：ログインセッション。auth.uid() は JWT 由来であり、クライアントから詐称できない。
  SELECT m.member_id INTO session_operator
  FROM   public.members m
  WHERE  m.auth_user_id = auth.uid();

  -- 経路②：service_role。auth.uid() が NULL になるため、呼び出し側の申告を読む。
  BEGIN
    declared_operator := nullif(btrim(coalesce(current_setting('app.operator_id', true), '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.operator_id が uuid として解釈できない' USING ERRCODE = '22023';
  END;

  IF session_operator IS NOT NULL THEN
    -- 両方あって食い違う ＝ 他人になりすまそうとしている。安全側に倒して拒否する。
    IF declared_operator IS NOT NULL AND declared_operator <> session_operator THEN
      RAISE EXCEPTION 'app.operator_id (%) がログインセッションの会員 (%) と一致しない',
        declared_operator, session_operator USING ERRCODE = '42501';
    END IF;
    RETURN session_operator;
  END IF;

  RETURN declared_operator;   -- NULL になりうる。呼び出し側で拒否する
END;
$$;


-- =============================================================================
-- 実行権限：authenticated に限定する。anon から呼べる必要はない。
--
--   ⚠️ PUBLIC からの REVOKE を忘れると、anon も PUBLIC 経由で実行できてしまう。
-- =============================================================================

REVOKE EXECUTE ON FUNCTION
  public.current_member_id(), public.current_member_role(),
  public.is_staff(), public.is_admin(), public.current_operator_id()
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION
  public.current_member_id(), public.current_member_role(),
  public.is_staff(), public.is_admin(), public.current_operator_id()
  TO authenticated;
