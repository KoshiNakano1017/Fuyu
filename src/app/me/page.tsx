import { MyGrantList } from "@/components/eumo/MyGrantList";
import { Money } from "@/components/ui/Money";
import { requireSignedIn } from "@/lib/auth/guard";
import { fetchMyPendingAdjustments } from "@/lib/billing/fetch-my-ledger";
import { fetchMyPendingGrants } from "@/lib/eumo/store";
import { sumUnsettled } from "@/lib/billing/unsettled";
import { fetchMyOrders } from "@/lib/orders/fetch-orders";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

import { reportGrantReceiptAction } from "./actions";

/**
 * マイログ（画面ID A6／A2 ／ WBS 8-4・8-2・8-3）。
 *
 * ## 未処理差額を本人に出す
 *
 * v13 §5.6.6 は「未処理差額を**本人にも常時表示する**」と定めている。
 * 運営側だけが把握していて本人が知らない請求を作らないための要件であり、
 * `settlement_adjustments` に `_select_self` ポリシーが置かれているのもこのためである。
 *
 * ## 金額は Uii 主・円副
 *
 * v13 §5.5／§9 #41。画面ごとに書式を作らず `Money` に集約する。
 * 合計の Uii は**伝票の保存値の和**であり、円合計から計算し直さない（`unsettled.ts`）。
 *
 * ## 提供ステータスの表示語
 *
 * 保存値 `未提供` は本人向けには「調理中」と出す（v13 §5.4.1）。
 * 変換は `toServingStatusDisplayLabel()` に一本化してある。
 */
export default async function MyPage() {
  const viewer = await requireSignedIn();

  const [orders, adjustments, pendingGrants] = await Promise.all([
    fetchMyOrders(viewer.memberId),
    fetchMyPendingAdjustments(viewer.memberId),
    // 未受領のUii給付も本画面に出す（v13 §5.3.1 ／ WBS 8-4 は 5-7 と連動する）
    fetchMyPendingGrants(viewer.memberId),
  ]);

  const unsettled = sumUnsettled(orders);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">マイページ</h1>

      <section className="rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-bold">未会計</h2>
        {unsettled.orderCount === 0 ? (
          <p className="mt-1 text-sm text-neutral-600">未会計の伝票はありません。</p>
        ) : (
          <p className="mt-1 text-xl font-bold">
            {unsettled.totalAmountUii.toLocaleString("ja-JP")} Uii（¥
            {unsettled.totalAmountYen.toLocaleString("ja-JP")}）
            <span className="ml-2 text-sm font-normal text-neutral-600">
              {unsettled.orderCount}件
            </span>
          </p>
        )}
      </section>

      {adjustments.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-lg font-bold text-amber-900">未処理の差額</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-amber-900">
            {adjustments.map((adjustment) => (
              <li key={adjustment.adjustmentId} className="flex justify-between gap-3">
                <span>{adjustment.reason}</span>
                <span className="font-medium">
                  {adjustment.category}{" "}
                  <Money priceYen={Math.abs(adjustment.amountYen)} />
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800">
            次回のご来訪時に精算します。内容にお心当たりがない場合は運営へお伝えください。
          </p>
        </section>
      )}

      <MyGrantList grants={pendingGrants} reportReceipt={reportGrantReceiptAction} />

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">注文履歴</h2>
        {orders.length === 0 ? (
          <p className="text-sm text-neutral-600">まだ注文はありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {orders.map((order) => (
              <li
                key={order.orderId}
                className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-600">
                    {new Date(order.createdAt).toLocaleString("ja-JP")}
                  </span>
                  <span className="flex gap-1 text-xs">
                    <span className="rounded bg-neutral-100 px-2 py-0.5">{order.status}</span>
                    <span className="rounded bg-neutral-100 px-2 py-0.5">
                      {toServingStatusDisplayLabel(order.servingStatus)}
                    </span>
                  </span>
                </div>
                <ul className="text-sm">
                  {order.lines.map((line, index) => (
                    <li key={`${order.orderId}-${index}`}>
                      {line.productName} × {line.quantity}
                    </li>
                  ))}
                </ul>
                <span className="text-sm font-medium">
                  <Money priceYen={order.totalAmountYen} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
