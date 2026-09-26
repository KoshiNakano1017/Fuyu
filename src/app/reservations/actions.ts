"use server";

import { revalidatePath } from "next/cache";

import type { SubmitState } from "@/lib/forms/submit-state";
import { readViewer } from "@/lib/auth/session";
import { fetchAccommodationTypes } from "@/lib/lodging/fetch-lodging";
import {
  decideReservation,
  describeReservationResult,
  requestedNights,
  reservationDenialMessage,
} from "@/lib/lodging/reservation-intake";
import {
  fetchMealReservations,
  fetchPreOrderableItems,
  saveMealSlot,
} from "@/lib/lodging/meal-reservation-store";
import {
  decideMealEdit,
  indexByDateAndSlot,
  mealDaysForStay,
  mealEditDenialMessage,
} from "@/lib/lodging/meal-reservations";
import {
  fetchCapacities,
  fetchOtherStayNights,
  fetchStayForChange,
  fetchStayOwner,
} from "@/lib/lodging/stay-change-store";
import { findFullNight } from "@/lib/lodging/stay-changes";
import { fetchStayTicketBalance } from "@/lib/lodging/stay-tickets";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { todayInJapan } from "@/lib/japan-time";

const MESSAGE = {
  denied: "この操作を行う権限がありません。",
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
 * ## 会員だから省けること・使えるもの（2026-09-26 ／ WBS 3-7 の残り）
 *
 * ①**既知情報を尋ねない**（氏名・連絡先は会員行にある ／ v13 §5.2.4「既知情報の再入力を求めない」）
 * ②**会員料金**を画面に出す（`quoteReservation()` ／ Uii 主・円 副）
 * ③**宿泊券の充当**を受け取る。**予約時点では消費しない**（同節 ／ 消費は WBS 3-4）
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

  const input = {
    roomType: String(formData.get("roomType") ?? "").trim(),
    checkInDate: String(formData.get("checkInDate") ?? "").trim(),
    checkOutDate: String(formData.get("checkOutDate") ?? "").trim(),
    arrivalTime: String(formData.get("arrivalTime") ?? "").trim(),
    transportMethod: String(formData.get("transportMethod") ?? "").trim(),
    adultsCount: Number.parseInt(String(formData.get("adultsCount") ?? "0"), 10),
    childrenCount: Number.parseInt(String(formData.get("childrenCount") ?? "0"), 10),
    stayTicketNights: Number.parseInt(String(formData.get("stayTicketNights") ?? "0"), 10),
    note: String(formData.get("note") ?? ""),
  };

  // ★ 残高は**サーバで引き直す**。画面が持っていた残高は描いた時点の写しであり、
  //   その間に運営が調整している（WBS 10-4）かもしれない。画面の値を信じると、
  //   保有していない宿泊券を充当した予約が成立しうる。
  const [types, stayTicketBalance] = await Promise.all([
    fetchAccommodationTypes(),
    fetchStayTicketBalance(viewer.memberId),
  ]);

  const decision = decideReservation({
    input,
    knownRoomTypes: types.map((type) => type.roomType),
    stayTicketBalance,
    today: todayInJapan(),
  });
  if (!decision.allowed) {
    return { status: "error", message: reservationDenialMessage(decision.reason) };
  }

  // ★ 満室判定は**滞在中の変更（WBS 3-10）と同じ道具**で行う。
  //   `check_ins.room_type`（現在の形態）で他人の占有を数えると、「明日からコテージへ移る」
  //   予約が今夜のコテージまで埋めてしまう（`0041` の残枠ビューと同じ理屈）。
  let fullNight;
  try {
    const [capacities, others] = await Promise.all([
      fetchCapacities(),
      fetchOtherStayNights({
        excludeCheckinId: null, // 新規予約なので除外するものが無い
        fromDate: input.checkInDate,
        toDate: input.checkOutDate,
      }),
    ]);
    fullNight = findFullNight({
      requested: requestedNights(input),
      others,
      capacities,
    });
  } catch {
    // 読めないときに「空いている」と見なすとダブルブッキングを作る。予約を止める。
    return { status: "error", message: MESSAGE.failed };
  }
  if (fullNight !== null) {
    return { status: "error", message: reservationDenialMessage("full") };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("check_ins").insert({
    member_id: viewer.memberId,
    room_type: input.roomType,
    check_in_date: input.checkInDate,
    check_out_date: input.checkOutDate,
    adults_count: input.adultsCount,
    children_count: input.childrenCount,
    // ★ 備考が完全な空欄なら自動確定（v13 §5.2.4「確定処理」）。公開予約と同じ基準である
    status: decision.plan.status,
    reservation_source: "in_app",
    arrival_time: input.arrivalTime === "" ? null : input.arrivalTime,
    transport_method: input.transportMethod === "" ? null : input.transportMethod,
    note: input.note.trim() === "" ? null : input.note.trim(),
    // ★ 充当の意思だけを残す。**消費はチェックアウト時**（v13 §5.2.4 ／ WBS 3-4）
    stay_tickets_applied_nights: decision.plan.stayTicketNights,
  });

  if (error) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/reservations");
  revalidatePath("/me");
  // 残枠と当日の板が変わる（運営のカレンダー・チェックイン板）。
  revalidatePath("/staff/calendar");
  revalidatePath("/staff/checkins");
  return { status: "done", message: describeReservationResult(decision.plan) };
}

/**
 * カフェの事前予約注文の保存（WBS 3-5c ／ v13 §5.4.1b）。
 *
 * ## 本人の画面と運営の画面で同じ入口を使う
 *
 * §5.4.1b の権限は「本人（自身の予約分）／運営は全件参照・代理編集可」である。
 * 判定（`decideMealEdit()`）が本人・運営の違いを持っているので、Action は1本で足りる。
 * 入口を2つに分けると、片方だけに条件を足す取りこぼしが起きる。
 *
 * ## 枠ごとに保存し、変わっていない枠は触らない
 *
 * フォームは滞在日 × 区分ぶんの選択を全部送ってくる。毎回すべて UPDATE すると、
 * 触っていない枠の `updated_at` まで動いて「誰がいつ変えたか」が読めなくなる。
 *
 * ⚠️ **伝票（`orders`）は作らない。** 事前予約の時点で伝票を起こすと、まだ提供していない金額が
 * 未会計へ前倒しで載る（§5.4.1b の [!important]）。変換は提供操作の時点＝WBS `6-5` の責務である。
 */
export async function saveMealPreOrdersAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.denied };
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  const [stay, owner, items] = await Promise.all([
    fetchStayForChange(checkinId),
    fetchStayOwner(checkinId),
    fetchPreOrderableItems(),
  ]);
  if (stay === null || owner === null) {
    return { status: "error", message: "対象の滞在が見つかりません。" };
  }

  const existingByKey = indexByDateAndSlot(
    (await fetchMealReservations([checkinId])).get(checkinId) ?? [],
  );
  const isOwner = owner === viewer.memberId;
  let changed = 0;

  for (const day of mealDaysForStay(stay)) {
    for (const slot of day.slots) {
      const rawItem = formData.get(`item_${day.date}_${slot}`);
      if (rawItem === null) {
        continue; // その枠はフォームに無い（画面が出していない）
      }
      const menuItemId = String(rawItem).trim() === "" ? null : String(rawItem).trim();
      const quantity = Number.parseInt(String(formData.get(`qty_${day.date}_${slot}`) ?? "1"), 10);
      const existing = existingByKey.get(`${day.date}_${slot}`) ?? null;

      // 変わっていない枠は触らない（`updated_at` を動かさない）
      const unchanged =
        (existing?.menuItemId ?? null) === menuItemId &&
        (menuItemId === null || existing?.quantity === quantity);
      if (unchanged) {
        continue;
      }

      const item = menuItemId === null
        ? null
        : (items.find((candidate) => candidate.menuItemId === menuItemId) ?? undefined);
      if (item === undefined) {
        return { status: "error", message: mealEditDenialMessage("unknown_item") };
      }

      const decision = decideMealEdit({
        actorRole: viewer.role,
        isOwner,
        stay,
        date: day.date,
        slot,
        item,
        quantity,
        existing,
      });
      if (!decision.allowed) {
        return { status: "error", message: mealEditDenialMessage(decision.reason) };
      }

      const saved = await saveMealSlot({
        checkinId,
        servedOn: day.date,
        mealSlot: slot,
        menuItemId,
        quantity,
        existing,
      });
      if (!saved) {
        return { status: "error", message: MESSAGE.failed };
      }
      changed += 1;
    }
  }

  revalidatePath("/reservations");
  revalidatePath(`/admin/customers/${owner}`);
  // 日別の食数サマリー（画面ID C10）が変わる。前日に翌日の仕込み数を出すのが本機能の価値である
  revalidatePath("/staff/calendar");

  return {
    status: "done",
    message:
      changed === 0
        ? "変更はありませんでした。"
        : `食事の予約を保存しました（${changed}件を更新）。会計は提供した時点で発生します。`,
  };
}
