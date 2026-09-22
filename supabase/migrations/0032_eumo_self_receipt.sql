-- =============================================================================
-- WBS 5-7 / 8-4：本人による Eumo 給付の受領報告
--
-- 根拠: v13 §5.3.1（2026-08-29 拡張：「**受領確認を『本人の受領報告』でも可能にする**」／
--         受領までを本人のタスクとして表示する）、
--       v13 §5.6.6・§5.3.1（本人向け表示＝マイログに未受領の給付を常時出す）、
--       `0023_eumo_grants.sql` ②（本人には SELECT だけを許し、更新は staff に限っていた）
--
-- ── なぜ本ファイルが要るか ────────────────────────────────
--   `0023` の UPDATE ポリシーは `eumo_update_staff` だけである。したがって
--   **本人が受領を報告する経路が DB に無い**。§5.3.1 の拡張がそのまま実装できない。
--
-- ── なぜ RLS だけで済ませないのか ──────────────────────────
--   RLS は**列を絞れない**。`USING (member_id = current_member_id())` を足すと、
--   本人が自分の行の **`amount_uii` も `status` も好きに書き換えられる**
--   （「5,000 Uii の発行依頼」を「50,000 Uii」に書き換えられる）。
--   列単位 GRANT でも足りない——`status` の書き込み自体は許す必要があるのに、
--   許してよいのは `送付済 → 受領確認済` の1遷移だけだからである。
--   したがって **`0017` の `work_logs_guard_approval()` と同じくトリガーで守る**。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : 本人 UPDATE ポリシー ＋ 遷移ガードのトリガー
--   含まない:
--     - マイログ側の表示          → `src/app/me/page.tsx`（WBS 8-4）
--     - 運営の送付・受領確認操作  → `0023` の staff ポリシー（実装済み）
-- =============================================================================


-- =============================================================================
-- ① 本人の UPDATE を開ける（行の範囲だけ。中身はトリガーが縛る）
-- =============================================================================

CREATE POLICY eumo_update_self ON public.eumo_grants
  FOR UPDATE TO authenticated
  USING       ( member_id = (SELECT public.current_member_id()) )
  WITH CHECK  ( member_id = (SELECT public.current_member_id()) );


-- =============================================================================
-- ② 遷移ガード（本人に許すのは「受け取りました」の1操作だけ）
--
--   staff の操作（送付記録・受領確認・失敗記録）はこれまでどおり通す。
--   判定の根拠は `members.role` のみで、`member_type` は見ない（v13 §2）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.eumo_grants_guard_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 運営の操作は従来どおり。ここで返さないと staff の送付記録まで弾いてしまう。
  IF public.is_staff() THEN
    RETURN NEW;
  END IF;

  -- ここから先は本人（または本人ですらない誰か）の UPDATE である。
  IF NEW.member_id IS DISTINCT FROM public.current_member_id() THEN
    RAISE EXCEPTION '他人の給付は更新できません' USING ERRCODE = '42501';
  END IF;

  -- 許すのは「送付済 → 受領確認済」の1遷移だけ。
  IF NOT (OLD.status = '送付済' AND NEW.status = '受領確認済') THEN
    RAISE EXCEPTION '本人が行えるのは受領報告（送付済 → 受領確認済）だけです'
      USING ERRCODE = '42501';
  END IF;

  -- 金額・種別・用途・送付の記録を本人が書き換えられないようにする。
  -- ★ ここが本ファイルの本体である。RLS では列を絞れないため、1列ずつ突き合わせる。
  IF NEW.amount_uii    IS DISTINCT FROM OLD.amount_uii
  OR NEW.grant_type    IS DISTINCT FROM OLD.grant_type
  OR NEW.purpose       IS DISTINCT FROM OLD.purpose
  OR NEW.quest_id      IS DISTINCT FROM OLD.quest_id
  OR NEW.log_id        IS DISTINCT FROM OLD.log_id
  OR NEW.eumo_url      IS DISTINCT FROM OLD.eumo_url
  OR NEW.sent_to       IS DISTINCT FROM OLD.sent_to
  OR NEW.sent_channel  IS DISTINCT FROM OLD.sent_channel
  OR NEW.sent_by       IS DISTINCT FROM OLD.sent_by
  OR NEW.sent_at       IS DISTINCT FROM OLD.sent_at
  OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
    RAISE EXCEPTION '受領報告で変更できるのは受領の記録だけです' USING ERRCODE = '42501';
  END IF;

  -- 受領確認者は必ず本人になる。運営が確認したように見せかけられないようにする。
  IF NEW.received_confirmed_by IS DISTINCT FROM NEW.member_id THEN
    RAISE EXCEPTION '受領報告の確認者は本人でなければなりません' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.eumo_grants_guard_self_update() IS
  '本人の受領報告（v13 §5.3.1）を「送付済 → 受領確認済」の1遷移に限るガード。'
  'RLS は列を絞れないため、本人 UPDATE を開けると金額まで書き換えられる。'
  'そのためトリガーで列ごとに突き合わせる（0017 の work_logs_guard_approval と同じ作法）。';

CREATE TRIGGER trg_eumo_grants_guard_self_update
  BEFORE UPDATE ON public.eumo_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.eumo_grants_guard_self_update();


-- =============================================================================
-- ③ GRANT
--
--   `0023` は既に `GRANT INSERT, UPDATE ON public.eumo_grants TO authenticated` を
--   与えている（行は RLS が絞る）。本人 UPDATE のために追加の GRANT は要らない。
--   ⚠️ INSERT は `eumo_insert_staff` しかポリシーが無いため、本人は引き続き起票できない。
-- =============================================================================
