// 公開予約ページ（未ログイン）が表示に使う材料。WBS 3-5b。
//
// ★ **なぜ service_role で読むのか**
//
// `accommodation_types`（0014）・`v_room_availability`（0015）・`accommodation_rates`（0021）は
// いずれも `GRANT SELECT ... TO authenticated` であり、**`anon` には与えていない**。
// 0015 のコメントがその理由を明示している：
//
//   「⚠️ `anon` には与えない。未ログインの公開予約ページは anon キーで直接 DB を読まず、
//     必ずサーバ側（service_role）を経由する（API設計 §1-1・非機能要件詳細 §2-2b）。」
//
// したがって未ログインの画面がそのまま `createServerSupabaseClient()` で読むと
// **0件が返って満室に見える**（エラーではなく静かに空になる）。ここを分けているのはそのためである。
//
// ⚠️ 返すのは**集計値とマスタだけ**である。会員の行・予約の行をこの経路で返さないこと。
//    service_role は RLS を迂回するので、ここに1本足すたびに防壁が1つ減る。

import { createAdminSupabaseClient } from "@/lib/supabase/admin";

import type { AccommodationType, DailyAvailability } from "@/lib/lodging/fetch-lodging";
import type { AccommodationRate } from "@/lib/lodging/rates";

export async function fetchPublicAccommodationTypes(): Promise<AccommodationType[]> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("accommodation_types")
    .select("room_type, display_name, allocation_mode, display_order")
    .order("display_order", { ascending: true });

  return ((data ?? []) as {
    room_type: string;
    display_name: string;
    allocation_mode: AccommodationType["allocationMode"];
    display_order: number;
  }[]).map((row) => ({
    roomType: row.room_type,
    displayName: row.display_name,
    allocationMode: row.allocation_mode,
    displayOrder: row.display_order,
  }));
}

/** 本日の残枠。満室の形態を選択不可にするための目安である（v13 §5.2.3 ③）。 */
export async function fetchPublicAvailability(date: string): Promise<DailyAvailability[]> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("v_room_availability")
    .select("date, room_type, total, occupied, available")
    .eq("date", date);

  return ((data ?? []) as {
    date: string;
    room_type: string;
    total: number;
    occupied: number;
    available: number;
  }[]).map((row) => ({
    date: row.date,
    roomType: row.room_type,
    total: row.total,
    occupied: row.occupied,
    available: row.available,
  }));
}

/**
 * 非会員料金の現行行だけを返す。
 *
 * ★ 会員料金をこの経路で返さない。未ログインの予約は**常に非会員料金**であり
 * （v13 §5.2.3 の warning：会員料金の自己申告を廃止する）、
 * 会員料金を画面へ送ると「安い方があるのに選べない」という不要な摩擦を生む。
 */
export async function fetchPublicRates(): Promise<AccommodationRate[]> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("accommodation_rates")
    .select("rate_id, room_type, member_category, price_per_night_yen, effective_from, effective_until")
    .eq("member_category", "non_member")
    .is("effective_until", null);

  return ((data ?? []) as {
    rate_id: string;
    room_type: string;
    member_category: "member" | "non_member";
    price_per_night_yen: number;
    effective_from: string;
    effective_until: string | null;
  }[]).map((row) => ({
    rateId: row.rate_id,
    roomType: row.room_type,
    memberCategory: row.member_category,
    pricePerNightYen: row.price_per_night_yen,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  }));
}
