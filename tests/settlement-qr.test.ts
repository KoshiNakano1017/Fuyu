// 精算QRトークン（WBS 7-3）の単体テスト。
//
// 根拠: `QUESTIONS.md`「QRトークンの保護強化」2026-09-10 **A案**
//       （256bit乱数 ／ ハッシュ保存 ／ TTL 24時間 ／ 単回使用）、
//       v13 §5.6.1④・§5.6.3-5・§7「トークン失効フラグ」。
//
// 金銭の受け渡しに直結する判定であり、CLAUDE.md §4.4 が「必ずテストを書く」と定める領域である。

import {
  canIssueSettlementQr,
  decideRedemption,
  hashSettlementToken,
  issueSettlementToken,
  SETTLEMENT_QR_TTL_HOURS,
  type SettlementQrColumns,
} from "@/lib/billing/settlement-qr";

const ISSUED_AT = new Date("2026-09-22T09:00:00.000Z");

/** 有効なQRの状態。各テストは必要な項目だけを上書きする。 */
function qrColumns(overrides: Partial<SettlementQrColumns> = {}): SettlementQrColumns {
  return {
    tokenHash: hashSettlementToken("token-a"),
    expiresAt: "2026-09-23T09:00:00.000Z",
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("トークンの発行", () => {
  test("発行するたびに異なるトークンになる", () => {
    const first = issueSettlementToken(ISSUED_AT);
    const second = issueSettlementToken(ISSUED_AT);
    expect(first.token).not.toBe(second.token);
  });

  test("256bit の乱数を base64url で表す（43文字）", () => {
    expect(issueSettlementToken(ISSUED_AT).token).toHaveLength(43);
  });

  test("保存するのはハッシュであり、平文を含まない", () => {
    const issued = issueSettlementToken(ISSUED_AT);
    expect(issued.tokenHash).toBe(hashSettlementToken(issued.token));
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  test("有効期限は発行から24時間である", () => {
    const issued = issueSettlementToken(ISSUED_AT);
    const hours = (issued.expiresAt.getTime() - ISSUED_AT.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(SETTLEMENT_QR_TTL_HOURS);
  });
});

describe("精算してよいかの判定", () => {
  const now = new Date("2026-09-22T10:00:00.000Z");

  test("発行済み・期限内・未使用のトークンで精算できる", () => {
    const decision = decideRedemption({
      qr: qrColumns(),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: true });
  });

  test("違うトークンでは精算できない", () => {
    const decision = decideRedemption({
      qr: qrColumns(),
      presentedTokenHash: hashSettlementToken("token-b"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "token_mismatch" });
  });

  test("違うトークンには失効・期限切れの理由を返さない（当たりの手がかりを出さない）", () => {
    const decision = decideRedemption({
      qr: qrColumns({ revokedAt: "2026-09-22T09:30:00.000Z" }),
      presentedTokenHash: hashSettlementToken("token-b"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "token_mismatch" });
  });

  test("伝票の編集で失効したトークンでは精算できない（v13 §5.6.3-5）", () => {
    const decision = decideRedemption({
      qr: qrColumns({ revokedAt: "2026-09-22T09:30:00.000Z" }),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "revoked" });
  });

  test("一度使ったトークンは二度使えない（単回使用）", () => {
    const decision = decideRedemption({
      qr: qrColumns({ consumedAt: "2026-09-22T09:30:00.000Z" }),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "consumed" });
  });

  test("期限を過ぎたトークンでは精算できない", () => {
    const decision = decideRedemption({
      qr: qrColumns({ expiresAt: "2026-09-22T09:59:00.000Z" }),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "expired" });
  });

  test("取消済みの伝票は精算できない", () => {
    const decision = decideRedemption({
      qr: qrColumns(),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "取消",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "order_cancelled" });
  });

  test("QRを発行していない伝票では精算できない", () => {
    const decision = decideRedemption({
      qr: qrColumns({ tokenHash: null }),
      presentedTokenHash: hashSettlementToken("token-a"),
      orderStatus: "未会計",
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "not_issued" });
  });
});

describe("発行してよい伝票", () => {
  test("未会計の伝票にだけ発行する", () => {
    expect(canIssueSettlementQr("未会計")).toBe(true);
  });

  test("精算済みの伝票には発行しない（二重請求の経路を作らない）", () => {
    expect(canIssueSettlementQr("精算済み")).toBe(false);
  });

  test("取消済みの伝票には発行しない", () => {
    expect(canIssueSettlementQr("取消")).toBe(false);
  });
});
