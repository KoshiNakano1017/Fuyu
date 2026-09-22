"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import {
  decideCancel,
  decideReassign,
  decideSlipEdit,
  planCancellation,
  planSlipEdit,
} from "@/lib/orders/slip-edit";
import {
  applySlipEdit,
  cancelOrder,
  fetchOrderForEdit,
  issueSettlementQr,
  markOrderSettled,
  markOrderUnsettled,
  reassignPurchaser,
} from "@/lib/orders/slip-store";
import { canIssueSettlementQr } from "@/lib/billing/settlement-qr";

/**
 * 顧客管理画面の操作（WBS 7-2 伝票管理 ／ 7-3 精算QR）。
 *
 * ## 認可を3重に置いている
 *
 * ① 画面（`page.tsx` の `requireAdmin()`）② ここ（`isStaff` 判定）
 * ③ DB（`0019` の `orders_update_staff` / `order_items_update_staff`）。
 * ②が要るのは、Server Action が URL を持つ公開エンドポイントであり、
 * 画面を経由せずに呼べるためである（v13 §5.9.3）。
 *
 * ⚠️ 画面は管理者限定（v13 §5.9.1 の「管理者PCダッシュボード（顧客管理・一括精算）」）だが、
 * **操作そのものはコアメンバーにも許されている**（v13 §6 L2332「請求精算額の手動調整・
 * 決済ステータス変更・精算QR再発行」＝管理者〇・コアメンバー〇）。したがって
 * Action 側の判定は staff であり、admin ではない。DB の RLS もこれに揃えてある。
 */

const MESSAGE: Record<string, string> = {
  not_staff: "この操作を行う権限がありません。",
  blank_reason: "編集理由の入力が必要です（v13 §5.6.4）。",
  order_cancelled: "取消済みの伝票は編集できません。",
  empty_lines: "明細をすべて取り消す場合は、伝票の取消を使ってください。",
  invalid_quantity: "数量は1以上の整数で入力してください。",
  invalid_price: "単価は0以上の整数で入力してください。",
  same_purchaser: "付け替え先を選んでください。",
  not_found: "伝票が見つかりません。",
  not_unsettled: "未会計の伝票にだけ精算QRを発行できます。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
};

function fail(reason: string): SubmitState {
  return { status: "error", message: MESSAGE[reason] ?? MESSAGE.failed };
}

async function readStaffViewer() {
  const viewer = await readViewer();
  if (!viewer.signedIn || (viewer.role !== "admin" && viewer.role !== "core_member")) {
    return null;
  }
  return viewer;
}

/**
 * 明細の編集（数量・単価・行の取消）（v13 §5.6.2・§5.6.3）。
 *
 * 精算済みの伝票を直した場合は、差額が `settlement_adjustments` へ「未処理」として残る
 * （§5.6.5-3）。生きている精算QRは自動で失効する（§5.6.3-5）。
 */
export async function editSlipAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const order = await fetchOrderForEdit(orderId);
  if (order === null) {
    return fail("not_found");
  }

  const voidedItemIds = formData.getAll("voidItemId").map(String);
  const updates = order.lines
    .filter((line) => !voidedItemIds.includes(line.itemId))
    .map((line) => ({
      itemId: line.itemId,
      quantity: Number(formData.get(`quantity_${line.itemId}`) ?? line.quantity),
      unitPriceYen: Number(formData.get(`unitPrice_${line.itemId}`) ?? line.unitPriceYen),
    }));

  const nextLines = updates.map((update) => ({
    productName: order.lines.find((line) => line.itemId === update.itemId)?.productName ?? "",
    unitPriceYen: update.unitPriceYen,
    quantity: update.quantity,
  }));

  const decision = decideSlipEdit({
    actorRole: viewer.role,
    orderStatus: order.status,
    reason,
    lines: nextLines,
  });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const plan = planSlipEdit({
    lines: nextLines,
    orderStatus: order.status,
    settledAmountYen: order.totalAmountYen,
    hasActiveQr: order.hasActiveQr,
  });

  const saved = await applySlipEdit({
    orderId,
    editorId: viewer.memberId,
    reason: reason.trim(),
    updates,
    voidedItemIds,
    plan,
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${order.purchaserId}`);
  return { status: "done", message: describeEditResult(plan) };
}

/** 編集結果の要約。差額とQR失効は**必ず読み手へ伝える**（v13 §5.6.5-2・§5.6.3-5）。 */
function describeEditResult(plan: ReturnType<typeof planSlipEdit>): string {
  const parts = [`伝票を更新しました（合計 ${plan.totals.totalAmountUii} Uii）。`];
  if (plan.difference !== null) {
    const label = plan.difference.category === "追加請求" ? "追加請求" : "返金";
    parts.push(`精算済みのため差額 ${Math.abs(plan.difference.amountYen)} 円を${label}として未処理で残しました。`);
  }
  if (plan.revokeQr) {
    parts.push("発行済みの精算QRは失効しました。必要なら再発行してください。");
  }
  return parts.join(" ");
}

/** 注文者の付け替え（v13 §5.6.2「代理注文の誤選択を救済」）。 */
export async function reassignPurchaserAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  // ★ 滞在と本人を1つの選択肢に束ねて受け取る（代理注文の `StayingPicker` と同じ形）。
  //   別々に受け取ると「A さんの滞在に B さんの伝票」を組み立てられてしまう。
  const [nextCheckinId, nextPurchaserId] = String(formData.get("stay") ?? "").split(":");

  const order = await fetchOrderForEdit(orderId);
  if (order === null) {
    return fail("not_found");
  }

  const decision = decideReassign({
    actorRole: viewer.role,
    orderStatus: order.status,
    reason,
    currentPurchaserId: order.purchaserId,
    nextPurchaserId: nextPurchaserId ?? "",
  });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const moved = await reassignPurchaser({
    orderId,
    nextPurchaserId: nextPurchaserId ?? "",
    nextCheckinId: nextCheckinId ?? "",
    editorId: viewer.memberId,
    reason: reason.trim(),
  });
  if (!moved) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${order.purchaserId}`);
  revalidatePath(`/admin/customers/${nextPurchaserId}`);
  return { status: "done", message: "注文者を付け替えました。精算QRは失効しています。" };
}

/** 伝票の取消（論理削除 ／ v13 §5.6.2・§5.6.5-5）。 */
export async function cancelOrderAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const order = await fetchOrderForEdit(orderId);
  if (order === null) {
    return fail("not_found");
  }

  const decision = decideCancel({
    actorRole: viewer.role,
    orderStatus: order.status,
    reason,
  });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const difference = planCancellation({
    orderStatus: order.status,
    settledAmountYen: order.totalAmountYen,
  });

  const cancelled = await cancelOrder({
    orderId,
    editorId: viewer.memberId,
    reason: reason.trim(),
    difference,
  });
  if (!cancelled) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${order.purchaserId}`);
  return {
    status: "done",
    message:
      difference === null
        ? "伝票を取り消しました（履歴には残ります）。"
        : `伝票を取り消し、精算済みの ${Math.abs(difference.amountYen)} 円を返金差額として残しました。`,
  };
}

/**
 * 精算QRを発行する（WBS 7-3 ／ v13 §5.6.1④）。
 *
 * ⚠️ **平文のトークンは1度しか表示されない。** 保存しているのはハッシュだけで、
 * 再表示の手段は無い（`src/lib/billing/settlement-qr.ts`）。見失ったら再発行する。
 */
export async function issueSettlementQrAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const order = await fetchOrderForEdit(orderId);
  if (order === null) {
    return fail("not_found");
  }
  if (!canIssueSettlementQr(order.status)) {
    return fail("not_unsettled");
  }

  const issued = await issueSettlementQr({ orderId, staffId: viewer.memberId });
  if (issued === null) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${order.purchaserId}`);
  return {
    status: "done",
    // ⚠️ この文字列はログへ出さない（画面へ1度だけ返す）。
    message: `精算トークン: ${issued.token}（有効期限 ${issued.expiresAt.toLocaleString("ja-JP")}／この表示を閉じると再確認できません）`,
  };
}

/** 決済ステータスの手動切替（v13 §5.6.2）。現金・Eumo手渡し等の場外精算に対応する。 */
export async function toggleSettlementStatusAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const orderId = String(formData.get("orderId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const order = await fetchOrderForEdit(orderId);
  if (order === null) {
    return fail("not_found");
  }
  if (order.status === "取消") {
    return fail("order_cancelled");
  }

  if (order.status === "未会計") {
    const settled = await markOrderSettled({ orderId, staffId: viewer.memberId });
    if (!settled) {
      return fail("failed");
    }
    revalidatePath(`/admin/customers/${order.purchaserId}`);
    return { status: "done", message: "精算済みにしました。" };
  }

  // 精算済み → 未会計へ戻すのは金額が動く操作なので、理由を必須にする（§5.6.4）。
  if (reason.trim() === "") {
    return fail("blank_reason");
  }
  const reverted = await markOrderUnsettled({ orderId, staffId: viewer.memberId, reason: reason.trim() });
  if (!reverted) {
    return fail("failed");
  }
  revalidatePath(`/admin/customers/${order.purchaserId}`);
  return { status: "done", message: "未会計へ戻しました。精算QRは失効しています。" };
}
