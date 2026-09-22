// 伝票編集（WBS 7-2）の判定と、編集結果の組み立ての単体テスト。
//
// 根拠: v13 §5.6.2（編集できる操作）・§5.6.3（自動再計算・旧QRの失効）・
//       §5.6.4（編集理由の必須）・§5.6.5（精算済み伝票の遡及修正と差額）。
//
// 金額に関わる判定であり、CLAUDE.md §4.4 が「必ずテストを書く」と定める領域である。

import {
  decideCancel,
  decideReassign,
  decideSlipEdit,
  planCancellation,
  planSlipEdit,
} from "@/lib/orders/slip-edit";

const LINES = [{ productName: "おにぎり", unitPriceYen: 300, quantity: 2 }];

describe("編集の可否（v13 §5.6.2・§5.6.4・§5.6.5）", () => {
  test("一般会員は伝票を編集できない", () => {
    const decision = decideSlipEdit({
      actorRole: "member",
      orderStatus: "未会計",
      reason: "数量の訂正",
      lines: LINES,
    });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("理由が空白だけの編集を受け付けない", () => {
    const decision = decideSlipEdit({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "　",
      lines: LINES,
    });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });

  test("精算済みの伝票も編集できる（遡及修正を塞がない）", () => {
    const decision = decideSlipEdit({
      actorRole: "core_member",
      orderStatus: "精算済み",
      reason: "品目の取り違え",
      lines: LINES,
    });
    expect(decision).toEqual({ allowed: true });
  });

  test("取消済みの伝票は編集できない", () => {
    const decision = decideSlipEdit({
      actorRole: "admin",
      orderStatus: "取消",
      reason: "訂正",
      lines: LINES,
    });
    expect(decision).toEqual({ allowed: false, reason: "order_cancelled" });
  });

  test("明細を全部消す編集は受け付けない（それは伝票の取消である）", () => {
    const decision = decideSlipEdit({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "全部取り消す",
      lines: [],
    });
    expect(decision).toEqual({ allowed: false, reason: "empty_lines" });
  });

  test("数量0の明細を受け付けない", () => {
    const decision = decideSlipEdit({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "訂正",
      lines: [{ productName: "おにぎり", unitPriceYen: 300, quantity: 0 }],
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid_quantity" });
  });

  test("負の単価を受け付けない（返金は差額の経路で扱う）", () => {
    const decision = decideSlipEdit({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "値引き",
      lines: [{ productName: "おにぎり", unitPriceYen: -100, quantity: 1 }],
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid_price" });
  });
});

describe("編集結果の組み立て（v13 §5.6.3・§5.6.5）", () => {
  test("未会計の伝票を編集しても差額は生まれない", () => {
    const plan = planSlipEdit({
      lines: LINES,
      orderStatus: "未会計",
      settledAmountYen: 900,
      hasActiveQr: false,
    });
    expect(plan.difference).toBeNull();
  });

  test("精算済みの伝票を増額すると追加請求の差額が残る", () => {
    const plan = planSlipEdit({
      lines: [{ productName: "おにぎり", unitPriceYen: 300, quantity: 4 }],
      orderStatus: "精算済み",
      settledAmountYen: 600,
      hasActiveQr: false,
    });
    expect(plan.difference).toEqual({ amountYen: 600, amountUii: 480, category: "追加請求" });
  });

  test("精算済みの伝票を減額すると返金の差額が残る", () => {
    const plan = planSlipEdit({
      lines: [{ productName: "おにぎり", unitPriceYen: 300, quantity: 1 }],
      orderStatus: "精算済み",
      settledAmountYen: 600,
      hasActiveQr: false,
    });
    expect(plan.difference).toEqual({ amountYen: -300, amountUii: -240, category: "返金" });
  });

  test("金額が変わらない編集では差額の行を作らない（0円の調整行は作れない）", () => {
    const plan = planSlipEdit({
      lines: LINES,
      orderStatus: "精算済み",
      settledAmountYen: 600,
      hasActiveQr: false,
    });
    expect(plan.difference).toBeNull();
  });

  test("生きている精算QRがある伝票を編集すると失効させる（v13 §5.6.3-5）", () => {
    const plan = planSlipEdit({
      lines: LINES,
      orderStatus: "未会計",
      settledAmountYen: 0,
      hasActiveQr: true,
    });
    expect(plan.revokeQr).toBe(true);
  });

  test("QRを発行していない伝票には失効時刻を書かない", () => {
    const plan = planSlipEdit({
      lines: LINES,
      orderStatus: "未会計",
      settledAmountYen: 0,
      hasActiveQr: false,
    });
    expect(plan.revokeQr).toBe(false);
  });

  test("合計は単品ごとに丸めた Uii の合算である（v13 §5.5）", () => {
    const plan = planSlipEdit({
      lines: [{ productName: "コーヒー", unitPriceYen: 1299, quantity: 2 }],
      orderStatus: "未会計",
      settledAmountYen: 0,
      hasActiveQr: false,
    });
    expect(plan.totals).toEqual({ totalAmountYen: 2598, totalAmountUii: 2078 });
  });
});

describe("注文者の付け替え（v13 §5.6.2）", () => {
  test("同じ人への付け替えは受け付けない", () => {
    const decision = decideReassign({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "誤選択",
      currentPurchaserId: "m1",
      nextPurchaserId: "m1",
    });
    expect(decision).toEqual({ allowed: false, reason: "same_purchaser" });
  });

  test("理由なしの付け替えは受け付けない", () => {
    const decision = decideReassign({
      actorRole: "admin",
      orderStatus: "未会計",
      reason: "",
      currentPurchaserId: "m1",
      nextPurchaserId: "m2",
    });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });
});

describe("伝票の取消（v13 §5.6.2・§5.6.5-5）", () => {
  test("理由なしの取消は受け付けない", () => {
    expect(decideCancel({ actorRole: "admin", orderStatus: "未会計", reason: " " })).toEqual({
      allowed: false,
      reason: "blank_reason",
    });
  });

  test("未会計の伝票を取り消しても返金差額は生まれない", () => {
    expect(planCancellation({ orderStatus: "未会計", settledAmountYen: 600 })).toBeNull();
  });

  test("精算済みの伝票を取り消すと精算額の全額が返金差額になる", () => {
    expect(planCancellation({ orderStatus: "精算済み", settledAmountYen: 600 })).toEqual({
      amountYen: -600,
      amountUii: -480,
      category: "返金",
    });
  });
});
