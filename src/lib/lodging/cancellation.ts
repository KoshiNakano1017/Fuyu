/**
 * 予約のキャンセル・ノーショー処理（WBS 3-3 ／ v13 §5.2.2 ／ §9 #27）。
 *
 * ## この処理の本質は「2つを必ず一緒にやる」ことである
 *
 * 1. `check_ins` を**論理削除**する（`cancelled_at` ＋ 理由 ＋ 操作者）
 * 2. 紐づく `room_assignments` を**終了**して部屋を空き枠へ戻す（`ended_at`）
 *
 * 片方だけ実行されると、キャンセル済みなのに部屋が押さえられたまま（＝誰も泊まれない）か、
 * 部屋は空いたのに予約が生きている（＝残枠が減ったまま）になる。
 *
 * ## 宿泊券には触らない
 *
 * v13 §5.2.2 の note：宿泊券の消費（`stay_ticket_transactions.consume`）は
 * **チェックアウト時に発生**する。したがってチェックイン前のキャンセル・ノーショーでは
 * **そもそも消費が起きていない**。返却処理を書くと二重付与になる。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

/** キャンセル理由の種別（v13 §7 ／ DB の CHECK 制約と同じ3値）。 */
export type CancelReasonType = "会員都合" | "ノーショー" | "運営都合";

export const CANCEL_REASON_TYPES: readonly CancelReasonType[] = [
  "会員都合",
  "ノーショー",
  "運営都合",
];

export type CancelStayResult =
  | { ok: true; releasedRoomAssignmentCount: number }
  | { ok: false; reason: "blank_reason" | "invalid_reason_type" | "already_cancelled" | "denied" | "failed" };

function isCancelReasonType(candidate: string): candidate is CancelReasonType {
  return (CANCEL_REASON_TYPES as readonly string[]).includes(candidate);
}

/**
 * 入力の検証だけを行う純関数。画面・API・バッチのどこから呼んでも同じ判定にするため分けてある。
 *
 * v13 §5.2.2「理由入力は**必須**」。種別の選択だけでは足りず、自由記述も要る
 * （§5.6.4 の編集理由必須ルールに準拠）。
 */
export function validateCancellation(params: {
  reasonType: string;
  reason: string;
}): { ok: true } | { ok: false; reason: "blank_reason" | "invalid_reason_type" } {
  if (!isCancelReasonType(params.reasonType)) {
    return { ok: false, reason: "invalid_reason_type" };
  }
  if (params.reason.trim() === "") {
    return { ok: false, reason: "blank_reason" };
  }
  return { ok: true };
}

/**
 * 予約をキャンセル（またはノーショー）として論理削除し、部屋を解放する。
 *
 * ## 認可について
 *
 * **この関数は認可をしない。** 呼び出し元（Server Action / Route Handler）が
 * `readViewer()` ＋ `isStaff()` で判定してから呼ぶ（`record.ts` と同じ分担）。
 * ここで使うのは RLS が効く通常のサーバクライアントなので、判定漏れがあっても
 * `check_ins_update_staff` が最後に拒否する ＝ 二重防御になる（v13 §5.9.3）。
 *
 * ## なぜ先に `check_ins` を更新するのか
 *
 * Supabase の JS クライアントは複数テーブルにまたがる BEGIN/COMMIT を張れない。
 * そこで**失敗しても害の少ない順**に並べている。`check_ins` の更新が成功して
 * `room_assignments` の終了に失敗した場合、残るのは「キャンセル済みなのに部屋割当が
 * 残っている」状態だが、**残枠の算出元は `check_ins` なので予約枠は正しく戻っている**
 * （v13 §9 #47）。逆順だと、部屋は空いたのに予約が生きている状態になり、
 * 残枠が減ったまま復旧できない。
 */
export async function cancelStay(params: {
  checkinId: string;
  reasonType: string;
  reason: string;
  cancelledByMemberId: string;
}): Promise<CancelStayResult> {
  const validation = validateCancellation(params);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const supabase = await createServerSupabaseClient();
  const cancelledAt = new Date().toISOString();

  const { data: cancelled, error: cancelError } = await supabase
    .from("check_ins")
    .update({
      status: "cancelled",
      cancelled_at: cancelledAt,
      cancel_reason_type: params.reasonType,
      cancel_reason: params.reason,
      cancelled_by: params.cancelledByMemberId,
      updated_at: cancelledAt,
    })
    .eq("checkin_id", params.checkinId)
    // 二度押し・再送で理由と操作者が上書きされるのを防ぐ。
    // 最初にキャンセルした人の記録が正である（v13 §5.2.2 の監査要件）。
    .is("cancelled_at", null)
    .select("checkin_id")
    .maybeSingle();

  if (cancelError) {
    return { ok: false, reason: cancelError.code === "42501" ? "denied" : "failed" };
  }
  if (!cancelled) {
    // 行が無いか、既にキャンセル済み。どちらも「これ以上やることは無い」。
    return { ok: false, reason: "already_cancelled" };
  }

  // 部屋の解放。現在有効な割当（`ended_at IS NULL`）だけを終了する。
  const { data: released, error: releaseError } = await supabase
    .from("room_assignments")
    .update({ ended_at: cancelledAt })
    .eq("check_in_id", params.checkinId)
    .is("ended_at", null)
    .select("assignment_id");

  if (releaseError) {
    return { ok: false, reason: releaseError.code === "42501" ? "denied" : "failed" };
  }

  return { ok: true, releasedRoomAssignmentCount: released?.length ?? 0 };
}
