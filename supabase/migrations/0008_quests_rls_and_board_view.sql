-- =============================================================================
-- WBS 5-1：quests / work_categories の RLS・GRANT と、クエストボード用ビュー
--
-- 根拠: v13 §5.10.6（`guest_allowed = false` は**一覧には表示したうえで施錠表示**。
--         ただし詳細な内容（報酬額・指示内容・担当者情報）はゲストに返さない）、
--       v13 §5.9.3（行単位の制御は RLS。画面ガードと API 認可は同一のロール定義を参照する）、
--       DB物理設計.md §6-6①②・§6-7（anon ゼロ・デフォルト拒否・列単位 GRANT）
--
-- > [!warning] 派生設計と正本が食い違う箇所である（2026-09-19 に報告済み）
-- > `DB物理設計.md` §6-7 の `quests_select_guest` は「ゲストには `guest_allowed = true` の行
-- > **だけ**を見せる」としている。それでは施錠カードも解放件数バナーも成立しない。
-- > `CLAUDE.md` §1.1 により**正本 v13 §5.10.6 が勝つ**ため、ここでは
-- > **行は返し、詳細列をビューで落とす**構成を採る。派生設計側の追随はオーナー判断。
-- =============================================================================


-- =============================================================================
-- ① work_categories：非PII テーブルの共通テンプレート（DB物理設計 §6-7）
--
--   読みは authenticated 全員（ゲストの施錠カードにもカテゴリ名を出すため）。
--   書き込みは admin だけ。カテゴリ体系は 15 業務ドメインの定義そのものであり、
--   現場運用で足し引きするマスタではない。
-- =============================================================================

CREATE POLICY work_categories_select_all ON public.work_categories
  FOR SELECT TO authenticated
  USING ( true );

CREATE POLICY work_categories_write_admin ON public.work_categories
  FOR ALL TO authenticated
  USING       ( (SELECT public.is_admin()) )
  WITH CHECK  ( (SELECT public.is_admin()) );


-- =============================================================================
-- ② quests：**行は隠さない**（v13 §5.10.6）
--
-- ★ ここをロール別に絞ってはならない。
--   施錠クエストの行がゲストに返らないと、
--     - カードに `🔒 街人登録で解放` を重ねられない
--     - 「あと N 件が解放されます」の N を数えられない（＝登録導線そのものが消える）
--   の2つが同時に壊れる。**見せたうえで施錠する**のが本節の設計である。
--
--   ゲストへ返してはいけないのは**行ではなく列**（報酬額・指示内容・担当者情報）であり、
--   RLS は列を絞れない。その役目は ③ の v_quest_board が負う。
-- =============================================================================

CREATE POLICY quests_select_all ON public.quests
  FOR SELECT TO authenticated
  USING ( true );

-- 書き込みは運営のみ。クエストの起案・締切・退役は運営の判断であり、
-- 会員がクライアントから作れてはならない（v13 §5.3-3）。
CREATE POLICY quests_write_staff ON public.quests
  FOR ALL TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );


-- =============================================================================
-- ③ v_quest_board：**列を落とす**ための唯一の関門
--
-- RLS は行にしか効かない。v13 §5.10.6 末尾が求める「施錠クエストの報酬額・指示内容・
-- 担当者情報はゲストに返さない」は、ビューで NULL 化することで DB 側にも置く。
-- アプリ側（`src/lib/quests/board.ts`）でも同じ列を落としており、これは冗長ではなく
-- 二重防御である（v13 §5.9.3）。片方が抜けても詳細が漏れない。
--
-- > [!danger] security_invoker は必ず true にする
-- > false（＝ビュー所有者権限）で作ると quests の RLS を迂回する。
-- > 本ビューは RLS を迂回する目的を持たない。迂回してよいのは
-- > `v_member_public`（0009）のように、露出してよい列だけで構成した場合に限る。
--
-- 担当者情報の列はまだ無い。担当は `quest_applications`（WBS 5-2）が持つため、
-- **5-2 がここへ列を足すときは、同じ CASE でゲストへ NULL を返すこと。**
-- =============================================================================

CREATE VIEW public.v_quest_board
WITH (security_invoker = true)
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
  q.created_at,   -- 一覧の並び順（新しい順）に使う。施錠クエストでも伏せる必要は無い

  -- 施錠されている閲覧者にだけ NULL を返す。判定の根拠は `role` のみであり、
  -- `member_type`（立場）は見ない（v13 §2・CLAUDE.md §4.1）。
  CASE WHEN public.current_member_role() = 'guest' AND NOT q.guest_allowed
       THEN NULL ELSE q.reward_uii  END AS reward_uii,
  CASE WHEN public.current_member_role() = 'guest' AND NOT q.guest_allowed
       THEN NULL ELSE q.description END AS description
FROM public.quests q;

COMMENT ON VIEW public.v_quest_board IS
  'クエストボード用。施錠クエスト（ゲスト × guest_allowed = false）の報酬額・指示内容を NULL で返す'
  '（v13 §5.10.6 末尾）。行は隠さない。担当者の列を足すときも同じ CASE を通すこと。';


-- =============================================================================
-- ④ GRANT（DB物理設計 §6-6②）
--
-- ★ 0005・0006 と同じく、**先に既定の広い権限を剥がしてから**必要分だけ与える。
--   剥がさないと Supabase の既定 GRANT が残り、RLS より手前で素通りする。
--   anon は 0005 の ALTER DEFAULT PRIVILEGES により既定で閉じているが、
--   「この表は anon に開いていない」を読み手に示すため明示的に REVOKE する。
-- =============================================================================

REVOKE ALL ON public.work_categories FROM anon, authenticated;
REVOKE ALL ON public.quests          FROM anon, authenticated;
REVOKE ALL ON public.v_quest_board   FROM anon;

GRANT SELECT                         ON public.work_categories TO authenticated;
GRANT INSERT, UPDATE, DELETE         ON public.work_categories TO authenticated;  -- 行は RLS で admin のみ
GRANT SELECT                         ON public.quests          TO authenticated;
GRANT INSERT, UPDATE, DELETE         ON public.quests          TO authenticated;  -- 行は RLS で staff のみ
GRANT SELECT                         ON public.v_quest_board   TO authenticated;
