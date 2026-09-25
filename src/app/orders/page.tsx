import { MenuBoard } from "@/components/orders/MenuBoard";
import { Money } from "@/components/ui/Money";
import { requireSignedIn } from "@/lib/auth/guard";
import {
  fetchMenuItems,
  fetchMyOrders,
  fetchMyStayingCheckIn,
  type OrderSummary,
} from "@/lib/orders/fetch-orders";
import { groupMenuItemsByCategory, isMenuItemListableOn } from "@/lib/orders/menu";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

import { placeSelfOrderAction } from "./actions";

/**
 * セルフオーダー（画面ID A5 ／ WBS 6-1）。
 *
 * ## 🔒 要チェックイン
 *
 * v13 §5.4.1 は「カフェ注文はチェックイン中の利用者に限る」と定めている。
 * ここでは**品書きは見せたうえで数量入力と確定を止める**。
 * 画面ごと隠すと、滞在前の利用者が「何があるか」を下見できなくなる。
 *
 * 止めているのは画面だけではない。`orders_insert_self`（`0019`）の WITH CHECK が
 * 「自分がチェックイン中であること」を DB 側で要求しており、
 * Server Action を直接叩いても通らない（v13 §5.9.3 の二重防御）。
 *
 * ## 対象ロール
 *
 * `AREAS` の `cafeOrder` は全ロール可視（v13 §5.9.1）。ゲストも注文できる。
 *
 * ## 注文したものの状況を同じ画面に出す（WBS 6-5 ／ Issue #4）
 *
 * v13 §5.4.1 が定める本人向けの表示語は **「調理中」「提供済み」の2つだけ**である。
 * 注文した本人が状況を見られないと、結果として**カウンターへ聞きに行く**ことになる
 * （Issue #4 の目的そのもの）。表示語は `toServingStatusDisplayLabel()` を通し、
 * 画面側で文字列を書かない（保存値は `未提供`／`提供済み`、表示は「調理中」／「提供済み」）。
 *
 * ⚠️ **会計ステータス（未会計／精算済み）と同じ列に混ぜない。** §5.4.1 の警告どおり
 * 2軸は独立であり、「精算済み」を提供済みの代わりに使わない。
 */
export default async function OrdersPage() {
  const viewer = await requireSignedIn();

  const [menuItems, stay, myOrders] = await Promise.all([
    fetchMenuItems(),
    fetchMyStayingCheckIn(viewer.memberId),
    fetchMyOrders(viewer.memberId),
  ]);

  // 「今日」は利用者の手元の日付ではなくサーバの日付で決める。
  // 端末の時計を進めれば期間外の商品が注文できる、という経路を作らないため。
  const today = new Date().toISOString().slice(0, 10);
  const categories = groupMenuItemsByCategory(
    menuItems.filter((item) => isMenuItemListableOn(item, today)),
  );
  // 本日の注文だけを出す。過去分はマイログ（A2 ／ `/me`）が持つ役割であり、
  // 注文直後の画面に履歴を積むと「いま何が来るのか」が埋もれる。
  const todaysOrders = myOrders.filter((order) => order.createdAt.slice(0, 10) === today);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">カフェ注文</h1>

      {categories.length === 0 ? (
        <p className="text-sm text-neutral-600">本日ご用意している商品はありません。</p>
      ) : (
        <MenuBoard
          categories={categories}
          action={placeSelfOrderAction}
          submitLabel="注文する"
          disabledReason={stay === null ? "要チェックイン（滞在中のみ注文できます）" : null}
        />
      )}

      <ServingStatusSection orders={todaysOrders} />
    </main>
  );
}

/**
 * 本日の自分の注文と提供ステータス（v13 §5.4.1「本人への表示」）。
 *
 * 表示語は `toServingStatusDisplayLabel()` から取る。保存値（`未提供`）をそのまま出すと
 * 「未提供」という語が客の画面へ出てしまい、正本の表示語と食い違う。
 */
function ServingStatusSection({ orders }: { orders: readonly OrderSummary[] }) {
  if (orders.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-bold">本日の注文</h2>
      <ul className="flex flex-col gap-2">
        {orders.map((order) => (
          <li
            key={order.orderId}
            className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-600">
                {new Date(order.createdAt).toLocaleTimeString("ja-JP", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                {toServingStatusDisplayLabel(order.servingStatus)}
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
      <p className="text-xs text-neutral-600">
        お支払いは滞在の最後にまとめて精算します（この一覧は提供の状況だけを表しています）。
      </p>
    </section>
  );
}
