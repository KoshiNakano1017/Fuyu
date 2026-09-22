-- =============================================================================
-- WBS 7-2（伝票管理）：明細行の取消（論理削除）
--
-- 根拠: v13 §5.6.2「商品明細の修正 … 品目の追加／削除」、
--       v13 §5.6.2「伝票のキャンセル … 物理削除は行わず論理削除とし、一覧では取消線表示で残す」、
--       v13 §5.6.4「編集理由の必須入力」・「編集履歴ログ」、
--       `0019_orders_and_settlement.sql` ②（`order_items` の DDL と GRANT）
--
-- ── なぜ本ファイルが要るか ────────────────────────────────
--   `0019` の `order_items` には **行を消す手段が無い**。
--     - `GRANT` は SELECT / INSERT / UPDATE だけで DELETE を与えていない（意図どおり）
--     - `quantity` は `CHECK (quantity > 0)` のため 0 にもできない
--   その結果、v13 §5.6.2 の「品目の削除」を表現できず、**間違えて入れた1行を消せない**。
--   伝票ごと取り消す（`orders.cancelled_at`）しか手が無く、正しい行まで巻き添えになる。
--
-- ── 物理削除にしない理由 ────────────────────────────────
--   伝票の取消が論理削除である理由（v13 §5.6.2）がそのまま当てはまる。
--   行を消すと「何が削られたか」が残らず、§5.6.4 の編集履歴ログが
--   **削除だけ追えない**状態になる。金額が動く操作なので、痕跡を必ず残す。
--
-- ── スコープ ────────────────────────────────────────────────
--   含む  : `order_items` への取消3列 ＋ 整合の CHECK ＋ 索引
--   含まない:
--     - 編集履歴ログ（`audit_log`）・精算グループ・手動調整行
--       → `QUESTIONS.md`「[2026-09-20] 伝票の編集履歴ログ・精算グループ・手動調整行の
--         物理設計が存在しない」でオーナー判断待ち（本ファイルはその3件を**作らない**）
--     - 合計の再計算            → アプリ層（`src/lib/orders/slip-edit.ts`）
-- =============================================================================

ALTER TABLE public.order_items
  ADD COLUMN voided_at   timestamptz,
  ADD COLUMN voided_by   uuid REFERENCES public.members (member_id),
  ADD COLUMN void_reason text;

COMMENT ON COLUMN public.order_items.voided_at IS
  '明細行の取消（論理削除 ／ v13 §5.6.2）。物理削除しないのは、削られた行が残らないと'
  '§5.6.4 の編集履歴ログが「削除だけ追えない」状態になるため。合計の再計算では'
  'voided_at IS NOT NULL の行を除外する（src/lib/orders/slip-edit.ts）。';

-- 理由・操作者のない取消を物理的に作れなくする（v13 §5.6.4 ／ `0019` の
-- `chk_order_items_edit_needs_reason` と同じ作法）。
ALTER TABLE public.order_items
  ADD CONSTRAINT chk_order_items_void_complete CHECK (
    voided_at IS NULL
    OR (voided_by IS NOT NULL AND btrim(coalesce(void_reason, '')) <> '')
  );

-- 生きている明細だけを引く（合計の再計算と伝票表示が毎回この条件を付けるため）。
CREATE INDEX ix_order_item_live ON public.order_items (order_id) WHERE voided_at IS NULL;

-- GRANT は `0019` の `GRANT SELECT, INSERT, UPDATE ON public.order_items TO authenticated`
-- が全列に及ぶため、本ファイルで追加の GRANT は要らない。
-- 行を絞るのは `order_items_update_staff`（staff のみ）である。
