"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import { fetchMyStayingCheckIn } from "@/lib/orders/fetch-orders";
import { placeOrder } from "@/lib/orders/place-order";
import type { SubmitState } from "@/lib/forms/submit-state";

/** 失敗理由の利用者向け文言。内部の識別子をそのまま見せない。 */
const MESSAGE: Record<string, string> = {
  empty_cart: "数量を1つ以上選んでください。",
  not_staying: "チェックイン中のときだけ注文できます。",
  sold_out: "選んだ商品が売り切れになりました。数量を見直してください。",
  failed: "注文できませんでした。時間をおいて再試行してください。",
  denied: "この操作を行う権限がありません。",
};

/**
 * セルフ注文の確定（A5 ／ WBS 6-1）。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * Server Action は URL を持つエンドポイントとして公開されるため、
 * 「🔒 要チェックイン と表示している」だけでは防御にならない。
 *
 * ★ `checkin_id` をフォームから受け取らない。**サーバ側で本人の滞在から引く。**
 * 受け取ると、他人の `checkin_id` を送って他人の伝票に付け替えられる
 * （RLS の `orders_insert_self` も塞いでいるが、届かせないほうが読みやすい）。
 */
export async function placeSelfOrderAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.denied };
  }

  const stay = await fetchMyStayingCheckIn(viewer.memberId);
  if (stay === null) {
    return { status: "error", message: MESSAGE.not_staying };
  }

  const result = await placeOrder({
    checkinId: stay.checkinId,
    purchaserId: viewer.memberId,
    createdByMemberId: null,
    quantities: readQuantities(formData),
  });

  if (result.ok) {
    // 注文直後に自分の伝票が一覧へ反映されるようにする。
    revalidatePath("/orders");
    revalidatePath("/me");
    return { status: "done", message: "注文を受け付けました。" };
  }
  return { status: "error", message: MESSAGE[result.reason] ?? MESSAGE.failed };
}

/**
 * `quantity:<menu_item_id>` という名前の入力を数量表に畳む。
 *
 * 数量の上限をここで持たないのは、`order_items` の CHECK（`quantity > 0`）と
 * 在庫の概念が Phase 1 に無いためである。負数・非数は 0 に倒して黙って落とす。
 */
function readQuantities(formData: FormData): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("quantity:")) {
      continue;
    }
    const quantity = Number.parseInt(String(value), 10);
    if (Number.isSafeInteger(quantity) && quantity > 0) {
      quantities.set(key.slice("quantity:".length), quantity);
    }
  }
  return quantities;
}
