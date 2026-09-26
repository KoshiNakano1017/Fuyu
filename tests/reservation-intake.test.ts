// アプリ内からの宿泊予約（WBS 3-7 ／ v13 §5.2.4）の受入テスト。
//
// ここで固定したいのは、§5.2.4 の表のうち**会員だから変わる振る舞い**である。
//   ① 備考が空なら自動確定（空白・改行だけは「書かれていない」＝公開予約ページと同じ式）
//   ② 宿泊券は「泊数」と「保有数」の両方を超えて充当できない（予約時点では消費しない）
//   ③ 会員料金は**夜ごとにその日付で有効な単価**を引く（料金改定をまたいでも過去の夜が動かない）
//   ④ 前回の滞在から初期値を作るが、PII は扱わない
//
// CLAUDE.md §4.4 は金額計算に必ずテストを求める。③は金額そのものなので1泊ずつ確かめる。

import type { AccommodationRate } from "@/lib/lodging/rates";
import {
  autoConfirms,
  decideReservation,
  describeReservationResult,
  maxApplicableTicketNights,
  prefillFromStays,
  quoteReservation,
  requestedNights,
  reservationDenialMessage,
  RESERVABLE_DAYS_AHEAD,
  type ReservationInput,
} from "@/lib/lodging/reservation-intake";

const TODAY = "2026-10-01";

function input(overrides: Partial<ReservationInput> = {}): ReservationInput {
  return {
    roomType: "dormitory",
    checkInDate: "2026-10-10",
    checkOutDate: "2026-10-12", // 2泊
    arrivalTime: "15:00",
    transportMethod: "car",
    adultsCount: 1,
    childrenCount: 0,
    stayTicketNights: 0,
    note: "",
    ...overrides,
  };
}

function decide(overrides: Partial<ReservationInput> = {}, balance = 0) {
  return decideReservation({
    input: input(overrides),
    knownRoomTypes: ["dormitory", "cottage", "campsite"],
    stayTicketBalance: balance,
    today: TODAY,
  });
}

function rate(overrides: Partial<AccommodationRate> = {}): AccommodationRate {
  return {
    rateId: "r1",
    roomType: "dormitory",
    memberCategory: "member",
    pricePerNightYen: 4000,
    effectiveFrom: "2026-01-01",
    effectiveUntil: null,
    ...overrides,
  };
}

describe("decideReservation", () => {
  test("既定の入力は受け付ける", () => {
    expect(decide()).toMatchObject({ allowed: true, plan: { nights: 2, status: "confirmed" } });
  });

  test("マスタに無い宿泊形態は選べない", () => {
    expect(decide({ roomType: "treehouse" })).toEqual({ allowed: false, reason: "unknown_type" });
  });

  test("退去日が初日以前なら断る", () => {
    expect(decide({ checkOutDate: "2026-10-10" })).toEqual({
      allowed: false,
      reason: "invalid_dates",
    });
  });

  test("過去日では予約できない（残枠ビューの窓の外で可否が数えられない）", () => {
    expect(decide({ checkInDate: "2026-09-30", checkOutDate: "2026-10-02" })).toEqual({
      allowed: false,
      reason: "past_date",
    });
  });

  test("当日の予約は受け付ける（過去日ではない）", () => {
    expect(decide({ checkInDate: TODAY, checkOutDate: "2026-10-02" }).allowed).toBe(true);
  });

  test(`${RESERVABLE_DAYS_AHEAD} 日より先は断る（ビューが行を持たない範囲）`, () => {
    expect(decide({ checkInDate: "2027-05-01", checkOutDate: "2027-05-02" })).toEqual({
      allowed: false,
      reason: "outside_window",
    });
  });

  test("大人0名・子供0名は受け付けない", () => {
    expect(decide({ adultsCount: 0, childrenCount: 0 })).toEqual({
      allowed: false,
      reason: "invalid_headcount",
    });
  });

  test("到着予定時刻は時刻の形でなければ断る", () => {
    expect(decide({ arrivalTime: "15時" })).toEqual({
      allowed: false,
      reason: "invalid_arrival_time",
    });
    expect(decide({ arrivalTime: "24:00" })).toEqual({
      allowed: false,
      reason: "invalid_arrival_time",
    });
    expect(decide({ arrivalTime: "" }).allowed).toBe(true); // 申告なしは許す
  });

  test("交通手段は4値以外を受け付けない（`0026` の CHECK と同じ）", () => {
    expect(decide({ transportMethod: "helicopter" })).toEqual({
      allowed: false,
      reason: "invalid_transport",
    });
    expect(decide({ transportMethod: "shuttle" }).allowed).toBe(true);
    expect(decide({ transportMethod: "" }).allowed).toBe(true);
  });

  test("★ 備考が空欄なら自動確定、何か書かれていれば要確認（v13 §9 #30-③）", () => {
    expect(decide({ note: "" })).toMatchObject({
      plan: { autoConfirmed: true, status: "confirmed" },
    });
    // 空白・改行だけは「書かれていない」として扱う（公開予約ページと同じ式 ／ `trim()`）
    expect(decide({ note: "  " })).toMatchObject({
      plan: { autoConfirmed: true, status: "confirmed" },
    });
    expect(decide({ note: "21時ごろ到着します" })).toMatchObject({
      plan: { autoConfirmed: false, status: "pre_registered" },
    });
  });

  test("★ 宿泊券は保有数を超えて充当できない", () => {
    expect(decide({ stayTicketNights: 2 }, 1)).toEqual({
      allowed: false,
      reason: "too_many_tickets",
    });
    expect(decide({ stayTicketNights: 1 }, 1).allowed).toBe(true);
  });

  test("★ 宿泊券は泊数を超えて充当できない（2泊の予約に3泊ぶんは充てられない）", () => {
    expect(decide({ stayTicketNights: 3 }, 10)).toEqual({
      allowed: false,
      reason: "too_many_tickets",
    });
    expect(decide({ stayTicketNights: 2 }, 10).allowed).toBe(true);
  });

  test("負の充当・小数の充当は受け付けない", () => {
    expect(decide({ stayTicketNights: -1 }, 5)).toEqual({
      allowed: false,
      reason: "too_many_tickets",
    });
    expect(decide({ stayTicketNights: 1.5 }, 5)).toEqual({
      allowed: false,
      reason: "too_many_tickets",
    });
  });
});

describe("autoConfirms / maxApplicableTicketNights", () => {
  test("空白・改行だけの備考は「書かれていない」とみなす（公開予約と同じ基準）", () => {
    expect(autoConfirms("")).toBe(true);
    expect(autoConfirms("\n ")).toBe(true);
    expect(autoConfirms("21時ごろ到着")).toBe(false);
  });

  test("充当上限は泊数と残高の小さいほう", () => {
    expect(maxApplicableTicketNights({ nights: 3, balance: 5 })).toBe(3);
    expect(maxApplicableTicketNights({ nights: 3, balance: 1 })).toBe(1);
    expect(maxApplicableTicketNights({ nights: 0, balance: 5 })).toBe(0);
    expect(maxApplicableTicketNights({ nights: 3, balance: -2 })).toBe(0);
  });
});

describe("requestedNights", () => {
  test("退去日は含めない（その夜は専有しない）", () => {
    const nights = requestedNights({
      roomType: "cottage",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-13",
      adultsCount: 2,
      childrenCount: 1,
    });
    expect(nights.map((night) => night.date)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(nights[0]).toEqual({
      date: "2026-10-10",
      roomType: "cottage",
      adultsCount: 2,
      childrenCount: 1,
    });
  });
});

describe("quoteReservation", () => {
  test("泊ごとに単価を積む", () => {
    const quote = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-13",
      rates: [rate()],
      memberCategory: "member",
    });
    expect(quote.lines).toHaveLength(3);
    expect(quote.totalYen).toBe(12000);
    expect(quote.payableYen).toBe(12000);
  });

  test("★ 会員区分で単価が変わる（会員料金の自動適用 ／ v13 §5.2.4）", () => {
    const rates = [rate(), rate({ rateId: "r2", memberCategory: "non_member", pricePerNightYen: 5000 })];
    const asMember = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-11",
      rates,
      memberCategory: "member",
    });
    const asGuest = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-11",
      rates,
      memberCategory: "non_member",
    });
    expect(asMember.totalYen).toBe(4000);
    expect(asGuest.totalYen).toBe(5000);
  });

  test("★ 単価が未登録の夜を0円として合計に混ぜない", () => {
    const quote = quoteReservation({
      roomType: "cottage", // 料金マスタに無い形態
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-12",
      rates: [rate()],
      memberCategory: "member",
    });
    expect(quote.totalYen).toBe(0);
    expect(quote.missingRateNights).toBe(2);
  });

  test("宿泊券を充当した分だけ支払額が下がる（単価が一律の場合）", () => {
    const quote = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-13",
      rates: [rate()],
      memberCategory: "member",
      stayTicketNights: 2,
    });
    expect(quote.coveredNights).toBe(2);
    expect(quote.payableYen).toBe(4000);
  });

  test("★ 料金改定をまたぐ日程で充当するときは金額を出さない（金額の仕様判断を実装がしない）", () => {
    const revised = [
      rate({ rateId: "old", pricePerNightYen: 4000, effectiveUntil: "2026-10-10" }),
      rate({ rateId: "new", pricePerNightYen: 5000, effectiveFrom: "2026-10-11" }),
    ];
    const quote = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-12",
      rates: revised,
      memberCategory: "member",
      stayTicketNights: 1,
    });
    // 合計は夜ごとに積むので出る。**どの夜に券を充てるかが未決**なので支払額だけが null
    expect(quote.totalYen).toBe(9000);
    expect(quote.payableYen).toBeNull();
  });

  test("充当が0泊なら、単価がばらついていても支払額は合計と同じ", () => {
    const revised = [
      rate({ rateId: "old", pricePerNightYen: 4000, effectiveUntil: "2026-10-10" }),
      rate({ rateId: "new", pricePerNightYen: 5000, effectiveFrom: "2026-10-11" }),
    ];
    const quote = quoteReservation({
      roomType: "dormitory",
      checkInDate: "2026-10-10",
      checkOutDate: "2026-10-12",
      rates: revised,
      memberCategory: "member",
      stayTicketNights: 0,
    });
    expect(quote.payableYen).toBe(9000);
  });
});

describe("prefillFromStays", () => {
  test("最新の滞在の形態・人数を初期値にする", () => {
    expect(
      prefillFromStays([
        { roomType: "dormitory", checkInDate: "2026-05-01", adultsCount: 1, childrenCount: 0 },
        { roomType: "cottage", checkInDate: "2026-08-01", adultsCount: 2, childrenCount: 1 },
      ]),
    ).toEqual({ roomType: "cottage", adultsCount: 2, childrenCount: 1 });
  });

  test("滞在が無ければ null（既定値はフォーム側のドミトリー）", () => {
    expect(prefillFromStays([])).toBeNull();
  });
});

describe("利用者へ返す言葉", () => {
  test("充当の超過は「満室」と言い換えない", () => {
    expect(reservationDenialMessage("too_many_tickets")).toContain("宿泊券");
    expect(reservationDenialMessage("full")).toContain("満室");
  });

  test("自動確定かどうかで案内が変わる", () => {
    expect(
      describeReservationResult({
        nights: 2,
        autoConfirmed: true,
        status: "confirmed",
        stayTicketNights: 0,
      }),
    ).toContain("確定しました");
    expect(
      describeReservationResult({
        nights: 2,
        autoConfirmed: false,
        status: "pre_registered",
        stayTicketNights: 0,
      }),
    ).toContain("確認してから確定");
  });

  test("充当したときは「消費はチェックアウト時」と伝える（v13 §5.2.4）", () => {
    expect(
      describeReservationResult({
        nights: 2,
        autoConfirmed: true,
        status: "confirmed",
        stayTicketNights: 2,
      }),
    ).toContain("チェックアウト時");
  });
});
