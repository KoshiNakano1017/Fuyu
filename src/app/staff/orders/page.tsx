import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { RevisitAlerts } from "@/components/customers/RevisitAlerts";
import { MenuBoard } from "@/components/orders/MenuBoard";
import { OrderKanban } from "@/components/orders/OrderKanban";
import { SoldOutPanel } from "@/components/orders/SoldOutPanel";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { fetchRevisitAlerts } from "@/lib/customers/fetch-revisit";
import {
  fetchMenuItems,
  fetchOpenOrders,
  fetchStayingCheckIns,
} from "@/lib/orders/fetch-orders";
import { groupMenuItemsByCategory, isMenuItemListableOn } from "@/lib/orders/menu";

import { markServedAction, placeProxyOrderAction, toggleSoldOutAction } from "./actions";

/**
 * 店員用タブレット（画面ID B1・B2・B3 ／ WBS 6-1・6-2・6-3・6-5）。
 *
 * 1枚に3つを載せるのは画面設計.md §2 の配置指定どおりである
 * （B2「B1に内包」・B3 も同じ板の上）。現場ではタブレット1台を
 * 調理と会計で共用するため、画面を跨ぐと操作が間に合わない。
 *
 * ⚠️ **実名を出さない。** 伝票の持ち主は `v_member_public` の表示名
 * （ニックネーム／会員番号）で出す。タブレットは客から見える位置に置かれる。
 */
export default async function StaffOrdersPage() {
  try {
    await requireStaff();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  const [orders, menuItems, stayingCheckIns, revisitAlerts] = await Promise.all([
    fetchOpenOrders(),
    fetchMenuItems(),
    fetchStayingCheckIns(),
    // 未処理の差額を持つ方が滞在中なら、注文の板より先に出す（v13 §5.6.6 ／ WBS 10-3）
    fetchRevisitAlerts(),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const listable = menuItems.filter((item) => isMenuItemListableOn(item, today));

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-bold">店員用タブレット</h1>

      {/* 入館の操作は別画面（画面ID A1 ／ WBS 3-2）。同じ端末から辿れるようにする */}
      <Link href="/staff/checkins" className="text-sm underline underline-offset-4">
        チェックイン／チェックアウトへ
      </Link>

      <RevisitAlerts alerts={revisitAlerts} />

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">注文</h2>
        {orders.length === 0 ? (
          <p className="text-sm text-neutral-600">未処理の注文はありません。</p>
        ) : (
          <OrderKanban orders={orders} markServed={markServedAction} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">売り切れ</h2>
        <p className="text-sm text-neutral-600">
          押すと販売中と SOLDOUT が入れ替わります。価格の変更は管理者のマスタ管理から行います。
        </p>
        <SoldOutPanel items={listable} toggleSoldOut={toggleSoldOutAction} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">代理注文</h2>
        {stayingCheckIns.length === 0 ? (
          <p className="text-sm text-neutral-600">
            滞在中の方がいないため、代理注文はできません。
          </p>
        ) : (
          <MenuBoard
            categories={groupMenuItemsByCategory(listable)}
            action={placeProxyOrderAction}
            submitLabel="代理で注文する"
            disabledReason={null}
            extraFields={<StayingPicker stayingCheckIns={stayingCheckIns} />}
          />
        )}
      </section>
    </main>
  );
}

/**
 * 代理注文の相手を選ぶ（v13 §5.4.1「チェックイン中ユーザー限定」）。
 *
 * ★ `checkin_id` と `purchaser_id` を **1つの選択肢に束ねて**送る
 * （`<checkin_id>:<member_id>` の形）。2つの入力に分けると、
 * 「A さんの滞在に B さんの伝票」という組み合わせを組み立てられてしまう。
 * 束ねておけば、送られてくるのは必ず実在する滞在と、その滞在の本人の組である。
 */
function StayingPicker({
  stayingCheckIns,
}: {
  stayingCheckIns: { checkinId: string; memberId: string; memberLabel: string; roomType: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      注文する方
      <select
        name="stay"
        required
        className="rounded border border-neutral-300 px-3 py-2"
        defaultValue=""
      >
        <option value="" disabled>
          選んでください
        </option>
        {stayingCheckIns.map((stay) => (
          <option key={stay.checkinId} value={`${stay.checkinId}:${stay.memberId}`}>
            {stay.memberLabel}（{stay.roomType}）
          </option>
        ))}
      </select>
    </label>
  );
}
