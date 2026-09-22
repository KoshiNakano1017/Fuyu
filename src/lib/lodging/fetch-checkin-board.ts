/**
 * チェックイン板の材料を読む（WBS 3-2）。判定は `checkin-ops.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS。`check_ins_select_staff` / `check_ins_update_staff`（`0014`）が行を絞る。
 *
 * ⚠️ **実名を読まない。** 表示名は `v_member_public`（`0009`）のニックネーム／会員番号である。
 *   この板は店員タブレットに出る＝客から見える位置に置かれうる。
 *   宿泊者名簿（氏名・住所）は専用画面（`/admin/checkins/{id}/lodging-register`）が扱う。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import { isTodaysStay, type CheckInStatus } from "./checkin-ops";

export type CheckInBoardRow = {
  checkinId: string;
  memberId: string;
  memberLabel: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
  status: CheckInStatus;
  /** 宿泊者名簿（宿泊法の申告）が済んでいるか（v13 §5.2.7） */
  hasLodgingRegister: boolean;
};

export async function fetchCheckInBoard(today: string): Promise<CheckInBoardRow[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    .order("check_in_date", { ascending: true });

  if (error || data === null) {
    return [];
  }

  const rows = (data as Record<string, unknown>[])
    .map((row) => ({
      checkinId: String(row.checkin_id),
      memberId: String(row.member_id),
      roomType: String(row.room_type),
      checkInDate: String(row.check_in_date),
      checkOutDate: String(row.check_out_date),
      adultsCount: Number(row.adults_count),
      childrenCount: Number(row.children_count),
      status: row.status as CheckInStatus,
    }))
    // 当日の板に出す範囲は `isTodaysStay()` が決める（画面側で条件を書かない）
    .filter((row) =>
      isTodaysStay({
        status: row.status,
        checkInDate: row.checkInDate,
        checkOutDate: row.checkOutDate,
        today,
      }),
    );

  if (rows.length === 0) {
    return [];
  }

  const [labels, registers] = await Promise.all([
    fetchMemberLabels(rows.map((row) => row.memberId)),
    fetchLodgingRegisterFlags(rows.map((row) => row.checkinId)),
  ]);

  return rows.map((row) => ({
    ...row,
    memberLabel: labels.get(row.memberId) ?? "（表示名なし）",
    hasLodgingRegister: registers.has(row.checkinId),
  }));
}

async function fetchMemberLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name")
    .in("member_id", unique);

  const labels = new Map<string, string>();
  for (const row of (data ?? []) as { member_id: string; display_name: string | null }[]) {
    if (row.display_name !== null) {
      labels.set(row.member_id, row.display_name);
    }
  }
  return labels;
}

/**
 * 宿泊者名簿が登録済みの滞在（v13 §5.2.7）。
 *
 * ⚠️ **中身（氏名・住所）は読まない。** 板に出すのは「済んでいるか」だけである。
 * PII-A を板へ運ぶ必要が無い（`lodging_register_entries` は `0010`）。
 */
async function fetchLodgingRegisterFlags(checkinIds: readonly string[]): Promise<Set<string>> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("lodging_register_entries")
    .select("checkin_id")
    .in("checkin_id", [...new Set(checkinIds)]);

  return new Set(((data ?? []) as { checkin_id: string }[]).map((row) => row.checkin_id));
}

/** 操作の前に現在の状態を読む（画面の表示は古いかもしれないため）。 */
export async function fetchCheckInStatus(
  checkinId: string,
): Promise<{ status: CheckInStatus; memberId: string } | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("check_ins")
    .select("status, member_id")
    .eq("checkin_id", checkinId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return { status: data.status as CheckInStatus, memberId: String(data.member_id) };
}

/** 状態を進める。`checked_in_at` / `checked_out_at` も同時に埋める（`0014`）。 */
export async function updateCheckInStatus(params: {
  checkinId: string;
  next: "staying" | "checked_out";
  expected: CheckInStatus;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> =
    params.next === "staying"
      ? { status: "staying", checked_in_at: now, updated_at: now }
      : { status: "checked_out", checked_out_at: now, updated_at: now };

  const { error } = await supabase
    .from("check_ins")
    .update(patch)
    .eq("checkin_id", params.checkinId)
    // 画面を開いたときの状態のままであることを条件にする。別の端末が先に操作していたら何も起きない
    .eq("status", params.expected);

  return error === null;
}
