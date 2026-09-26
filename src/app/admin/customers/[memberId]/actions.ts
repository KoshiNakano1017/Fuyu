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
  fetchAdjustmentState,
  fetchOrderForEdit,
  issueSettlementQr,
  markOrderSettled,
  markOrderUnsettled,
  reassignPurchaser,
  resolveAdjustment,
} from "@/lib/orders/slip-store";
import {
  adjustmentResolveDenialMessage,
  decideAdjustmentResolution,
} from "@/lib/billing/adjustment";
import { canIssueSettlementQr } from "@/lib/billing/settlement-qr";
import { judgeFirstVisitCashback } from "@/lib/eumo/grants";
import { cancelStay } from "@/lib/lodging/cancellation";
import { decideStayCancellation } from "@/lib/lodging/checkin-ops";
import { fetchCheckInStatus } from "@/lib/lodging/fetch-checkin-board";
import {
  decideStayTicketAdjustment,
  formatBalanceTransition,
  stayTicketAdjustDenialMessage,
} from "@/lib/lodging/stay-ticket-adjust";
import {
  fetchStayTicketBalance,
  insertStayTicketAdjustment,
} from "@/lib/lodging/stay-tickets";
import { fetchAccommodationRates, fetchAccommodationTypes } from "@/lib/lodging/fetch-lodging";
import { memberCategoryOf } from "@/lib/lodging/rates";
import {
  applyStayChange,
  fetchCapacities,
  fetchOtherStayNights,
  fetchStayChangeHistory,
  fetchStayForChange,
  fetchStayOwner,
} from "@/lib/lodging/stay-change-store";
import {
  decideStayChange,
  describeStayChange,
  nightlyLodgingCharge,
  nightlyRoomTypes,
  stayChangeDenialMessage,
  type StayChangeDiff,
  type StayForChange,
} from "@/lib/lodging/stay-changes";
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
  stay_not_found: "予約が見つかりません。",
  stay_already_arrived: "入館済みの滞在は取り消せません。途中退去はチェックアウトで記録してください。",
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

/**
 * 差額の消し込み（WBS 8-3 ／ v13 §5.6.6）。
 *
 * ## 「精算済み」と「免除」を1つの操作にまとめない
 *
 * 前者は**受け取った**（現金・QR・返金のいずれかで現地で渡した）、後者は**諦めた**である。
 * 同じボタンにすると、後から回収率も未収の実態も読めなくなる。
 * DB 側も残す列が違う（`settled_*` / `waived_*` ／ `0019`）。
 *
 * ## 免除はコアメンバーにも許す
 *
 * 2026-08-16 回答。`admin` 限定に戻すと、少人数運営で現場の免除判断が止まる
 * （判定は `canWaive()` に置いてある）。
 */
export async function resolveAdjustmentAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const adjustmentId = String(formData.get("adjustmentId") ?? "").trim();
  const memberId = String(formData.get("memberId") ?? "").trim();
  const resolution = String(formData.get("resolution") ?? "");
  if (resolution !== "settle" && resolution !== "waive") {
    return { status: "error", message: "操作を特定できませんでした。" };
  }

  const current = await fetchAdjustmentState(adjustmentId);
  if (current === null) {
    return { status: "error", message: "対象の差額が見つかりません。" };
  }

  const decision = decideAdjustmentResolution({
    actorRole: viewer.role,
    resolution,
    status: current.status,
    isStale: current.isStale,
  });
  if (!decision.allowed) {
    return { status: "error", message: adjustmentResolveDenialMessage(decision.reason) };
  }

  const saved = await resolveAdjustment({
    adjustmentId,
    resolution,
    operatorId: viewer.memberId,
  });
  if (!saved) {
    // WHERE で `未処理` を条件にしているため、同時押しの2件目はここへ来る。
    return { status: "error", message: adjustmentResolveDenialMessage("already_resolved") };
  }

  revalidatePath(`/admin/customers/${memberId}`);
  revalidatePath("/admin");
  // 本人のマイログの未処理差額も変わる（v13 §5.6.6「本人への表示」）。
  revalidatePath("/me");
  return {
    status: "done",
    message: resolution === "settle" ? "精算済みにしました。" : "免除しました。",
  };
}

/**
 * 滞在中の宿泊形態・部屋・日程・人数の変更（WBS 3-10 ／ v13 §5.6.9）。
 *
 * ## 画面から届いた値を信じない
 *
 * 変更前の内容は `fetchStayForChange()` で引き直す。画面が描かれてから押されるまでの間に
 * 別の端末で変更されているかもしれず、**画面が持っていた「変更前」で履歴を書くと
 * 実際には起きていない差分が記録される**（`check_in_changes` は追記専用なので後から直せない）。
 *
 * ## 満室判定は自分を除いて数える
 *
 * `fetchOtherStayNights()` が自分の滞在を除外する。含めたまま数えると、
 * 人数を減らす変更さえ「満室」で弾かれる（自分の旧占有と新占有を二重に数えるため）。
 */
export async function changeStayAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const stay = await fetchStayForChange(checkinId);
  if (stay === null) {
    return { status: "error", message: "対象の滞在が見つかりません。" };
  }

  const roomId = String(formData.get("roomId") ?? "").trim();
  const input = {
    roomType: String(formData.get("roomType") ?? "").trim(),
    roomId: roomId === "" ? null : roomId,
    checkOutDate: String(formData.get("checkOutDate") ?? "").trim(),
    adultsCount: Number(formData.get("adultsCount") ?? Number.NaN),
    childrenCount: Number(formData.get("childrenCount") ?? Number.NaN),
    effectiveDate: String(formData.get("effectiveDate") ?? "").trim(),
    reason: String(formData.get("reason") ?? ""),
  };

  // 残枠を数える窓。**滞在の初日から、新旧どちらか遅い退去日まで**を見る
  // （短縮だけの変更でも、旧い日程に他人が入っていないかは判定に要らないが、
  //   窓を広く取っておくほうが「延泊 ＋ 形態変更」を1回で判定できる）。
  const toDate =
    ISO_DATE.test(input.checkOutDate) && input.checkOutDate > stay.checkOutDate
      ? input.checkOutDate
      : stay.checkOutDate;

  let others;
  try {
    others = await fetchOtherStayNights({
      excludeCheckinId: stay.checkinId,
      fromDate: stay.checkInDate,
      toDate,
    });
  } catch {
    // 他の滞在が読めないときに「空いている」と見なすとダブルブッキングを作る。操作を止める。
    return { status: "error", message: "残枠を確認できませんでした。時間をおいて再試行してください。" };
  }

  const [types, capacities] = await Promise.all([fetchAccommodationTypes(), fetchCapacities()]);

  const decision = decideStayChange({
    actorRole: viewer.role,
    stay,
    input,
    knownRoomTypes: types.map((type) => type.roomType),
    others,
    capacities,
  });
  if (!decision.allowed) {
    return { status: "error", message: stayChangeDenialMessage(decision.reason, decision.fullNight) };
  }

  const saved = await applyStayChange({
    stay,
    input,
    diff: decision.diff,
    operatorId: viewer.memberId,
  });
  if (!saved.logged || !saved.updated) {
    return {
      status: "error",
      message: saved.logged
        ? "変更履歴は記録できましたが、滞在の内容を更新できませんでした。画面を再読み込みして、もう一度実行してください。"
        : MESSAGE.failed,
    };
  }

  const memberId = (await fetchStayOwner(stay.checkinId)) ?? String(formData.get("memberId") ?? "");
  revalidatePath(`/admin/customers/${memberId}`);
  // 残枠と当日の板が変わる（v13 §5.2.5・§5.2.2）。本人のマイページの宿泊タブも変わる。
  revalidatePath("/staff/calendar");
  revalidatePath("/staff/checkins");
  revalidatePath("/reservations");

  return {
    status: "done",
    message: await describeStayChangeResult({
      stay,
      input,
      diff: decision.diff,
      roomMoved: saved.roomMoved,
    }),
  };
}

/** `YYYY-MM-DD` だけを日付として扱う（`<input type="date">` 以外から呼ばれても窓を壊さないため）。 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 変更後の宿泊費まで含めて報告する。
 *
 * ★ **泊単位で、その夜の形態の単価を積んだ額**である（v13 §5.6.9）。
 * 差額が出た場合の消し込みは §5.6.5／§5.6.6 の未処理差額の経路に載せる。
 * ⚠️ 宿泊費を伝票として起こす経路は Phase 1 にまだ無いため（`orders` は注文のみ）、
 *    ここでは額を**運営へ伝える**ところまでを担う（`0041` の冒頭「含まないもの」）。
 */
async function describeStayChangeResult(params: {
  stay: StayForChange;
  input: { roomType: string; checkOutDate: string };
  diff: StayChangeDiff;
  roomMoved: boolean;
}): Promise<string> {
  const { stay, input, diff } = params;
  const parts = [`滞在を変更しました（${describeStayChange(diff)}）。`];

  const [history, rates] = await Promise.all([
    fetchStayChangeHistory([stay.checkinId]),
    fetchAccommodationRates(),
  ]);
  const charge = nightlyLodgingCharge({
    nights: nightlyRoomTypes({
      stay: {
        checkInDate: stay.checkInDate,
        checkOutDate: input.checkOutDate,
        roomType: input.roomType,
      },
      changes: history.get(stay.checkinId) ?? [],
    }),
    rates,
    // 滞在の持ち主は `members` に行がある＝会員料金（`rates.ts` の `memberCategoryOf()` の規則）。
    memberCategory: memberCategoryOf(true),
  });
  parts.push(`宿泊費は ¥${charge.totalYen.toLocaleString("ja-JP")}（${charge.lines.length}泊）です。`);
  if (charge.missingRateNights > 0) {
    parts.push(
      `⚠️ ${charge.missingRateNights}泊は宿泊料金マスタに該当行が無く、合計に含めていません（マスタ管理で登録してください）。`,
    );
  }
  if (diff.room !== null && !params.roomMoved) {
    parts.push("⚠️ 部屋の割当は更新できませんでした。部屋割当をやり直してください。");
  }
  return parts.join(" ");
}

/**
 * 予約のキャンセル／ノーショー（画面ID C11 の「宿泊」タブ ／ WBS 3-3 ／ v13 §5.2.2）。
 *
 * 正本は操作場所を**顧客管理画面**と定めており（§5.2.2「操作場所」／ §6 L2344 の権限行も
 * 顧客管理画面の機能として与えている）、チェックイン板（`/staff/checkins`）の同じ操作は
 * 当日の板の中でしか届かない。処理の本体は `cancelStay()`（`check_ins` の論理削除 ＋
 * 部屋の解放を必ず一緒にやる）で、板と**同じ関数**を通す。条件を2箇所に書かない。
 *
 * ⚠️ **入館済み（`staying` / `checked_out`）は対象にしない。** 途中退去は「退館」であって
 * キャンセルではなく、キャンセルにすると滞在の記録が通算来訪回数・宿泊履歴（§5.6.8）から
 * 抜け落ちる。
 */
export async function cancelStayAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  // 街人・ゲストは実行できない（v13 §6 L2344 の権限行が `−`）。
  // 画面の `requireAdmin()` とは別にここでも判定する — Server Action は URL を持つ
  // 公開エンドポイントであり、画面を経由せずに呼べる（v13 §5.9.3）。
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return fail("not_staff");
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const current = await fetchCheckInStatus(checkinId);
  if (current === null) {
    return fail("stay_not_found");
  }
  // 「誰が」「どの状態の予約を」取り消せるかは `decideStayCancellation()` が持つ。
  // チェックイン板（`/staff/checkins`）の同じ操作と**同一の判定**を通す（条件を2箇所に書かない）。
  const decision = decideStayCancellation({ actorRole: viewer.role, status: current.status });
  if (!decision.allowed) {
    return fail(decision.reason === "already_arrived" ? "stay_already_arrived" : decision.reason);
  }

  const result = await cancelStay({
    checkinId,
    reasonType: String(formData.get("reasonType") ?? ""),
    reason: String(formData.get("reason") ?? ""),
    cancelledByMemberId: viewer.memberId,
  });

  if (!result.ok) {
    // `blank_reason` は伝票編集の理由（§5.6.4）と語が同じで意味が違う。
    // ここだけキャンセルの文言へ差し替える。
    return result.reason === "blank_reason"
      ? { status: "error", message: "キャンセルの理由を入力してください（v13 §5.2.2）。" }
      : fail(result.reason);
  }

  revalidatePath(`/admin/customers/${current.memberId}`);
  // 板・カレンダー・残枠、そして本人のマイページ（v13 §5.2.2「本人への表示」）も変わる。
  revalidatePath("/staff/checkins");
  revalidatePath("/staff/calendar");
  revalidatePath("/reservations");
  return {
    status: "done",
    message: `キャンセルしました（部屋の解放 ${result.releasedRoomAssignmentCount} 件）。`,
  };
}
