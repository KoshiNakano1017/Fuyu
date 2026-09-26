/**
 * カフェ事前予約注文（WBS 3-5c ／ v13 §5.4.1b）の読み書き。判定は `meal-reservations.ts` にある。
 *
 * ## 1つの枠（滞在 × 日付 × 区分）につき1行を持ち回す
 *
 * `uq_meal_res_slot`（`0019`）は `(checkin_id, served_on, meal_slot, menu_item_id)` の一意制約であり、
 * **取消した行も残る**（`0019` は DELETE のポリシーも GRANT も与えていない ＝ 物理削除できない）。
 * したがって「取消 → 同じメニューを選び直す」を新しい INSERT で表現すると一意制約に当たる。
 * 枠ごとに1行を UPDATE で持ち回し、選択を外すときは `cancelled_at` を立て、
 * 選び直すときは同じ行の `menu_item_id` を書き換える。
 *
 * ⚠️ **提供操作による伝票への変換（`converted_order_id`）はここでは行わない。** WBS `6-5` の責務である
 * （v13 §5.4.1b の [!important]：事前予約の時点で `orders` を作らない）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { MealReservation, MealSlot, PreOrderableItem } from "./meal-reservations";

type MealRow = {
  meal_reservation_id: string;
  checkin_id: string;
  served_on: string;
  meal_slot: MealSlot;
  menu_item_id: string;
  quantity: number;
  cancelled_at: string | null;
  converted_at: string | null;
};

const MEAL_COLUMNS =
  "meal_reservation_id, checkin_id, served_on, meal_slot, menu_item_id, quantity, cancelled_at, converted_at";

function toMealReservation(row: MealRow): MealReservation {
  return {
    mealReservationId: row.meal_reservation_id,
    checkinId: row.checkin_id,
    servedOn: row.served_on,
    mealSlot: row.meal_slot,
    menuItemId: row.menu_item_id,
    quantity: row.quantity,
    cancelledAt: row.cancelled_at,
    convertedAt: row.converted_at,
  };
}

/**
 * 事前予約できる商品（v13 §5.4.1b「対象」）。
 *
 * ★ `is_pre_orderable = true` の公開商品だけを出す。全メニューを出すと、
 * ドリンクや直売所の品まで「朝ごはん」の枠に並ぶ。
 * 品切れ（SOLDOUT）は**選択肢から消さずに印を付けて出す** — 消すと、前に選んでいた人の画面から
 * 自分の選択が理由なく消えたように見える。予約できないことは判定側（`decideMealEdit()`）で断る。
 */
export async function fetchPreOrderableItems(): Promise<PreOrderableItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("menu_items")
    .select("menu_item_id, name, unit_price_yen, meal_slot, is_sold_out")
    .eq("is_pre_orderable", true)
    .eq("is_published", true)
    .order("display_order", { ascending: true });

  return ((data ?? []) as {
    menu_item_id: string;
    name: string;
    unit_price_yen: number;
    meal_slot: MealSlot;
    is_sold_out: boolean;
  }[]).map((row) => ({
    menuItemId: row.menu_item_id,
    name: row.name,
    unitPriceYen: row.unit_price_yen,
    mealSlot: row.meal_slot,
    isSoldOut: row.is_sold_out,
  }));
}

/** ある滞在群の事前予約を読む（取消済みも含めて返し、絞り込みは呼び出し側の判断に委ねる）。 */
export async function fetchMealReservations(
  checkinIds: readonly string[],
): Promise<Map<string, MealReservation[]>> {
  const byStay = new Map<string, MealReservation[]>();
  if (checkinIds.length === 0) {
    return byStay;
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("meal_reservations")
    .select(MEAL_COLUMNS)
    .in("checkin_id", checkinIds)
    .order("served_on", { ascending: true });

  for (const row of (data ?? []) as MealRow[]) {
    const bucket = byStay.get(row.checkin_id) ?? [];
    bucket.push(toMealReservation(row));
    byStay.set(row.checkin_id, bucket);
  }
  return byStay;
}

/**
 * 枠の選択を保存する。`menuItemId` が null なら選択を外す（`cancelled_at` を立てる）。
 *
 * 既存行があれば UPDATE、無ければ INSERT（冒頭の理由 ／ 物理削除できないため一意制約に当たらない形にする）。
 */
export async function saveMealSlot(params: {
  checkinId: string;
  servedOn: string;
  mealSlot: MealSlot;
  menuItemId: string | null;
  quantity: number;
  existing: MealReservation | null;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  if (params.existing !== null) {
    const { error } = await supabase
      .from("meal_reservations")
      .update(
        params.menuItemId === null
          ? { cancelled_at: params.existing.cancelledAt ?? now, updated_at: now }
          : {
              menu_item_id: params.menuItemId,
              quantity: params.quantity,
              cancelled_at: null,
              updated_at: now,
            },
      )
      .eq("meal_reservation_id", params.existing.mealReservationId);
    return error === null;
  }

  if (params.menuItemId === null) {
    return true; // 何も選ばれておらず、外す対象も無い
  }

  const { error } = await supabase.from("meal_reservations").insert({
    checkin_id: params.checkinId,
    served_on: params.servedOn,
    meal_slot: params.mealSlot,
    menu_item_id: params.menuItemId,
    quantity: params.quantity,
  });
  return error === null;
}

/**
 * 期間内の事前予約を読む（運営の日別食数サマリー用 ／ 画面ID C10）。
 *
 * ⚠️ **誰が予約したかを返さない。** カレンダーに要るのは食数だけであり、
 * 運営PCに開きっぱなしになる画面へ行レベルの情報を増やさない（`fetchStaysOverlapping()` と同じ約束）。
 */
export async function fetchMealReservationsBetween(params: {
  fromDate: string;
  toDate: string;
}): Promise<MealReservation[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("meal_reservations")
    .select(MEAL_COLUMNS)
    .gte("served_on", params.fromDate)
    .lte("served_on", params.toDate)
    .is("cancelled_at", null);

  return ((data ?? []) as MealRow[]).map(toMealReservation);
}
