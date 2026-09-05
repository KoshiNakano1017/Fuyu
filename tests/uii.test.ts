import { toUii } from "@/lib/uii";

describe("toUii: 円からUiiへの換算（v13 §5.5）", () => {
  test("999円は floor(999×0.8) = 799 Uii になる", () => {
    expect(toUii(999)).toBe(799);
  });

  test("0円は 0 Uii になる", () => {
    expect(toUii(0)).toBe(0);
  });

  test("端数の出ない3,000円は 2,400 Uii になる", () => {
    expect(toUii(3000)).toBe(2400);
  });

  test("切り捨ては単品ごとに行われ、999円×2品はUii単価の和 1,598 Uii になる", () => {
    expect(toUii(999) * 2).toBe(1598);
  });

  test("1,111円×2品は 1,776 Uii であり、合計金額に0.8を掛けた floor(2222×0.8) = 1777 とは一致しない", () => {
    // v13 §5.5 が「単品ごとに切り捨て」と定める理由の実例。
    // 合算後に0.8を掛けると切り捨てが1回にまとまり、1 Uii 多く算出されてしまう
    const uiiPerItem = toUii(1111);
    expect(uiiPerItem * 2).toBe(1776);
    expect(Math.floor(2222 * 0.8)).toBe(1777);
  });

  test("負数の円価格は RangeError になる", () => {
    expect(() => toUii(-100)).toThrow(RangeError);
  });

  test("非整数の円価格は TypeError になる", () => {
    expect(() => toUii(999.5)).toThrow(TypeError);
  });
});
