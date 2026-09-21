// マイログの材料を Supabase から読む。WBS 8-4（マイログ）・8-2（未会計額）・8-3（差額）。
//
// ★ すべて anon キー＋RLS 経由で読む。行を絞っているのは
//   `orders_select_self` と `settlement_adjustments_select_self`（`0019`）である。
//   **`settlement_adjustments` に `_select_self` が置かれているのは仕様**であり
//   （v13 §5.6.6「本人にも未処理差額を常時表示する」）、差額の存在を本人に隠さない。

import { createServerSupabaseClient } from "@/lib/supabase/server";

/** 未処理の差額1件（`settlement_adjustments`）。 */
export type PendingAdjustment = {
  adjustmentId: string;
  amountYen: number;
  category: "追加請求" | "返金";
  reason: string;
  occurredAt: string;
};

/**
 * 本人の未処理差額を読む（v13 §5.6.6）。
 *
 * `is_stale`（後続の修正で意味を失った行）は出さない。出すと
 * 「もう関係ない請求」が本人の画面に残り続ける。
 */
export async function fetchMyPendingAdjustments(memberId: string): Promise<PendingAdjustment[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("settlement_adjustments")
    .select("adjustment_id, amount_yen, category, reason, occurred_at, orders!inner(purchaser_id)")
    .eq("status", "未処理")
    .eq("is_stale", false)
    .eq("orders.purchaser_id", memberId)
    .order("occurred_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return (
    data as {
      adjustment_id: string;
      amount_yen: number;
      category: "追加請求" | "返金";
      reason: string;
      occurred_at: string;
    }[]
  ).map((row) => ({
    adjustmentId: row.adjustment_id,
    amountYen: row.amount_yen,
    category: row.category,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}
