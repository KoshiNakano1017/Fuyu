-- =============================================================================
-- WBS 5-2（受注申請・運営審査・実行指示）／5-3（完了報告）／5-4（日次承認・差戻し）
--   ／5-6（クエスト承認の二段階化）
--
-- 根拠: v13 §5.3-2〜§5.3-6、v13 §5.3.2（★ 二段階化・遷移図・4つの確定論点）、
--       v13 §6 権限マトリクス L2147（最終承認は admin のみ）、v13 §7 L2407（申請ステータスの列挙）、
--       `DB物理設計.md` §3-1 L147-217（本ファイルの DDL の出どころ）、
--       `API設計.md` §2-4 L133-145（`/api/quest-applications/{id}/work-logs` 等の対応DB）、
--       `0007_quests_schema.sql` L12（「quest_applications（受注申請の台帳）→ WBS 5-2」）
--
-- ── 表の分け方は `DB物理設計.md` §3-1 に従う ─────────────────────
--   `quest_applications`（受注申請）／`work_logs`（完了報告＋二段階承認）／
--   `work_log_reviews`（2人目以降の確認ログ）の3表構成。
--   ★ 名前を変えてはならない。`API設計.md` §2-4 のエンドポイントと
--     `eumo_grants.log_id`（§3-8）が `work_logs` を名指しで参照している。
--
-- ── 正本と派生設計の食い違いを、正本側へ寄せて解消する（CLAUDE.md §1.1）──
--   `DB物理設計.md` L151-152 の `quest_applications.status` CHECK には **`指示済み` が無い**。
--   しかし正本 v13 §5.3.2 L836 の遷移図と §7 L2407 の列挙はどちらも `指示済み` を含み、
--   WBS `5-2` の内容欄も「運営による審査・指示」である。**正本が勝つ**ため `指示済み` を加える。
--   あわせて §5.3-3 が要求する「いつ・どこで・何を」の指示内容の列を足す
--   （派生設計の DDL には `reviewed_by` / `reviewed_at` しか無く、指示の中身を保存できなかった）。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : 上記3表 ／ 遷移ガードのトリガー ／ RLS ／ GRANT
--   含まない:
--     - 画面・Server Action                       → 同パッケージのアプリ層（別コミット）
--     - Eumo給付（`eumo_grants`）と XP 付与        → 0019（WBS 5-5）
--     - Before/After 写真の実体（署名付きURL基盤） → WBS 1-4 ／ `media_assets` は WBS 2-1c
--
-- ⚠️ `QUESTIONS.md`「[2026-09-20] WBS `5-2` の完了条件と、`5-3`・`5-6` との範囲の切れ目」は
--    未回答だが、論点は**どこまでを `5-2` で作るか**であって、作るもの自体（表・遷移・権限）は
--    v13 §5.3.2 と §6 で確定している。選択肢 A/B/C のどれを選んでも本 DDL は変わらない。
-- =============================================================================


-- =============================================================================
-- ① quest_applications（受注申請）— DB物理設計 §3-1 L147-160 ＋ 正本による補正
-- =============================================================================

CREATE TABLE public.quest_applications (
  application_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  quest_id           uuid NOT NULL REFERENCES public.quests (quest_id) ON DELETE CASCADE,

  -- 受注者。v13 §5.3 の「1クエスト＝募集人数の範囲で受注可・報酬は均等割り」に従い、
  -- 1クエストに複数行を許容する（上限は `quests.recruit_count`）。
  member_id          uuid NOT NULL REFERENCES public.members (member_id),

  -- ★ 正本 v13 §7 L2407 の列挙に合わせる。
  --   派生設計（DB物理設計 L151-152）に無かった **`指示済み` を加えている**。
  --   `報告済み` 以降のステージは `work_logs.approval_status` が持つ（§3-1 の分担）。
  --   本表は「マッチングが成立したか」までを表す。
  status             text NOT NULL DEFAULT '申請中'
                       CONSTRAINT chk_quest_app_status
                       CHECK (status IN ('申請中', '指示済み', '承認', '差戻し', '完了', 'キャンセル')),

  applied_at         timestamptz NOT NULL DEFAULT now(),

  reviewed_by        uuid REFERENCES public.members (member_id),
  reviewed_at        timestamptz,

  -- ▼ 実行指示の中身（v13 §5.3-3「いつ・どこで・何を任せるか」）。
  --   派生設計には「誰が審査したか」しか無く、**指示そのものを保存できなかった**。
  --   受注者は指示を見て現場へ行くため、保存先が無いと運用が成立しない。
  scheduled_start_at timestamptz,   -- いつ
  instruction_place  text,          -- どこで
  instruction_body   text,          -- 何を

  -- Phase1 は募集人数内で均等割り（按分ロジックは Phase 2／v13 §5.3 note）。
  reward_uii_actual  integer
                       CONSTRAINT chk_quest_app_reward_non_negative
                       CHECK (reward_uii_actual IS NULL OR reward_uii_actual >= 0),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- 同じ人が同じクエストへ二重に申請できない。
  -- 差戻し後の再提出は `work_logs` を積み直すのであって、申請行を増やさない。
  CONSTRAINT uq_quest_app_per_member UNIQUE (quest_id, member_id),

  -- `指示済み` 以降には審査者が要る（v13 §6：審査・指示は admin / core_member のみ）。
  CONSTRAINT chk_quest_app_reviewed_has_operator CHECK (
    reviewed_at IS NULL OR reviewed_by IS NOT NULL
  )
);

COMMENT ON TABLE public.quest_applications IS
  '受注申請（v13 §5.3-2・§5.3-3 ／ DB物理設計 §3-1）。status は「マッチングが成立したか」まで。'
  '報告済み以降の審査ステージは work_logs.approval_status が持つ。'
  '派生設計の CHECK に無かった 指示済み を正本 v13 §7 に合わせて加えている（CLAUDE.md §1.1）。';

COMMENT ON COLUMN public.quest_applications.reward_uii_actual IS
  '確定支払Uii額。quests.reward_uii（募集時の提示額）とは別物であり、提示額を上書きしてはならない'
  '（他の受注者の提示額まで動くため）。Phase 1 は募集人数内で均等割り（按分は Phase 2）。';

CREATE INDEX ix_quest_app_quest  ON public.quest_applications (quest_id);
CREATE INDEX ix_quest_app_member ON public.quest_applications (member_id, applied_at DESC);


-- =============================================================================
-- ② work_logs（完了報告 ＋ 二段階承認）— DB物理設計 §3-1 L162-194
--
--   ★ 1申請に **複数行**を許す。差戻し → 再提出を別行として積み、
--     「何を直して再提出したか」が残る（上書きすると差戻しの経緯が消える）。
-- =============================================================================

CREATE TABLE public.work_logs (
  log_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  application_id        uuid NOT NULL REFERENCES public.quest_applications (application_id) ON DELETE CASCADE,
  member_id             uuid NOT NULL REFERENCES public.members (member_id),
  quest_id              uuid NOT NULL REFERENCES public.quests (quest_id),

  worked_at             timestamptz NOT NULL DEFAULT now(),
  work_hours            numeric
                          CONSTRAINT chk_worklog_hours_positive
                          CHECK (work_hours IS NULL OR work_hours > 0),

  -- ★ Before / After 写真（v13 §5.3-4「Before / After 写真 mandatory」）。
  --   ⚠️ 参照先の `media_assets` は**まだ存在しない**（WBS 2-1c ／ `QUESTIONS.md`
  --      「[2026-09-20] `media_assets` の列構成が…食い違う」が未回答でブロック中）。
  --      `0006` が `rooms.place_id` に対して取ったのと同じ方針で、**FK は張らず値だけ持つ**。
  --      `media_assets` を作る作業パッケージが次の ALTER を足すこと:
  --
  --        ALTER TABLE public.work_logs
  --          ADD CONSTRAINT fk_worklog_before_photo
  --          FOREIGN KEY (before_photo_media_id) REFERENCES public.media_assets (media_id);
  --        （after も同様）
  --
  --   **NOT NULL にしない。** 写真基盤（WBS 1-4）が入る前に報告行が作れなくなるうえ、
  --   「写真必須」はアプリ層のバリデーションで担保できる（DB で縛ると 1-4 完了まで 5-3 が死ぬ）。
  before_photo_media_id uuid,
  after_photo_media_id  uuid,

  notes                 text,

  -- トラブル・失敗発生フラグ。RAG の failure_patterns 連携の起点（DB物理設計 §3-1）。
  issue_flag            boolean NOT NULL DEFAULT false,
  issue_note            text,

  -- ▼ 二段階承認（v13 §5.3.2 ／ §9 #34）
  approval_status       text NOT NULL DEFAULT '報告済み'
                          CONSTRAINT chk_worklog_approval_status
                          CHECK (approval_status IN ('報告済み', 'コアメンバー確認済', '承認完了', '差戻し')),

  -- ★ 確認者（1人目の確認で遷移する）と承認者を**別カラム**で保持する。
  --   統合すると「確認なしで承認されたのか、確認者と承認者が同じ人だったのか」を
  --   区別できなくなる（DB物理設計 §3-1 の不可侵注記 ／ v13 §5.3.2）。
  reviewed_by           uuid REFERENCES public.members (member_id),
  reviewed_at           timestamptz,

  -- 管理者が確認を飛ばして直接承認した場合 true（v13 §5.3.2「ログに残す」）。
  -- 常態化しているかどうかが運用の健全性の指標になるため、一覧で絞れる列として持つ。
  review_skipped        boolean NOT NULL DEFAULT false,

  -- ★ 最終承認者。**admin のみ**（v13 §5.3.2・§6 L2147）。強制はトリガー（下の ④）。
  approved_by           uuid REFERENCES public.members (member_id),
  approved_at           timestamptz,

  rejected_by           uuid REFERENCES public.members (member_id),
  rejected_at           timestamptz,
  rejection_reason      text,

  created_at            timestamptz NOT NULL DEFAULT now(),

  -- 差戻しには必ず理由を伴う（v13 §5.3.2「理由の入力を必須とし、受注者へ通知する」）。
  -- 派生設計は `IS NOT NULL` だけだったが、空白文字列で抜けられるため btrim で締める。
  CONSTRAINT ck_worklog_rejection_reason CHECK (
    approval_status <> '差戻し'
    OR (btrim(coalesce(rejection_reason, '')) <> '' AND rejected_by IS NOT NULL)
  ),

  -- 承認完了には承認者が要る。承認者なしで給付予定を起票できてしまうのを防ぐ（§5.3.1）。
  CONSTRAINT ck_worklog_approved_has_operator CHECK (
    approval_status <> '承認完了' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),

  CONSTRAINT ck_worklog_reviewed_has_operator CHECK (
    reviewed_at IS NULL OR reviewed_by IS NOT NULL
  )
);

COMMENT ON TABLE public.work_logs IS
  '完了報告と二段階承認（v13 §5.3-4・§5.3.2 ／ DB物理設計 §3-1）。'
  '確認者（reviewed_by）と承認者（approved_by）を同一カラムに統合してはならない。'
  '差戻し後の再提出は同じ申請に対する別行として積む（上書きしない）。'
  '最終承認は admin のみ。強制は RLS ではなくトリガー（service_role が RLS を迂回するため）。';

CREATE INDEX ix_worklog_application ON public.work_logs (application_id, created_at DESC);
CREATE INDEX ix_worklog_issue       ON public.work_logs (issue_flag) WHERE issue_flag = true;

-- 日次承認サイクル（WBS 5-4）の作業待ち行列。運営が毎日開く一覧がこの索引で引ける。
CREATE INDEX ix_worklog_pending ON public.work_logs (approval_status)
  WHERE approval_status IN ('報告済み', 'コアメンバー確認済');


-- =============================================================================
-- ③ work_log_reviews（2人目以降の確認ログ）— DB物理設計 §3-1 L196-205
--
--   v13 §5.3.2「1人目の確認で `コアメンバー確認済` へ遷移する。全員の承認は求めない。
--   2人目以降の確認は追加の確認ログとして記録する」。
-- =============================================================================

CREATE TABLE public.work_log_reviews (
  review_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  log_id      uuid NOT NULL REFERENCES public.work_logs (log_id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES public.members (member_id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  comment     text,

  -- 同一人物の二重確認は記録しない（DB物理設計 §3-1）。
  CONSTRAINT uq_worklog_review_reviewer UNIQUE (log_id, reviewer_id)
);

COMMENT ON TABLE public.work_log_reviews IS
  '2人目以降のコアメンバー確認ログ（v13 §5.3.2）。1人目の確認は work_logs.reviewed_by が持つ。'
  '★ 本表に _select_self を作らない（評価コメントを被評価者に見せない／DB物理設計 §6-7）。';

CREATE INDEX ix_worklog_review_log ON public.work_log_reviews (log_id);


-- =============================================================================
-- ④ 遷移ガード（トリガー）
--
-- > [!danger] なぜ RLS ではなくトリガーで守るのか
-- > `DB物理設計.md` §6-6b が members について示したのと同じ理由である。
-- > **`service_role` は RLS も GRANT も迂回する。** サーバ側の実装が1箇所でも
-- > `createAdminSupabaseClient()` を使って UPDATE すれば、「最終承認は admin のみ」は素通りする。
-- >
-- > また RLS の `UPDATE ... USING (is_staff())` だけでは、**`core_member` が
-- > `approved_by` を書いて `承認完了` にできてしまう**（行は見えるので通る）。
-- > 列単位 GRANT でも防げない（`core_member` と `admin` は同じ `authenticated` ロールである）。
-- > 判定に**呼び出した人の role** が要る以上、トリガーが唯一の場所になる。
-- =============================================================================

-- 操作者の role を1箇所で引く。ログインセッション経路と service_role 経路の両方に効かせる。
CREATE OR REPLACE FUNCTION public.current_actor_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role text;
BEGIN
  -- 経路①：ログインセッション（auth.uid() 由来。クライアントから詐称できない）
  actor_role := public.current_member_role();
  IF actor_role IS NOT NULL THEN
    RETURN actor_role;
  END IF;

  -- 経路②：service_role。auth.uid() が NULL になるため申告された操作者から引く。
  -- current_operator_id() は申告とセッションの食い違いを検出して 42501 を投げる（0002）。
  SELECT m.role INTO actor_role
  FROM   public.members m
  WHERE  m.member_id = public.current_operator_id();

  RETURN actor_role;   -- NULL になりうる。拒否の判断は呼び出し側で行う
END;
$$;

COMMENT ON FUNCTION public.current_actor_role() IS
  '操作者の role。ログインセッション優先、service_role 経路は app.operator_id の申告から引く。'
  'is_staff() と違い service_role 経由でも判定できる点が要（トリガーから使うため）。';

REVOKE EXECUTE ON FUNCTION public.current_actor_role() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_actor_role() TO   authenticated;


CREATE OR REPLACE FUNCTION public.work_logs_guard_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role text;
BEGIN
  -- 承認ステージが動かない UPDATE（notes の推敲等）は本ガードの対象外。
  IF TG_OP = 'UPDATE' AND NEW.approval_status = OLD.approval_status THEN
    RETURN NEW;
  END IF;

  actor_role := public.current_actor_role();

  -- ★ 最終承認は admin のみ（v13 §5.3.2「コアメンバーは最終承認できない」・§6 L2147）。
  IF NEW.approval_status = '承認完了' AND coalesce(actor_role, '') <> 'admin' THEN
    RAISE EXCEPTION 'クエストの最終承認は管理者のみが行える（v13 §5.3.2）'
      USING ERRCODE = '42501';
  END IF;

  -- コアメンバー確認・差戻しは運営（admin / core_member）のみ（v13 §6）。
  IF NEW.approval_status IN ('コアメンバー確認済', '差戻し')
     AND coalesce(actor_role, '') NOT IN ('admin', 'core_member') THEN
    RAISE EXCEPTION 'クエストの確認・差戻しは管理者またはコアメンバーのみが行える（v13 §6）'
      USING ERRCODE = '42501';
  END IF;

  -- ★ 「確認を飛ばした承認」を DB 側で記録する（v13 §5.3.2）。
  --   アプリ側の記録忘れで監査の根拠が欠けるのを防ぐため、旗はここで立てる。
  IF TG_OP = 'UPDATE' AND NEW.approval_status = '承認完了'
     AND OLD.approval_status <> 'コアメンバー確認済' THEN
    NEW.review_skipped := true;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.work_logs_guard_approval() IS
  '完了報告の承認ガード（v13 §5.3.2・§6）。最終承認は admin のみ、確認・差戻しは staff のみ。'
  'RLS では防げない（core_member にも行が見えるため）。service_role も通す必要があるためトリガー。';

CREATE TRIGGER trg_work_logs_guard_approval
  BEFORE INSERT OR UPDATE ON public.work_logs
  FOR EACH ROW EXECUTE FUNCTION public.work_logs_guard_approval();


-- 受注申請側も同じ理由で縛る。審査・指示は staff のみ（v13 §6 権限マトリクス）。
CREATE OR REPLACE FUNCTION public.quest_applications_guard_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  actor_role := public.current_actor_role();

  -- 受注者本人が行えるのは申請（申請中）と取り下げ（キャンセル）だけである。
  IF NEW.status IN ('指示済み', '承認', '差戻し', '完了')
     AND coalesce(actor_role, '') NOT IN ('admin', 'core_member') THEN
    RAISE EXCEPTION 'クエストの審査・実行指示は管理者またはコアメンバーのみが行える（v13 §6）'
      USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.quest_applications_guard_review() IS
  '受注申請の審査ガード（v13 §5.3-3・§6）。指示済み以降へ進められるのは staff のみ。';

CREATE TRIGGER trg_quest_applications_guard_review
  BEFORE INSERT OR UPDATE ON public.quest_applications
  FOR EACH ROW EXECUTE FUNCTION public.quest_applications_guard_review();


-- =============================================================================
-- ⑤ RLS（§6-7 デフォルト拒否 ／ §6-1 #18・#20）
-- =============================================================================

ALTER TABLE public.quest_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_log_reviews   ENABLE ROW LEVEL SECURITY;

-- ── quest_applications（PII-B：誰がどのクエストに申請したか）───────
CREATE POLICY quest_applications_select_self ON public.quest_applications
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY quest_applications_select_staff ON public.quest_applications
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- 受注申請は本人名義でのみ作れる（DB物理設計 §6-7 差分表「`_insert_self` を追加」）。
CREATE POLICY quest_applications_insert_self ON public.quest_applications
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY quest_applications_insert_staff ON public.quest_applications
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- 本人の UPDATE は取り下げのためだけに開ける。どの遷移が通るかはトリガーが決める。
CREATE POLICY quest_applications_update_self ON public.quest_applications
  FOR UPDATE TO authenticated
  USING       ( member_id = (SELECT public.current_member_id()) )
  WITH CHECK  ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY quest_applications_update_staff ON public.quest_applications
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否（§1-3 論理削除）。取り下げは status = 'キャンセル'。

-- ── work_logs（PII-B：本人＝申請者 ＋ staff ／ §6-1 #18）──────────
CREATE POLICY work_logs_select_self ON public.work_logs
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY work_logs_select_staff ON public.work_logs
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- 完了報告は申請者本人が出す（DB物理設計 §6-7 差分表）。
-- 運営が代筆できると「本人が報告した」という事実が壊れる。
CREATE POLICY work_logs_insert_self ON public.work_logs
  FOR INSERT TO authenticated
  WITH CHECK ( member_id = (SELECT public.current_member_id())
               AND EXISTS (SELECT 1
                           FROM   public.quest_applications a
                           WHERE  a.application_id = work_logs.application_id
                             AND  a.member_id      = (SELECT public.current_member_id())) );

-- 確認・承認・差戻しは staff（さらに最終承認が admin 限定であることはトリガーが担保する）。
CREATE POLICY work_logs_update_staff ON public.work_logs
  FOR UPDATE TO authenticated
  USING       ( (SELECT public.is_staff()) )
  WITH CHECK  ( (SELECT public.is_staff()) );

-- DELETE：全拒否。

-- ── work_log_reviews ────────────────────────────────────────
-- ★ `_select_self` を**作らない**（DB物理設計 §6-7 差分表：評価コメントを被評価者に見せない）。
CREATE POLICY work_log_reviews_select_staff ON public.work_log_reviews
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY work_log_reviews_insert_staff ON public.work_log_reviews
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff())
               AND reviewer_id = (SELECT public.current_member_id()) );

-- UPDATE / DELETE：全拒否（追記専用ログ）。


-- =============================================================================
-- ⑥ GRANT（§6-6②）— 先に既定の広い権限を剥がしてから必要分だけ与える
-- =============================================================================

REVOKE ALL ON public.quest_applications FROM anon, authenticated;
REVOKE ALL ON public.work_logs          FROM anon, authenticated;
REVOKE ALL ON public.work_log_reviews   FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.quest_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.work_logs          TO authenticated;
GRANT SELECT, INSERT         ON public.work_log_reviews   TO authenticated;
