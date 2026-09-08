import type { ReactElement } from "react";

import { toUii } from "@/lib/uii";

type MoneyProps = {
  priceYen: number;
};

/**
 * Uii主・円副の通貨表示（例: 2,400 Uii（¥3,000））。
 *
 * v13 §5.5 / §9 #41: Uii・円の併記フォーマットは画面ごとに実装せず、
 * この共通コンポーネント1箇所に集約する。
 */
export function Money({ priceYen }: MoneyProps): ReactElement {
  const uii = toUii(priceYen);
  return (
    <span>
      {uii.toLocaleString("ja-JP")} Uii（¥{priceYen.toLocaleString("ja-JP")}）
    </span>
  );
}
