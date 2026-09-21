import { MenuBoard } from "@/components/orders/MenuBoard";
import { requireSignedIn } from "@/lib/auth/guard";
import { fetchMenuItems, fetchMyStayingCheckIn } from "@/lib/orders/fetch-orders";
import { groupMenuItemsByCategory, isMenuItemListableOn } from "@/lib/orders/menu";

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
 */
export default async function OrdersPage() {
  const viewer = await requireSignedIn();

  const [menuItems, stay] = await Promise.all([
    fetchMenuItems(),
    fetchMyStayingCheckIn(viewer.memberId),
  ]);

  // 「今日」は利用者の手元の日付ではなくサーバの日付で決める。
  // 端末の時計を進めれば期間外の商品が注文できる、という経路を作らないため。
  const today = new Date().toISOString().slice(0, 10);
  const categories = groupMenuItemsByCategory(
    menuItems.filter((item) => isMenuItemListableOn(item, today)),
  );

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
    </main>
  );
}
