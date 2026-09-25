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
 *
 * ## 主副は順序だけでなく見た目でも表す（Issue #13 ／ v13 §5.5）
 *
 * 正本の実装上の注意が「**フォントサイズ・色のコントラストでも主副を表現する**
 * （Uii を大きく／円を小さく淡く）。順序だけでは主副が伝わらない」と定めている。
 * 主表示が円のままだと **Uii が「円のおまけ」に見え**、コミュニティ通貨としての
 * 位置づけが伝わらない、というのが逆転（2026-08-20）の理由である。
 *
 * ★ **円は消さない。** 旅館業法・会計処理・現金精算はすべて円建てであり、
 * 円が読めなくなると現場が回らない（同節の明示）。淡くするのは「副」だからで、
 * 読めなくするためではない（`neutral-500` は本文色より淡いが十分に可読である）。
 *
 * ## なぜ円の大きさを `em` で指定するのか
 *
 * このコンポーネントは `text-sm` の一覧・`font-medium` の合計欄・本文の中など、
 * **文字サイズの異なる文脈へ埋め込まれる**（`MenuBoard`・`SlipEditor`・`/me` 等）。
 * `text-xs` のような絶対値を置くと、埋め込み先が小さい場所では円が本文より大きくなり、
 * 主副が逆転して見える。`em` なら常に「その場の文字サイズより一段小さい」になる。
 *
 * Uii 側にサイズを指定しないのは同じ理由である。**主表示は埋め込み先の大きさをそのまま継ぐ。**
 */
export function Money({ priceYen }: MoneyProps): ReactElement {
  const uii = toUii(priceYen);
  return (
    <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
      <span className="font-semibold">{uii.toLocaleString("ja-JP")} Uii</span>
      <span className="text-[0.8em] text-neutral-500">
        （¥{priceYen.toLocaleString("ja-JP")}）
      </span>
    </span>
  );
}
