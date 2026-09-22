"use server";

import { revalidatePath } from "next/cache";

import { viewerIsStaff } from "@/lib/auth/guard";
import { readViewer } from "@/lib/auth/session";
import { placeOrder } from "@/lib/orders/place-order";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ServingStatus } from "@/lib/serving-status";

import type { SubmitState } from "@/lib/forms/submit-state";

const DENIED: SubmitState = { status: "error", message: "この操作を行う権限がありません。" };
const FAILED: SubmitState = {
  status: "error",
  message: "処理できませんでした。時間をおいて再試行してください。",
};

/**
 * 提供ステータスを「提供済み」にする（WBS 6-5）。
 *
 * ⚠️ **会計ステータスに触らない。** v13 §5.4.1／§9 #39 は
 * 「提供済みかどうか」と「精算済みかどうか」を**独立した2軸**と定めている。
 * ここで `status` も動かすと、出しただけの伝票が会計済みに見えて取り漏れる。
 *
 * `served_by` を必ず入れるのは `chk_orders_served_has_operator`（`0019`）の要求であり、
 * 「誰が出したか」を後から辿れるようにするためでもある。
 */
export async function markServedAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !(await viewerIsStaff())) {
    return DENIED;
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  if (orderId === "") {
    return FAILED;
  }

  // 保存値は型で縛る。表示語（「調理中」）を誤って書き込むと CHECK 制約で落ちる
  const served: ServingStatus = "提供済み";

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("orders")
    .update({
      serving_status: served,
      served_at: new Date().toISOString(),
      served_by: viewer.memberId,
    })
    .eq("order_id", orderId);

  if (error) {
    return FAILED;
  }
  revalidatePath("/staff/orders");
  return { status: "done", message: "提供済みにしました。" };
}

/**
 * 売り切れトグル（WBS 6-3）。
 *
 * ★ `is_sold_out` 以外の列を送らない。`0018` の GRANT が
 * `UPDATE (is_sold_out, updated_at, updated_by)` に絞られており、
 * 他の列を混ぜると**更新そのものが失敗する**（値段をコアメンバーが動かせないようにする設計）。
 */
export async function toggleSoldOutAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !(await viewerIsStaff())) {
    return DENIED;
  }

  const menuItemId = String(formData.get("menuItemId") ?? "").trim();
  const soldOut = String(formData.get("soldOut") ?? "") === "true";
  if (menuItemId === "") {
    return FAILED;
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("menu_items")
    .update({
      is_sold_out: soldOut,
      updated_at: new Date().toISOString(),
      updated_by: viewer.memberId,
    })
    .eq("menu_item_id", menuItemId);

  if (error) {
    return FAILED;
  }
  revalidatePath("/staff/orders");
  revalidatePath("/orders");
  return { status: "done", message: soldOut ? "売り切れにしました。" : "販売を再開しました。" };
}

/**
 * 代理注文（B3 ／ WBS 6-2）。
 *
 * ★ 相手は**滞在中のチェックインからしか選べない**。`checkin_id` を受け取るのは
 * セルフ注文（本人の滞在をサーバで引く）と違い、店員が「誰の伝票か」を選ぶ操作だからである。
 * 任意の `checkin_id` を送られても、`orders_insert_staff` が staff であることを要求し、
 * `orders.checkin_id` の外部キーが実在する滞在であることを保証する。
 */
export async function placeProxyOrderAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !(await viewerIsStaff())) {
    return DENIED;
  }

  // `<checkin_id>:<member_id>` の組で届く（`StayingPicker`）。分けて受け取ると
  // 「他人の滞在に別人の伝票」を組み立てられるため、1つの値として扱う。
  const [checkinId = "", purchaserId = ""] = String(formData.get("stay") ?? "").split(":");
  if (checkinId === "" || purchaserId === "") {
    return { status: "error", message: "注文する方を選んでください。" };
  }

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

  const result = await placeOrder({
    checkinId,
    purchaserId,
    createdByMemberId: viewer.memberId,
    quantities,
  });

  if (result.ok) {
    revalidatePath("/staff/orders");
    return { status: "done", message: "代理注文を登録しました。" };
  }

  const MESSAGE: Record<string, string> = {
    empty_cart: "数量を1つ以上選んでください。",
    not_staying: "選んだ方は滞在中ではありません。",
    sold_out: "選んだ商品が売り切れになりました。",
    failed: "登録できませんでした。",
  };
  return { status: "error", message: MESSAGE[result.reason] ?? MESSAGE.failed };
}
