-- =============================================================================
-- 0039_member_link_requests.sql — 名寄せの運営承認キュー ＋ 成立・解除の監査ログ
--
--   WBS  : 10-2（名寄せロジック ／ 2026-09-25 オーナー決定 B ＝ 照合基盤 ＋ 初回アクセス導線）
--   根拠 : 正本 v13 §5.8.3（STEP 2 の自動名寄せ・誤名寄せの防止の3点）、
--          `DB物理設計.md` §3-14 ⑤（候補が複数なら運営承認キューへ）・§6-1
--   含む : member_link_requests（承認キュー）／member_link_events（監査ログ）の
--          DDL ／ 制約 ／ 索引 ／ RLS ／ GRANT
--
-- ── なぜ2表に分けるのか ──────────────────────────────────────────
--
-- **キューは「これから決めること」、監査は「決まった事実」**であり、寿命が違う。
--   ・キュー: `保留` → `承認` / `却下` で終わる。運営の作業待ち行列である
--   ・監査:  成立・解除の**すべて**（自動で成立した分も含む）を残す。消さない
--
-- 1表に混ぜると「自動成立には保留の状態が無い」ためキューが状態機械として壊れるか、
-- あるいは監査側に「保留」という**事実ではない行**が混ざる。
--
-- ── 誤名寄せの防止（v13 §5.8.3 の [!warning]）──────────────────────
--
-- 名寄せの成立は**他人の宿泊券・Uii残高・XP の引き継ぎ**を意味する。正本は3点を必須とする。
--
--   ① 候補が複数件ヒットしたら自動連携せず運営承認キューへ回す → 本表（キュー）
--   ② 初回紐付け時は招待コードまたはメール／SMS の OTP による本人確認を必須 →
--      アプリ側はログインの `verifyOtp()` を通ったメールしか照合キーに使わない
--      （`member_identifiers.is_verified` と同じ意味を持たせる）
--   ③ 成立・解除を監査ログへ（誰が・いつ・どのレコードを・どの根拠で）→ 本表（監査）
--
-- ── 個人情報の扱い ──────────────────────────────────────────────
--
-- キューは**照合に使った連絡先（PII-A）**を持つ。運営が「誰の申請か」を判断するために要る。
-- したがって RLS は `member_identifiers` と同じ **staff 限定**に揃える（§6-1）。
-- **本人向けのポリシーは作らない** — 自分の申請が保留中であることは画面の文言で伝えるため、
-- 行を開ける必要がない（開けると、他人の候補件数まで推測できる形になりやすい）。
-- =============================================================================


-- =============================================================================
-- ① 運営承認キュー（v13 §5.8.3 ①）
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_link_requests (
  request_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ★ まだ `members` へ結合されていない Auth ユーザー。**`members` への外部キーは張れない**
  --   （結合先が決まっていないのが、この行が存在する理由そのものである）。
  auth_user_id   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  -- 照合に使ったキー（PII-A）。`member_identifiers.kind` と同じ語彙に揃える。
  matched_kind   text NOT NULL
                   CONSTRAINT chk_link_request_kind
                   CHECK (matched_kind IN ('email', 'phone', 'line', 'discord')),
  matched_value  text NOT NULL
                   CONSTRAINT chk_link_request_value_present
                   CHECK (btrim(matched_value) <> ''),

  -- ★ 何件ヒットしたか。0件は「候補が無い」＝キューに載せる理由が無いので許さない。
  --   1件でも載ることがある（本人確認が足りない場合。②の要件）。
  candidate_count integer NOT NULL
                   CONSTRAINT chk_link_request_candidates CHECK (candidate_count >= 1),

  -- キューへ回した理由。運営が画面で読む（内部識別子ではなく人が読む語を入れる）。
  reason         text NOT NULL
                   CONSTRAINT chk_link_request_reason_present CHECK (btrim(reason) <> ''),

  status         text NOT NULL DEFAULT '保留'
                   CONSTRAINT chk_link_request_status
                   CHECK (status IN ('保留', '承認', '却下')),

  -- 承認時に選ばれた会員。★ 却下では入らない。
  resolved_member_id uuid REFERENCES public.members (member_id),
  resolved_by    uuid REFERENCES public.members (member_id),
  resolved_at    timestamptz,
  reject_reason  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- 承認したなら「どの会員へ結合したか」「誰がいつ決めたか」が揃っていなければならない。
  -- ここが緩いと「承認済みだが結合先が分からない」行が残り、監査の意味が消える。
  CONSTRAINT chk_link_request_approved_complete CHECK (
    status <> '承認'
    OR (resolved_member_id IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),

  -- 却下は理由必須（`0017` の差戻し・`0037` の却下と同じ規律）。
  CONSTRAINT chk_link_request_rejected_needs_reason CHECK (
    status <> '却下'
    OR (btrim(coalesce(reject_reason, '')) <> '' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  ),

  -- 却下に結合先は入らない（入っていたら、却下なのか承認なのか読めない）。
  CONSTRAINT chk_link_request_rejected_has_no_member CHECK (
    status <> '却下' OR resolved_member_id IS NULL
  )
);

COMMENT ON TABLE public.member_link_requests IS
  '名寄せの運営承認キュー（v13 §5.8.3 ①）。候補が複数、または本人確認が足りない場合に積む。'
  '★ 照合に使った連絡先（PII-A）を持つため RLS は staff 限定（member_identifiers と同じ）。';

COMMENT ON COLUMN public.member_link_requests.auth_user_id IS
  'まだ members へ結合されていない Auth ユーザー。結合先が未定であることが本行の存在理由なので、'
  'members への外部キーは張らない。';

COMMENT ON COLUMN public.member_link_requests.candidate_count IS
  '照合でヒットした候補件数。2件以上＝同姓同名・連絡先共有の疑い（v13 §5.8.3 の [!warning]）。';

-- ★ 同じ Auth ユーザーの保留を2件作らない（ログインを繰り返すたびに積み上がるのを防ぐ）。
--   終了状態（承認・却下）は対象外にして、再申請の余地を残す。
CREATE UNIQUE INDEX IF NOT EXISTS ux_link_request_pending_per_auth_user
  ON public.member_link_requests (auth_user_id)
  WHERE status = '保留';

CREATE INDEX IF NOT EXISTS ix_link_request_pending
  ON public.member_link_requests (created_at)
  WHERE status = '保留';


-- =============================================================================
-- ② 名寄せの監査ログ（v13 §5.8.3 ③「誰が・いつ・どのレコードを・どの根拠で」）
--
--   ★ **自動で成立した分も残す。** 「人が判断したものだけ記録する」と、
--   事故（他人の宿泊券を引き継いだ）が起きたときに**自動成立分を追跡できない**。
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.member_link_events (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  member_id    uuid NOT NULL REFERENCES public.members (member_id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL,   -- 解除後も残すため auth.users への FK は張らない

  action       text NOT NULL
                 CONSTRAINT chk_link_event_action CHECK (action IN ('成立', '解除')),

  -- ★ 根拠。「検証済みメールの一致」「運営承認（候補2件から選択）」など、**人が読める文**を入れる。
  --   内部識別子だけを入れると、後から「なぜこの人だと判断したのか」が読めない。
  match_basis  text NOT NULL
                 CONSTRAINT chk_link_event_basis_present CHECK (btrim(match_basis) <> ''),

  -- 自動成立では NULL（システムが決めた）。運営承認では操作者が入る。
  decided_by   uuid REFERENCES public.members (member_id),
  -- 承認キュー経由なら、その申請。自動成立では NULL。
  request_id   uuid REFERENCES public.member_link_requests (request_id),

  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_link_events IS
  '名寄せの成立・解除の監査ログ（v13 §5.8.3 ③）。★ 自動成立分も残す'
  '（人の判断だけ記録すると、事故のときに自動成立分を追跡できない）。';

CREATE INDEX IF NOT EXISTS ix_link_event_member
  ON public.member_link_events (member_id, occurred_at DESC);


-- =============================================================================
-- ③ RLS（`member_identifiers`（`0025`）と同じ staff 限定に揃える）
-- =============================================================================

ALTER TABLE public.member_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_link_events   ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_link_requests_select_staff ON public.member_link_requests
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- 承認・却下（`保留` からの遷移）。INSERT は service_role 経由のみ想定だが、
-- 運営が画面から代理で積む余地を残す。
CREATE POLICY member_link_requests_insert_staff ON public.member_link_requests
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

CREATE POLICY member_link_requests_update_staff ON public.member_link_requests
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_staff()) )
  WITH CHECK ( (SELECT public.is_staff()) );

-- 監査ログは staff が読むだけ。**書き込みポリシーを作らない**（＝全拒否）。
-- 記録は名寄せを実行する SECURITY DEFINER 関数（`0040` 以降 ／ service_role）だけが行う。
-- ここに INSERT を開けると、根拠を偽った監査行を作れてしまう。
CREATE POLICY member_link_events_select_staff ON public.member_link_events
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

-- DELETE：どちらの表にもポリシーを作らない ＝ 全拒否（証跡を消させない）。


-- =============================================================================
-- ④ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.member_link_requests FROM anon, authenticated;
REVOKE ALL ON public.member_link_events   FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.member_link_requests TO authenticated;  -- 行は RLS で staff
GRANT SELECT                 ON public.member_link_events   TO authenticated;  -- 読むだけ

-- ⚠️ `service_role` からも DELETE / TRUNCATE を剥がす（`0101` と同じ理由）。
--    監査ログとキューはアプリ側から消せる経路を持たない。
REVOKE DELETE, TRUNCATE ON public.member_link_requests FROM service_role;
REVOKE DELETE, TRUNCATE ON public.member_link_events   FROM service_role;
