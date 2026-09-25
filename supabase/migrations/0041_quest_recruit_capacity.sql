-- =============================================================================
-- 0041_quest_recruit_capacity.sql — 受注申請を募集人数の範囲で閉じる
--
--   WBS  : 5-2（受注申請・運営審査・実行指示 ／ Issue #167）
--   根拠 : 正本 v13 §5.3 note L844「1クエスト＝運営が指定した**募集人数の範囲で**受注可」、
--          v13 §5.9.3（サーバサイド認可・二重防御。DOM 非表示は認可ではない）、
--          `0007_quests_schema.sql` L73-74（`recruit_count`）、
--          `0017_quest_applications_and_work_logs.sql` L46-48（`member_id` 列コメント
--          「1クエストに複数行を許容する（上限は `quests.recruit_count`）」）
--   含む : 枠の数え方を1箇所に置く関数 ／ BEFORE INSERT の上限ガード ／
--          `v_quest_board` への判定材料2列の追加
--   含まない: 画面・API（同パッケージのアプリ層）／完了報告以降の遷移（5-3・5-4・5-6）
--
-- ── なぜ DB 側にも上限を置くのか ────────────────────────────────────
--
-- `quest_applications` の SELECT は `_select_self` / `_select_staff` しか無い（`0017` L367-374）。
-- **一般会員のセッションからはそのクエストの申請件数を数えられない**（自分の行しか返らない）ため、
-- 「アプリで数えてから判定する」だけでは上限を知る手段が無い。加えて `service_role` は
-- RLS も GRANT も迂回するので、アプリ層の判定は最後の砦になれない。
-- 審査ガード（`quest_applications_guard_review()`）を DB 側に置いたのと同じ事情である。
--
-- ── 同時申請の競合を止める ──────────────────────────────────────────
--
-- 数える前に対象の `quests` 行を `FOR UPDATE` で押さえる。押さえないと、2人が同時に
-- 最後の1枠へ入ったとき双方のトリガーが「まだ空きがある」と読んで両方通る。
-- =============================================================================


-- =============================================================================
-- ① 枠を占有する受注申請の数え方（ビューとトリガーが同じ規則を見るための1箇所）
--
--   占有するのは `申請中` / `指示済み` / `承認` / `完了`。
--   `差戻し` / `キャンセル` は受注が成立していないため数えない（`0017` L79 の
--   「取り下げは status = 'キャンセル'」。取り下げた人の枠を抱えたまま閉じると、
--   募集人数の範囲で受注可という §5.3 note の運用そのものが止まる）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quest_occupied_application_count(p_quest_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER   -- 呼び出し元（一般会員）は他人の申請行を SELECT できない。件数だけを返す
SET search_path = ''
AS $$
  SELECT count(*)::integer
  FROM   public.quest_applications a
  WHERE  a.quest_id = p_quest_id
    AND  a.status IN ('申請中', '指示済み', '承認', '完了');
$$;

COMMENT ON FUNCTION public.quest_occupied_application_count(uuid) IS
  '募集枠を占有している受注申請の件数（v13 §5.3 note L844）。差戻し・キャンセルは数えない。'
  '件数だけを返し、誰が申請したか（PII-B）は返さない。上限判定はこの関数を唯一の根拠にする。';

REVOKE EXECUTE ON FUNCTION public.quest_occupied_application_count(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.quest_occupied_application_count(uuid) TO authenticated;


-- =============================================================================
-- ② 上限ガード（AFTER INSERT）
--
-- ── なぜ BEFORE ではなく AFTER なのか ──────────────────────────────────
--
-- Postgres は BEFORE ROW トリガー → 一意制約・RLS の WITH CHECK → AFTER ROW トリガー
-- の順に評価する。BEFORE に置くと、**本来は別の理由で拒否される操作**が
-- 「枠が無い」として返ってしまう:
--   - 他人名義の受注申請（`_insert_self` の WITH CHECK ／ 42501）
--   - 同じ人の2件目（`uq_quest_app_per_member` ／ 23505。アプリはこれを
--     「すでに申請済み」として伝える必要がある＝完了条件 A7 後半）
-- 枠の判定は**最後に**行う。AFTER なので自分の行も数に入る（比較が `>` になる）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quest_applications_guard_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  recruit_limit  integer;
  occupied_count integer;
BEGIN
  -- 数える前に枠の持ち主を押さえる。この順序でなければ競合を止められない。
  -- READ COMMITTED では、ロックを待たされた側が待機解除後に最新の行を読み直すため、
  -- 続く count は先行トランザクションの申請を数に入れる。
  SELECT q.recruit_count INTO recruit_limit
  FROM   public.quests q
  WHERE  q.quest_id = NEW.quest_id
  FOR UPDATE;

  occupied_count := public.quest_occupied_application_count(NEW.quest_id);

  -- `>` で書く（自分の行を含む件数と比べる）。`=` で書くと、既に溢れているクエスト
  -- （運用ミス・`recruit_count` の引き下げで起こりうる）にだけ枠が開く。
  IF occupied_count > recruit_limit THEN
    -- 認可違反の 42501（`quest_applications_guard_review()`）とは別の SQLSTATE にする。
    -- アプリ側が「権限が無い」と「枠が無い」を取り違えないようにするため。
    RAISE EXCEPTION '受注申請は募集人数の範囲でしか受け付けない（v13 §5.3 note）'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;   -- AFTER トリガーの戻り値は使われない
END;
$$;

COMMENT ON FUNCTION public.quest_applications_guard_capacity() IS
  '受注申請の上限ガード（v13 §5.3 note L844）。quests 行を FOR UPDATE で押さえてから数えるため、'
  '同時申請でも募集人数を超えない。AFTER INSERT なのは、一意制約（23505）と RLS（42501）の'
  '拒否を枠切れで上書きしないため。';

CREATE TRIGGER trg_quest_applications_guard_capacity
  AFTER INSERT ON public.quest_applications
  FOR EACH ROW EXECUTE FUNCTION public.quest_applications_guard_capacity();

COMMENT ON COLUMN public.quest_applications.member_id IS
  '受注者。1クエストに複数行を許容する（上限は quests.recruit_count）。'
  '上限は 0041 の quest_applications_guard_capacity() が DB 側で強制する（v13 §5.3 note L844）。';


-- =============================================================================
-- ③ v_quest_board に判定材料を足す
--
--   アプリ側の判定点は `canApplyToQuest()` 1本のままにする（v13 §5.9.3「二重管理しない」）。
--   そのためには募集人数と占有件数の**両方**が判定関数へ渡る必要があるので、
--   一覧を読む唯一の入口であるこのビューに載せる。
--
--   ⚠️ 新設列は**必ず末尾に置く**。`CREATE OR REPLACE VIEW` は既存列の名前・順序を
--      変えられず、途中へ挿すと 42P16 で落ちる（`0012` ③の記録どおり）。
--
--   ⚠️ ここで返すのは**件数**であって、誰が申請したか（PII-B）ではない。
--      カードへ載せる項目は「タイトル・カテゴリ・施錠状態まで」（v13 §5.10.6 末尾）であり、
--      この2列はクライアントへ渡さない（`src/lib/quests/board.ts` が落とす）。
-- =============================================================================

CREATE OR REPLACE VIEW public.v_quest_board
WITH (security_invoker = false)   -- 0012 ③のまま。件数を数えられるのも所有者権限だからである
AS
SELECT
  q.quest_id,
  q.title,
  q.category_id,
  q.origin_type,
  q.execution_mode,
  q.required_certification,
  q.guest_allowed,
  q.status,
  q.created_at,

  CASE WHEN (public.current_member_role() = 'guest' AND NOT q.guest_allowed)
         OR (NOT public.is_staff() AND q.core_only_reward)
       THEN NULL ELSE q.reward_uii  END AS reward_uii,
  CASE WHEN (public.current_member_role() = 'guest' AND NOT q.guest_allowed)
         OR (NOT public.is_staff() AND q.core_only_reward)
       THEN NULL ELSE q.description END AS description,

  q.core_only_reward,

  -- ▼ 0041 追加（末尾）。受注申請の可否判定の材料。
  q.recruit_count,
  public.quest_occupied_application_count(q.quest_id) AS application_count
FROM public.quests q;

COMMENT ON VIEW public.v_quest_board IS
  'クエストボード用。報酬額・指示内容は (a) ゲスト×施錠中、(b) core_only_reward×非スタッフ、'
  'のいずれかで NULL を返す（v13 §5.10.6）。行は隠さない。security_invoker=false は意図的'
  '（0012 で0008から反転）。recruit_count / application_count は受注申請の可否判定の材料であり'
  '（0041 ／ v13 §5.3 note）、件数のみで申請者は返さない。担当者の列を足すときも同じ CASE を通すこと。';
