import Link from "next/link";
import { notFound } from "next/navigation";

import { Money } from "@/components/ui/Money";
import { requireSignedIn } from "@/lib/auth/guard";
import { fetchAccommodationTypes, fetchMyStay } from "@/lib/lodging/fetch-lodging";
import { fetchMyOrders } from "@/lib/orders/fetch-orders";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

/**
 * 滞在の詳細（画面ID A12 の遷移先 ／ WBS 3-8）。
 *
 * 根拠: v13 §5.2.5②「日付タップで当該滞在の詳細（部屋・同伴人数・注文・クエスト）へ遷移」／
 *       `画面設計.md` §4 A12「遷移」。
 *
 * ## 他人の滞在は「無い」ものとして返す
 *
 * `fetchMyStay()` が `member_id` で絞り、取れなければ 404 にする。
 * 「権限がありません」と出すと、**その滞在IDが存在すること自体**を教えてしまう
 * （v13 §8 ／ CLAUDE.md §7.1）。
 *
 * ## クエストはまだ出さない
 *
 * 正本は詳細に「クエスト」も挙げているが、滞在と参加クエストを結ぶ導線は
 * WBS `4-*`（クエスト）側に無く、この画面から引ける関係が存在しない。
 * **空欄や推測で埋めず、出さない。** 取れるようになった時点で足す。
 */
export default async function MyStayDetailPage({
  params,
}: {
  params: Promise<{ checkinId: string }>;
}) {
  const viewer = await requireSignedIn();
  const { checkinId } = await params;

  const stay = await fetchMyStay({ memberId: viewer.memberId, checkinId });
  if (stay === null) {
    notFound();
  }

  const [types, orders] = await Promise.all([fetchAccommodationTypes(), fetchMyOrders(viewer.memberId)]);
  const roomTypeLabel =
    types.find((type) => type.roomType === stay.roomType)?.displayName ?? stay.roomType;

  // 滞在中に出した注文だけを並べる。日付で切るのは、伝票が滞在IDを持たないためである
  // （`orders` は購入者と時刻だけを持つ ／ `0019`）。
  const ordersDuringStay = orders.filter((order) => {
    const orderedOn = order.createdAt.slice(0, 10);
    return stay.checkInDate <= orderedOn && orderedOn <= stay.checkOutDate;
  });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Link className="text-sm underline" href={`/me?stayMonth=${stay.checkInDate.slice(0, 7)}`}>
          ← 宿泊予定・履歴へ戻る
        </Link>
        <h1 className="text-2xl font-bold">
          {stay.checkInDate} 〜 {stay.checkOutDate} の滞在
        </h1>
      </div>

      <section className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-bold">滞在の内容</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-600">宿泊形態</dt>
          <dd>{roomTypeLabel}</dd>

          <dt className="text-neutral-600">お部屋</dt>
          {/* 未割当は「未割当」と出す。当日までに決まることがあるため空欄にしない */}
          <dd>{stay.assignedRoomName ?? "未割当（当日ご案内します）"}</dd>

          <dt className="text-neutral-600">人数</dt>
          <dd>
            大人 {stay.adultsCount}名・子供 {stay.childrenCount}名
          </dd>

          <dt className="text-neutral-600">状態</dt>
          <dd>{stay.status}</dd>

          {(stay.note ?? "") !== "" && (
            <>
              <dt className="text-neutral-600">備考</dt>
              <dd>{stay.note}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">この滞在中の注文</h2>
        {ordersDuringStay.length === 0 ? (
          <p className="text-sm text-neutral-600">この期間の注文はありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ordersDuringStay.map((order) => (
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
