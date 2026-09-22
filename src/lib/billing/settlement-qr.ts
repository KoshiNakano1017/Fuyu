/**
 * 精算QRトークンの発行・失効・消し込みの判定（WBS 7-3）。
 *
 * 根拠: v13 §5.6.1④（一括精算QRの発行）・§5.6.3-5（伝票編集で旧QRを自動失効）・
 *       §5.6.5（精算済み伝票の遡及修正）・§7「トークン失効フラグ」、
 *       `QUESTIONS.md`「QRトークンの保護強化」2026-09-10 **A案で確定**
 *       （256bit乱数 ／ ハッシュ保存 ／ TTL 24時間 ／ 単回使用）、
 *       `0019_orders_and_settlement.sql` の `settlement_qr_*` 5列。
 *
 * ## 平文を保存しない
 *
 * DB には `sha256(トークン)` だけを置く（`settlement_qr_token_hash`）。
 * こうすると **DB が流出しただけでは誰も精算できない**。平文は発行時の応答で
 * 1度だけ返し、再表示はしない（見失ったら再発行する＝旧トークンは失効する）。
 *
 * ## `consumed` と `revoked` を同じ列に寄せない
 *
 * 「使われた」と「無効にした」は別の事実である。伝票を編集したら旧QRは失効するが、
 * それは精算が済んだことを意味しない。1列にまとめると、
 * **編集しただけの伝票が「精算済み」に見える**。
 */

import { createHash, randomBytes } from "node:crypto";

/** トークンの有効期間（2026-09-10 A案）。 */
export const SETTLEMENT_QR_TTL_HOURS = 24;

/** 乱数の強度（A案の「256bit乱数」）。 */
const TOKEN_BYTES = 32;

export type IssuedSettlementToken = {
  /** ★ 平文。**保存しない。** 発行時に1度だけ画面へ返す */
  token: string;
  /** DB へ入れる sha256 の16進 */
  tokenHash: string;
  expiresAt: Date;
};

/** 精算QRの現在の状態（`orders` の該当列をそのまま写した形）。 */
export type SettlementQrColumns = {
  tokenHash: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
};

export type RedemptionRejection =
  | "not_issued"
  | "token_mismatch"
  | "revoked"
  | "consumed"
  | "expired"
  | "order_cancelled"
  | "already_settled";

export type RedemptionDecision =
  | { allowed: true }
  | { allowed: false; reason: RedemptionRejection };

/** トークンを1本発行する。`randomBytes` は暗号用途の乱数であり `Math.random()` とは別物である。 */
export function issueSettlementToken(issuedAt: Date): IssuedSettlementToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashSettlementToken(token),
    expiresAt: settlementQrExpiresAt(issuedAt),
  };
}

export function hashSettlementToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function settlementQrExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + SETTLEMENT_QR_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * 提示されたトークンで精算してよいかを判定する。
 *
 * ## 判定の順番に意味がある
 *
 * 失効・使用済み・期限切れを**トークンの一致より後**に見る。
 * 先に見ると、誤ったトークンに対して「そのQRは期限切れです」と答えることになり、
 * **当たっているかどうかが応答から読める**（総当たりの手がかりになる）。
 *
 * ## 比較は必ずハッシュで行う
 *
 * `tokenHash` は DB から来る値であり、平文は保存されていない。
 * 呼び出し側は受け取った平文を `hashSettlementToken()` に通してから渡す。
 */
export function decideRedemption(params: {
  qr: SettlementQrColumns;
  presentedTokenHash: string;
  orderStatus: "未会計" | "精算済み" | "取消";
  now: Date;
}): RedemptionDecision {
  const { qr, presentedTokenHash, orderStatus, now } = params;

  if (qr.tokenHash === null) {
    return { allowed: false, reason: "not_issued" };
  }
  if (qr.tokenHash !== presentedTokenHash) {
    return { allowed: false, reason: "token_mismatch" };
  }
  if (qr.revokedAt !== null) {
    // 伝票が編集された後のQR。旧金額で精算されるのを防ぐ（v13 §5.6.3-5）
    return { allowed: false, reason: "revoked" };
  }
  if (qr.consumedAt !== null) {
    return { allowed: false, reason: "consumed" };
  }
  if (qr.expiresAt === null || new Date(qr.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "expired" };
  }
  if (orderStatus === "取消") {
    return { allowed: false, reason: "order_cancelled" };
  }
  if (orderStatus === "精算済み") {
    return { allowed: false, reason: "already_settled" };
  }
  return { allowed: true };
}

/**
 * 発行してよい伝票か。
 *
 * 取消済み・精算済みの伝票には発行しない。**二重に請求する経路を作らない**ためである。
 * 未会計へ戻す（決済ステータスの手動切替 ／ v13 §5.6.2）operation を経れば再発行できる。
 */
export function canIssueSettlementQr(orderStatus: "未会計" | "精算済み" | "取消"): boolean {
  return orderStatus === "未会計";
}
