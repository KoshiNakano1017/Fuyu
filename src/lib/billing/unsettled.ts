// 未会計額の集計（WBS 8-2）。純関数だけを置く。
//
// 根拠: v13 §5.6.1（未会計額の表示）、§5.5（Uii主・円副）、
//       `0019_orders_and_settlement.sql`（`status` の3値・`total_amount_*` の意味）。

/** 集計に必要な伝票の最小形。`OrderSummary` をそのまま受けられる形にしてある。 */
export type SettleableOrder = {
  status: "未会計" | "精算済み" | "取消";
  totalAmountYen: number;
  totalAmountUii: number;
};

export type UnsettledTotals = {
  orderCount: number;
  totalAmountYen: number;
  totalAmountUii: number;
};

/**
 * 未会計の合計。
 *
 * ★ **Uii を円から計算し直さない。** 伝票に保存済みの `total_amount_uii` を足す。
 * 円の合計に 0.8 を掛け直すと、単品ごとの切り捨て（v13 §5.5）と結果がずれ、
 * 画面の合計と伝票の合計が一致しなくなる。保存値は「当時の事実」である。
 *
 * 取消（`取消`）は数えない。精算済みも数えない。残っている請求だけを出す。
 */
export function sumUnsettled(orders: readonly SettleableOrder[]): UnsettledTotals {
  return orders
    .filter((order) => order.status === "未会計")
    .reduce<UnsettledTotals>(
      (totals, order) => ({
        orderCount: totals.orderCount + 1,
        totalAmountYen: totals.totalAmountYen + order.totalAmountYen,
        totalAmountUii: totals.totalAmountUii + order.totalAmountUii,
      }),
      { orderCount: 0, totalAmountYen: 0, totalAmountUii: 0 },
    );
}
