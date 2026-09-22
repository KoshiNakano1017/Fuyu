// 未会計額の集計（WBS 8-2）の受入テスト。
//
// CLAUDE.md §4.4 は金額計算に必ずテストを求める。ここで守りたいのは
// 「画面の合計と伝票の合計が一致すること」である（v13 §5.5 の丸めの作法）。

import { sumUnsettled, type SettleableOrder } from "@/lib/billing/unsettled";

function order(overrides: Partial<SettleableOrder> = {}): SettleableOrder {
  return { status: "未会計", totalAmountYen: 1000, totalAmountUii: 800, ...overrides };
}

describe("sumUnsettled", () => {
  test("伝票が無ければ0件・0円", () => {
    expect(sumUnsettled([])).toEqual({ orderCount: 0, totalAmountYen: 0, totalAmountUii: 0 });
  });

  test("未会計の伝票だけを数える", () => {
    expect(
      sumUnsettled([order(), order({ status: "精算済み" }), order({ status: "取消" })]).orderCount,
    ).toBe(1);
  });

  test("精算済みの金額は合計に入らない", () => {
    expect(sumUnsettled([order({ status: "精算済み" })]).totalAmountYen).toBe(0);
  });

  test("取消の金額は合計に入らない", () => {
    expect(sumUnsettled([order({ status: "取消" })]).totalAmountYen).toBe(0);
  });

  test("円の合計は各伝票の保存値の和になる", () => {
    expect(
      sumUnsettled([order({ totalAmountYen: 1000 }), order({ totalAmountYen: 250 })])
        .totalAmountYen,
    ).toBe(1250);
  });

  // ★ v13 §5.5: Uii は単品ごとに floor(単価×0.8)。円合計へ 0.8 を掛け直すと
  //   丸めが1回にまとまり、伝票に保存された Uii の和とずれる。
  //   ここは「掛け直していないこと」を数字で固定する試験である。
  test("Uii の合計は保存値の和であり、円合計からの再計算ではない", () => {
    const totals = sumUnsettled([
      order({ totalAmountYen: 125, totalAmountUii: 100 }),
      order({ totalAmountYen: 125, totalAmountUii: 100 }),
    ]);
    expect(totals.totalAmountUii).toBe(200);
  });

  test("円合計から再計算した値とは一致しない組み合わせでも保存値を優先する", () => {
    // 101円の商品は floor(101×0.8)=80 Uii。2件で 160 Uii。
    // 円合計 202 から計算すると floor(202×0.8)=161 になり、1 Uii ずれる。
    const totals = sumUnsettled([
      order({ totalAmountYen: 101, totalAmountUii: 80 }),
      order({ totalAmountYen: 101, totalAmountUii: 80 }),
    ]);
    expect(totals.totalAmountUii).toBe(160);
  });
});
