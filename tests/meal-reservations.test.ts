// カフェの事前予約注文（WBS 3-5c ／ v13 §5.4.1b ／ §9 #48）の受入テスト。
//
// ここで固定したいのは、§5.4.1b が名指しした「単純移植では成立しない」点である。
//   ① 滞在日ぶんの枠を出す。**退去日の朝食を落とさない**（朝ごはんはチェックイン翌朝）
//   ② 到着日は昼・夜、中日は朝・昼・夜、退去日は朝（到着15:00・退去10:00 の運用）
//   ③ 本人はチェックインまで、運営は滞在中も直せる
//   ④ 日別サマリーは**数量の合計**で数える（件数ではない）
//   ⑤ 提供済み（伝票になった）行は書き換えられない

import {
  decideMealEdit,
  indexByDateAndSlot,
  MEAL_SLOT_LABELS,
  mealDaysForStay,
  mealEditDenialMessage,
  slotsForDate,
  summarizeMealCounts,
  totalMeals,
  type MealReservation,
  type PreOrderableItem,
} from "@/lib/lodging/meal-reservations";

const STAY = { checkInDate: "2026-10-10", checkOutDate: "2026-10-12", status: "confirmed" };

function item(overrides: Partial<PreOrderableItem> = {}): PreOrderableItem {
  return {
    menuItemId: "m1",
    name: "夜のプレートごはん",
    unitPriceYen: 1500,
    mealSlot: "dinner",
    isSoldOut: false,
    ...overrides,
  };
}

function reservation(overrides: Partial<MealReservation> = {}): MealReservation {
  return {
    mealReservationId: "r1",
    checkinId: "c1",
    servedOn: "2026-10-10",
    mealSlot: "dinner",
    menuItemId: "m1",
    quantity: 1,
    cancelledAt: null,
    convertedAt: null,
    ...overrides,
  };
}

describe("mealDaysForStay / slotsForDate", () => {
  test("★ 2泊なら3日ぶんの枠が出る（退去日の朝食を落とさない）", () => {
    const days = mealDaysForStay(STAY);
    expect(days.map((day) => day.date)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
  });

  test("到着日は昼・夜、中日は朝・昼・夜、退去日は朝", () => {
    const days = mealDaysForStay(STAY);
    expect(days[0].slots).toEqual(["lunch", "dinner"]);
    expect(days[1].slots).toEqual(["breakfast", "lunch", "dinner"]);
    expect(days[2].slots).toEqual(["breakfast"]);
  });

  test("★ 2泊なら夕食2回・朝食2回になる（v13 §5.4.1b の [!note]）", () => {
    const days = mealDaysForStay(STAY);
    const countSlot = (slot: "breakfast" | "dinner") =>
      days.filter((day) => day.slots.includes(slot)).length;
    expect(countSlot("dinner")).toBe(2);
    expect(countSlot("breakfast")).toBe(2);
  });

  test("滞在の外の日付は枠が無い", () => {
    expect(slotsForDate({ date: "2026-10-09", ...STAY })).toEqual([]);
    expect(slotsForDate({ date: "2026-10-13", ...STAY })).toEqual([]);
  });

  test("1泊なら到着日（昼・夜）と退去日（朝）の2日ぶん", () => {
    const days = mealDaysForStay({ checkInDate: "2026-10-10", checkOutDate: "2026-10-11" });
    expect(days).toHaveLength(2);
    expect(days[1].slots).toEqual(["breakfast"]);
  });
});

describe("decideMealEdit", () => {
  const base = {
    actorRole: "member",
    isOwner: true,
    stay: STAY,
    date: "2026-10-10",
    slot: "dinner" as const,
    item: item(),
    quantity: 1,
    existing: null,
  };

  test("本人は予約段階の滞在を変更できる", () => {
    expect(decideMealEdit(base)).toEqual({ allowed: true });
  });

  test("他人の滞在は変更できない", () => {
    expect(decideMealEdit({ ...base, isOwner: false })).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
  });

  test("★ 本人はチェックイン後（滞在中）は変更できない（現地で運営へ）", () => {
    expect(
      decideMealEdit({ ...base, stay: { ...STAY, status: "staying" } }),
    ).toEqual({ allowed: false, reason: "stay_finished" });
  });

  test("★ 運営（コアメンバー）は滞在中も代理で変更できる", () => {
    expect(
      decideMealEdit({
        ...base,
        actorRole: "core_member",
        isOwner: false,
        stay: { ...STAY, status: "staying" },
      }),
    ).toEqual({ allowed: true });
  });

  test("退館済み・取消済みの滞在は運営でも変更できない", () => {
    for (const status of ["checked_out", "cancelled"]) {
      expect(
        decideMealEdit({ ...base, actorRole: "admin", isOwner: false, stay: { ...STAY, status } }),
      ).toEqual({ allowed: false, reason: "stay_finished" });
    }
  });

  test("滞在の日程の外の日付は断る", () => {
    expect(decideMealEdit({ ...base, date: "2026-10-13" })).toEqual({
      allowed: false,
      reason: "outside_stay",
    });
  });

  test("既定で提示していない区分でも、滞在日の範囲内なら足せる（早着・延泊があるため）", () => {
    // 到着日の朝食は既定では出さないが、値域としては許す
    expect(
      decideMealEdit({ ...base, slot: "breakfast", item: item({ mealSlot: "breakfast" }) }),
    ).toEqual({ allowed: true });
  });

  test("★ 区分の違うメニューは入れられない（夜のプレートを朝の枠へ）", () => {
    expect(decideMealEdit({ ...base, slot: "breakfast" })).toEqual({
      allowed: false,
      reason: "slot_mismatch",
    });
  });

  test("品切れのメニューは予約できない", () => {
    expect(decideMealEdit({ ...base, item: item({ isSoldOut: true }) })).toEqual({
      allowed: false,
      reason: "sold_out",
    });
  });

  test("数量は1〜20の整数", () => {
    expect(decideMealEdit({ ...base, quantity: 0 })).toEqual({
      allowed: false,
      reason: "invalid_quantity",
    });
    expect(decideMealEdit({ ...base, quantity: 21 })).toEqual({
      allowed: false,
      reason: "invalid_quantity",
    });
    expect(decideMealEdit({ ...base, quantity: 1.5 })).toEqual({
      allowed: false,
      reason: "invalid_quantity",
    });
  });

  test("選択を外す（null）ときは数量を見ない", () => {
    expect(decideMealEdit({ ...base, item: null, quantity: 0 })).toEqual({ allowed: true });
  });

  test("★ 提供済み（伝票になった）行は書き換えられない", () => {
    expect(
      decideMealEdit({
        ...base,
        existing: reservation({ convertedAt: "2026-10-10T10:00:00Z" }),
      }),
    ).toEqual({ allowed: false, reason: "already_converted" });
  });
});

describe("summarizeMealCounts / totalMeals", () => {
  test("★ 数量の合計で数える（件数ではない）", () => {
    const summary = summarizeMealCounts([
      reservation({ mealReservationId: "a", quantity: 4 }),
      reservation({ mealReservationId: "b", menuItemId: "m2", quantity: 1 }),
    ]);
    expect(summary.get("2026-10-10")).toEqual({ breakfast: 0, lunch: 0, dinner: 5 });
  });

  test("取消済みは数えない", () => {
    const summary = summarizeMealCounts([
      reservation({ mealReservationId: "a", quantity: 2 }),
      reservation({ mealReservationId: "b", quantity: 3, cancelledAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(totalMeals(summary.get("2026-10-10"))).toBe(2);
  });

  test("★ 提供済み（伝票になった）分は数える — その日に作った食数であることは変わらない", () => {
    const summary = summarizeMealCounts([
      reservation({ quantity: 2, convertedAt: "2026-10-10T12:00:00Z" }),
    ]);
    expect(totalMeals(summary.get("2026-10-10"))).toBe(2);
  });

  test("区分ごとに分けて数える", () => {
    const summary = summarizeMealCounts([
      reservation({ mealReservationId: "a", mealSlot: "breakfast", quantity: 3 }),
      reservation({ mealReservationId: "b", mealSlot: "lunch", quantity: 2 }),
      reservation({ mealReservationId: "c", mealSlot: "dinner", quantity: 1 }),
    ]);
    expect(summary.get("2026-10-10")).toEqual({ breakfast: 3, lunch: 2, dinner: 1 });
  });

  test("予約が無い日は 0 として扱える", () => {
    expect(totalMeals(undefined)).toBe(0);
  });
});

describe("indexByDateAndSlot", () => {
  test("日付と区分で引ける（取消済みは入れない）", () => {
    const index = indexByDateAndSlot([
      reservation({ mealReservationId: "a" }),
      reservation({ mealReservationId: "b", mealSlot: "lunch", cancelledAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(index.get("2026-10-10_dinner")?.mealReservationId).toBe("a");
    expect(index.get("2026-10-10_lunch")).toBeUndefined();
  });
});

describe("利用者へ返す言葉", () => {
  test("区分の表示名は日本語で出す（内部識別子を画面へ出さない）", () => {
    expect(MEAL_SLOT_LABELS.breakfast).toBe("朝ごはん");
  });

  test("チェックイン後の変更は「現地で承る」と伝える", () => {
    expect(mealEditDenialMessage("stay_finished")).toContain("現地");
  });

  test("提供済みは伝票側で直すよう伝える", () => {
    expect(mealEditDenialMessage("already_converted")).toContain("伝票");
  });
});
