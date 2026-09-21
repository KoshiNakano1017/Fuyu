"use server";

import { revalidatePath } from "next/cache";

import type { SubmitState } from "@/lib/forms/submit-state";
import { readViewer } from "@/lib/auth/session";
import { canAccommodateStay, type OccupyingStay } from "@/lib/lodging/availability";
import { fetchAccommodationTypes } from "@/lib/lodging/fetch-lodging";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const MESSAGE = {
  denied: "この操作を行う権限がありません。",
  invalid_dates: "チェックイン日より後のチェックアウト日を選んでください。",
  invalid_headcount: "人数を1名以上で入力してください。",
  unknown_type: "宿泊形態を選んでください。",
  full: "選んだ期間は満室です。日程か宿泊形態を変えてお試しください。",
  failed: "予約できませんでした。時間をおいて再試行してください。",
} as const;

/**
 * アプリ内からの宿泊予約（画面ID A11 ／ WBS 3-7）。
 *
 * ## 残枠を確定の直前に取り直す
 *
 * 画面に出ていた残枠は**開いた時点の写し**である。入力している間に他の予約が入りうるので、
 * 確定の直前にもう一度数える（v13 §5.2.3 ③）。
 *
 * ⚠️ これは競合を完全には防がない。2人が同時に最後の1枠を取ると両方通りうる。
 * DB 側に排他（`EXCLUDE` 制約や在庫行のロック）が無いためで、根治は DB 層の仕事である。
 * ここで防げるのは「画面を開きっぱなしにしていた間に埋まった」という**大半の事故**であり、
 * 取りこぼしは運営のカレンダー（画面ID C10）で気づける。
 *
 * ## `reservation_source` を `in_app` にする
 *
 * 公開予約ページ（`web_public`）・運営手入力（`staff_manual`）と区別できるようにする。
 * どの経路で入った予約かは、名寄せ（WBS 10-2）と再訪判定（10-3）の材料になる。
 */
export async function createReservationAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.denied };
  }

  const roomType = String(formData.get("roomType") ?? "").trim();
  const checkInDate = String(formData.get("checkInDate") ?? "").trim();
  const checkOutDate = String(formData.get("checkOutDate") ?? "").trim();
  const adultsCount = Number.parseInt(String(formData.get("adultsCount") ?? "0"), 10);
  const childrenCount = Number.parseInt(String(formData.get("childrenCount") ?? "0"), 10);

  if (roomType === "") {
    return { status: "error", message: MESSAGE.unknown_type };
  }
  if (checkInDate === "" || checkOutDate === "" || checkOutDate <= checkInDate) {
    return { status: "error", message: MESSAGE.invalid_dates };
  }
  if (
    !Number.isSafeInteger(adultsCount) ||
    !Number.isSafeInteger(childrenCount) ||
    adultsCount < 0 ||
    childrenCount < 0 ||
    adultsCount + childrenCount < 1
  ) {
    return { status: "error", message: MESSAGE.invalid_headcount };
  }

  const requested: OccupyingStay = { checkInDate, checkOutDate, adultsCount, childrenCount };

  const available = await hasRoomFor(roomType, requested);
  if (available === null) {
    return { status: "error", message: MESSAGE.failed };
  }
  if (!available) {
    return { status: "error", message: MESSAGE.full };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("check_ins").insert({
    member_id: viewer.memberId,
    room_type: roomType,
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    adults_count: adultsCount,
    children_count: childrenCount,
    status: "pre_registered",
    reservation_source: "in_app",
  });

  if (error) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/reservations");
  revalidatePath("/me");
  return { status: "done", message: "予約を受け付けました。" };
}

/**
 * その形態・その日程に空きがあるか。判定できなければ null。
 *
 * ★ **`v_room_availability` ではなく `availability.ts` の式を使う。**
 * ビューは「既にある予約」だけを数えるので、いま組み立てている予約が
 * 何枠を消費するか（棟貸型なら定員超過で複数棟）を勘定に入れられない
 * （`availability.ts` 冒頭が二重実装の理由として挙げているのがこの場面である）。
 */
async function hasRoomFor(roomType: string, requested: OccupyingStay): Promise<boolean | null> {
  const supabase = await createServerSupabaseClient();

  const types = await fetchAccommodationTypes();
  const type = types.find((candidate) => candidate.roomType === roomType);
  if (type === undefined) {
    return null;
  }

  // 分母は「利用可」の部屋だけ。メンテナンス中を数えると、予約できたのに当日部屋が無い
  // （`0015` のビューが同じ条件で絞っている）。
  const { data: roomRows, error: roomError } = await supabase
    .from("rooms")
    .select("capacity")
    .eq("room_type", roomType)
    .eq("status", "利用可");

  if (roomError || !roomRows) {
    return null;
  }

  const capacities = (roomRows as { capacity: number }[]).map((row) => row.capacity);
  const capacity = {
    allocationMode: type.allocationMode,
    totalCapacity: capacities.reduce((total, value) => total + value, 0),
    totalUnits: capacities.length,
    unitCapacity: capacities.length === 0 ? 0 : Math.max(...capacities),
  };

  const { data: stayRows, error: stayError } = await supabase
    .from("check_ins")
    .select("check_in_date, check_out_date, adults_count, children_count")
    .eq("room_type", roomType)
    .is("cancelled_at", null)
    .in("status", ["pre_registered", "confirmed", "staying"])
    .gt("check_out_date", requested.checkInDate)
    .lt("check_in_date", requested.checkOutDate);

  if (stayError || !stayRows) {
    return null;
  }

  const existingStays: OccupyingStay[] = (
    stayRows as {
      check_in_date: string;
      check_out_date: string;
      adults_count: number;
      children_count: number;
    }[]
  ).map((row) => ({
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
  }));

  return canAccommodateStay({ requested, existingStays, capacity });
}
