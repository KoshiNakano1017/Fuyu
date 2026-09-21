// 宿泊料金の選び方（WBS 3-9 ／ Issue #106）の受入テスト。
//
// CLAUDE.md §4.4 は金額計算に必ずテストを求める。ここで守りたいのは
// 「**過去の予約が今の料金で再計算されない**」こと（v13 §5.4.2② ／ §5.6.5）である。

import {
  memberCategoryOf,
  rateOn,
  stayPriceYen,
  type AccommodationRate,
} from "@/lib/lodging/rates";

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

describe("rateOn", () => {
  test("適用期間内なら料金が引ける", () => {
    expect(rateOn([rate()], { roomType: "dormitory", memberCategory: "member", date: "2026-06-01" })
      ?.pricePerNightYen).toBe(4000);
  });

  test("適用開始日より前は引けない", () => {
    expect(
      rateOn([rate({ effectiveFrom: "2026-07-01" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-30",
      }),
    ).toBeNull();
  });

  test("適用終了日を過ぎていれば引けない", () => {
    expect(
      rateOn([rate({ effectiveUntil: "2026-05-31" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-01",
      }),
    ).toBeNull();
  });

  test("適用開始日の当日は引ける", () => {
    expect(
      rateOn([rate({ effectiveFrom: "2026-06-01" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-01",
      }),
    ).not.toBeNull();
  });

  test("適用終了日の当日は引ける", () => {
    expect(
      rateOn([rate({ effectiveUntil: "2026-06-01" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-01",
      }),
    ).not.toBeNull();
  });

  // ★ 過去の予約は当時の料金で再計算する（v13 §5.4.2②）。
  //   「現行行（effective_until が NULL）を優先する」実装にすると、この試験が落ちる。
  test("改定後の日付でも、その日に適用されていた旧料金を引く", () => {
    const rates = [
      rate({ rateId: "old", pricePerNightYen: 3500, effectiveFrom: "2026-01-01", effectiveUntil: "2026-06-30" }),
      rate({ rateId: "new", pricePerNightYen: 4200, effectiveFrom: "2026-07-01", effectiveUntil: null }),
    ];
    expect(
      rateOn(rates, { roomType: "dormitory", memberCategory: "member", date: "2026-03-15" })?.rateId,
    ).toBe("old");
  });

  test("会員区分が違う料金は引かない", () => {
    expect(
      rateOn([rate({ memberCategory: "non_member" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-01",
      }),
    ).toBeNull();
  });

  test("宿泊形態が違う料金は引かない", () => {
    expect(
      rateOn([rate({ roomType: "cottage" })], {
        roomType: "dormitory",
        memberCategory: "member",
        date: "2026-06-01",
      }),
    ).toBeNull();
  });

  // 期間の重なりは DB の ex_rate_no_overlap が禁じている。
  // それでも2行届いたときに黙ってどちらかを選ぶと、重なりが入っていることに気づけない。
  test("該当行が複数あるときはどちらも選ばず null を返す", () => {
    const overlapping = [
      rate({ rateId: "a", effectiveFrom: "2026-01-01", effectiveUntil: "2026-12-31" }),
      rate({ rateId: "b", effectiveFrom: "2026-06-01", effectiveUntil: null }),
    ];
    expect(rateOn(overlapping, { roomType: "dormitory", memberCategory: "member", date: "2026-07-01" }))
      .toBeNull();
  });
});

describe("stayPriceYen", () => {
  test("泊数を掛ける", () => {
    expect(stayPriceYen({ pricePerNightYen: 4000, nights: 3 })).toBe(12000);
  });

  test("1泊なら単価のまま", () => {
    expect(stayPriceYen({ pricePerNightYen: 4000, nights: 1 })).toBe(4000);
  });

  test("0泊は受け付けない（退去日は専有しないため最低1泊になる）", () => {
    expect(() => stayPriceYen({ pricePerNightYen: 4000, nights: 0 })).toThrow(RangeError);
  });
});

describe("memberCategoryOf", () => {
  // v13 §5.2.3 の warning：会員料金の自己申告を廃止し、ログイン状態から判定する。
  // 自己申告を受け取る実装にすると、ゲストが会員料金を選べる抜け道が復活する。
  test("ログインしていれば会員料金", () => {
    expect(memberCategoryOf(true)).toBe("member");
  });

  test("未ログインは非会員料金", () => {
    expect(memberCategoryOf(false)).toBe("non_member");
  });
});
