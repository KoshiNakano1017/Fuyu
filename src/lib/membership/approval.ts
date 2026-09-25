/**
 * 街人登録申請の運営操作の判定（WBS 12-2 Step 3〜5 ／ v13 §5.10.4・§5.10.7）。
 *
 * ## 入金QRは精算QRと同一基盤で出す（§5.10.4）
 *
 * トークンの生成・ハッシュ化は `lib/billing/settlement-qr.ts` を再利用する
 * （256bit乱数 ／ 平文を保存しない ／ 2026-09-10 A案）。**違うのは有効期間だけ**である。
 * 入金QRは入金を挟むため **7日**（精算QRは 24時間）で、その値は `0037` の列コメントにも書いてある。
 *
 * ## 承認の実体は DB 側の RPC である
 *
 * 承認は「申請の更新 ＋ role 昇格 ＋ 宿泊券付与 ＋ キャッシュバック起票」の4つが
 * 揃って初めて意味を持つ（§5.10.5）。分割すると「権限は上がったが宿泊券が無い」
 * 「申込中のまま付与済み」が残り、後者は**二重付与**に直結する。
 * したがって承認は `approve_membership_application()`（`0038`）が1トランザクションで行い、
 * ここが持つのは**押せるかどうかの事前判定**だけである。
 */

import { hashSettlementToken, issueSettlementToken } from "@/lib/billing/settlement-qr";

import type { ApplicationStatus } from "./store";

/** 決済手段（`0037` の CHECK と同じ3値。クレジットカードは Phase 2 ／ §5.10.7 ④）。 */
export type PaymentMethod = "settlement_qr" | "cash" | "uii_qr";

/** QRの送付経路（`0037` の CHECK と同じ3値 ／ §5.10.4 Step 3）。 */
export type QrDeliveryChannel = "line" | "in_app" | "in_person";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  settlement_qr: "精算QR（eumo）",
  cash: "現金",
  uii_qr: "Uii（eumo）QR",
};

export const QR_DELIVERY_CHANNEL_LABELS: Record<QrDeliveryChannel, string> = {
  line: "LINE",
  in_app: "アプリ内通知",
  in_person: "対面提示",
};

/** 入金QRの有効期間（`0037` の列コメント ／ 精算QRの 24時間より長い）。 */
export const MEMBERSHIP_QR_TTL_DAYS = 7;

/** 終了状態。ここからは動かさない（`0037` のガードトリガーが DB 側でも拒否する）。 */
const TERMINAL_STATUSES: readonly ApplicationStatus[] = ["承認済み", "却下"];

export type OperationDenialReason =
  | "terminal"
  | "cash_has_no_qr"
  | "payment_not_recorded"
  | "reason_required"
  | "receiver_required";

export type OperationDecision =
  | { allowed: true }
  | { allowed: false; reason: OperationDenialReason };

/**
 * QRを発行できるか（§5.10.4 Step 3）。
 *
 * ★ **現金を選んだ申込にはQRを発行させない**（§5.10.7「QRと現金の両方で受け取る事故を
 * 構造的に防ぐ」）。`0037` の CHECK も「現金 ＋ 生きたQR」を禁じている。
 */
export function decideIssueQr(params: {
  status: ApplicationStatus;
  paymentMethod: PaymentMethod | null;
}): OperationDecision {
  if (TERMINAL_STATUSES.includes(params.status)) {
    return { allowed: false, reason: "terminal" };
  }
  if (params.paymentMethod === "cash") {
    return { allowed: false, reason: "cash_has_no_qr" };
  }
  return { allowed: true };
}

/**
 * 現金の受領を記録できるか（§5.10.7「受領者と受領日時を必須入力とする」）。
 *
 * 受領者は**操作している運営自身**である（誰が受け取ったかを後から追えるようにする）。
 */
export function decideRecordCash(params: {
  status: ApplicationStatus;
  receivedBy: string | null;
}): OperationDecision {
  if (TERMINAL_STATUSES.includes(params.status)) {
    return { allowed: false, reason: "terminal" };
  }
  if (params.receivedBy === null || params.receivedBy.trim() === "") {
    return { allowed: false, reason: "receiver_required" };
  }
  return { allowed: true };
}

/**
 * 承認できるか（§5.10.4 Step 5）。
 *
 * ★ **決済の記録が前提である。** 「現金は受領記録、QRは入金確認が承認の前提になる」
 * （同節）。記録が無いまま承認すると、何で払われたか分からない会員が生まれる。
 */
export function decideApprove(params: {
  status: ApplicationStatus;
  paymentMethod: PaymentMethod | null;
  paidAt: string | null;
}): OperationDecision {
  if (TERMINAL_STATUSES.includes(params.status)) {
    return { allowed: false, reason: "terminal" };
  }
  if (params.paymentMethod === null || params.paidAt === null) {
    return { allowed: false, reason: "payment_not_recorded" };
  }
  return { allowed: true };
}

/** 却下できるか（§5.10.4「却下する場合は理由を入力し、ユーザーへ通知する」）。 */
export function decideReject(params: {
  status: ApplicationStatus;
  reason: string;
}): OperationDecision {
  if (TERMINAL_STATUSES.includes(params.status)) {
    return { allowed: false, reason: "terminal" };
  }
  if (params.reason.trim() === "") {
    return { allowed: false, reason: "reason_required" };
  }
  return { allowed: true };
}

export function operationDenialMessage(reason: OperationDenialReason): string {
  switch (reason) {
    case "terminal":
      return "承認済み・却下の申請は操作できません。";
    case "cash_has_no_qr":
      return "現金を選んだ申込にはQRを発行できません（二重受領を防ぐため）。";
    case "payment_not_recorded":
      return "決済手段と受領日時を記録してから承認してください。";
    case "reason_required":
      return "却下の理由を入力してください。";
    case "receiver_required":
      return "受領者を特定できませんでした。";
  }
}

export type IssuedMembershipQr = {
  /** ★ 平文。**保存しない。** 発行時に1度だけ画面へ返す */
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

/**
 * 入金QRのトークンを1本発行する。
 *
 * 生成とハッシュ化は精算QRと同じ関数を使い（§5.10.4「同一基盤」）、
 * **有効期限だけ 7日へ伸ばす**。ここで乱数の作り方を再発明しない。
 */
export function issueMembershipQrToken(issuedAt: Date): IssuedMembershipQr {
  const settlement = issueSettlementToken(issuedAt);
  return {
    token: settlement.token,
    tokenHash: hashSettlementToken(settlement.token),
    expiresAt: membershipQrExpiresAt(issuedAt),
  };
}

export function membershipQrExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + MEMBERSHIP_QR_TTL_DAYS * 24 * 60 * 60 * 1000);
}
