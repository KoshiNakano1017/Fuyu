// 街人登録申請の運営操作の判定（WBS 12-2 ／ `src/lib/membership/approval.ts`）の単体テスト。
//
// 固定する完了条件（v13 §5.10.4・§5.10.7）:
//  1 現金を選んだ申込にはQRを発行させない（二重受領の防止）
//  2 決済の記録が無い申請は承認できない（「受領記録・入金確認が承認の前提」）
//  3 却下は理由必須
//  4 承認済み・却下からは動かせない
//  5 入金QRの有効期間は7日（精算QRの24時間と混ぜない）
//  6 トークンは平文を保存しない（ハッシュだけを返す）

import {
  decideApprove,
  decideIssueQr,
  decideRecordCash,
  decideReject,
  issueMembershipQrToken,
  membershipQrExpiresAt,
  MEMBERSHIP_QR_TTL_DAYS,
  operationDenialMessage,
  PAYMENT_METHOD_LABELS,
  QR_DELIVERY_CHANNEL_LABELS,
  type OperationDenialReason,
} from "@/lib/membership/approval";
import { SETTLEMENT_QR_TTL_HOURS, hashSettlementToken } from "@/lib/billing/settlement-qr";

describe("QRの発行（v13 §5.10.4 Step 3 ／ §5.10.7）", () => {
  test("申込中の申請へは発行できる", () => {
    expect(decideIssueQr({ status: "申込中", paymentMethod: null })).toEqual({ allowed: true });
  });

  test("★ 現金を選んだ申込には発行できない（QRと現金の二重受領を防ぐ）", () => {
    expect(decideIssueQr({ status: "申込中", paymentMethod: "cash" })).toEqual({
      allowed: false,
      reason: "cash_has_no_qr",
    });
  });

  test("Uii QR を選んでいても発行できる（eumo 側の送金であり QR 経路は残る）", () => {
    expect(decideIssueQr({ status: "申込中", paymentMethod: "uii_qr" }).allowed).toBe(true);
  });

  test("承認済み・却下からは発行できない", () => {
    for (const status of ["承認済み", "却下"] as const) {
      expect(decideIssueQr({ status, paymentMethod: null })).toEqual({
        allowed: false,
        reason: "terminal",
      });
    }
  });
});

describe("受領の記録（§5.10.7「受領者と受領日時を必須入力とする」）", () => {
  test("操作者を受領者として記録できる", () => {
    expect(decideRecordCash({ status: "QR送付済み", receivedBy: "member-1" })).toEqual({
      allowed: true,
    });
  });

  test("受領者を特定できないときは拒否される", () => {
    expect(decideRecordCash({ status: "申込中", receivedBy: null })).toEqual({
      allowed: false,
      reason: "receiver_required",
    });
  });
});

describe("承認（§5.10.4 Step 5）", () => {
  test("決済手段と受領日時が揃っていれば承認できる", () => {
    expect(
      decideApprove({
        status: "QR送付済み",
        paymentMethod: "settlement_qr",
        paidAt: "2026-09-25T00:00:00Z",
      }),
    ).toEqual({ allowed: true });
  });

  test("★ 決済手段が無いまま承認できない", () => {
    expect(decideApprove({ status: "申込中", paymentMethod: null, paidAt: null })).toEqual({
      allowed: false,
      reason: "payment_not_recorded",
    });
  });

  test("★ 受領日時が無いまま承認できない（手段だけ選んでも足りない）", () => {
    expect(decideApprove({ status: "申込中", paymentMethod: "cash", paidAt: null })).toEqual({
      allowed: false,
      reason: "payment_not_recorded",
    });
  });

  test("二重承認は判定の段階でも止まる", () => {
    expect(
      decideApprove({ status: "承認済み", paymentMethod: "cash", paidAt: "2026-09-25T00:00:00Z" }),
    ).toEqual({ allowed: false, reason: "terminal" });
  });
});

describe("却下（§5.10.4「理由を入力し、ユーザーへ通知する」）", () => {
  test("理由があれば却下できる", () => {
    expect(decideReject({ status: "申込中", reason: "本人確認が取れなかった" })).toEqual({
      allowed: true,
    });
  });

  test("理由が空だと拒否される", () => {
    expect(decideReject({ status: "申込中", reason: "" })).toEqual({
      allowed: false,
      reason: "reason_required",
    });
  });

  test("空白文字だけの理由も拒否される", () => {
    expect(decideReject({ status: "申込中", reason: "  　" })).toEqual({
      allowed: false,
      reason: "reason_required",
    });
  });
});

describe("入金QRのトークン（2026-09-10 A案 ／ §5.10.4「精算トークンと同一基盤」）", () => {
  const issuedAt = new Date("2026-09-25T00:00:00Z");

  test("★ 有効期間は7日である（精算QRの24時間と混ぜない）", () => {
    expect(MEMBERSHIP_QR_TTL_DAYS).toBe(7);
    expect(membershipQrExpiresAt(issuedAt).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    // 精算QRの TTL を流用していないこと（入金を挟むため意図的に長い）
    expect(MEMBERSHIP_QR_TTL_DAYS * 24).not.toBe(SETTLEMENT_QR_TTL_HOURS);
  });

  test("平文とハッシュの対応が精算QRと同じ規格である", () => {
    const issued = issueMembershipQrToken(issuedAt);
    expect(issued.tokenHash).toBe(hashSettlementToken(issued.token));
    // sha256 の16進は64文字
    expect(issued.tokenHash).toHaveLength(64);
  });

  test("毎回違うトークンが出る（256bit乱数）", () => {
    const first = issueMembershipQrToken(issuedAt);
    const second = issueMembershipQrToken(issuedAt);
    expect(first.token).not.toBe(second.token);
  });
});

describe("表示名（内部識別子を画面へ出さない ／ CLAUDE.md §3.2）", () => {
  test("決済手段は3値で、クレジットカードを含まない（Phase 2 ／ §5.10.7 ④）", () => {
    expect(Object.keys(PAYMENT_METHOD_LABELS)).toEqual(["settlement_qr", "cash", "uii_qr"]);
  });

  test("送付経路は LINE・アプリ内通知・対面提示の3値である（§5.10.4 Step 3）", () => {
    expect(Object.values(QR_DELIVERY_CHANNEL_LABELS)).toEqual([
      "LINE",
      "アプリ内通知",
      "対面提示",
    ]);
  });

  test("拒否の文言に内部の識別子が出ない", () => {
    const reasons: OperationDenialReason[] = [
      "terminal",
      "cash_has_no_qr",
      "payment_not_recorded",
      "reason_required",
      "receiver_required",
    ];
    for (const reason of reasons) {
      const message = operationDenialMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reason);
    }
  });
});
