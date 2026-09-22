"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import {
  decideConfirmReceipt,
  decideManualGrant,
  decideMarkFailed,
  decideSend,
  type SentChannel,
} from "@/lib/eumo/grants";
import {
  fetchGrantStatus,
  insertGrant,
  markGrantFailed,
  markGrantReceived,
  markGrantSent,
} from "@/lib/eumo/store";
import type { SubmitState } from "@/lib/forms/submit-state";

/**
 * Eumo給付の操作（WBS 5-7 ／ v13 §5.3.1）。
 *
 * ⚠️ **判定を2箇所に置いている。** ここ（`decide*`）で止めるのは利用者へ理由を返すためで、
 * 本当の防壁は `0023` の RLS（`eumo_update_staff` / `eumo_insert_staff`）と CHECK 制約である。
 * 画面のボタンを外しても DB で止まる（v13 §5.9.3）。
 */

const MESSAGE: Record<string, string> = {
  not_staff: "この操作を行う権限がありません。",
  already_sent: "この給付は送付済みです。再送が必要なら送付失敗として記録してください。",
  already_received: "この給付は受領確認済みです。",
  not_sent_yet: "まだ送付していない給付を受領確認済みにはできません。",
  blank_channel: "送付経路を選んでください。",
  blank_reason: "失敗の理由を入力してください。",
  invalid_amount: "給付額は1以上の整数（Uii）で入力してください。",
  blank_purpose: "用途を入力してください（何のための給付かを後から辿れなくなります）。",
  not_found: "対象の給付が見つかりません。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
};

function fail(reason: string): SubmitState {
  return { status: "error", message: MESSAGE[reason] ?? MESSAGE.failed };
}

/** 「eumo で発行して送った」ことを記録する。 */
export async function markSentAction(_prev: SubmitState, formData: FormData): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const grantId = String(formData.get("grantId") ?? "").trim();
  const sentChannel = String(formData.get("sentChannel") ?? "");
  const status = await fetchGrantStatus(grantId);
  if (status === null) {
    return fail("not_found");
  }

  const decision = decideSend({ actorRole: viewer.role, status, sentChannel });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const saved = await markGrantSent({
    grantId,
    staffId: viewer.memberId,
    sentChannel: sentChannel as SentChannel,
    sentTo: String(formData.get("sentTo") ?? "").trim(),
    eumoUrl: String(formData.get("eumoUrl") ?? "").trim(),
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath("/staff/eumo");
  return { status: "done", message: "送付済みとして記録しました。" };
}

/** 受領を確認する。本人の受領報告でも同じ経路を通る（v13 §5.3.1 拡張）。 */
export async function confirmReceiptAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const grantId = String(formData.get("grantId") ?? "").trim();
  const status = await fetchGrantStatus(grantId);
  if (status === null) {
    return fail("not_found");
  }

  const decision = decideConfirmReceipt({ actorRole: viewer.role, status });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const saved = await markGrantReceived({ grantId, confirmedBy: viewer.memberId });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath("/staff/eumo");
  return { status: "done", message: "受領確認済みにしました。" };
}

/** 送付に失敗したことを記録する（理由が無いと再送の判断ができない）。 */
export async function markFailedAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const grantId = String(formData.get("grantId") ?? "").trim();
  const failureReason = String(formData.get("failureReason") ?? "");
  const status = await fetchGrantStatus(grantId);
  if (status === null) {
    return fail("not_found");
  }

  const decision = decideMarkFailed({ actorRole: viewer.role, status, failureReason });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const saved = await markGrantFailed({ grantId, failureReason: failureReason.trim() });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath("/staff/eumo");
  return { status: "done", message: "送付失敗として記録しました。" };
}

/**
 * 手動起票（v13 §5.3.1 ／ #59 論点1）。
 *
 * システム導入前に発行した分の取り込みも、自動判定が漏れた例外対応も、この1本を通る。
 * 一括インポートのパイプラインは**作らないと決まっている**（2026-09-22 オーナー確定）。
 */
export async function createManualGrantAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const memberId = String(formData.get("memberId") ?? "").trim();
  const amountUii = Number(formData.get("amountUii") ?? Number.NaN);
  const purpose = String(formData.get("purpose") ?? "");

  const decision = decideManualGrant({ actorRole: viewer.role, amountUii, purpose });
  if (!decision.allowed) {
    return fail(decision.reason);
  }
  if (memberId === "") {
    return fail("not_found");
  }

  const saved = await insertGrant({
    member_id: memberId,
    amount_uii: amountUii,
    grant_type: "manual",
    purpose: purpose.trim(),
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath("/staff/eumo");
  return { status: "done", message: "手動で発行依頼を起票しました。" };
}
