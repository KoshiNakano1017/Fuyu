// 宿泊まわりの材料を Supabase から読む。WBS 3-6（宿泊予定カレンダー）・3-7（アプリ内予約）・3-8（残枠）。
//
// ★ 残枠は **`v_room_availability`（`0015`）を読む**。`availability.ts` の同じ式を
//   一覧表示に使わない。ビューが正本であり（そのファイルの冒頭コメント）、
//   TypeScript 側の式は「まだ DB に無い予約を含めて判定する」ときだけの道具である。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { AllocationMode } from "./availability";

/** 宿泊形態（`accommodation_types`）。並び順は `display_order`。 */
export type AccommodationType = {
  roomType: string;
  displayName: string;
  allocationMode: AllocationMode;
  displayOrder: number;
};

/** ある日・ある形態の残枠（`v_room_availability` の1行）。 */
export type DailyAvailability = {
  date: string;
  roomType: string;
  total: number;
  occupied: number;
  available: number;
};

/** カレンダーに並べる滞在（`check_ins`）。**個人情報は持たない。** */
export type StayEntry = {
  checkinId: string;
  memberId: string;
  memberLabel: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
  status: string;
};

export async function fetchAccommodationTypes(): Promise<AccommodationType[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("accommodation_types")
    .select("room_type, display_name, allocation_mode, display_order")
    .order("display_order", { ascending: true });

  if (error || !data) {
    throw new Error("宿泊形態を取得できませんでした");
  }

  return (
    data as {
      room_type: string;
      display_name: string;
      allocation_mode: AllocationMode;
      display_order: number;
    }[]
  ).map((row) => ({
    roomType: row.room_type,
    displayName: row.display_name,
    allocationMode: row.allocation_mode,
    displayOrder: row.display_order,
  }));
}

/**
 * 期間内の残枠を読む。
 *
 * ビューは今日から180日先までしか行を持たない（`0015`）。期間をそれより先に取ると
 * 静かに0件になるため、**呼び出し側が窓の内側を渡す**前提でここは絞るだけにする。
 */
export async function fetchAvailability(params: {
  fromDate: string;
  toDate: string;
}): Promise<DailyAvailability[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("v_room_availability")
    .select("date, room_type, total, occupied, available")
    .gte("date", params.fromDate)
    .lte("date", params.toDate)
    .order("date", { ascending: true });

  if (error || !data) {
    throw new Error("残枠を取得できませんでした");
  }

  return (
    data as { date: string; room_type: string; total: number; occupied: number; available: number }[]
  ).map((row) => ({
    date: row.date,
    roomType: row.room_type,
    total: row.total,
    occupied: row.occupied,
    available: row.available,
  }));
}

/**
 * 期間に重なる滞在を読む（運営のカレンダー用 ／ WBS 3-6）。
 *
 * キャンセルは除く。カレンダーは「誰が居るか」を見る道具であり、
 * 取り消された予定を残すと当日の人数が実態より多く見える。
 *
 * ⚠️ **氏名を引かない。** 表示名は `v_member_public`（`0009`）のニックネーム／会員番号。
 * カレンダーは運営PCに開きっぱなしになるため、実名を載せると常時露出する（CLAUDE.md §7.1）。
 */
export async function fetchStaysOverlapping(params: {
  fromDate: string;
  toDate: string;
}): Promise<StayEntry[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    // 退去日は専有しないので、境界は `check_out_date > fromDate`（`>=` にすると
    // 前日に発った予約まで拾ってしまう）。
    .gt("check_out_date", params.fromDate)
    .lte("check_in_date", params.toDate)
    .is("cancelled_at", null)
    .order("check_in_date", { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as {
    checkin_id: string;
    member_id: string;
    room_type: string;
    check_in_date: string;
    check_out_date: string;
    adults_count: number;
    children_count: number;
    status: string;
  }[];

  const labels = await fetchMemberLabels(rows.map((row) => row.member_id));

  return rows.map((row) => ({
    checkinId: row.checkin_id,
    memberId: row.member_id,
    memberLabel: labels.get(row.member_id) ?? "（表示名なし）",
    roomType: row.room_type,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
    status: row.status,
  }));
}

/** 本人の予約（マイページの宿泊タブ ／ 画面ID A12 ／ WBS 3-8）。RLS が行を絞る。 */
export async function fetchMyStays(memberId: string): Promise<StayEntry[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    .eq("member_id", memberId)
    .order("check_in_date", { ascending: false });

  if (error || !data) {
    return [];
  }

  return (
    data as {
      checkin_id: string;
      member_id: string;
      room_type: string;
      check_in_date: string;
      check_out_date: string;
      adults_count: number;
      children_count: number;
      status: string;
    }[]
  ).map((row) => ({
    checkinId: row.checkin_id,
    memberId: row.member_id,
    memberLabel: "自分",
    roomType: row.room_type,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
    status: row.status,
  }));
}

/** 表示名をまとめて引く。他者向けの表示規則（v13 §5.9.5）はビュー側が持っている。 */
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
