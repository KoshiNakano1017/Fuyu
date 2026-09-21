// 宿泊予定カレンダーの組み立て（WBS 3-6・3-8）の受入テスト。
//
// 守りたいのは「カレンダーの人数と `v_room_availability` の残枠が食い違わないこと」。
// 退去日の扱い（専有しない）を両者で揃えているかが要点である。

import {
  buildCalendar,
  datesOfMonth,
  headcountOn,
  needsAttention,
  type CalendarDay,
} from "@/lib/lodging/calendar";
import type { DailyAvailability, StayEntry } from "@/lib/lodging/fetch-lodging";

function stay(overrides: Partial<StayEntry> = {}): StayEntry {
  return {
    checkinId: "s1",
    memberId: "m1",
    memberLabel: "街人#10001",
    roomType: "dormitory",
    checkInDate: "2026-09-10",
    checkOutDate: "2026-09-12",
    adultsCount: 2,
    childrenCount: 0,
    status: "confirmed",
    ...overrides,
  };
}

function availability(overrides: Partial<DailyAvailability> = {}): DailyAvailability {
  return { date: "2026-09-10", roomType: "dormitory", total: 16, occupied: 2, available: 14, ...overrides };
}

describe("datesOfMonth", () => {
  test("30日の月は30日分を返す", () => {
    expect(datesOfMonth("2026-09")).toHaveLength(30);
  });

  test("31日の月は31日分を返す", () => {
    expect(datesOfMonth("2026-10")).toHaveLength(31);
  });

  test("うるう年の2月は29日分を返す", () => {
    expect(datesOfMonth("2028-02")).toHaveLength(29);
  });

  test("先頭は月初、末尾は月末になる", () => {
    const dates = datesOfMonth("2026-09");
    expect([dates[0], dates[dates.length - 1]]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  test("月の指定が不正なら例外を投げる", () => {
    expect(() => datesOfMonth("九月")).toThrow(RangeError);
  });
});

describe("buildCalendar", () => {
  test("宿泊初日は滞在として現れる", () => {
    const days = buildCalendar({ dates: ["2026-09-10"], stays: [stay()], availability: [] });
    expect(days[0].stays).toHaveLength(1);
  });

  test("中日も滞在として現れる", () => {
    const days = buildCalendar({ dates: ["2026-09-11"], stays: [stay()], availability: [] });
    expect(days[0].stays).toHaveLength(1);
  });

  // ★ 退去日は専有しない（`availability.ts` の `occupiesDate()` と同じ約束）。
  //   ここを `<=` にするとカレンダーの人数とビューの残枠が食い違う。
  test("退去日は滞在として現れない", () => {
    const days = buildCalendar({ dates: ["2026-09-12"], stays: [stay()], availability: [] });
    expect(days[0].stays).toHaveLength(0);
  });

  test("宿泊初日より前は滞在として現れない", () => {
    const days = buildCalendar({ dates: ["2026-09-09"], stays: [stay()], availability: [] });
    expect(days[0].stays).toHaveLength(0);
  });

  test("残枠はその日の行だけが束ねられる", () => {
    const days = buildCalendar({
      dates: ["2026-09-10"],
      stays: [],
      availability: [availability(), availability({ date: "2026-09-11" })],
    });
    expect(days[0].availability).toHaveLength(1);
  });
});

describe("headcountOn", () => {
  test("件数ではなく人数（大人＋子ども）を数える", () => {
    const day: CalendarDay = {
      date: "2026-09-10",
      stays: [stay({ adultsCount: 2, childrenCount: 1 }), stay({ checkinId: "s2", adultsCount: 1 })],
      availability: [],
    };
    expect(headcountOn(day)).toBe(4);
  });
});

describe("needsAttention", () => {
  test("満室の形態が1つでもあれば要確認になる", () => {
    const day: CalendarDay = {
      date: "2026-09-10",
      stays: [],
      availability: [availability({ available: 5 }), availability({ roomType: "cottage", total: 3, available: 0 })],
    };
    expect(needsAttention(day)).toBe(true);
  });

  test("すべて空きがあれば要確認にならない", () => {
    const day: CalendarDay = {
      date: "2026-09-10",
      stays: [],
      availability: [availability({ available: 5 })],
    };
    expect(needsAttention(day)).toBe(false);
  });

  // 部屋が1つも登録されていない形態（total = 0）は「満室」ではなく「取り扱いが無い」。
  // これを要確認にすると、使っていない形態のせいで毎日が警告になる。
  test("そもそも枠が0の形態は要確認にしない", () => {
    const day: CalendarDay = {
      date: "2026-09-10",
      stays: [],
      availability: [availability({ roomType: "salon", total: 0, occupied: 0, available: 0 })],
    };
    expect(needsAttention(day)).toBe(false);
  });
});
