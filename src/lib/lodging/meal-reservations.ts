/**
 * カフェの事前予約注文（WBS 3-5c ／ v13 §5.4.1b ／ §9 #48）。純関数だけを置く。
 *
 * **目的は仕込み数量の把握である。** 現行フォームは「チェックイン当日のカフェ利用」しか聞いておらず、
 * 回答は予約担当者が目視するだけでシステムに載っていなかった。
 *
 * ## 予約の時点で伝票（`orders`）を作らない
 *
 * §5.4.1b の [!important] が名指しで禁じている。予約時に伝票を起こすと、
 * **まだ来訪も提供もしていない金額が未会計請求（§5.6）へ前倒しで載り**、顧客管理の未会計額が実態とずれる。
 * 「会計ステータス × 提供ステータス」の2軸に**存在しない第3の状態（予約済・未来訪）**が混ざって濁る。
 * 伝票への変換は**当日タブレットで「提供」を操作した時点**であり、WBS `6-5` の責務である。
 *
 * ## 日別に出す。滞在日数ぶんが必要である
 *
 * §5.4.1b の [!note]：**朝ごはんはチェックイン翌朝**であり、2泊すれば夕食2回・朝食2回になる。
 * 「当日の昼／夜／利用しない」を移植しただけでは成立しない。
 */

/** 食事の区分（`meal_reservations.meal_slot` ／ `menu_items.meal_slot` と同じ3値）。 */
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner"] as const;

export type MealSlot = (typeof MEAL_SLOTS)[number];

/** 利用者向けの表示名。内部識別子を画面へ出さない。 */
export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: "朝ごはん",
  lunch: "昼",
  dinner: "夜",
};

/** 事前予約できる商品（`menu_items` の `is_pre_orderable = true`）。 */
export type PreOrderableItem = {
  menuItemId: string;
  name: string;
  unitPriceYen: number;
  mealSlot: MealSlot;
  isSoldOut: boolean;
};

/** 保存済みの事前予約1件。 */
export type MealReservation = {
  mealReservationId: string;
  checkinId: string;
  servedOn: string;
  mealSlot: MealSlot;
  menuItemId: string;
  quantity: number;
  cancelledAt: string | null;
  convertedAt: string | null;
};

/** 画面に出す1日ぶんの枠。 */
export type MealDay = {
  date: string;
  /** その日に**既定で提示する**区分。選べない区分ではなく「出す区分」である */
  slots: MealSlot[];
};

/**
 * ★ 滞在日ごとに提示する区分を決める（v13 §5.4.1b「既定の選択肢の出し方」）。
 *
 * - チェックイン日: **昼・夜**（到着15:00 の運用）
 * - 中日: **朝・昼・夜**
 * - チェックアウト日: **朝**（退去10:00 の運用）
 *
 * ⚠️ **チェックアウト日を落とさない。** 残枠の数え方（「退去日は専有しない」）とは別の話で、
 * **退去日の朝食は実際に提供される**。ここを泊数と同じ日数にすると、
 * 最終日の朝の仕込みが毎回抜ける（§5.4.1b の [!note] が言う「単純移植では成立しない」の核心）。
 */
export function mealDaysForStay(stay: { checkInDate: string; checkOutDate: string }): MealDay[] {
  const days: MealDay[] = [];
  const last = new Date(`${stay.checkOutDate}T00:00:00Z`);

  for (
    const cursor = new Date(`${stay.checkInDate}T00:00:00Z`);
    cursor <= last;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({ date, slots: slotsForDate({ date, ...stay }) });
  }
  return days;
}

/** その日に提示する区分。滞在の外の日付なら空。 */
export function slotsForDate(params: {
  date: string;
  checkInDate: string;
  checkOutDate: string;
}): MealSlot[] {
  if (params.date < params.checkInDate || params.date > params.checkOutDate) {
    return [];
  }
  if (params.checkInDate === params.checkOutDate) {
    // 0泊（日帰り）の滞在は残枠側では作れない（`0014` の `chk_check_ins_stay_has_length`）。
    // 万一そうなった場合も、昼・夜だけ出して朝食を出さないほうが実態に近い。
    return ["lunch", "dinner"];
  }
  if (params.date === params.checkInDate) {
    return ["lunch", "dinner"];
  }
  if (params.date === params.checkOutDate) {
    return ["breakfast"];
  }
  return [...MEAL_SLOTS];
}

export type MealEditRejection =
  | "not_allowed"
  | "stay_finished"
  | "outside_stay"
  | "unknown_item"
  | "slot_mismatch"
  | "sold_out"
  | "invalid_quantity"
  | "already_converted";

export type MealEditDecision = { allowed: true } | { allowed: false; reason: MealEditRejection };

function isStaffRole(role: string): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * 1件の選択を保存してよいか（v13 §5.4.1b の「変更」「権限」行）。
 *
 * ## 本人はチェックインまで、運営は滞在中も直せる
 *
 * §5.4.1b は「**チェックインまで本人が変更可**」「運営は管理者・コアメンバーが全件参照・代理編集可」と定める。
 * 滞在中の追加・取消は現場で口頭に変わるため、**本人の経路は閉じて運営の経路だけ開けておく**。
 * ⚠️ 変更締切は**Phase 1 ではシステム制御しない**（同節）。ここで縛るのは状態だけで、時刻では縛らない。
 *
 * ## 変換済みの行は触らせない
 *
 * 提供操作で伝票になった行（`converted_at`）を後から書き換えると、**伝票と注文内容が食い違う**。
 * 訂正は伝票側（WBS 7-2 の明細編集）で行う。
 */
export function decideMealEdit(params: {
  actorRole: string;
  isOwner: boolean;
  stay: { status: string; checkInDate: string; checkOutDate: string };
  date: string;
  slot: MealSlot;
  /** 選択を外す場合は null */
  item: PreOrderableItem | null;
  quantity: number;
  /** 既存行（あれば）。変換済みかどうかの判定に使う */
  existing: MealReservation | null;
}): MealEditDecision {
  const staff = isStaffRole(params.actorRole);
  if (!staff && !params.isOwner) {
    return { allowed: false, reason: "not_allowed" };
  }
  if (!staff && params.stay.status !== "pre_registered" && params.stay.status !== "confirmed") {
    // 本人の変更はチェックインまで。滞在中以降は運営へ回す（§5.4.1b「変更」）
    return { allowed: false, reason: "stay_finished" };
  }
  if (params.stay.status === "cancelled" || params.stay.status === "checked_out") {
    return { allowed: false, reason: "stay_finished" };
  }
  // ★ 縛るのは**滞在日の範囲**だけである。既定で提示していない区分（例：到着日の朝食）も、
  //   範囲の内側なら足せてよい（早着・延泊は現場で起きる）。既定は「出す枠」であって値域ではない。
  if (params.date < params.stay.checkInDate || params.date > params.stay.checkOutDate) {
    return { allowed: false, reason: "outside_stay" };
  }
  if (params.existing?.convertedAt != null) {
    return { allowed: false, reason: "already_converted" };
  }
  if (params.item === null) {
    return { allowed: true }; // 選択を外す
  }
  if (params.item.mealSlot !== params.slot) {
    // 夜のプレートを朝の枠へ入れると、日別サマリーの食数が実態とずれる
    return { allowed: false, reason: "slot_mismatch" };
  }
  if (params.item.isSoldOut) {
    return { allowed: false, reason: "sold_out" };
  }
  if (!Number.isSafeInteger(params.quantity) || params.quantity < 1 || params.quantity > 20) {
    return { allowed: false, reason: "invalid_quantity" };
  }
  return { allowed: true };
}

/** 1日ぶんの食数（朝・昼・夜）。 */
export type MealCounts = Record<MealSlot, number>;

/**
 * ★ 日別の食数サマリー（v13 §5.4.1b「管理画面」）。
 *
 * **前日の時点で翌日の仕込み数が出せることが本機能の実質的な価値である**（同節）。
 * 数えるのは**数量の合計**であって件数ではない（4人分1件と1人分1件を同じ「1」にすると仕込みが足りない）。
 *
 * 取消済み（`cancelledAt`）は数えない。変換済み（`convertedAt`）は**数える** —
 * 提供して伝票になった食事も、その日に作った食数であることは変わらない。
 */
export function summarizeMealCounts(
  reservations: readonly MealReservation[],
): Map<string, MealCounts> {
  const summary = new Map<string, MealCounts>();
  for (const reservation of reservations) {
    if (reservation.cancelledAt !== null) {
      continue;
    }
    const counts = summary.get(reservation.servedOn) ?? { breakfast: 0, lunch: 0, dinner: 0 };
    counts[reservation.mealSlot] += reservation.quantity;
    summary.set(reservation.servedOn, counts);
  }
  return summary;
}

/** 合計食数（サマリーの1日ぶんを1つの数にする）。0 なら「予約なし」と出せる。 */
export function totalMeals(counts: MealCounts | undefined): number {
  if (counts === undefined) {
    return 0;
  }
  return counts.breakfast + counts.lunch + counts.dinner;
}

/** ある滞在の選択を「日付 → 区分 → 予約」で引ける形にする（画面の初期値に使う）。 */
export function indexByDateAndSlot(
  reservations: readonly MealReservation[],
): Map<string, MealReservation> {
  const index = new Map<string, MealReservation>();
  for (const reservation of reservations) {
    if (reservation.cancelledAt !== null) {
      continue;
    }
    index.set(`${reservation.servedOn}_${reservation.mealSlot}`, reservation);
  }
  return index;
}

/** 断られた理由を現場の言葉にする。 */
export function mealEditDenialMessage(reason: MealEditRejection): string {
  switch (reason) {
    case "not_allowed":
      return "この滞在の食事を変更する権限がありません。";
    case "stay_finished":
      return "チェックイン後の変更は運営へお申し出ください（現地で承ります）。";
    case "outside_stay":
      return "滞在の日程の外の日付は選べません。";
    case "unknown_item":
      return "選べないメニューが含まれています。画面を再読み込みしてください。";
    case "slot_mismatch":
      return "その時間帯に出していないメニューです。";
    case "sold_out":
      return "品切れのメニューは予約できません。";
    case "invalid_quantity":
      return "数量は1〜20の整数で入力してください。";
    case "already_converted":
      return "提供済み（伝票になった）の食事は変更できません。伝票側で訂正してください。";
  }
}
