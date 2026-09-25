"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import { approvalMatchBasis } from "@/lib/members/matching";
import { linkMemberByMatching } from "@/lib/members/matching-store";
import {
  fetchLinkRequestState,
  rejectLinkRequest,
} from "@/lib/members/link-queue-store";

/**
 * 名寄せの運営承認キューの決着（WBS 10-2 ／ v13 §5.8.3 ①）。
 *
 * ## 認可は staff である
 *
 * ①画面（`requireStaff()`）②ここ ③`0039` の `member_link_requests_update_staff`。
 * `member_identifiers`（`0025`）と同じ幅に揃えてある — キューは**照合に使った連絡先（PII-A）**を
 * 持つため、一般会員には1行も見せない。
 *
 * ## 承認は「誰の宿泊券を誰へ渡すか」を決める操作である
 *
 * 名寄せの成立は他人の宿泊券・Uii残高・XP の引き継ぎを意味する（§5.8.3 の [!warning]）。
 * したがって**候補の中から選ばせる**（自由入力の `member_id` を受け取らない）。
 * 受け取った `memberId` が現在の候補に含まれるかを、決着の直前にもう一度確かめる。
 */

async function readStaffViewer() {
  const viewer = await readViewer();
  if (!viewer.signedIn || (viewer.role !== "admin" && viewer.role !== "core_member")) {
    return null;
  }
  return viewer;
}

const MESSAGE = {
  not_staff: "この操作を行う権限がありません。",
  not_found: "対象の申請が見つかりません。",
  resolved: "この申請は既に決着しています。",
  no_member: "結合する会員を選んでください。",
  not_candidate: "選んだ会員は現在の候補に含まれていません（候補を読み直してください）。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
} as const;

/**
 * 承認して名寄せを成立させる。
 *
 * ★ 結合・監査記録・キューの決着を **`0040` の RPC 1本**で行う。分けると
 * 「結合済みなのにキューは保留のまま」が残り、運営が同じ申請をもう一度承認しようとする
 * （2回目は `members.auth_user_id` の一意制約で落ちるが、理由の分からない失敗として見える）。
 */
export async function approveLinkRequestAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_staff };
  }

  const requestId = String(formData.get("requestId") ?? "").trim();
  const memberId = String(formData.get("memberId") ?? "").trim();
  if (memberId === "") {
    return { status: "error", message: MESSAGE.no_member };
  }

  const current = await fetchLinkRequestState(requestId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }
  if (current.status !== "保留") {
    return { status: "error", message: MESSAGE.resolved };
  }

  const linked = await linkMemberByMatching({
    memberId,
    authUserId: current.authUserId,
    matchBasis: approvalMatchBasis({
      matchKind: current.matchedKind,
      candidateCount: current.candidateCount,
    }),
    decidedBy: viewer.memberId,
    requestId,
    identifierKind: current.matchedKind,
    identifierValue: current.matchedValue,
  });

  if (!linked) {
    // 候補から外れていた（既に結合済み・退会）／一意制約に当たった、のいずれか。
    // どれに当たったかは画面で候補を読み直せば分かるため、文言は1つにする。
    return { status: "error", message: MESSAGE.not_candidate };
  }

  revalidatePath("/admin/members/link-requests");
  return {
    status: "done",
    message: "名寄せを成立させました（監査ログに根拠を記録しました）。",
  };
}

/** 却下（理由必須 ／ §5.8.3 ③ の監査の一部）。 */
export async function rejectLinkRequestAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readStaffViewer();
  if (viewer === null) {
    return { status: "error", message: MESSAGE.not_staff };
  }

  const requestId = String(formData.get("requestId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  if (reason.trim() === "") {
    return { status: "error", message: "却下の理由を入力してください。" };
  }

  const current = await fetchLinkRequestState(requestId);
  if (current === null) {
    return { status: "error", message: MESSAGE.not_found };
  }
  if (current.status !== "保留") {
    return { status: "error", message: MESSAGE.resolved };
  }

  const saved = await rejectLinkRequest({
    requestId,
    reason: reason.trim(),
    resolvedBy: viewer.memberId,
  });
  if (!saved) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/admin/members/link-requests");
  return { status: "done", message: "却下しました（理由を記録しました）。" };
}
