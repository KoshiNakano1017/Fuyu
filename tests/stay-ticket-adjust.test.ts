// 宿泊券の手動増減の判定（WBS 10-4 ／ `src/lib/lodging/stay-ticket-adjust.ts`）の単体テスト。
//
// 固定する完了条件（v13 §5.8.5）:
//  1 管理者・コアメンバーが加算／減算できる（2026-09-25 決定 §23-3 ／ Issue #95）
//  2 一般会員・ゲストは操作できない
//  3 理由の入力が必須である
//  4 残高は取引の積み上げで算出し、直接上書きしない（＝差分だけを受け取る）
//  5 「いくつからいくつへ」を組める（調整ログの必須項目）
//
// ⚠️ ここで守っているのは**宿泊券という金銭価値を持つ権利**である。
//    実体の認可は `0016` の `stay_tx_insert_staff` と `chk_stay_tx_manual_needs_reason`
//    にあり、このテストは画面・Server Action が同じ境界を先に返すことを保証する。

import type { Role } from "@/lib/auth/session";
import {
  decideStayTicketAdjustment,
  formatBalanceTransition,
  stayTicketAdjustDenialMessage,
  STAY_TICKET_ADJUST_MAX_NIGHTS,
  type StayTicketAdjustDenialReason,
} from "@/lib/lodging/stay-ticket-adjust";

function request(overrides: {
  actorRole: Role;
  nights?: number;
  reason?: string;
  currentBalance?: number;
}) {
  return {
    nights: 1,
    reason: "出資追加",
    currentBalance: 4,
    ...overrides,
  };
}

describe("操作できるのは admin と core_member（v13 §5.8.5 ／ 決定 §23-3）", () => {
  test("管理者は加算できる", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", nights: 3 }))).toEqual({
      allowed: true,
      nightsAfter: 7,
    });
  });

  test("★ コアメンバーも加算できる（API設計・画面設計の「admin のみ」は誤りだった）", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "core_member", nights: 2 }))).toEqual({
      allowed: true,
      nightsAfter: 6,
    });
  });

  test("一般会員は操作できない", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "member" }))).toEqual({
      allowed: false,
      reason: "not_permitted",
    });
  });

  test("ゲストは操作できない", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "guest" }))).toEqual({
      allowed: false,
      reason: "not_permitted",
    });
  });
});

describe("理由の入力は必須（v13 §5.8.5 ／ §5.6.4 の編集理由必須ルール）", () => {
  test("空の理由は拒否される", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", reason: "" }))).toEqual({
      allowed: false,
      reason: "reason_required",
    });
  });

  test("空白文字だけの理由も拒否される", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", reason: " 　" }))).toEqual({
      allowed: false,
      reason: "reason_required",
    });
  });
});

describe("入力値の妥当性", () => {
  test("0 泊の調整は記録しない", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", nights: 0 }))).toEqual({
      allowed: false,
      reason: "zero_nights",
    });
  });

  test("小数は受け付けない（宿泊券は1枚＝1泊 ／ 決定 §23-2）", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", nights: 1.5 }))).toEqual({
      allowed: false,
      reason: "not_integer",
    });
  });

  test("数値として読めない入力は受け付けない", () => {
    expect(decideStayTicketAdjustment(request({ actorRole: "admin", nights: Number.NaN }))).toEqual({
      allowed: false,
      reason: "not_integer",
    });
  });

  test(`1回で動かせる幅は ±${STAY_TICKET_ADJUST_MAX_NIGHTS} 泊までである（桁の打ち間違いを通さない）`, () => {
    expect(
      decideStayTicketAdjustment(
        request({ actorRole: "admin", nights: STAY_TICKET_ADJUST_MAX_NIGHTS + 1 }),
      ),
    ).toEqual({ allowed: false, reason: "not_integer" });
  });
});

describe("減算は残っている泊数までである", () => {
  test("残高ぶんは減算できる", () => {
    expect(
      decideStayTicketAdjustment(
        request({ actorRole: "admin", nights: -4, currentBalance: 4, reason: "誤登録の訂正" }),
      ),
    ).toEqual({ allowed: true, nightsAfter: 0 });
  });

  test("★ 残高がマイナスになる減算は拒否される", () => {
    expect(
      decideStayTicketAdjustment(
        request({ actorRole: "admin", nights: -5, currentBalance: 4, reason: "誤登録の訂正" }),
      ),
    ).toEqual({ allowed: false, reason: "would_go_negative" });
  });
});

describe("調整ログの「いくつからいくつへ」", () => {
  test("加算は増えた後の残高を示す", () => {
    expect(formatBalanceTransition(4, 3)).toBe("4 → 7 泊");
  });

  test("減算は減った後の残高を示す", () => {
    expect(formatBalanceTransition(4, -1)).toBe("4 → 3 泊");
  });
});

describe("拒否の文言に内部の識別子を出さない（CLAUDE.md §3.2）", () => {
  test("すべての理由に利用者向けの文言がある", () => {
    const reasons: StayTicketAdjustDenialReason[] = [
      "not_permitted",
      "zero_nights",
      "not_integer",
      "reason_required",
      "would_go_negative",
    ];

    for (const reason of reasons) {
      const message = stayTicketAdjustDenialMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reason);
    }
  });
});
