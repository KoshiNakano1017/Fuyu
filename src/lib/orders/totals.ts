/**
 * 伝票の合計金額（WBS 6-1 ／ 7-2 ／ 8-2）。
 *
 * 根拠: v13 §5.5「★ 換算の適用単位と端数処理（確定）」
 *   - 単品Uii ＝ `floor(単価（円） × 0.8)`
 *   - 明細行Uii ＝ 単品Uii × 数量
 *   - 伝票Uii ＝ 明細行Uii の合算
 *   - **理由**: 商品カードに表示される単品Uiiを足した値と、伝票・未会計合計のUiiが
 *     必ず一致する。合計に 0.8 を掛ける方式では表示と合計がずれ、
 *     現場で「計算が合わない」問題が起きるため。
 *
 * ⚠️ **伝票合計（円）に 0.8 を掛けて Uii を出してはならない。**
 *    例: 700円 × 3点 の伝票
 *      正しい: floor(700×0.8) × 3 = 560 × 3 = 1,680
 *      誤り  : floor(2100 × 0.8)      = 1,680   ← たまたま一致する
 *    例: 1,300円 × 1点 ＋ 700円 × 1点
 *      正しい: 1040 + 560 = 1,600
 *      誤り  : floor(2000 × 0.8) = 1,600        ← これも一致する
 *    例: 1,299円 × 2点（端数が出る単価）
 *      正しい: floor(1299×0.8) × 2 = 1039 × 2 = 2,078
 *      誤り  : floor(2598 × 0.8)              = 2,078
 *    …一致する場合も多いが、**単価の端数が切り捨てで消える点数分だけずれる**。
 *    ずれた瞬間に「カードの合計と伝票が違う」という現場の不信になるため、式を1本に固定する。
 */

import { toUii } from "@/lib/uii";

/** 伝票明細1行。注文時点の単価のコピーを持つ（`order_items` と同じ形）。 */
export type OrderLine = {
  productName: string;
  unitPriceYen: number;
  quantity: number;
};

export type OrderTotals = {
  totalAmountYen: number;
  totalAmountUii: number;
};

/** 明細行の小計（円）。 */
export function lineSubtotalYen(line: OrderLine): number {
  return line.unitPriceYen * line.quantity;
}

/**
 * 明細行の小計（Uii）。
 *
 * ★ **単品ごとに丸めてから数量を掛ける**。`toUii(lineSubtotalYen(line))` と書くと、
 * 切り捨てが行の合計に対して1回だけ効き、商品カードの単品Uii × 数量と合わなくなる。
 */
export function lineSubtotalUii(line: OrderLine): number {
  return toUii(line.unitPriceYen) * line.quantity;
}

/** 伝票の合計。`orders.total_amount_yen` / `total_amount_uii` へ書き戻す値。 */
export function calculateOrderTotals(lines: readonly OrderLine[]): OrderTotals {
  return lines.reduce<OrderTotals>(
    (totals, line) => ({
      totalAmountYen: totals.totalAmountYen + lineSubtotalYen(line),
      totalAmountUii: totals.totalAmountUii + lineSubtotalUii(line),
    }),
    { totalAmountYen: 0, totalAmountUii: 0 },
  );
}

/**
 * 明細を `order_items` の行の形へ写す。
 *
 * `unit_price_uii` を保存するのは、マスタ（`menu_items`）が Uii を持たないのと
 * 矛盾しない。**マスタは「これから作る伝票の既定値」、明細は「当時の事実の記録」**である
 * （v13 §5.4.2 の警告）。マスタの単価が改定されても過去伝票の Uii は動かない。
 */
export function toOrderItemRows(lines: readonly OrderLine[]): {
  product_name: string;
  unit_price_yen: number;
  unit_price_uii: number;
  quantity: number;
}[] {
  return lines.map((line) => ({
    product_name: line.productName,
    unit_price_yen: line.unitPriceYen,
    unit_price_uii: toUii(line.unitPriceYen),
    quantity: line.quantity,
  }));
}
