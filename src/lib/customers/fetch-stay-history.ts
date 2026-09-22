/**
 * 宿泊履歴の材料を読む（WBS 8-6 ／ v13 §5.6.8）。組み立ては `stay-history.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS。`check_ins` / `room_assignments` とも staff ポリシー越しに読む。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import { buildStayHistory, type StayHistory } from "./stay-history";

export async function fetchStayHistory(memberId: string): Promise<StayHistory> {
  const supabase = await createServerSupabaseClient();

  const { data: stayRows } = await supabase
    .from("check_ins")
    .select("checkin_id, room_type, check_in_date, check_out_date, adults_count, children_count, status")
    .eq("member_id", memberId);

  const stays = ((stayRows ?? []) as Record<string, unknown>[]).map((row) => ({
    checkinId: String(row.checkin_id),
    roomType: String(row.room_type),
    checkInDate: String(row.check_in_date),
    checkOutDate: String(row.check_out_date),
    adultsCount: Number(row.adults_count),
    childrenCount: Number(row.children_count),
    status: String(row.status),
  }));

  if (stays.length === 0) {
    return { rows: [], totalNights: 0, favoriteRoom: null };
  }

  // ★ 部屋名は `room_name_snapshot`（割当時点の名前）を読む。`rooms` の現在名を引くと、
  //   部屋を改名した瞬間に過去の履歴まで新しい名前で表示される（v13 §5.6.8 の [!warning]）。
  const { data: assignmentRows } = await supabase
    .from("room_assignments")
    .select("check_in_id, room_name_snapshot, started_at, ended_at")
    .in(
      "check_in_id",
      stays.map((stay) => stay.checkinId),
    );

  const assignments = ((assignmentRows ?? []) as Record<string, unknown>[]).map((row) => ({
    checkinId: String(row.check_in_id),
    roomName: String(row.room_name_snapshot),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
  }));

  return buildStayHistory({ stays, assignments });
}
