-- =============================================================================
-- 0023_eumo_grants.sql — Eumo給付の送付・受領追跡
--
--   WBS  : 5-5（Uii支払・XP／貢献バッジ付与）／Issue #108
--   根拠 : v13 §5.3.1（★ 給付管理の拡張）・§7「★ Eumo給付」・§9 #35、
--          `DB物理設計.md` §3-8・§6-1 ⑥
--   含む : eumo_grants のスキーマ・索引・RLS・GRANT
--
-- ── `DB物理設計.md` §3-8 の DDL に2列を足している ────────────────────
--
-- 同節の [!warning]（2026-09-21 追記）が「本 DDL は正本 v13 の 2026-08-29 拡張に
-- 追随していない。**2列を必須**としている。実装では必ず足すこと」と指示している。
-- `CLAUDE.md` §1.1 により正本が勝つため、`grant_type` と `purpose` を含めた形で作る。
--
--   `grant_type` が無いと、初回来訪キャッシュバック（§5.10.8）・街人登録キャッシュバック
--   （§5.10.5）・手動起票の3経路がクエスト報酬と区別できず、
--   **過去分の転記（§9 #59）で二重付与を検出できない。**
--
-- ── 「送付した」と「受け取られた」は別の事実 ──────────────────────────
--
-- v13 §5.3.1 の要求。1カラムに統合すると、送ったが届いていない給付を検出できない。
-- `status` の4値と `sent_at` / `received_confirmed_at` の2つの時刻で追う。
-- =============================================================================


-- =============================================================================
-- ① スキーマ
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.eumo_grants (
  grant_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             uuid NOT NULL REFERENCES public.members (member_id),

  -- 起票元。クエスト報酬以外（キャッシュバック・手動）では NULL になりうる
  quest_id              uuid REFERENCES public.quests (quest_id),
  application_id        uuid REFERENCES public.quest_applications (application_id),
  log_id                uuid REFERENCES public.work_logs (log_id),

  amount_uii            integer NOT NULL
                          CONSTRAINT chk_eumo_amount_positive CHECK (amount_uii > 0),

  -- ★ 正本 v13 の 2026-08-29 拡張。`DB物理設計.md` §3-8 の [!warning] が必須としている2列
  grant_type            text NOT NULL
                          CONSTRAINT chk_eumo_grant_type
                          CHECK (grant_type IN ('quest_reward', 'first_visit_cashback',
                                                'registration_cashback', 'manual')),
  purpose               text NOT NULL
                          CONSTRAINT chk_eumo_purpose_present CHECK (btrim(purpose) <> ''),

  status                text NOT NULL DEFAULT '未送付'
                          CONSTRAINT chk_eumo_status
                          CHECK (status IN ('未送付', '送付済', '受領確認済', '送付失敗')),

  eumo_url              text,
  sent_to               text,   -- 送付先（メール／LINE ID）。PII-A
  sent_channel          text CONSTRAINT chk_eumo_sent_channel
                          CHECK (sent_channel IN ('email', 'line', 'in_person')),
  sent_by               uuid REFERENCES public.members (member_id),
  sent_at               timestamptz,

  -- Phase 1 は手動確認（EUMO API 連携は Phase 2）
  received_confirmed_by uuid REFERENCES public.members (member_id),
  received_confirmed_at timestamptz,

  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- 「送付済」を名乗るなら誰がいつ送ったかが要る。
  -- ここが空のまま送付済になれる状態だと、滞留の検出（下の索引）が空振りする
  CONSTRAINT chk_eumo_sent_complete CHECK (
    status NOT IN ('送付済', '受領確認済')
    OR (sent_at IS NOT NULL AND sent_by IS NOT NULL)
  ),
  CONSTRAINT chk_eumo_received_complete CHECK (
    (status = '受領確認済') = (received_confirmed_at IS NOT NULL)
  ),
  -- 失敗には理由を残す。理由の無い失敗は再送の判断ができない
  CONSTRAINT chk_eumo_failure_has_reason CHECK (
    status <> '送付失敗' OR btrim(coalesce(failure_reason, '')) <> ''
  )
);

COMMENT ON TABLE public.eumo_grants IS
  'Eumo給付の予定と送付・受領の追跡（v13 §5.3.1 ／ §9 #35）。'
  '「送付した」と「受け取られた」は別の事実であり1カラムに統合しない。'
  '給付予定は work_logs.approval_status = 承認完了 になった瞬間にのみ起票する'
  '（コアメンバー確認済の段階で起票すると、最終承認を admin に限定した意味が失われる）。';
COMMENT ON COLUMN public.eumo_grants.grant_type IS
  'クエスト報酬／初回来訪キャッシュバック（§5.10.8）／街人登録キャッシュバック（§5.10.5）／手動。'
  '区別が無いと過去分の転記（§9 #59）で二重付与を検出できない';
COMMENT ON COLUMN public.eumo_grants.sent_to IS
  '送付先メール／LINE ID。PII-A。画面へ出すのは staff の一覧のみ（§6-1 ⑥）';

CREATE INDEX IF NOT EXISTS ix_eumo_grant_member ON public.eumo_grants (member_id);
CREATE INDEX IF NOT EXISTS ix_eumo_grant_status ON public.eumo_grants (status);

-- 「誰にいくら送るか」を確定表示するための未送付一覧
CREATE INDEX IF NOT EXISTS ix_eumo_grant_unsent
  ON public.eumo_grants (created_at) WHERE status = '未送付';

-- 送付済のまま14日超＝滞留の検出（v13 §5.3.1）。期間の判定はアプリ側で行う
CREATE INDEX IF NOT EXISTS ix_eumo_grant_stale
  ON public.eumo_grants (sent_at) WHERE status = '送付済';


-- =============================================================================
-- ② RLS（`DB物理設計.md` §6-1 ⑥ をそのまま実装）
--
--   本人にも見せる。自分宛の給付が「未送付」のまま止まっていることを本人が知れる形にする
--   （v13 §5.3.1）。書き込みは staff のみ。
-- =============================================================================

ALTER TABLE public.eumo_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY eumo_select_self ON public.eumo_grants
  FOR SELECT TO authenticated
  USING ( member_id = (SELECT public.current_member_id()) );

CREATE POLICY eumo_select_staff ON public.eumo_grants
  FOR SELECT TO authenticated
  USING ( (SELECT public.is_staff()) );

CREATE POLICY eumo_insert_staff ON public.eumo_grants
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT public.is_staff()) );

-- 送付済 → 受領確認済 の遷移（v13 §5.3.1）
CREATE POLICY eumo_update_staff ON public.eumo_grants
  FOR UPDATE TO authenticated
  USING      ( (SELECT public.is_staff()) )
  WITH CHECK ( (SELECT public.is_staff()) );

-- DELETE：ポリシーを作らない ＝ 全拒否。給付の証跡を消させない（§1-3）。


-- =============================================================================
-- ③ GRANT（§6-6②）
-- =============================================================================

REVOKE ALL ON public.eumo_grants FROM anon, authenticated;

GRANT SELECT         ON public.eumo_grants TO authenticated;
GRANT INSERT, UPDATE ON public.eumo_grants TO authenticated;  -- 行は RLS で staff のみ
