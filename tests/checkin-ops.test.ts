// チェックイン／チェックアウト操作の判定（WBS 3-2 ／ v13 §5.2.2）の単体テスト。
//
// `check_ins.status` の遷移は DB の CHECK（値域）では縛れない。
// 「退館済みから戻せない」のような**向き**の性質はここで固定する。

import { decideCheckIn, decideCheckOut, isTodaysStay } from "@/lib/lodging/checkin-ops";

describe("チェックイン（v13 §5.2.2）", () => {
  test("予約確定から滞在中へ進められる", () => {
    expect(decideCheckIn({ actorRole: "core_member", status: "confirmed" })).toEqual({
      allowed: true,
    });
  });

  test("予約受付（自動確定前）からも入館できる（現地で受け付ける運用があるため）", () => {
    expect(decideCheckIn({ actorRole: "admin", status: "pre_registered" })).toEqual({
      allowed: true,
    });
  });

  test("一般会員はチェックイン操作を行えない", () => {
    expect(decideCheckIn({ actorRole: "member", status: "confirmed" })).toEqual({
      allowed: false,
      reason: "not_staff",
    });
  });

  test("既に滞在中の滞在を二重にチェックインできない", () => {
    expect(decideCheckIn({ actorRole: "admin", status: "staying" })).toEqual({
      allowed: false,
      reason: "already_staying",
    });
  });

  test("退館済みの滞在を再開できない（来訪回数の集計が潰れるため）", () => {
    expect(decideCheckIn({ actorRole: "admin", status: "checked_out" })).toEqual({
      allowed: false,
      reason: "already_checked_out",
    });
  });

  test("キャンセル済みの予約ではチェックインできない", () => {
    expect(decideCheckIn({ actorRole: "admin", status: "cancelled" })).toEqual({
      allowed: false,
      reason: "cancelled",
    });
  });
});

describe("チェックアウト", () => {
  test("滞在中なら退館できる", () => {
    expect(decideCheckOut({ actorRole: "admin", status: "staying" })).toEqual({ allowed: true });
  });

  test("まだ入館していない予約を退館させられない", () => {
    expect(decideCheckOut({ actorRole: "admin", status: "confirmed" })).toEqual({
      allowed: false,
      reason: "not_staying",
    });
  });

  test("一般会員は退館操作を行えない", () => {
    expect(decideCheckOut({ actorRole: "guest", status: "staying" })).toEqual({
      allowed: false,
      reason: "not_staff",
    });
  });
});

describe("当日の板に出す範囲", () => {
  const today = "2026-09-22";

  test("本日到着の予約を出す", () => {
    expect(
      isTodaysStay({ status: "confirmed", checkInDate: today, checkOutDate: "2026-09-24", today }),
    ).toBe(true);
  });

  test("滞在中は予定日を過ぎていても出す（延泊・退館忘れが見えなくなるため）", () => {
    expect(
      isTodaysStay({
        status: "staying",
        checkInDate: "2026-09-01",
        checkOutDate: "2026-09-03",
        today,
      }),
    ).toBe(true);
  });

  test("本日退館した滞在は出す（当日の対応が残るため）", () => {
    expect(
      isTodaysStay({
        status: "checked_out",
        checkInDate: "2026-09-20",
        checkOutDate: today,
        today,
      }),
    ).toBe(true);
  });

  test("先週退館した滞在は出さない", () => {
    expect(
      isTodaysStay({
        status: "checked_out",
        checkInDate: "2026-09-10",
        checkOutDate: "2026-09-12",
        today,
      }),
    ).toBe(false);
  });

  test("キャンセルは出さない", () => {
    expect(
      isTodaysStay({ status: "cancelled", checkInDate: today, checkOutDate: today, today }),
    ).toBe(false);
  });

  test("明日以降の到着は出さない", () => {
    expect(
      isTodaysStay({
        status: "confirmed",
        checkInDate: "2026-09-25",
        checkOutDate: "2026-09-26",
        today,
      }),
    ).toBe(false);
  });
});
