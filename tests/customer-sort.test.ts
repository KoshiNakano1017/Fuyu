// 顧客一覧の並び順（WBS 8-5 ／ v13 §5.6.7・§9 #43）の単体テスト。
//
// 並びは仕様そのものであり、実装を読んでも「なぜこの順か」は分からない。
// 各段が効いていることを1テスト1観点で固定する。

import { filterCustomers, groupByStay, sortCustomers, type CustomerRow } from "@/lib/customers/sort";

function customer(overrides: Partial<CustomerRow> & { memberId: string }): CustomerRow {
  return {
    displayName: "街人#10001",
    memberType: "街人",
    isStaying: false,
    checkInDate: null,
    hasPendingAdjustment: false,
    unsettledYen: 0,
    unsettledUii: 0,
    lastVisitDate: null,
    ...overrides,
  };
}

describe("既定の並び順（v13 §5.6.7）", () => {
  test("滞在中は未会計が0円でも滞在外より上に来る", () => {
    const sorted = sortCustomers([
      customer({ memberId: "away", unsettledYen: 50_000 }),
      customer({ memberId: "staying", isStaying: true, checkInDate: "2026-09-21" }),
    ]);
    expect(sorted[0].memberId).toBe("staying");
  });

  test("滞在中どうしはチェックイン日の古い順（退去が近い人が上）", () => {
    const sorted = sortCustomers([
      customer({ memberId: "new", isStaying: true, checkInDate: "2026-09-22" }),
      customer({ memberId: "old", isStaying: true, checkInDate: "2026-09-18" }),
    ]);
    expect(sorted.map((row) => row.memberId)).toEqual(["old", "new"]);
  });

  test("滞在外では未処理差額を持つ人が先に来る", () => {
    const sorted = sortCustomers([
      customer({ memberId: "rich", unsettledYen: 20_000 }),
      customer({ memberId: "pending", hasPendingAdjustment: true }),
    ]);
    expect(sorted[0].memberId).toBe("pending");
  });

  test("同条件なら未会計額の大きい順", () => {
    const sorted = sortCustomers([
      customer({ memberId: "small", unsettledYen: 1_000 }),
      customer({ memberId: "large", unsettledYen: 9_000 }),
    ]);
    expect(sorted.map((row) => row.memberId)).toEqual(["large", "small"]);
  });

  test("未会計額も同じなら最終来訪日の新しい順", () => {
    const sorted = sortCustomers([
      customer({ memberId: "older", lastVisitDate: "2026-05-01" }),
      customer({ memberId: "newer", lastVisitDate: "2026-09-01" }),
    ]);
    expect(sorted.map((row) => row.memberId)).toEqual(["newer", "older"]);
  });

  test("一度も来訪していない人を最終来訪日ありより上に置かない", () => {
    const sorted = sortCustomers([
      customer({ memberId: "never", lastVisitDate: null }),
      customer({ memberId: "visited", lastVisitDate: "2026-01-01" }),
    ]);
    expect(sorted.map((row) => row.memberId)).toEqual(["visited", "never"]);
  });

  test("元の配列を並べ替えない", () => {
    const rows = [
      customer({ memberId: "away" }),
      customer({ memberId: "staying", isStaying: true, checkInDate: "2026-09-21" }),
    ];
    sortCustomers(rows);
    expect(rows.map((row) => row.memberId)).toEqual(["away", "staying"]);
  });
});

describe("セクション分け", () => {
  test("滞在中と滞在外を分けて、それぞれ既定順で返す", () => {
    const { staying, away } = groupByStay([
      customer({ memberId: "away1", unsettledYen: 100 }),
      customer({ memberId: "stay2", isStaying: true, checkInDate: "2026-09-22" }),
      customer({ memberId: "stay1", isStaying: true, checkInDate: "2026-09-20" }),
    ]);
    expect(staying.map((row) => row.memberId)).toEqual(["stay1", "stay2"]);
    expect(away.map((row) => row.memberId)).toEqual(["away1"]);
  });
});

describe("検索（v13 §5.6.7「滞在状態に関わらず全件を対象」）", () => {
  test("滞在外の顧客も検索に出る", () => {
    const found = filterCustomers(
      [customer({ memberId: "m1", displayName: "たろう", isStaying: false })],
      "たろ",
    );
    expect(found).toHaveLength(1);
  });

  test("空の検索語では絞り込まない", () => {
    const rows = [customer({ memberId: "m1" }), customer({ memberId: "m2" })];
    expect(filterCustomers(rows, "  ")).toHaveLength(2);
  });
});
