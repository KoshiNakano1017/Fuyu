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
import { judgeFirstVisitCashback } from "@/lib/eumo/grants";
import {
  decideStayTicketAdjustment,
  formatBalanceTransition,
  stayTicketAdjustDenialMessage,
} from "@/lib/lodging/stay-ticket-adjust";
import {
  fetchStayTicketBalance,
  insertStayTicketAdjustment,
} from "@/lib/lodging/stay-tickets";
import {
  countVisits,
  fetchCashbackStatus,
  fetchCurrentSignupCashbackUii,
  fetchMemberOrigin,
  insertGrant,
} from "@/lib/eumo/store";

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

/**
 * 初回来訪キャッシュバックの起票（WBS 12-4 ／ v13 §5.10.8 ②④）。
 *
 * ## 自動起票と手動起票を1つの入口にまとめている
 *
 * 判定（`judgeFirstVisitCashback()`）が `auto_draft` を返したときはその額で、
 * `needs_review` のときは**運営が額を入力して**起こす。入口を分けると
 * 「要確認」の人だけ別画面へ行くことになり、現場ではどちらかが使われなくなる。
 *
 * ## 二重付与は書く直前にもう一度見る
 *
 * 画面に出した判定は描画した時点のものである。その間に別の端末で起票されているかもしれない。
 * eumo の送金はアプリ外であり、**二重に送ると取り消せない**（v13 §5.10.8 ③）。
 */
export async function issueFirstVisitCashbackAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const memberId = String(formData.get("memberId") ?? "").trim();
  const [origin, visitCount, existing, planCashbackUii] = await Promise.all([
    fetchMemberOrigin(memberId),
    countVisits(memberId),
    fetchCashbackStatus(memberId),
    fetchCurrentSignupCashbackUii(),
  ]);
  if (origin === null) {
    return fail("not_found");
  }

  const judgement = judgeFirstVisitCashback({
    memberType: origin.memberType,
    visitCount,
    existingCashbackStatus: existing,
    isImportedMember: origin.isImportedMember,
    planCashbackUii,
  });

  if (judgement.kind === "already_issued") {
    return { status: "error", message: "この会員には既にキャッシュバックの給付があります。" };
  }
  if (judgement.kind === "not_applicable") {
    return { status: "error", message: judgement.note };
  }

  // `needs_review` のときは運営が額を決める。自動判定できた場合はその額を使う。
  const inputAmount = Number(formData.get("amountUii") ?? Number.NaN);
  const amountUii = judgement.kind === "auto_draft" ? judgement.amountUii : inputAmount;
  if (!Number.isInteger(amountUii) || amountUii <= 0) {
    return { status: "error", message: "給付額は1以上の整数（Uii）で入力してください。" };
  }

  const saved = await insertGrant({
    member_id: memberId,
    amount_uii: amountUii,
    grant_type: "first_visit_cashback",
    purpose: `初回来訪キャッシュバック（通算${visitCount}回目の来訪時に起票）`,
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${memberId}`);
  revalidatePath("/staff/eumo");
  return {
    status: "done",
    message: `初回来訪キャッシュバック ${amountUii} Uii を発行依頼として起票しました。`,
  };
}

/**
 * 宿泊券の手動増減（WBS 10-4 ／ v13 §5.8.5「運営による手動増減」）。
 *
 * ## 残高は上書きしない
 *
 * `staff_adjust` の取引を1行積むだけである。残高は `stay_ticket_balance()`（取引の合計）が
 * 唯一の出所であり、保存された残高を書き換える経路はどこにも作らない（同節「消費との整合」）。
 *
 * ## 操作できるのは admin と core_member
 *
 * 2026-09-25 のオーナー決定（決定ログ §23-3 ／ Issue #95）で、正本 v13 §5.8.5 が正しいことが
 * 確定した（`API設計.md`・`画面設計.md` C8 の「admin のみ」は同日に訂正済み）。
 * 認可の実体は `0016` の `stay_tx_insert_staff` であり、ここの判定はそれと同じ幅にしてある。
 *
 * ## 理由は3重に必須である
 *
 * ① 画面の `required` ② ここ（`decideStayTicketAdjustment`）③ `0016` の
 * `chk_stay_tx_manual_needs_reason`。②が要るのは利用者へ理由を返すためで、
 * 画面を経由しない呼び出しでも③で必ず落ちる（v13 §5.9.3 の二重防御）。
 */
export async function adjustStayTicketsAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const memberId = String(formData.get("memberId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const nights = Number(formData.get("nights") ?? Number.NaN);

  // 調整前の残高を読む。前後の残高を記録には持たないため、判定のためだけに使う
  // （`would_go_negative` の判断と、操作後の報告文に出す値）。
  const currentBalance = await fetchStayTicketBalance(memberId);

  const decision = decideStayTicketAdjustment({
    actorRole: viewer.role,
    nights,
    reason,
    currentBalance,
  });
  if (!decision.allowed) {
    return { status: "error", message: stayTicketAdjustDenialMessage(decision.reason) };
  }

  const saved = await insertStayTicketAdjustment({
    memberId,
    nights,
    reason: reason.trim(),
    operatorId: viewer.memberId,
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath(`/admin/customers/${memberId}`);
  // 本人のマイログにも即時反映させる（v13 §5.8.5「本人への反映」）。
  revalidatePath("/me");
  return {
    status: "done",
    message: `宿泊券を ${formatBalanceTransition(currentBalance, nights)} に調整しました。`,
  };
}
