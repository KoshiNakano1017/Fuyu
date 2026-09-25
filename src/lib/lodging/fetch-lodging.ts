// 宿泊まわりの材料を Supabase から読む。WBS 3-6（宿泊予定カレンダー）・3-7（アプリ内予約）・3-8（残枠）。
//
// ★ 残枠は **`v_room_availability`（`0015`）を読む**。`availability.ts` の同じ式を
//   一覧表示に使わない。ビューが正本であり（そのファイルの冒頭コメント）、
//   TypeScript 側の式は「まだ DB に無い予約を含めて判定する」ときだけの道具である。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { AllocationMode } from "./availability";
import type { AccommodationRate } from "./rates";

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

/**
 * 会員区分の表示語（v13 §5.2.3「表示内容」＝ …大人/子供人数・**会員区分**）。
 *
 * 料金表の区分（`accommodation_rates.member_category` の `member` / `non_member`）とは別物で、
 * こちらは**運営が画面で読むためのラベル**である。料金の判定に使わない（`rates.ts` の
 * `memberCategoryOf()` が正本）。
 */
export type MemberCategoryLabel = "会員" | "非会員";

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
  /**
   * 備考（`check_ins.note`）。**「要確認」予約の判定に使う唯一の材料**である
   * （v13 §5.2.3 TO-BE④ ／ §9 #30-④：空と見なすのは完全な空欄のみ）。
   *
   * ⚠️ 本人が書いた自由記述であり、氏名・連絡先が混じりうる。
   * 一覧に出すのは運営画面（C10）に限り、他者向けの画面へ載せない（CLAUDE.md §7.1）。
   */
  note?: string | null;
  /**
   * 割当部屋の名前（`room_assignments.room_name_snapshot`）。未割当なら `null`。
   *
   * 現在名（`rooms.room_name`）ではなく**割当時のスナップショット**を引く。
   * 部屋はリネームされうるため（`0006` の COMMENT ／ v13 §5.6.8）。
   */
  assignedRoomName?: string | null;
  /** 会員区分の表示語。引けなければ `null`（別の値で埋めない）。 */
  memberCategory?: MemberCategoryLabel | null;
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
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status, note",
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
    note: string | null;
  }[];

  const [publicProfiles, assignedRoomNames] = await Promise.all([
    fetchMemberPublicProfiles(rows.map((row) => row.member_id)),
    fetchAssignedRoomNames(rows.map((row) => row.checkin_id)),
  ]);

  return rows.map((row) => ({
    checkinId: row.checkin_id,
    memberId: row.member_id,
    memberLabel: publicProfiles.get(row.member_id)?.displayName ?? "（表示名なし）",
    roomType: row.room_type,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
    status: row.status,
    note: row.note,
    assignedRoomName: assignedRoomNames.get(row.checkin_id) ?? null,
    memberCategory: publicProfiles.get(row.member_id)?.memberCategory ?? null,
  }));
}

/** 本人の予約（マイページの宿泊タブ ／ 画面ID A12 ／ WBS 3-8）。RLS が行を絞る。 */
export async function fetchMyStays(memberId: string): Promise<StayEntry[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status, note",
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
      note: string | null;
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
    note: row.note,
  }));
}

/**
 * 本人の滞在を1件読む（画面ID A12 の遷移先 `/me/stays/[checkinId]` ／ WBS 3-8）。
 *
 * ⚠️ **`member_id` の条件をここで必ず付ける。** RLS も同じ境界を引いているが、
 * URL の `checkinId` は利用者が書き換えられる。他人の滞在IDを入れられたときに
 * 「RLS が弾くはず」に頼ると、ポリシーを1つ緩めた瞬間に他人の滞在が読める
 * （v13 §5.9.4「認可は多層で持つ」）。見つからなければ `null`。
 */
export async function fetchMyStay(params: {
  memberId: string;
  checkinId: string;
}): Promise<StayEntry | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status, note",
    )
    .eq("member_id", params.memberId)
    .eq("checkin_id", params.checkinId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const row = data as {
    checkin_id: string;
    member_id: string;
    room_type: string;
    check_in_date: string;
    check_out_date: string;
    adults_count: number;
    children_count: number;
    status: string;
    note: string | null;
  };

  const assignedRoomNames = await fetchAssignedRoomNames([row.checkin_id]);

  return {
    checkinId: row.checkin_id,
    memberId: row.member_id,
    memberLabel: "自分",
    roomType: row.room_type,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
    status: row.status,
    note: row.note,
    assignedRoomName: assignedRoomNames.get(row.checkin_id) ?? null,
  };
}

/** 他者向けに出してよい会員情報（`v_member_public` の3列）。 */
type MemberPublicProfile = {
  displayName: string | null;
  memberCategory: MemberCategoryLabel | null;
};

/**
 * 表示名と会員区分をまとめて引く。他者向けの表示規則（v13 §5.9.5）はビュー側が持っている。
 *
 * `member_type` を読むのは**画面に出すバッジのため**であり（`0029` のビューの COMMENT）、
 * 認可の判定には使わない（v13 §2 ／ CLAUDE.md §4.1）。
 */
async function fetchMemberPublicProfiles(
  memberIds: readonly string[],
): Promise<Map<string, MemberPublicProfile>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name, member_type")
    .in("member_id", unique);

  const profiles = new Map<string, MemberPublicProfile>();
  for (const row of (data ?? []) as {
    member_id: string;
    display_name: string | null;
    member_type: string | null;
  }[]) {
    profiles.set(row.member_id, {
      displayName: row.display_name,
      memberCategory: memberCategoryLabelOf(row.member_type),
    });
  }
  return profiles;
}

/**
 * 会員種別（街人・親方・ゲスト）を会員区分の表示語へ移す。
 *
 * ゲストは会員ではないため「非会員」。未知の値は**会員側へ倒さず `null`** にする。
 * 会員区分は料金の目安として読まれるため、分からないものを「会員」と書くと安い側へ誤らせる。
 */
function memberCategoryLabelOf(memberType: string | null): MemberCategoryLabel | null {
  if (memberType === "街人" || memberType === "親方") {
    return "会員";
  }
  if (memberType === "ゲスト") {
    return "非会員";
  }
  return null;
}

/**
 * 滞在中の割当部屋名をまとめて引く（`room_assignments` ／ 画面ID C10 の「割当部屋」）。
 *
 * **終了していない割当（`ended_at IS NULL`）だけ**を見る。部屋移動は既存行を終了して
 * 新規行を足す形なので（`0006`）、終了済みを含めると移動前の部屋名が混ざる。
 */
async function fetchAssignedRoomNames(
  checkinIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(checkinIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("room_assignments")
    .select("check_in_id, room_name_snapshot")
    .in("check_in_id", unique)
    .is("ended_at", null);

  const names = new Map<string, string>();
  for (const row of (data ?? []) as { check_in_id: string; room_name_snapshot: string | null }[]) {
    if (row.room_name_snapshot !== null) {
      names.set(row.check_in_id, row.room_name_snapshot);
    }
  }
  return names;
}

/**
 * 宿泊料金マスタを全件読む（WBS 3-9 ／ 画面ID C13）。
 *
 * **現行行だけに絞らない。** マスタ管理画面は改定の履歴を見せる場所であり、
 * 期間を閉じた過去の料金も並べる（v13 §5.4.2②「適用期間を区切って新しい行を追加」）。
 * その日に適用される1行を選ぶのは `rates.ts` の `rateOn()` の仕事である。
 */
export async function fetchAccommodationRates(): Promise<AccommodationRate[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("accommodation_rates")
    .select("rate_id, room_type, member_category, price_per_night_yen, effective_from, effective_until")
    .order("room_type", { ascending: true })
    .order("effective_from", { ascending: false });

  if (error || !data) {
    // 料金マスタが空でも画面は開く（初期行を入れない設計のため／`0021` の冒頭）
    return [];
  }

  return (
    data as {
      rate_id: string;
      room_type: string;
      member_category: "member" | "non_member";
      price_per_night_yen: number;
      effective_from: string;
      effective_until: string | null;
    }[]
  ).map((row) => ({
    rateId: row.rate_id,
    roomType: row.room_type,
    memberCategory: row.member_category,
    pricePerNightYen: row.price_per_night_yen,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  }));
}
