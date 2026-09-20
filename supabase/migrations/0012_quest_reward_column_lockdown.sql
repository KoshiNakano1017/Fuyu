-- =============================================================================
-- WBS 5-1 追補：quests の報酬額・指示内容を PostgREST 直アクセスから守る
--
-- 根拠: v13 §5.10.6（2026-09-20 改訂／オーナー確定）、CONSOLIDATED_DECISIONS.md §2
--       「施錠クエストの報酬額・指示内容の可視性を絞る」（2026-09-20）、
--       QUESTIONS.md [2026-09-19] `quests` の RLS が、派生文書ではゲストに
--       `guest_allowed=true` の行だけを見せる（本コミットで解消・派生文書側も追随）。
--
-- ── 見つかった問題（オーナー指摘・2026-09-20） ──────────────────────
-- 0008 は `GRANT SELECT ON public.quests TO authenticated` を無条件に与えていた。
-- `quests_select_all USING (true)` と合わさると、**列マスクを行う `v_quest_board` を
-- 経由せずテーブルを直接 SELECT すれば、`role` に関わらず reward_uii・description が
-- そのまま返る**。PostgREST は `GET /rest/v1/quests?select=reward_uii,description` を
-- そのまま通す。アプリ側（`fetch-board.ts`）が `v_quest_board` しか読まない実装で
-- あることは、この経路を塞がない（ブラウザから直接叩く HTTP クライアントは
-- アプリの実装を経由しない）。
--
-- ── 対処 ────────────────────────────────────────────────────
-- ① `quests.reward_uii` / `quests.description` の SELECT を `authenticated` から剥がす
--    （DB物理設計 §6-6②の列単位GRANTを quests へも適用）。行の可視性
--    （`quests_select_all USING (true)`）は変えない。v13 §5.10.6 が求めるのは
--    「行は見せる・列だけ絞る」であり、列はビュー経由でしか読めない状態にするのが正しい。
-- ② `v_quest_board` を `security_invoker = false`（所有者権限）へ変更する。
--    0008 は「security_invoker は必ず true」としていたが、これは quests の RLS が
--    実際には行を1件も絞っていない（`USING (true)`）ため、当時懸念していた
--    「RLSの迂回」は最初から起きていない。`true` のままだと、①で権限を剥がした
--    直後にビュー自身も reward_uii/description を読めなくなり、CASE 式が
--    「条件に応じてNULLを返す」のではなく **列参照そのものが権限エラーになり
--    全閲覧者に対して失敗する**（列の権限チェックは実行時の分岐ではなく
--    クエリ解析時に行われるため、CASE の ELSE 側が実行されない閲覧者にも波及する）。
--    列を条件付きで伏せる（＝一部の閲覧者には本物の値を返す）には、ビュー側が
--    所有者権限で reward_uii/description を読めることが必須である。
-- ③ v13 §5.10.6（2026-09-20 改訂）に伴い `core_only_reward` フラグを新設する。
--    コアメンバー・管理者が特に機微と判断した施錠クエストに立てるフラグで、
--    true の場合は報酬額・指示内容を**一般会員にも返さない**（従来はゲストのみ対象）。
--    既定は false であり、「一般会員には施錠クエストでも報酬額を返す」という
--    従来の完了条件（`tests/quest-board.test.ts` 完了条件3）はフラグ未設定の
--    クエストでは変わらない。
--
-- ⚠️ 解釈の余地について: オーナー指示は「コアメンバー・管理者がフラグを付けた
--    クエストはコア・管理者のみ閲覧可」だった。「フラグ」を非破壊的な新設フラグ
--    （本カラム）と読み、既存の `guest_allowed` の意味・完了条件3のテストは
--    変更していない。全ての施錠クエストを対象にする趣旨だった場合は、
--    後続の変更で `core_only_reward` の既定値または CASE 条件を広げれば足りる
--    （列単位GRANTと security_invoker=false の構造自体はどちらの解釈でも共通）。
-- =============================================================================


-- =============================================================================
-- ① core_only_reward フラグの新設
-- =============================================================================

ALTER TABLE public.quests
  ADD COLUMN core_only_reward boolean NOT NULL DEFAULT false;

-- guest_allowed = true（ゲストにも開放済み）のクエストに立てると、
-- 「ゲストには見せるが会員には報酬額を見せない」という矛盾した状態になるため禁止する。
ALTER TABLE public.quests
  ADD CONSTRAINT chk_quests_core_only_reward_requires_locked
  CHECK ( NOT core_only_reward OR NOT guest_allowed );

COMMENT ON COLUMN public.quests.core_only_reward IS
  'true の場合、施錠クエスト（guest_allowed=false）の報酬額・指示内容を一般会員にも返さない'
  '（コアメンバー・管理者のみ／v13 §5.10.6 2026-09-20改訂）。guest_allowed=true との併用は'
  '禁止（CHECK制約 chk_quests_core_only_reward_requires_locked）。';


-- =============================================================================
-- ② quests テーブルの列単位 GRANT（DB物理設計 §6-6②の手法を quests へも適用）
--
--   reward_uii・description は authenticated への SELECT から明示的に外す。
--   以後この2列を読めるのは `v_quest_board`（所有者権限）を経由した場合だけになる。
-- =============================================================================

REVOKE SELECT ON public.quests FROM authenticated;

GRANT SELECT (
  quest_id, title, category_id, difficulty, base_hours, recruit_count, place_id,
  origin_type, execution_mode, required_certification, guest_allowed,
  core_only_reward, status, created_by, created_at, updated_at
) ON public.quests TO authenticated;

-- reward_uii・description は意図的に含めない。書き込み（INSERT/UPDATE/DELETE）は
-- 0008 のとおり quests_write_staff（RLS）に委ねる。書き込み権限に SELECT は
-- 必須ではない（Postgres は INSERT/UPDATE と SELECT の権限を列ごとに独立管理する）。
--
-- ★ 将来 `POST /api/quests` を実装するとき注意: staff の書き込みで
-- `Prefer: return=representation`（Supabase JS の `.select()` 連結）を使い
-- reward_uii/description を含めて返そうとすると、`quests` テーブルからは
-- 権限エラーになる。作成直後の値はクライアントが送信済みの値をそのまま表示するか、
-- `v_quest_board` を read-back すること（staff は is_staff() 経路で実値が返る）。


-- =============================================================================
-- ③ v_quest_board を再定義：security_invoker = false ＋ core_only_reward を反映
--
-- ⚠️ 0008 の「security_invoker は必ず true」を本コミットで反転する。
--   理由は本ファイル冒頭コメント②のとおり。quests の行レベルポリシーは
--   `USING (true)` で実質的な行フィルタを持たないため、迂回して問題になる
--   「行」が無い。迂回が意味を持つのは列（reward_uii・description）だけであり、
--   それはこのビューが唯一マスクを実装する場所である（迂回＝このビューの目的そのもの）。
-- =============================================================================

CREATE OR REPLACE VIEW public.v_quest_board
WITH (security_invoker = false)   -- ★ 0008 から反転。理由は本ファイル冒頭コメント②を参照
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

  -- 詳細（報酬額・指示内容）を伏せる条件は2つある。いずれかを満たせば NULL。
  --   (a) ゲスト かつ 施錠中（従来どおり／v13 §5.10.6 冒頭）
  --   (b) スタッフ以外 かつ core_only_reward（新設／v13 §5.10.6 2026-09-20改訂）
  -- スタッフ（admin/core_member）は (a)(b) いずれの条件にも該当しないため常に実値を見る。
  CASE WHEN (public.current_member_role() = 'guest' AND NOT q.guest_allowed)
         OR (NOT public.is_staff() AND q.core_only_reward)
       THEN NULL ELSE q.reward_uii  END AS reward_uii,
  CASE WHEN (public.current_member_role() = 'guest' AND NOT q.guest_allowed)
         OR (NOT public.is_staff() AND q.core_only_reward)
       THEN NULL ELSE q.description END AS description,

  -- ⚠️ 新設列は**必ず末尾に置く**。`CREATE OR REPLACE VIEW` は既存列の名前・順序を
  --    変えられず、途中へ挿すと `cannot change name of view column "status" to
  --    "core_only_reward"`（SQLSTATE 42P16）で落ちる。読みやすさのために
  --    `guest_allowed` の隣へ置きたくなるが、それをやるならビューの DROP が要り、
  --    0008 の GRANT/REVOKE を張り直す必要が出る（同じ結果に対して手数が増えるだけ）。
  q.core_only_reward
FROM public.quests q;

COMMENT ON VIEW public.v_quest_board IS
  'クエストボード用。報酬額・指示内容は (a) ゲスト×施錠中、(b) core_only_reward×非スタッフ、'
  'のいずれかで NULL を返す（v13 §5.10.6）。行は隠さない。security_invoker=false は意図的'
  '（0012 で0008から反転。理由はこのマイグレーション冒頭コメント）。'
  '担当者の列を足すときも同じ CASE を通すこと。';

-- GRANT は 0008 のまま変わらない（v_quest_board 自体への SELECT は authenticated 全員。
-- anon には従来どおり与えない）。
