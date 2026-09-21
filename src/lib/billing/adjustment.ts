/**
 * 差額の繰越・免除（WBS 8-3 ／ v13 §5.6.6 ／ §9 #7・#17）。
 *
 * ## Phase 1 の確定内容（`QUESTIONS.md` 2026-08-16 オーナー回答）
 *
 * 1. 返金差額の無期限繰越を**許可**する
 * 2. 免除操作は **コアメンバーにも許可**する（管理者限定にしない）
 * 3. 90日滞留後は**自動免除も督促も行わず、滞留フラグを立てるだけ**
 *
 * ⚠️ `DB物理設計.md` §3-2 の「`waived_by` の権限範囲は `QUESTIONS.md` 未回答」という
 *    注記は古い。上記のとおり解消済みであり、本コミットで派生文書側も是正した
 *    （CLAUDE.md §7.0.1）。
 */

import type { Role } from "@/lib/auth/session";
import { toUii } from "@/lib/uii";

/** 差額の区分（`settlement_adjustments.category`）。 */
export type AdjustmentCategory = "追加請求" | "返金";

/** 差額の処理状態（`settlement_adjustments.status`）。 */
export type AdjustmentStatus = "未処理" | "精算済み" | "免除";

/** 滞留とみなす日数（v13 §5.6.6）。 */
export const STALE_ADJUSTMENT_THRESHOLD_DAYS = 90;

export type Adjustment = {
  amountYen: number;
  status: AdjustmentStatus;
  occurredAt: string;
};

/**
 * 符号付きの円金額を Uii へ換算する。
 *
 * `toUii()` は負数で `RangeError` を投げる（単価に負数は無いため、そちらの仕様は正しい）。
 * 差額は**返金がマイナス**なので、絶対値で換算してから符号を戻す。
 *
 * ★ 切り捨ての向きに注意。`floor(-1)` ではなく `-floor(1)` になるよう組んでいる。
 * `Math.floor(-500 * 0.8) = -400` は偶然一致するが、端数が出ると
 * `Math.floor(-501 × 0.8) = Math.floor(-400.8) = -401`（＝切り上げ側へ1多く返す）となり、
 * **返金額が1 Uii 多くなる**。絶対値で丸めれば、追加請求と返金で丸めの向きが揃う。
 */
export function toSignedUii(amountYen: number): number {
  if (!Number.isInteger(amountYen)) {
    throw new TypeError(`円金額は整数で指定する必要があります: ${amountYen}`);
  }
  const magnitudeUii = toUii(Math.abs(amountYen));
  return amountYen < 0 ? -magnitudeUii : magnitudeUii;
}

/**
 * 金額から区分を決める。
 *
 * 区分と符号を別々に入力させると「返金なのに +5,000」という行が作れてしまう。
 * 入力は金額だけにして、区分はここで導出する（DB 側も CHECK で同じ関係を強制している）。
 */
export function categoryOf(amountYen: number): AdjustmentCategory {
  if (amountYen === 0) {
    throw new RangeError("差額 0 円の調整行は作れません");
  }
  return amountYen > 0 ? "追加請求" : "返金";
}

/**
 * 免除してよいか。
 *
 * Phase 1 は**コアメンバーにも許可**する（2026-08-16 回答）。
 * ここを `admin` 限定に戻すと、少人数運営で現場の免除判断が止まる。
 */
export function canWaive(actorRole: Role): boolean {
  return actorRole === "admin" || actorRole === "core_member";
}

/**
 * 滞留（90日超の未処理）か。
 *
 * **判定するだけで何もしない。** 自動免除も督促もしない（2026-08-16 回答）。
 * 運営が画面で気づいて判断するための旗である。
 */
export function isStale(adjustment: Adjustment, now: Date = new Date()): boolean {
  if (adjustment.status !== "未処理") {
    return false;
  }
  const elapsedMs = now.getTime() - new Date(adjustment.occurredAt).getTime();
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  return elapsedDays > STALE_ADJUSTMENT_THRESHOLD_DAYS;
}

/**
 * 未会計額に含める差額の合計（円）。
 *
 * ★ v13 §5.6.6 の警告：**ダッシュボードの「未会計額」には繰越差額を含めて表示し、
 * 繰越を選んだ瞬間に画面から消える設計にしてはならない。**
 * したがって「未処理」の差額は、繰越を選んでいても合計に入れ続ける。
 * 合計から外れるのは「精算済み」と「免除」だけである。
 */
export function outstandingAdjustmentYen(adjustments: readonly Adjustment[]): number {
  return adjustments
    .filter((adjustment) => adjustment.status === "未処理")
    .reduce((total, adjustment) => total + adjustment.amountYen, 0);
}
