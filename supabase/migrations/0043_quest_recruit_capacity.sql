-- =============================================================================
-- 0043_quest_recruit_capacity.sql — 受注申請を募集人数の範囲で閉じる
--
--   WBS  : 5-2（受注申請・運営審査・実行指示 ／ Issue #167）
--   根拠 : 正本 v13 §5.3 note L844「1クエスト＝運営が指定した**募集人数の範囲で**受注可」、
--          v13 §5.9.3（サーバサイド認可・二重防御。DOM 非表示は認可ではない）、
--          `0007_quests_schema.sql` L73-74（`recruit_count`）、
--          `0017_quest_applications_and_work_logs.sql` L46-48（`member_id` 列コメント
--          「1クエストに複数行を許容する（上限は `quests.recruit_count`）」）
--   含む : 枠の数え方を1箇所に置く関数 ／ INSERT・UPDATE の上限ガード ／
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
-- 数える前に対象の `quests` 行を `FOR NO KEY UPDATE` で押さえる。押さえないと、2人が同時に
-- 最後の1枠へ入ったとき双方のトリガーが「まだ空きがある」と読んで両方通る。
--
-- ロックの強さは `FOR UPDATE` ではなく `FOR NO KEY UPDATE` にする。
-- `quest_applications` への INSERT は FK（`quest_id` → `quests`）の検査として
-- 親行に `FOR KEY SHARE` を取る。`FOR UPDATE` はこれと競合するため、
-- 「A が INSERT（KEY SHARE 取得）→ B が INSERT（KEY SHARE 取得）→ 双方の AFTER
-- トリガーが FOR UPDATE を待つ」順で **デッドロック（40P01）** になり、
-- 枠切れとして返すべき 23514 が返らなくなる。
-- `FOR NO KEY UPDATE` は `FOR KEY SHARE` と競合せず、かつ自分自身とは競合するため、
-- 「同時申請を直列化する」という本来の目的だけを満たす。
-- =============================================================================


-- =============================================================================
-- ① 枠を占有する受注申請の数え方（ビューとトリガーが同じ規則を見るための1箇所）
--
--   占有するのは **`キャンセル` 以外の全ステータス**
--   （`申請中` / `指示済み` / `承認` / `差戻し` / `完了`）。
--
-- ── なぜ `差戻し` を占有側に数えるのか ─────────────────────────────
--
--   `差戻し` は v13 §5.3.2 の遷移図では「差戻し → 再提出」であり、**受注そのものは
--   成立したまま**である（`0017` L64-65 の「差戻し後の再提出は `work_logs` を積み直す
--   のであって、申請行を増やさない」も同じ前提に立っている）。枠から外すと、
--   `recruit_count = 1` のクエストで差戻し中の受注者がいる間に別人を受け入れてしまい、
--   しかも `uq_quest_app_per_member`（`0017` L80）により**元の受注者は再申請できない**。
--
--   `キャンセル` だけを外すのは `0017` L79 の「取り下げは status = 'キャンセル'」に従う。
--   取り下げた人の枠を抱えたまま閉じると、募集人数の範囲で受注可という §5.3 note の
--   運用そのものが止まる。
--
--   ⚠️ 「どのステータスが枠を占有するか」は正本 v13 にも `CONSOLIDATED_DECISIONS.md` にも
--      明文が無い。ここでは**溢れさせない側へ倒して**実装し、定義そのものは
--      `QUESTIONS.md`「[2026-09-25] 募集枠を占有する受注申請ステータスの定義」で
--      オーナーの判断を仰いでいる（CLAUDE.md §7）。回答が出たら
--      `quest_application_occupies_slot()` 1本を直せばビューもトリガーも追随する。
--
--   ⚠️ **未決は `差戻し` だけではない。`申請中` を占有に数えてよいかが最大の論点である。**
--      `recruit_count` の既定値は 1（`0007` L73-74）なので、`申請中` を占有に数える本実装では
--      最初の1人が申請した時点で枠が閉じる（＝早い者勝ち）。これは v13 §5.3 項目3 L838
--      「運営側が…指示を出して承認（マッチング成立）」・§6 L2307「クエスト審査・実行指示出し
--      （申請中処理）」が前提とする**運営が複数の申請者から選ぶ**運用と両立しない可能性がある。
--      オーナー判断が出るまで、この規則を**振る舞いの側から変更しない**（設計 §7.1）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.quest_application_occupies_slot(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_status IS DISTINCT FROM 'キャンセル';
$$;

COMMENT ON FUNCTION public.quest_application_occupies_slot(text) IS
  'その受注申請ステータスが募集枠を占有するか（v13 §5.3 note L844）。取り下げ（キャンセル）だけが'
  '占有しない。差戻しは「受注は成立したまま再提出を待つ」状態なので占有する（v13 §5.3.2）。'
  '占有の定義はここ1箇所に置き、ビューとトリガーの両方がこれを見る。';

-- ステータス文字列だけを受け取り、DB の中身を一切読まない純関数なので authenticated に開いてよい。
-- ⚠️ 開く必要がある。**関数の EXECUTE 権限は、security_invoker = false のビュー越しでも
--    呼び出し元のロールで判定される**（ビューの所有者へ委ねられるのはテーブル・列の権限だけ）。
--    ③のビューはこの述語を通るため、剥がすと一覧の SELECT 自体が権限エラーになる。
GRANT EXECUTE ON FUNCTION public.quest_application_occupies_slot(text) TO authenticated;

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
    AND  public.quest_application_occupies_slot(a.status);
$$;

COMMENT ON FUNCTION public.quest_occupied_application_count(uuid) IS
  '募集枠を占有している受注申請の件数（v13 §5.3 note L844）。キャンセルだけを数えない。'
  '件数だけを返し、誰が申請したか（PII-B）は返さない。上限判定はこの関数を唯一の根拠にする。'
  'authenticated へ EXECUTE を与えない（PostgREST の RPC として任意の quest_id で引かれるため）。';

-- ⚠️ authenticated へ GRANT しない。
--   与えると `POST /rest/v1/rpc/quest_occupied_application_count` で任意のクエストの
--   申請件数を直接引ける（③で件数そのものを返さないようにした意味が消える）。
--   呼ぶのは②のトリガー関数（SECURITY DEFINER なので所有者として走り、EXECUTE も所有者で通る）だけ。
--   ③のビューはこの関数を**呼ばない**。関数の EXECUTE 権限はビュー越しでも呼び出し元の
--   ロールで判定されるため、ビューに置くと authenticated へ開かざるを得なくなるからである。
REVOKE EXECUTE ON FUNCTION public.quest_occupied_application_count(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.quest_occupied_application_count(uuid) FROM anon, authenticated;


-- =============================================================================
-- ② 上限ガード（AFTER INSERT ＋ AFTER UPDATE）
--
-- ── なぜ UPDATE も見るのか ─────────────────────────────────────────
--
-- INSERT だけを見ていると、次の経路で募集人数を超えられる:
--   (a) 本人が `キャンセル` → `申請中` へ PATCH で戻す。`quest_applications_update_self`
--       （`0017` L386）が本人の UPDATE を開けており、`quest_applications_guard_review()` は
--       `申請中` / `キャンセル` を本人に許している。`uq_quest_app_per_member` で
--       再 INSERT が塞がっている以上、**再申請の経路は UPDATE しか無い**＝必ず通る道である。
--   (b) 自分の申請行の `quest_id` を満枠の別クエストへ書き換える。`_update_self` の
--       WITH CHECK は `member_id` しか見ていない。
-- どちらも「占有しない状態 → 占有する状態」への遷移として同じ判定に落ちる。
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
  -- 枠を新たに取る操作だけを見る。
  --   - 占有しない状態（キャンセル）で作られた・残る行は枠を取らない
  --   - 既に占有していた行の状態遷移（申請中 → 指示済み 等）は枠を取り直さない。
  --     ここで数え直すと、`recruit_count` を後から引き下げて既に溢れているクエストで
  --     運営の審査・実行指示まで止まる（本来の論点は枠ではなく運用ミスの是正である）
  -- 逆に、別クエストへ付け替える UPDATE は移動先の枠を新たに取るため、見る。
  IF NOT public.quest_application_occupies_slot(NEW.status) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND public.quest_application_occupies_slot(OLD.status)
     AND OLD.quest_id = NEW.quest_id THEN
    RETURN NULL;
  END IF;

  -- 数える前に枠の持ち主を押さえる。この順序でなければ競合を止められない。
  -- READ COMMITTED では、ロックを待たされた側が待機解除後に最新の行を読み直すため、
  -- 続く count は先行トランザクションの申請を数に入れる。
  SELECT q.recruit_count INTO recruit_limit
  FROM   public.quests q
  WHERE  q.quest_id = NEW.quest_id
  FOR NO KEY UPDATE;   -- FK 検査の FOR KEY SHARE と競合させない（冒頭コメント参照）

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
  '受注申請の上限ガード（v13 §5.3 note L844）。quests 行を FOR NO KEY UPDATE で押さえてから数えるため、'
  '同時申請でも募集人数を超えない。AFTER INSERT なのは、一意制約（23505）と RLS（42501）の'
  '拒否を枠切れで上書きしないため。UPDATE も見るのは、キャンセル → 申請中 の戻しと'
  'quest_id の付け替えが、INSERT を通らずに枠を取る経路になるためである。';

CREATE TRIGGER trg_quest_applications_guard_capacity
  AFTER INSERT OR UPDATE ON public.quest_applications
  FOR EACH ROW EXECUTE FUNCTION public.quest_applications_guard_capacity();

COMMENT ON COLUMN public.quest_applications.member_id IS
  '受注者。1クエストに複数行を許容する（上限は quests.recruit_count）。'
  '上限は 0043 の quest_applications_guard_capacity() が DB 側で強制する（v13 §5.3 note L844）。';


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
--   ⚠️ **件数そのものを返さない。** 返すのは「埋まっているか」の真偽値だけである。
--      当初は `application_count`（生の件数）を載せていたが、`v_quest_board` への
--      SELECT は authenticated 全員（ゲストを含む）に開いており（`0008` L121）、
--      `GET /rest/v1/v_quest_board?select=application_count` で全クエストの申請件数を
--      直接読めてしまう。「`board.ts` が落とすから安全」は**画面を経由した場合だけの話**であり、
--      0012 が「DOM 非表示は認可ではない・列は DB 側で落とす」として退けた論法そのものだった。
--      判定に要るのは充足の有無だけなので、DB 側で真偽値まで縮めて渡す。
--      件数が要る運営画面は `quest_applications` を直接読む（`_select_staff` が開いている）。
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

  -- ▼ 0043 追加（末尾）。受注申請の可否判定の材料。
  --   `recruit_count` は 0012 の列単位 GRANT で既に authenticated へ開いている列であり、
  --   ここで新たに見せるものは無い。増えるのは「埋まっているか」の1ビットだけである。
  q.recruit_count,
  -- 件数はここで真偽値へ畳む。`quest_occupied_application_count()` は呼ばない
  -- （関数の EXECUTE 権限はビュー越しでも呼び出し元のロールで判定されるため、
  --   ビューに置くと件数を返す関数を authenticated へ開くことになる）。
  -- `quest_applications` の**テーブル**権限と RLS は security_invoker = false により
  -- ビューの所有者で判定される。件数を数えられるのはそのためである（①と同じ理屈）。
  ((SELECT count(*)
    FROM   public.quest_applications a
    WHERE  a.quest_id = q.quest_id
      AND  public.quest_application_occupies_slot(a.status)) >= q.recruit_count)
    AS is_recruitment_full
FROM public.quests q;

COMMENT ON VIEW public.v_quest_board IS
  'クエストボード用。報酬額・指示内容は (a) ゲスト×施錠中、(b) core_only_reward×非スタッフ、'
  'のいずれかで NULL を返す（v13 §5.10.6）。行は隠さない。security_invoker=false は意図的'
  '（0012 で0008から反転）。recruit_count / is_recruitment_full は受注申請の可否判定の材料であり'
  '（0043 ／ v13 §5.3 note）、申請件数も申請者も返さない。担当者の列を足すときも同じ CASE を通すこと。';
