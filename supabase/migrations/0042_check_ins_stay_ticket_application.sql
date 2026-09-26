-- =============================================================================
-- 0042_check_ins_stay_ticket_application.sql — 宿泊券の充当（WBS 3-7 ／ v13 §5.2.4）
--
--   根拠: v13 §5.2.4「宿泊券の充当：会員は保有宿泊券を充当できる。**予約時点では消費せず**、
--         チェックアウト時に消費する（§5.2.2 の原則を維持）」
--
-- ── なぜ列が必要か ──────────────────────────────────────────
--   「予約時点では消費しない」ので、充当の意思は**取引（`stay_ticket_transactions`）としては
--   書けない**。一方でチェックアウト時に消費するには「何泊ぶんを充てるつもりだったか」が
--   予約側に残っていなければならない。残高から勝手に引くと、
--   **現金で払うつもりだった滞在で宿泊券が溶ける**。
--
--   充当の意思は予約の属性であり、予約1件に1つしか無いため `check_ins` の列とする
--   （表を増やすと「1予約に複数の充当行」という無い状態を表現できてしまう）。
--
-- ── 含まないもの ────────────────────────────────────────────
--   - チェックアウト時の消費（`stay_ticket_transactions` の `consume` 行を起こす処理）
--     → WBS `3-4`（宿泊券消費）の担当。`0016` の `uq_stay_tx_consume_per_checkin` が
--       1滞在1回の消費を既に保証している
-- =============================================================================

ALTER TABLE public.check_ins
  ADD COLUMN IF NOT EXISTS stay_tickets_applied_nights integer NOT NULL DEFAULT 0;

-- 泊数を超える充当を作れないようにする。**残高との比較はここではできない**
-- （残高は `stay_ticket_balance()` ＝ 取引の積み上げであり、行の中に無い）。
-- 残高側の判定はアプリ（`reservation-intake.ts`）と、消費時（WBS 3-4）の2箇所で行う。
ALTER TABLE public.check_ins
  DROP CONSTRAINT IF EXISTS chk_check_ins_stay_tickets_within_nights;

ALTER TABLE public.check_ins
  ADD CONSTRAINT chk_check_ins_stay_tickets_within_nights
  CHECK (stay_tickets_applied_nights >= 0
         AND stay_tickets_applied_nights <= (check_out_date - check_in_date));

COMMENT ON COLUMN public.check_ins.stay_tickets_applied_nights IS
  '宿泊券を何泊ぶん充当するか（v13 §5.2.4 ／ WBS 3-7）。**予約時点では消費しない**（0 は充当なし）。'
  '実際の消費はチェックアウト時に stay_ticket_transactions の consume 行として起こす（WBS 3-4）。'
  '残高を超えていないかはアプリ側が判定する（残高は取引の積み上げで、行の中に無い）。';
