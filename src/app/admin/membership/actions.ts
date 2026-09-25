"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import {
  decideApprove,
  decideIssueQr,
  decideRecordCash,
  decideReject,
  issueMembershipQrToken,
  operationDenialMessage,
  type PaymentMethod,
  type QrDeliveryChannel,
} from "@/lib/membership/approval";
import {
  approveApplication,
  fetchApplicationState,
  issueMembershipQr,
  recordPayment,
  rejectApplication,
} from "@/lib/membership/approval-store";

/**
 * 街人登録申請一覧（画面ID C7）の運営操作（WBS 12-2 Step 3〜5 ／ v13 §5.10.4・§5.10.7）。
 *
 * ## 認可は admin である（v13 §6「申請一覧は admin」）
 *
 * 伝票まわり（`7-2`）と違い、ここは **`core_member` に開けない**。
 * ①画面（`requireAdmin()`）②ここ ③`0037` の `membership_app_update_admin`
 * ④承認は `0038` の RPC が申告された操作者の role を自分で確かめる、の4重になっている。
 *
 * ## 「見つかりません」で統一する
 *
 * RLS 越しに読めない申請（admin でなければ他人の申請）は `null` で返る。
 * ここで「他の人の申請です」と返すと**存在そのものが分かる**ため、一律の文言にする。
 */

const MESSAGE = {
  not_admin: "この操作を行う権限がありません。",
  not_found: "対象の申請が見つかりません。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
} as const;

async function readAdminViewer() {
  const viewer = await readViewer();
  if (!viewer.signedIn || viewer.role !== "admin") {
    return null;
  }
  return viewer;
}

/**
 * 入金QRを発行して送付経路を記録する（Step 3）。
 *
 * ★ 平文トークンは**この戻り値で1度だけ返す**（DB にはハッシュだけを入れる）。
 * 画面はそれを表示・QR化して送付するが、再表示はできない（再発行が必要になる）。
 */
export async function issueMembershipQrAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readAdminViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_admin };
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const channel = String(formData.get("channel") ?? "") as QrDeliveryChannel;
  if (!isDeliveryChannel(channel)) {
    return { status: "error", message: "送付経路を選んでください。" };
  }

  const current = await fetchApplicationState(applicationId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }

  const decision = decideIssueQr({
    status: current.status,
    paymentMethod: current.paymentMethod as PaymentMethod | null,
  });
  if (!decision.allowed) {
    return { status: "error", message: operationDenialMessage(decision.reason) };
  }

  const issued = issueMembershipQrToken(new Date());
  const saved = await issueMembershipQr({
    applicationId,
    tokenHash: issued.tokenHash,
    expiresAt: issued.expiresAt,
    channel,
    issuedBy: viewer.memberId,
  });
  if (!saved) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/admin/membership");
  // ★ 平文はここでしか出ない。メッセージに載せるのは「1度だけ返す」設計そのものである。
  return {
    status: "done",
    message: `入金QRを発行しました（有効期限 ${issued.expiresAt.toLocaleDateString("ja-JP")}）。トークン: ${issued.token}`,
  };
}

/**
 * 決済手段と受領を記録する（Step 4 ／ §5.10.7）。
 *
 * 現金のときは**操作している運営自身**を受領者として残す（誰が受け取ったかを追う）。
 * 現金へ切り替えると、発行済みQRは `0037` のトリガーが失効させる。
 */
export async function recordPaymentAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readAdminViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_admin };
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const method = String(formData.get("method") ?? "") as PaymentMethod;
  if (!isPaymentMethod(method)) {
    return { status: "error", message: "決済手段を選んでください。" };
  }

  const current = await fetchApplicationState(applicationId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }

  const decision = decideRecordCash({ status: current.status, receivedBy: viewer.memberId });
  if (!decision.allowed) {
    return { status: "error", message: operationDenialMessage(decision.reason) };
  }

  const saved = await recordPayment({
    applicationId,
    method,
    receivedBy: viewer.memberId,
  });
  if (!saved) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/admin/membership");
  return { status: "done", message: "受領を記録しました。承認に進めます。" };
}

/**
 * 承認して登録を成立させる（Step 5 ／ §5.10.5）。
 *
 * 昇格・宿泊券付与・キャッシュバック起票は `0038` の RPC が1トランザクションで行う。
 * ここで4回に分けて呼ばない（途中で落ちると二重付与の余地が残る）。
 */
export async function approveApplicationAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readAdminViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_admin };
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const current = await fetchApplicationState(applicationId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }

  const decision = decideApprove({
    status: current.status,
    paymentMethod: current.paymentMethod as PaymentMethod | null,
    paidAt: current.paidAt,
  });
  if (!decision.allowed) {
    return { status: "error", message: operationDenialMessage(decision.reason) };
  }

  const approved = await approveApplication({ applicationId, operatorId: viewer.memberId });
  if (!approved) {
    return {
      status: "error",
      message: "承認できませんでした。申請の状態と決済の記録を確認してください。",
    };
  }

  revalidatePath("/admin/membership");
  // 昇格した本人の画面（マイページ・クエスト板の施錠）も変わる。
  revalidatePath("/me");
  revalidatePath("/quests");
  return {
    status: "done",
    message: "承認しました。街人へ昇格し、宿泊券とキャッシュバックの発行依頼を起票しました。",
  };
}

/** 却下（§5.10.4「理由を入力し、ユーザーへ通知する」）。 */
export async function rejectApplicationAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readAdminViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_admin };
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");

  const current = await fetchApplicationState(applicationId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }

  const decision = decideReject({ status: current.status, reason });
  if (!decision.allowed) {
    return { status: "error", message: operationDenialMessage(decision.reason) };
  }

  const saved = await rejectApplication({ applicationId, reason: reason.trim() });
  if (!saved) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/admin/membership");
  return { status: "done", message: "却下しました（理由を記録しました）。" };
}

function isPaymentMethod(value: string): value is PaymentMethod {
  return value === "settlement_qr" || value === "cash" || value === "uii_qr";
}

function isDeliveryChannel(value: string): value is QrDeliveryChannel {
  return value === "line" || value === "in_app" || value === "in_person";
}
