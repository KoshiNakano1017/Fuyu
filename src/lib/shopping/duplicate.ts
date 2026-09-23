import type { ShoppingItemStatus } from "./status";

/**
 * 買い物リストの重複検知（v13 §5.12.1）。
 *
 * ## 自動でまとめない
 *
 * 仕様は「候補を提示して**相乗り**へ誘導する」であって、自動マージではない。
 * 「同じ洗剤」でも容量違いが別物であることが多く、勝手に1件へ畳むと
 * 「頼んだのに買われていない」が発生する。**判断は人に残す。**
 */

export type DuplicateCandidate = {
  itemId: string;
  itemName: string;
  status: ShoppingItemStatus;
  withdrawnAt: string | null;
};

/**
 * 比較用に品名をそろえる。
 *
 * 全角／半角（NFKC）・大文字小文字・空白の揺れだけを吸収する。
 * 表記ゆれの正規化をこれ以上作り込まない（「トイレットペーパー」と「トイペ」は
 * 機械には同じにできず、無理に寄せると別物まで同一視する）。
 */
export function normalizeItemName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/**
 * 未購入かつ取下げでないものだけが重複の対象。
 *
 * `クエスト化済` も**まだ買われていない**ので含める（v13 §5.12.1「未購入の既存品目」）。
 * ここを `希望` / `買う` に絞ると、買い出しクエストが走っている最中に同じ品を登録しても
 * 警告が出ず、§5.12.1 が避けようとした「同じものが3件並ぶリスト」がそのまま起きる。
 * 除外するのは**買われた（`購入済`）か、買わないと決めた（`見送り`）か、取り下げられたもの**だけ。
 */
function isOpen(candidate: DuplicateCandidate): boolean {
  if (candidate.withdrawnAt !== null) {
    return false;
  }
  return candidate.status === "希望" || candidate.status === "買う" || candidate.status === "クエスト化済";
}

/**
 * 登録しようとしている品名に対する重複候補。
 *
 * 部分一致（どちらかがどちらかを含む）で拾う。完全一致だけにすると
 * 「醤油」と「醤油（濃口）」が別件で並び、リストに同じものが3件載る。
 */
export function findDuplicateCandidates(
  itemName: string,
  candidates: readonly DuplicateCandidate[],
): DuplicateCandidate[] {
  const needle = normalizeItemName(itemName);
  if (needle === "") {
    return [];
  }

  return candidates.filter((candidate) => {
    if (!isOpen(candidate)) {
      return false;
    }
    const hay = normalizeItemName(candidate.itemName);
    return hay.includes(needle) || needle.includes(hay);
  });
}
