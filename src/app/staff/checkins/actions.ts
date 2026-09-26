"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import { judgeFirstVisitCashback } from "@/lib/eumo/grants";
import {
  countVisits,
  fetchCashbackStatus,
  fetchCurrentSignupCashbackUii,
  fetchMemberOrigin,
  insertGrant,
} from "@/lib/eumo/store";
import type { SubmitState } from "@/lib/forms/submit-state";
import { cancelStay } from "@/lib/lodging/cancellation";
import { decideCheckIn, decideCheckOut, decideStayCancellation } from "@/lib/lodging/checkin-ops";
import { fetchCheckInStatus, updateCheckInStatus } from "@/lib/lodging/fetch-checkin-board";

/**
 * チェックイン／チェックアウト操作（WBS 3-2 ／ v13 §5.2.2・§5.10.8 ②）。
 *
 * ⚠️ 判定は3箇所にある。ここ（`decide*`）は利用者へ理由を返すため、
 * `0014` の `check_ins_update_staff` が本当の防壁、そして
 * `updateCheckInStatus()` の `eq("status", expected)` が**別端末との取り合い**を防ぐ。
 */

const MESSAGE: Record<string, string> = {
  not_staff: "この操作を行う権限がありません。",
  already_staying: "この方は既に滞在中です。",
  already_checked_out: "この滞在は退館済みです。",
  cancelled: "この予約はキャンセル済みです。",
  already_cancelled: "この予約は既にキャンセル済みです。",
  already_arrived: "入館済みの滞在は取り消せません。途中退去はチェックアウトで記録してください。",
  not_staying: "滞在中の方だけが退館できます。",
  not_found: "対象の滞在が見つかりません。",
  conflict: "別の端末が先に操作しました。画面を再読み込みしてください。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
};

function fail(reason: string): SubmitState {
  return { status: "error", message: MESSAGE[reason] ?? MESSAGE.failed };
}

/**
 * チェックインを確定する。
 *
 * ## 初回来訪キャッシュバックはここで起票する（v13 §5.10.8 ②）
 *
 * 「チェックイン確定時、**初回来訪かつ街人**と判定されたら `eumo_grants` へ
 * `first_visit_cashback`・`未送付`（＝発行依頼）で自動起票する」が仕様である。
 * 顧客管理画面からの手動起票（WBS 12-4）と同じ判定関数を通しており、
 * **判定の置き場所は1つ**である（2箇所に書くと、片方だけ条件が古くなる）。
 *
 * ⚠️ 起票に失敗してもチェックインは巻き戻さない。現場の入館を給付の都合で止めないためで、
 * 代わりに画面へ「起票できなかった」ことを返す（運営が給付一覧から手動で起こせる）。
 */
export async function checkInAction(_prev: SubmitState, formData: FormData): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const current = await fetchCheckInStatus(checkinId);
  if (current === null) {
    return fail("not_found");
  }

  const decision = decideCheckIn({ actorRole: viewer.role, status: current.status });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const moved = await updateCheckInStatus({
    checkinId,
    next: "staying",
    expected: current.status,
  });
  if (!moved) {
    return fail("conflict");
  }

  const cashbackNote = await draftFirstVisitCashback(current.memberId);
  revalidatePath("/staff/checkins");
  revalidatePath("/staff/orders");
  return {
    status: "done",
    message: `チェックインしました。${cashbackNote}`,
  };
}

/** 退館させる。会計は別（未会計の伝票は残り、顧客管理画面で精算する）。 */
export async function checkOutAction(_prev: SubmitState, formData: FormData): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_staff");
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const current = await fetchCheckInStatus(checkinId);
  if (current === null) {
    return fail("not_found");
  }

  const decision = decideCheckOut({ actorRole: viewer.role, status: current.status });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const moved = await updateCheckInStatus({
    checkinId,
    next: "checked_out",
    expected: current.status,
  });
  if (!moved) {
    return fail("conflict");
  }

  revalidatePath("/staff/checkins");
  revalidatePath("/staff/orders");
  return { status: "done", message: "退館の記録をしました。" };
}

/**
 * 初回来訪キャッシュバックの自動起票。戻り値は画面へ足す一文である。
 *
 * **「起票しなかった」ことも必ず伝える。** 黙って何もしないと、運営は
 * 「自動で起票されたはず」と思い込み、`要確認` の人が誰にも拾われなくなる（#59 の決着）。
 */
async function draftFirstVisitCashback(memberId: string): Promise<string> {
  const [origin, visitCount, existing, planCashbackUii] = await Promise.all([
    fetchMemberOrigin(memberId),
    countVisits(memberId),
    fetchCashbackStatus(memberId),
    fetchCurrentSignupCashbackUii(),
  ]);
  if (origin === null) {
    return "";
  }

  const judgement = judgeFirstVisitCashback({
    memberType: origin.memberType,
    visitCount,
    existingCashbackStatus: existing,
    isImportedMember: origin.isImportedMember,
    planCashbackUii,
  });

  if (judgement.kind === "needs_review") {
    return `⚠️ 初回来訪キャッシュバックは「要確認」です（${judgement.note} 顧客管理画面から起票できます）。`;
  }
  if (judgement.kind !== "auto_draft") {
    return "";
  }

  const saved = await insertGrant({
    member_id: memberId,
    amount_uii: judgement.amountUii,
    grant_type: "first_visit_cashback",
    purpose: "初回来訪キャッシュバック（チェックイン確定時に自動起票）",
  });
  return saved
    ? `初回来訪のため、キャッシュバック ${judgement.amountUii} Uii を発行依頼として起票しました。`
    : "⚠️ 初回来訪キャッシュバックの起票に失敗しました。給付一覧から手動で起票してください。";
}

/**
 * 予約のキャンセル／ノーショー（WBS 3-3 ／ v13 §5.2.2）。
 *
 * 処理の本体は `cancelStay()` にある（`check_ins` の論理削除 ＋ 部屋の解放を必ず一緒にやる）。
 * ここは**認可と入力の受け渡しだけ**を行う。
 *
 * ⚠️ **滞在中の予約も取り消せる形にはしていない。** 途中退去は「退館」であって
 * キャンセルではなく、キャンセルにすると滞在の記録そのものが消えて
 * 通算来訪回数・宿泊履歴（§5.6.8）から抜け落ちる。
 */
export async function cancelStayAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || (viewer.role !== "admin" && viewer.role !== "core_member")) {
    // 状態を読む前に断る。街人・ゲストへ「予約が見つからない」ではなく
    // 「権限が無い」を返すため（規則そのものは `decideStayCancellation()` と同じ）。
    return fail("not_staff");
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const current = await fetchCheckInStatus(checkinId);
  if (current === null) {
    return fail("not_found");
  }

  // 顧客管理画面（§5.2.2 の定める操作場所）と**同一の判定**を通す。
  // 街人・ゲストは `readViewer()` の段で既に断っているため、ここは二重防御である
  // （画面を経由しない直接呼び出しに備える ／ v13 §5.9.3）。
  const decision = decideStayCancellation({ actorRole: viewer.role, status: current.status });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const result = await cancelStay({
    checkinId,
    reasonType: String(formData.get("reasonType") ?? ""),
    reason: String(formData.get("reason") ?? ""),
    cancelledByMemberId: viewer.memberId,
  });

  if (!result.ok) {
    const message: Record<string, string> = {
      blank_reason: "キャンセルの理由を入力してください（v13 §5.2.2）。",
      invalid_reason_type: "キャンセル種別を選んでください。",
      already_cancelled: "この予約は既にキャンセル済みです。",
      denied: MESSAGE.not_staff,
      failed: MESSAGE.failed,
    };
    return { status: "error", message: message[result.reason] ?? MESSAGE.failed };
  }

  revalidatePath("/staff/checkins");
  revalidatePath("/staff/calendar");
  return {
    status: "done",
    message:
      result.releasedRoomAssignmentCount === 0
        ? "キャンセルとして記録しました。"
        : `キャンセルとして記録し、部屋 ${result.releasedRoomAssignmentCount} 件を空き枠へ戻しました。`,
  };
}
