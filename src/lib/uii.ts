// 換算率の根拠: v13 §5.5（1円 = 0.8 Uii）
const YEN_TO_UII_RATE = 0.8;

/**
 * 円価格を地域通貨 Uii へ換算する。
 *
 * v13 §5.5: 単品ごとに floor(単価×0.8)。合算はUii単価の和であり、合計金額に0.8を掛けない。
 * 合計金額に掛けると切り捨てが1回にまとまり、単品ごとの換算の和と結果がずれるため。
 */
export function toUii(priceYen: number): number {
  if (!Number.isInteger(priceYen)) {
    throw new TypeError(`円価格は整数で指定する必要があります: ${priceYen}`);
  }
  if (priceYen < 0) {
    throw new RangeError(`円価格に負数は指定できません: ${priceYen}`);
  }
  return Math.floor(priceYen * YEN_TO_UII_RATE);
}
