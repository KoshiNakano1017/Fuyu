// 滞在中の宿泊形態・部屋・日程・人数の変更（WBS 3-10 ／ v13 §5.6.9）の受入テスト。
//
// ここで固定したいのは、§5.6.9 が名指しで禁じている3つの壊れ方である。
//   ① 滞在全体が新しい形態の単価で塗り替わる（→ `nightlyRoomTypes` / `nightlyLodgingCharge`）
//   ② 満室の夜へ変更が通る（→ `decideStayChange` の `full`）
//   ③ 理由なしで変更できる（→ `decideStayChange` の `blank_reason`）
//
// CLAUDE.md §4.4 は金額計算に必ずテストを求める。宿泊費は泊単位の積み上げなので、
// 「どの夜がどの単価で計算されたか」を1泊ずつ確かめる。

import type { AccommodationCapacity } from "@/lib/lodging/availability";
import type { AccommodationRate } from "@/lib/lodging/rates";
import {
  decideStayChange,
  defaultEffectiveDate,
  describeStayChange,
  findFullNight,
  nightlyLodgingCharge,
  nightlyRoomTypes,
  nightsToJudge,
  stayChangeDenialMessage,
  type NightlyStay,
  type StayChangeInput,
  type StayForChange,
} from "@/lib/lodging/stay-changes";

function stay(overrides: Partial<StayForChange> = {}): StayForChange {
  return {
    checkinId: "stay-1",
    status: "staying",
    roomType: "campsite",
    checkInDate: "2026-10-01",
    checkOutDate: "2026-10-04", // 3泊
    adultsCount: 2,
    childrenCount: 0,
    roomId: null,
    roomName: null,
    stayTicketsAppliedNights: 0,
    ...overrides,
  };
}

function input(overrides: Partial<StayChangeInput> = {}): StayChangeInput {
  return {
    roomType: "cottage",
    roomId: null,
    checkOutDate: "2026-10-04",
    adultsCount: 2,
    childrenCount: 0,
    effectiveDate: "2026-10-03",
    reason: "雨天のためコテージへ移動",
    ...overrides,
  };
}

/** キャンプサイト＝人数枠型（定員10）／コテージ＝棟貸型（3棟・1棟2名）。v13 §5.4.2 の確定表に合わせる。 */
function capacities(
  overrides: Record<string, AccommodationCapacity> = {},
): Map<string, AccommodationCapacity> {
  return new Map(
    Object.entries({
      campsite: {
        allocationMode: "per_person",
        totalCapacity: 10,
        totalUnits: 1,
        unitCapacity: 10,
      } satisfies AccommodationCapacity,
      cottage: {
        allocationMode: "per_unit",
        totalCapacity: 6,
        totalUnits: 3,
        unitCapacity: 2,
      } satisfies AccommodationCapacity,
      ...overrides,
    }),
  );
}

const KNOWN_ROOM_TYPES = ["campsite", "cottage", "dormitory"];

function decide(params: {
  stayOverrides?: Partial<StayForChange>;
  inputOverrides?: Partial<StayChangeInput>;
  actorRole?: string;
  others?: readonly NightlyStay[];
  capacityOverrides?: Record<string, AccommodationCapacity>;
}) {
  return decideStayChange({
    actorRole: params.actorRole ?? "core_member",
    stay: stay(params.stayOverrides),
    input: input(params.inputOverrides),
    knownRoomTypes: KNOWN_ROOM_TYPES,
    others: params.others ?? [],
    capacities: capacities(params.capacityOverrides),
  });
}

describe("decideStayChange", () => {
  test("運営（コアメンバー）は変更できる", () => {
    expect(decide({}).allowed).toBe(true);
  });

  test("一般会員は変更できない", () => {
    const decision = decide({ actorRole: "member" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("退館済みの滞在は変更できない", () => {
    expect(decide({ stayOverrides: { status: "checked_out" } })).toEqual({
      allowed: false,
      reason: "not_changeable",
    });
  });

  test("取消済みの滞在は変更できない", () => {
    expect(decide({ stayOverrides: { status: "cancelled" } })).toEqual({
      allowed: false,
      reason: "not_changeable",
    });
  });

  test("理由が空白だけなら断る（v13 §5.6.9 の理由必須）", () => {
    expect(decide({ inputOverrides: { reason: "  " } })).toEqual({
      allowed: false,
      reason: "blank_reason",
    });
  });

  test("何も変わっていない送信は断る", () => {
    expect(
      decide({ inputOverrides: { roomType: "campsite", checkOutDate: "2026-10-04" } }),
    ).toEqual({ allowed: false, reason: "no_change" });
  });

  test("大人0名・子供0名は受け付けない（幽霊予約を作らない）", () => {
    expect(decide({ inputOverrides: { adultsCount: 0, childrenCount: 0 } })).toEqual({
      allowed: false,
      reason: "invalid_counts",
    });
  });

  test("退去日が初日以前なら断る", () => {
    expect(decide({ inputOverrides: { checkOutDate: "2026-10-01" } })).toEqual({
      allowed: false,
      reason: "invalid_check_out_date",
    });
  });

  test("★ 適用日に退去日を選ぶと1泊も効かないため断る", () => {
    expect(decide({ inputOverrides: { effectiveDate: "2026-10-04" } })).toEqual({
      allowed: false,
      reason: "effective_date_outside_stay",
    });
  });

  test("適用日が初日より前なら断る", () => {
    expect(decide({ inputOverrides: { effectiveDate: "2026-09-30" } })).toEqual({
      allowed: false,
      reason: "effective_date_outside_stay",
    });
  });

  test("マスタに無い宿泊形態は選べない", () => {
    expect(decide({ inputOverrides: { roomType: "treehouse" } })).toEqual({
      allowed: false,
      reason: "unknown_room_type",
    });
  });

  test("★ 変更後の夜が満室なら断る（棟貸型は棟数で数える）", () => {
    // コテージ3棟が他人で埋まっている夜（1名ずつでも3棟＝満室 ／ v13 §9 #47）
    const others: NightlyStay[] = ["other-a", "other-b", "other-c"].map(() => ({
      date: "2026-10-03",
      roomType: "cottage",
      adultsCount: 1,
      childrenCount: 0,
    }));
    const decision = decide({ others });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({
      reason: "full",
      fullNight: { date: "2026-10-03", roomType: "cottage" },
    });
  });

  test("満室でも、変更が効く日より前の夜なら変更を止めない", () => {
    // 1泊目のコテージは埋まっているが、変更は3泊目（10-03）からしか効かない
    const others: NightlyStay[] = [1, 2, 3].map(() => ({
      date: "2026-10-01",
      roomType: "cottage",
      adultsCount: 1,
      childrenCount: 0,
    }));
    expect(decide({ others }).allowed).toBe(true);
  });

  test("部屋が1つも無い形態は満室として扱う", () => {
    const decision = decide({ inputOverrides: { roomType: "dormitory" } });
    expect(decision).toMatchObject({ reason: "full" });
  });

  test("★ 人数を減らす変更は、自分の占有を除いて数えるので通る", () => {
    // 自分（コテージ2名）を others に含めない前提を固定する。含めると二重に数えて満室になる。
    const others: NightlyStay[] = [
      { date: "2026-10-03", roomType: "cottage", adultsCount: 2, childrenCount: 0 },
      { date: "2026-10-03", roomType: "cottage", adultsCount: 2, childrenCount: 0 },
    ];
    const decision = decide({
      stayOverrides: { roomType: "cottage", adultsCount: 2 },
      inputOverrides: { roomType: "cottage", adultsCount: 1 },
      others,
    });
    expect(decision.allowed).toBe(true);
  });

  test("延泊は増えた夜まで残枠を判定する", () => {
    const others: NightlyStay[] = [1, 2, 3].map(() => ({
      date: "2026-10-05",
      roomType: "cottage",
      adultsCount: 1,
      childrenCount: 0,
    }));
    const decision = decide({ inputOverrides: { checkOutDate: "2026-10-06" } });
    expect(decision.allowed).toBe(true);

    const blocked = decide({ inputOverrides: { checkOutDate: "2026-10-06" }, others });
    expect(blocked).toMatchObject({ reason: "full", fullNight: { date: "2026-10-05" } });
  });

  test("★ 宿泊券の充当泊数より短い日程には変更できない（履歴だけが積まれるのを防ぐ）", () => {
    // 3泊の滞在に3泊ぶんの宿泊券を充てている状態で、1泊へ短縮しようとする
    const decision = decide({
      stayOverrides: { stayTicketsAppliedNights: 3 },
      inputOverrides: { checkOutDate: "2026-10-02", effectiveDate: "2026-10-01" },
    });
    expect(decision).toEqual({ allowed: false, reason: "tickets_exceed_nights" });
  });

  test("充当泊数と同じ泊数までは短縮できる", () => {
    expect(
      decide({
        stayOverrides: { stayTicketsAppliedNights: 1 },
        inputOverrides: { checkOutDate: "2026-10-02", effectiveDate: "2026-10-01" },
      }).allowed,
    ).toBe(true);
  });

  test("許可された変更は差分を返す（変わっていない項目は null）", () => {
    const decision = decide({ inputOverrides: { adultsCount: 3 } });
    expect(decision).toMatchObject({
      allowed: true,
      diff: {
        roomType: { before: "campsite", after: "cottage" },
        adults: { before: 2, after: 3 },
        checkOutDate: null,
        children: null,
        room: null,
      },
    });
  });
});

describe("nightsToJudge", () => {
  test("適用日から新しい退去日の前日までを並べる", () => {
    const nights = nightsToJudge(stay(), input({ checkOutDate: "2026-10-06" }));
    expect(nights.map((night) => night.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
  });

  test("適用日が初日より前でも、滞在の初日から並べる", () => {
    const nights = nightsToJudge(stay(), input({ effectiveDate: "2026-10-01" }));
    expect(nights.map((night) => night.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
});

describe("findFullNight", () => {
  test("人数枠型は人数の合計で数える", () => {
    const others: NightlyStay[] = [
      { date: "2026-10-01", roomType: "campsite", adultsCount: 9, childrenCount: 0 },
    ];
    const requested: NightlyStay[] = [
      { date: "2026-10-01", roomType: "campsite", adultsCount: 2, childrenCount: 0 },
    ];
    expect(findFullNight({ requested, others, capacities: capacities() })).toEqual({
      date: "2026-10-01",
      roomType: "campsite",
    });
  });

  test("定員を超える人数は複数棟を消費する", () => {
    // コテージ3棟。他人が1棟。3名の予約は2棟要るので入る（1 + 2 = 3）
    const others: NightlyStay[] = [
      { date: "2026-10-01", roomType: "cottage", adultsCount: 2, childrenCount: 0 },
    ];
    const requested: NightlyStay[] = [
      { date: "2026-10-01", roomType: "cottage", adultsCount: 3, childrenCount: 0 },
    ];
    expect(findFullNight({ requested, others, capacities: capacities() })).toBeNull();

    // 5名なら3棟要るので入らない（1 + 3 > 3）
    const tooMany: NightlyStay[] = [
      { date: "2026-10-01", roomType: "cottage", adultsCount: 5, childrenCount: 0 },
    ];
    expect(findFullNight({ requested: tooMany, others, capacities: capacities() })).toMatchObject({
      date: "2026-10-01",
    });
  });

  test("別の日・別の形態の占有は数えない", () => {
    const others: NightlyStay[] = [
      { date: "2026-10-02", roomType: "cottage", adultsCount: 2, childrenCount: 0 },
      { date: "2026-10-01", roomType: "campsite", adultsCount: 10, childrenCount: 0 },
    ];
    const requested: NightlyStay[] = [
      { date: "2026-10-01", roomType: "cottage", adultsCount: 2, childrenCount: 0 },
    ];
    expect(findFullNight({ requested, others, capacities: capacities() })).toBeNull();
  });
});

describe("nightlyRoomTypes", () => {
  const target = { checkInDate: "2026-10-01", checkOutDate: "2026-10-04", roomType: "cottage" };

  test("変更履歴が無ければ全泊が現在の形態", () => {
    expect(nightlyRoomTypes({ stay: target, changes: [] })).toEqual([
      { date: "2026-10-01", roomType: "cottage" },
      { date: "2026-10-02", roomType: "cottage" },
      { date: "2026-10-03", roomType: "cottage" },
    ]);
  });

  test("★ 途中で形態が変わった滞在は、変更日を境に切り替わる（滞在全体を塗り替えない）", () => {
    const changes = [
      {
        effectiveDate: "2026-10-03",
        roomTypeBefore: "campsite",
        roomTypeAfter: "cottage",
        createdAt: "2026-10-02T10:00:00Z",
      },
    ];
    expect(nightlyRoomTypes({ stay: target, changes })).toEqual([
      { date: "2026-10-01", roomType: "campsite" },
      { date: "2026-10-02", roomType: "campsite" },
      { date: "2026-10-03", roomType: "cottage" },
    ]);
  });

  test("2回移った滞在も夜ごとに追える", () => {
    const changes = [
      {
        effectiveDate: "2026-10-02",
        roomTypeBefore: "campsite",
        roomTypeAfter: "dormitory",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        effectiveDate: "2026-10-03",
        roomTypeBefore: "dormitory",
        roomTypeAfter: "cottage",
        createdAt: "2026-10-02T10:00:00Z",
      },
    ];
    expect(nightlyRoomTypes({ stay: target, changes }).map((night) => night.roomType)).toEqual([
      "campsite",
      "dormitory",
      "cottage",
    ]);
  });

  test("形態を変えていない変更行（人数だけの訂正）は形態に影響しない", () => {
    const changes = [
      {
        effectiveDate: "2026-10-02",
        roomTypeBefore: null,
        roomTypeAfter: null,
        createdAt: "2026-10-01T10:00:00Z",
      },
    ];
    expect(nightlyRoomTypes({ stay: target, changes }).map((night) => night.roomType)).toEqual([
      "cottage",
      "cottage",
      "cottage",
    ]);
  });
});

describe("nightlyLodgingCharge", () => {
  function rate(overrides: Partial<AccommodationRate> = {}): AccommodationRate {
    return {
      rateId: "r1",
      roomType: "campsite",
      memberCategory: "member",
      pricePerNightYen: 2000,
      effectiveFrom: "2026-01-01",
      effectiveUntil: null,
      ...overrides,
    };
  }

  const rates = [
    rate(),
    rate({ rateId: "r2", roomType: "cottage", pricePerNightYen: 8000 }),
  ];

  test("★ 夜ごとにその夜の形態の単価を積む", () => {
    const charge = nightlyLodgingCharge({
      nights: [
        { date: "2026-10-01", roomType: "campsite" },
        { date: "2026-10-02", roomType: "campsite" },
        { date: "2026-10-03", roomType: "cottage" },
      ],
      rates,
      memberCategory: "member",
    });
    expect(charge.lines.map((line) => line.pricePerNightYen)).toEqual([2000, 2000, 8000]);
    expect(charge.totalYen).toBe(12000);
    expect(charge.missingRateNights).toBe(0);
  });

  test("★ 単価が引けない夜を0円として合計に混ぜない", () => {
    const charge = nightlyLodgingCharge({
      nights: [
        { date: "2026-10-01", roomType: "campsite" },
        { date: "2026-10-02", roomType: "earthbag" },
      ],
      rates,
      memberCategory: "member",
    });
    expect(charge.totalYen).toBe(2000);
    expect(charge.missingRateNights).toBe(1);
    expect(charge.lines[1].pricePerNightYen).toBeNull();
  });

  test("★ 料金改定をまたぐ滞在は、その夜に有効だった単価で積む", () => {
    const revised = [
      rate({ rateId: "old", pricePerNightYen: 2000, effectiveUntil: "2026-10-01" }),
      rate({ rateId: "new", pricePerNightYen: 2500, effectiveFrom: "2026-10-02" }),
    ];
    const charge = nightlyLodgingCharge({
      nights: [
        { date: "2026-10-01", roomType: "campsite" },
        { date: "2026-10-02", roomType: "campsite" },
      ],
      rates: revised,
      memberCategory: "member",
    });
    expect(charge.lines.map((line) => line.pricePerNightYen)).toEqual([2000, 2500]);
    expect(charge.totalYen).toBe(4500);
  });

  test("会員区分が違えば別の単価を引く", () => {
    const withNonMember = [
      ...rates,
      rate({ rateId: "r3", memberCategory: "non_member", pricePerNightYen: 3000 }),
    ];
    const charge = nightlyLodgingCharge({
      nights: [{ date: "2026-10-01", roomType: "campsite" }],
      rates: withNonMember,
      memberCategory: "non_member",
    });
    expect(charge.totalYen).toBe(3000);
  });
});

describe("defaultEffectiveDate", () => {
  test("滞在中は当日から", () => {
    expect(defaultEffectiveDate(stay(), "2026-10-02")).toBe("2026-10-02");
  });

  test("予約段階は初日から", () => {
    expect(defaultEffectiveDate(stay({ status: "confirmed" }), "2026-09-20")).toBe("2026-10-01");
  });

  test("滞在中でも当日が滞在の窓の外なら初日へ寄せる（予定日とのずれを弾かない）", () => {
    expect(defaultEffectiveDate(stay(), "2026-10-09")).toBe("2026-10-01");
    expect(defaultEffectiveDate(stay(), "2026-09-28")).toBe("2026-10-01");
  });
});

describe("利用者へ返す言葉", () => {
  test("満室のときは、どの夜のどの形態が埋まっているかを伝える", () => {
    expect(
      stayChangeDenialMessage("full", { date: "2026-10-03", roomType: "コテージ" }),
    ).toContain("2026-10-03");
  });

  test("理由の書き忘れを「満室」と言い換えない", () => {
    expect(stayChangeDenialMessage("blank_reason")).toContain("理由");
  });

  test("宿泊券の充当が邪魔しているときはそう伝える", () => {
    expect(stayChangeDenialMessage("tickets_exceed_nights")).toContain("宿泊券");
  });

  test("変更の要約は変わった項目だけを並べる", () => {
    expect(
      describeStayChange({
        roomType: { before: "キャンプサイト", after: "コテージ" },
        checkOutDate: null,
        adults: { before: 2, after: 3 },
        children: null,
        room: null,
      }),
    ).toBe("宿泊形態 キャンプサイト → コテージ ／ 大人 2名 → 3名");
  });
});
