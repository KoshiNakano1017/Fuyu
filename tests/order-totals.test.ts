// 伝票合計（WBS 6-1 / 7-2 / 8-2）と差額の Uii 換算（WBS 8-3）の単体テスト。
//
// CLAUDE.md §4.4：金額計算に関わるロジックは必ずテストを書く。
// 主眼は v13 §5.5「Uii は**単品ごと**に floor(単価×0.8) する」であり、
// 伝票合計に 0.8 を掛ける実装へ退行したら落ちるよう、端数が出る単価で固定している。

import {
  calculateOrderTotals,
  lineSubtotalUii,
  lineSubtotalYen,
  toOrderItemRows,
} from "@/lib/orders/totals";
import {
  canWaive,
  categoryOf,
  isStale,
  outstandingAdjustmentYen,
  toSignedUii,
  type Adjustment,
} from "@/lib/billing/adjustment";

describe("明細行の小計", () => {
  test("円の小計は単価×数量である", () => {
    expect(lineSubtotalYen({ productName: "季節のプレートごはん", unitPriceYen: 2100, quantity: 2 })).toBe(4200);
  });

  test("Uii の小計は単品ごとに丸めてから数量を掛ける", () => {
    // floor(2100 × 0.8) = 1680 → ×2 = 3360
    expect(lineSubtotalUii({ productName: "季節のプレートごはん", unitPriceYen: 2100, quantity: 2 })).toBe(3360);
  });

  test("端数が出る単価では、合計に0.8を掛ける方式と結果がずれる", () => {
    // 正しい: floor(999 × 0.8) × 3 = 799 × 3 = 2397
    // 誤り  : floor(2997 × 0.8)           = 2397 … ここは一致する
    // ずれるのは切り捨て分が点数だけ積み上がる場合である（下の伝票合計のテストで固定する）
    expect(lineSubtotalUii({ productName: "テスト商品", unitPriceYen: 999, quantity: 3 })).toBe(2397);
  });
});

describe("伝票合計（v13 §5.5）", () => {
  test("複数明細の Uii 合計は明細行 Uii の和である", () => {
    const totals = calculateOrderTotals([
      { productName: "ワンプレートごはん", unitPriceYen: 1300, quantity: 1 },
      { productName: "抹茶ラテ", unitPriceYen: 700, quantity: 1 },
    ]);
    // floor(1300×0.8)=1040 ＋ floor(700×0.8)=560 → 1600
    expect(totals.totalAmountUii).toBe(1600);
  });

  test("円の合計は明細行の小計の和である", () => {
    const totals = calculateOrderTotals([
      { productName: "ワンプレートごはん", unitPriceYen: 1300, quantity: 1 },
      { productName: "抹茶ラテ", unitPriceYen: 700, quantity: 1 },
    ]);
    expect(totals.totalAmountYen).toBe(2000);
  });

  test("単品ごとの丸めが積み上がる伝票では、合計に0.8を掛けた値と一致しない", () => {
    // 単品ごと: floor(101×0.8)=80 を5点 → 400
    // 合計に掛ける: floor(505×0.8) = 404
    // この 4 の差が「カードの合計と伝票が合わない」現場の不信になる
    const totals = calculateOrderTotals([{ productName: "テスト商品", unitPriceYen: 101, quantity: 5 }]);
    expect(totals.totalAmountUii).toBe(400);
    expect(totals.totalAmountUii).not.toBe(Math.floor(totals.totalAmountYen * 0.8));
  });

  test("明細が無い伝票の合計は0である", () => {
    expect(calculateOrderTotals([])).toEqual({ totalAmountYen: 0, totalAmountUii: 0 });
  });

  test("送迎は1,900円＝1,520Uii として計上できる（v13 §5.4.2③）", () => {
    const totals = calculateOrderTotals([
      { productName: "送迎（三角駅→浮遊街・片道）", unitPriceYen: 1900, quantity: 1 },
    ]);
    expect(totals.totalAmountUii).toBe(1520);
  });
});

describe("伝票明細の行への写し", () => {
  test("明細行は注文時点の Uii 単価を持つ", () => {
    const rows = toOrderItemRows([{ productName: "抹茶ラテ", unitPriceYen: 700, quantity: 2 }]);
    expect(rows[0].unit_price_uii).toBe(560);
  });
});

describe("差額の Uii 換算（WBS 8-3）", () => {
  test("追加請求は正の Uii になる", () => {
    expect(toSignedUii(1000)).toBe(800);
  });

  test("返金は負の Uii になる", () => {
    expect(toSignedUii(-1000)).toBe(-800);
  });

  test("返金の端数は絶対値で丸めるため、追加請求と丸めの向きが揃う", () => {
    // 素朴に Math.floor(-501 × 0.8) とすると -401 になり、返金が 1 Uii 多くなる
    expect(toSignedUii(-501)).toBe(-400);
    expect(toSignedUii(501)).toBe(400);
  });

  test("整数でない金額は受け付けない", () => {
    expect(() => toSignedUii(100.5)).toThrow(TypeError);
  });
});

describe("差額の区分（v13 §5.6.6）", () => {
  test("正の金額は追加請求である", () => {
    expect(categoryOf(3000)).toBe("追加請求");
  });

  test("負の金額は返金である", () => {
    expect(categoryOf(-3000)).toBe("返金");
  });

  test("0円の調整行は作れない", () => {
    expect(() => categoryOf(0)).toThrow(RangeError);
  });
});

describe("免除の権限（Phase 1 はコアメンバーにも許可 ／ 2026-08-16 回答）", () => {
  test("管理者は免除できる", () => {
    expect(canWaive("admin")).toBe(true);
  });

  test("コアメンバーも免除できる", () => {
    expect(canWaive("core_member")).toBe(true);
  });

  test("一般会員は免除できない", () => {
    expect(canWaive("member")).toBe(false);
  });
});

describe("90日滞留の判定（旗を立てるだけで自動免除はしない）", () => {
  const now = new Date("2026-09-20T00:00:00Z");

  function adjustment(occurredAt: string, status: Adjustment["status"]): Adjustment {
    return { amountYen: 1000, status, occurredAt };
  }

  test("未処理のまま90日を超えた差額は滞留である", () => {
    expect(isStale(adjustment("2026-06-01T00:00:00Z", "未処理"), now)).toBe(true);
  });

  test("90日以内の未処理は滞留ではない", () => {
    expect(isStale(adjustment("2026-09-01T00:00:00Z", "未処理"), now)).toBe(false);
  });

  test("精算済みは古くても滞留ではない", () => {
    expect(isStale(adjustment("2026-01-01T00:00:00Z", "精算済み"), now)).toBe(false);
  });

  test("免除済みは古くても滞留ではない", () => {
    expect(isStale(adjustment("2026-01-01T00:00:00Z", "免除"), now)).toBe(false);
  });
});

describe("未会計額に含める差額（v13 §5.6.6 の警告）", () => {
  test("未処理の差額は繰越を選んでも合計に含め続ける", () => {
    const adjustments: Adjustment[] = [
      { amountYen: 1500, status: "未処理", occurredAt: "2026-09-01T00:00:00Z" },
      { amountYen: -500, status: "未処理", occurredAt: "2026-09-02T00:00:00Z" },
    ];
    expect(outstandingAdjustmentYen(adjustments)).toBe(1000);
  });

  test("精算済み・免除の差額は合計に含めない", () => {
    const adjustments: Adjustment[] = [
      { amountYen: 1500, status: "精算済み", occurredAt: "2026-09-01T00:00:00Z" },
      { amountYen: 800, status: "免除", occurredAt: "2026-09-02T00:00:00Z" },
    ];
    expect(outstandingAdjustmentYen(adjustments)).toBe(0);
  });
});
