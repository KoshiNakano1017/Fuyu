// 宿泊枠の残数算出（WBS 3-8）の単体テスト。
//
// 検証の主眼は **占有量の数え方が2通りある**ことである（v13 §9 #47）。
// 一律の式に戻す改変が入ったら、ここが落ちる。
//
// 期待値は `supabase/migrations/0015_room_availability_view.sql` の
// `v_room_availability` と同じ式から引いており、
// TypeScript 側とビュー側が割れていないことを固定する。

import {
  calculateAvailability,
  canAccommodateStay,
  countNights,
  countOccupancy,
  datesOfStay,
  type AccommodationCapacity,
  type OccupyingStay,
} from "@/lib/lodging/availability";

/** ドミトリー: 1行・capacity 16（v13 §5.4.2 確定表）。 */
const DORMITORY: AccommodationCapacity = {
  allocationMode: "per_person",
  totalCapacity: 16,
  totalUnits: 1,
  unitCapacity: 16,
};

/** コテージ: 3棟・各 capacity 2（v13 §5.4.2 確定表）。 */
const COTTAGE: AccommodationCapacity = {
  allocationMode: "per_unit",
  totalCapacity: 6,
  totalUnits: 3,
  unitCapacity: 2,
};

function stay(checkInDate: string, checkOutDate: string, adults: number, children = 0): OccupyingStay {
  return { checkInDate, checkOutDate, adultsCount: adults, childrenCount: children };
}

describe("占有量の数え方（v13 §9 #47）", () => {
  test("人数枠型は予約人数の合計を占有量とする", () => {
    const stays = [stay("2026-10-01", "2026-10-02", 2), stay("2026-10-01", "2026-10-02", 3)];
    expect(countOccupancy(stays, DORMITORY)).toBe(5);
  });

  test("人数枠型は子供も人数に数える", () => {
    expect(countOccupancy([stay("2026-10-01", "2026-10-02", 2, 3)], DORMITORY)).toBe(5);
  });

  test("棟貸型は1名の予約でも1棟を占有する", () => {
    expect(countOccupancy([stay("2026-10-01", "2026-10-02", 1)], COTTAGE)).toBe(1);
  });

  test("棟貸型は1名の予約が3件で3棟すべてを占有する（一律計算だと「残り3名」と誤表示されていた欠陥）", () => {
    const stays = [
      stay("2026-10-01", "2026-10-02", 1),
      stay("2026-10-01", "2026-10-02", 1),
      stay("2026-10-01", "2026-10-02", 1),
    ];
    expect(countOccupancy(stays, COTTAGE)).toBe(3);
  });

  test("棟貸型は定員を超える人数の予約が複数棟を消費する", () => {
    // 3名 ÷ 1棟あたり2名 = 2棟（切り上げ）
    expect(countOccupancy([stay("2026-10-01", "2026-10-02", 3)], COTTAGE)).toBe(2);
  });
});

describe("残枠の算出", () => {
  test("人数枠型の分母は定員の合計である", () => {
    const { total } = calculateAvailability({ date: "2026-10-01", stays: [], capacity: DORMITORY });
    expect(total).toBe(16);
  });

  test("棟貸型の分母は棟数である", () => {
    const { total } = calculateAvailability({ date: "2026-10-01", stays: [], capacity: COTTAGE });
    expect(total).toBe(3);
  });

  test("コテージに1名の予約が3件入ると残枠は0になる", () => {
    const stays = [
      stay("2026-10-01", "2026-10-02", 1),
      stay("2026-10-01", "2026-10-02", 1),
      stay("2026-10-01", "2026-10-02", 1),
    ];
    const { available } = calculateAvailability({ date: "2026-10-01", stays, capacity: COTTAGE });
    expect(available).toBe(0);
  });

  test("定員を超過して登録された場合も残枠は負数にならない", () => {
    const stays = [stay("2026-10-01", "2026-10-02", 20)];
    const { available } = calculateAvailability({ date: "2026-10-01", stays, capacity: DORMITORY });
    expect(available).toBe(0);
  });

  test("チェックアウト日は専有しない（退去日と次の到着日が重なる予約を弾かないため）", () => {
    const stays = [stay("2026-10-01", "2026-10-03", 4)];
    const { occupied } = calculateAvailability({ date: "2026-10-03", stays, capacity: DORMITORY });
    expect(occupied).toBe(0);
  });

  test("チェックイン日は専有する", () => {
    const stays = [stay("2026-10-01", "2026-10-03", 4)];
    const { occupied } = calculateAvailability({ date: "2026-10-01", stays, capacity: DORMITORY });
    expect(occupied).toBe(4);
  });

  test("滞在の中日も専有する", () => {
    const stays = [stay("2026-10-01", "2026-10-03", 4)];
    const { occupied } = calculateAvailability({ date: "2026-10-02", stays, capacity: DORMITORY });
    expect(occupied).toBe(4);
  });

  test("対象日にかからない予約は占有量に数えない", () => {
    const stays = [stay("2026-11-01", "2026-11-03", 4)];
    const { occupied } = calculateAvailability({ date: "2026-10-01", stays, capacity: DORMITORY });
    expect(occupied).toBe(0);
  });
});

describe("滞在全日程での受け入れ可否（v13 §5.2.3 ③）", () => {
  test("全日程に空きがあれば受け入れられる", () => {
    const accepted = canAccommodateStay({
      requested: stay("2026-10-01", "2026-10-03", 2),
      existingStays: [],
      capacity: DORMITORY,
    });
    expect(accepted).toBe(true);
  });

  test("初日は空いていても2泊目が満室なら受け入れない", () => {
    const accepted = canAccommodateStay({
      requested: stay("2026-10-01", "2026-10-03", 2),
      existingStays: [stay("2026-10-02", "2026-10-03", 16)],
      capacity: DORMITORY,
    });
    expect(accepted).toBe(false);
  });

  test("棟貸型では空き棟数より必要棟数が多いと受け入れない", () => {
    // 既に2棟埋まっており、3名（＝2棟必要）の予約は入らない
    const accepted = canAccommodateStay({
      requested: stay("2026-10-01", "2026-10-02", 3),
      existingStays: [stay("2026-10-01", "2026-10-02", 1), stay("2026-10-01", "2026-10-02", 1)],
      capacity: COTTAGE,
    });
    expect(accepted).toBe(false);
  });
});

describe("滞在日数の展開", () => {
  test("2泊の滞在は専有日を2日返す（退去日を含まない）", () => {
    expect(datesOfStay(stay("2026-10-01", "2026-10-03", 1))).toEqual(["2026-10-01", "2026-10-02"]);
  });

  test("月をまたぐ滞在でも日付が正しく繰り上がる", () => {
    expect(datesOfStay(stay("2026-10-31", "2026-11-02", 1))).toEqual(["2026-10-31", "2026-11-01"]);
  });

  test("うるう年の2月29日をまたぐ滞在でも日付が正しく繰り上がる", () => {
    expect(datesOfStay(stay("2028-02-28", "2028-03-01", 1))).toEqual(["2028-02-28", "2028-02-29"]);
  });

  test("泊数は専有日数と一致する（宿泊券の消費数の根拠になる）", () => {
    expect(countNights(stay("2026-10-01", "2026-10-04", 1))).toBe(3);
  });
});
