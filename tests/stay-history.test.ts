// 宿泊履歴（泊まった部屋）の組み立て（WBS 8-6 ／ v13 §5.6.8）の単体テスト。
//
// §5.6.8 が「1行に潰さない」「部屋未割当を空欄にしない」「当時の部屋名で出す」と定める理由は、
// 用途の1つが**忘れ物・クレームの追跡**（日付と部屋の対応が正確でなければ役に立たない）だからである。

import { buildStayHistory, nightsBetween } from "@/lib/customers/stay-history";

const STAY = {
  checkinId: "c1",
  roomType: "cottage",
  checkInDate: "2026-09-01",
  checkOutDate: "2026-09-03",
  adultsCount: 2,
  childrenCount: 0,
  status: "checked_out",
};

describe("泊数", () => {
  test("チェックイン日とチェックアウト日の差を泊数にする", () => {
    expect(nightsBetween("2026-09-01", "2026-09-03")).toBe(2);
  });

  test("日帰り（同日）を1泊へ切り上げない", () => {
    expect(nightsBetween("2026-09-01", "2026-09-01")).toBe(0);
  });

  test("日付が逆転していたら0泊として扱う（負の泊数を作らない）", () => {
    expect(nightsBetween("2026-09-03", "2026-09-01")).toBe(0);
  });
});

describe("滞在の並びと部屋の展開（v13 §5.6.8）", () => {
  test("チェックイン日の新しい順に並べる", () => {
    const history = buildStayHistory({
      stays: [
        { ...STAY, checkinId: "old", checkInDate: "2026-05-01", checkOutDate: "2026-05-02" },
        { ...STAY, checkinId: "new", checkInDate: "2026-09-01", checkOutDate: "2026-09-02" },
      ],
      assignments: [],
    });
    expect(history.rows.map((row) => row.checkinId)).toEqual(["new", "old"]);
  });

  test("部屋移動のあった滞在は1行に潰さず時系列で展開する", () => {
    const history = buildStayHistory({
      stays: [STAY],
      assignments: [
        { checkinId: "c1", roomName: "ドミトリー3番", startedAt: "2026-09-02T00:00:00Z", endedAt: null },
        { checkinId: "c1", roomName: "コテージA", startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-02T00:00:00Z" },
      ],
    });
    expect(history.rows[0].rooms.map((room) => room.roomName)).toEqual([
      "コテージA",
      "ドミトリー3番",
    ]);
  });

  test("部屋の割当が無い滞在は空の配列で返す（画面が「部屋未割当」と出せるように）", () => {
    const history = buildStayHistory({ stays: [STAY], assignments: [] });
    expect(history.rows[0].rooms).toEqual([]);
  });

  test("他人の滞在の割当を混ぜない", () => {
    const history = buildStayHistory({
      stays: [STAY],
      assignments: [
        { checkinId: "other", roomName: "アースバッグ", startedAt: "2026-09-01T00:00:00Z", endedAt: null },
      ],
    });
    expect(history.rows[0].rooms).toEqual([]);
  });
});

describe("通算泊数とよく使う部屋", () => {
  test("予約段階・キャンセルの滞在は通算泊数に数えない", () => {
    const history = buildStayHistory({
      stays: [
        { ...STAY, checkinId: "done", status: "checked_out" },
        { ...STAY, checkinId: "booked", status: "confirmed" },
        { ...STAY, checkinId: "gone", status: "cancelled" },
      ],
      assignments: [],
    });
    expect(history.totalNights).toBe(2);
  });

  test("予約・キャンセルも行としては残す（顧客の履歴であるため）", () => {
    const history = buildStayHistory({
      stays: [{ ...STAY, checkinId: "gone", status: "cancelled" }],
      assignments: [],
    });
    expect(history.rows).toHaveLength(1);
  });

  test("よく使う部屋は回数の多い順に1つ出す", () => {
    const history = buildStayHistory({
      stays: [
        { ...STAY, checkinId: "c1" },
        { ...STAY, checkinId: "c2" },
      ],
      assignments: [
        { checkinId: "c1", roomName: "コテージA", startedAt: "2026-09-01T00:00:00Z", endedAt: null },
        { checkinId: "c2", roomName: "コテージA", startedAt: "2026-09-05T00:00:00Z", endedAt: null },
        { checkinId: "c2", roomName: "ドミトリー3番", startedAt: "2026-09-06T00:00:00Z", endedAt: null },
      ],
    });
    expect(history.favoriteRoom).toEqual({ roomName: "コテージA", times: 2 });
  });

  test("一度も泊まっていなければ「よく使う部屋」は無い", () => {
    const history = buildStayHistory({ stays: [], assignments: [] });
    expect(history.favoriteRoom).toBeNull();
  });
});
