// 宿泊料金の選び方（WBS 3-9 ／ 画面ID C13・A11・`/reserve`）。純関数だけを置く。
//
// 根拠: v13 §5.4.2②（適用期間付きの履歴。マスタは「これから作る予約の既定値」）、
//       §5.5（Uii 主・円 副）、`0021_accommodation_rates.sql`。

/** `accommodation_rates` の1行（camelCase への変換は fetch 層で行う）。 */
export type AccommodationRate = {
  rateId: string;
  roomType: string;
  memberCategory: "member" | "non_member";
  pricePerNightYen: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
};

/**
 * その日に適用される料金を選ぶ。無ければ null。
 *
 * ## なぜ「今の料金」を取らないのか
 *
 * v13 §5.4.2② は料金を**適用期間付きの履歴**として持つと定めている。
 * 過去の予約を顧客管理画面で開いたときに現在価格で再計算されると、
 * §5.6.5 の遡及修正で差額が誤って算出される。したがって引くのは常に
 * 「**いつの料金か**」であり、呼び出し側が日付を渡す。
 *
 * 期間の重なりは DB の `ex_rate_no_overlap` が禁じているため、
 * 該当する行は高々1件である。ここで「複数あったらどれを選ぶか」を決めない
 * （決めてしまうと、重なった行が入っていても画面が黙って動いてしまう）。
 */
export function rateOn(
  rates: readonly AccommodationRate[],
  params: { roomType: string; memberCategory: "member" | "non_member"; date: string },
): AccommodationRate | null {
  const matched = rates.filter(
    (rate) =>
      rate.roomType === params.roomType &&
      rate.memberCategory === params.memberCategory &&
      rate.effectiveFrom <= params.date &&
      (rate.effectiveUntil === null || params.date <= rate.effectiveUntil),
  );
  return matched.length === 1 ? matched[0] : null;
}

/**
 * 滞在1件の宿泊費（円）。泊数 × 1泊単価。
 *
 * ⚠️ **人数を掛けない。** 人数枠型（ドミトリー等）か棟貸型（コテージ等）かで
 * 掛ける相手が変わるが、`accommodation_rates` が持つのは「1泊あたり単価」だけであり、
 * 人数按分の規則は正本に無い（v13 §5.4.2② の保持項目は「1泊あたり単価（円）」のみ）。
 * 規則が決まるまで**泊数だけを掛ける**。ここで推測して掛けると、
 * 請求額が仕様の裏付けなく決まってしまう。
 */
export function stayPriceYen(params: { pricePerNightYen: number; nights: number }): number {
  if (!Number.isSafeInteger(params.nights) || params.nights < 1) {
    throw new RangeError(`泊数は1以上の整数である必要があります: ${params.nights}`);
  }
  return params.pricePerNightYen * params.nights;
}

/**
 * 会員区分。**`role` でも `member_type` でもなく、料金表の区分である。**
 *
 * v13 §5.4.2② が持つのは `member` / `non_member` の2値のみ。
 * ログインしていれば会員料金、していなければ非会員料金とする。
 * 「ゲストロールの会員」は**ログインできている時点で会員である**（`members` に行がある）。
 */
export function memberCategoryOf(signedIn: boolean): "member" | "non_member" {
  return signedIn ? "member" : "non_member";
}
