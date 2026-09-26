// 本人向けカレンダー A12（宿泊予定・履歴カレンダー）の受入テスト（WBS 3-8 ／ Issue #169）。
//
// 根拠: v13 §5.2.5②（L681「自身の宿泊予定（未来）と宿泊履歴（過去）を月表示のカレンダーで表示。
//       日付タップで当該滞在の詳細へ遷移」）／ 画面設計.md §4 A12（L430–432）／
//       v13 §6「自身の宿泊予定・履歴カレンダー ＝ 全ロール〇」。
//
// 運営向け C10 と違い、A12 は **閲覧者自身の滞在しか載せない**。
// ここを緩めると、ゲストを含む全ロールに開いている画面から他人の滞在が読める
// （CLAUDE.md §7.1 ／ v13 §8「一般会員・ゲスト向けレスポンスに個人情報を含めない」）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { buildMyStayCalendar, type MyStayDay } from "@/lib/lodging/calendar";
import type { StayEntry } from "@/lib/lodging/fetch-lodging";

const ME = "00000000-0000-0000-0000-00000000aa01";
const SOMEONE_ELSE = "00000000-0000-0000-0000-00000000aa02";
const TODAY = "2026-09-15";
const MONTH = "2026-09";

function stay(overrides: Partial<StayEntry> = {}): StayEntry {
  return {
    checkinId: "stay-1",
    memberId: ME,
    memberLabel: "街人#10001",
    roomType: "dormitory",
    checkInDate: "2026-09-20",
    checkOutDate: "2026-09-22",
    adultsCount: 1,
    childrenCount: 0,
    status: "confirmed",
    note: "",
    ...overrides,
  };
}

function buildForMe(stays: StayEntry[], memberId = ME): MyStayDay[] {
  return buildMyStayCalendar({ month: MONTH, today: TODAY, memberId, stays });
}

function dayOf(days: MyStayDay[], date: string): MyStayDay {
  const found = days.find((day) => day.date === date);
  if (found === undefined) throw new Error(`${date} の日セルが無い`);
  return found;
}

describe("月表示のカレンダーで予定と履歴を見せる（完了条件14 ／ 画面設計.md §4 A12「表示」）", () => {
  test("指定した月の日数ぶんの日セルを返す（一覧ではなく月表示である）", () => {
    expect(buildForMe([])).toHaveLength(30);
  });

  test("未来の宿泊予定が日セルに現れる", () => {
    const days = buildForMe([stay({ checkInDate: "2026-09-20", checkOutDate: "2026-09-22" })]);
    expect(dayOf(days, "2026-09-20").stays).toHaveLength(1);
  });

  test("過去の宿泊履歴も同じカレンダーの日セルに現れる", () => {
    const days = buildForMe([
      stay({
        checkinId: "past",
        checkInDate: "2026-09-02",
        checkOutDate: "2026-09-04",
        status: "checked_out",
      }),
    ]);
    expect(dayOf(days, "2026-09-02").stays).toHaveLength(1);
  });

  test("滞在の中日も現れる（初日だけの点にしない）", () => {
    const days = buildForMe([stay({ checkInDate: "2026-09-20", checkOutDate: "2026-09-22" })]);
    expect(dayOf(days, "2026-09-21").stays).toHaveLength(1);
  });

  test("退去日は滞在として現れない（残枠の数え方と揃える ／ DB物理設計 §3-12）", () => {
    const days = buildForMe([stay({ checkInDate: "2026-09-20", checkOutDate: "2026-09-22" })]);
    expect(dayOf(days, "2026-09-22").stays).toHaveLength(0);
  });
});

describe("日付タップで滞在の詳細へ遷移する（完了条件15 ／ 画面設計.md §4 A12「遷移」）", () => {
  test("滞在のある日セルは当該滞在の詳細への遷移先を持つ", () => {
    const days = buildForMe([stay({ checkinId: "stay-42" })]);
    expect(dayOf(days, "2026-09-20").href).toBe("/me/stays/stay-42");
  });

  test("滞在の無い日セルは遷移先を持たない（空振りのリンクを作らない）", () => {
    const days = buildForMe([stay()]);
    expect(dayOf(days, "2026-09-10").href).toBeNull();
  });
});

describe("予定・履歴・要確認を色で区別する（完了条件16 ／ 画面設計.md §4 A12「区別」）", () => {
  // 色そのものは画面側の関心なので、ここでは**区別が付く値が日セルに乗ること**を固定する。
  // 3種が同じ値に潰れていれば落ちる。
  test("未来の滞在の日セルは予定として区別される", () => {
    const days = buildForMe([stay({ checkInDate: "2026-09-20", checkOutDate: "2026-09-22" })]);
    expect(dayOf(days, "2026-09-20").tone).toBe("upcoming");
  });

  test("過去の滞在の日セルは履歴として区別される", () => {
    const days = buildForMe([
      stay({ checkInDate: "2026-09-02", checkOutDate: "2026-09-04", status: "checked_out" }),
    ]);
    expect(dayOf(days, "2026-09-02").tone).toBe("history");
  });

  test("「要確認」の予約がある日セルは要確認として区別される（v13 §5.2.3 TO-BE④）", () => {
    const days = buildForMe([
      stay({ status: "pre_registered", note: "アレルギーがあります" }),
    ]);
    expect(dayOf(days, "2026-09-20").tone).toBe("attention");
  });

  test("滞在の無い日セルには区別が付かない", () => {
    expect(dayOf(buildForMe([stay()]), "2026-09-10").tone).toBeNull();
  });
});

describe("自分の滞在だけを載せる（完了条件17 ／ v13 §6 ／ 画面設計.md §5 A12）", () => {
  test("拒否側: 他人の滞在はカレンダーに現れない", () => {
    const days = buildForMe([stay({ checkinId: "other", memberId: SOMEONE_ELSE })]);
    expect(dayOf(days, "2026-09-20").stays).toHaveLength(0);
  });

  test("拒否側: 他人の滞在だけの日セルは遷移先も持たない（他人の滞在IDを露出させない）", () => {
    const days = buildForMe([stay({ checkinId: "other", memberId: SOMEONE_ELSE })]);
    expect(dayOf(days, "2026-09-20").href).toBeNull();
  });

  test("許可側: ロールで絞り込まない（ゲストの利用者でも自分の滞在は現れる）", () => {
    // v13 §6 の「自身の宿泊予定・履歴カレンダー」は全ロール〇。
    // 閲覧できるかどうかは `member_id` の一致だけで決まり、`role` も `member_type` も見ない
    // （CLAUDE.md §4.1：認可に `member_type` を使わない）。
    const guestId = "00000000-0000-0000-0000-00000000aa09";
    const days = buildForMe([stay({ checkinId: "guest-stay", memberId: guestId })], guestId);
    expect(dayOf(days, "2026-09-20").stays).toHaveLength(1);
  });
});
