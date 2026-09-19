/** 提供ステータスの DB 保存値。v13 §7 データ要件および DB の CHECK 制約で2値に閉じている */
export type ServingStatus = "未提供" | "提供済み";

/**
 * 提供ステータスの保存値 → 本人（客）向け表示文言。
 *
 * v13 §5.4.1「本人への表示」に従い、保存値 `未提供` は「調理中」として見せる。
 * `docs/spec/detailed-design/画面設計.md` L319 は本人向けの行を「未提供」と書いているが、
 * 矛盾時は正本が勝つため（CLAUDE.md §1.1）正本の表示語を採る。
 * 表示語の一本化はこの1箇所で行い、画面側は必ず下記の変換関数を通す。
 */
export const SERVING_STATUS_DISPLAY_LABELS: Record<ServingStatus, string> = {
  未提供: "調理中",
  提供済み: "提供済み",
};

function isServingStatus(candidate: string): candidate is ServingStatus {
  return Object.prototype.hasOwnProperty.call(SERVING_STATUS_DISPLAY_LABELS, candidate);
}

/**
 * 提供ステータスの保存値を本人向け表示文言へ変換する。
 *
 * 値域外は表示文言を用意せず RangeError にする。DB 側は CHECK 制約で2値に限定されており
 * （`docs/spec/detailed-design/DB物理設計.md`）、値域外が届くのは保存値と表示語の取り違えなど
 * 呼び出し側の誤りである。黙ってフォールバックすると、正本に無い状態を客の画面へ出すことになる。
 *
 * 引数を `ServingStatus` に絞らず `string` で受けるのは、DB や API から来る
 * 検証前の文字列をそのまま渡せるようにするため。
 */
export function toServingStatusDisplayLabel(storedServingStatus: string): string {
  if (!isServingStatus(storedServingStatus)) {
    throw new RangeError(`提供ステータスの保存値ではありません: ${storedServingStatus}`);
  }
  return SERVING_STATUS_DISPLAY_LABELS[storedServingStatus];
}
