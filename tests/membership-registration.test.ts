// 街人登録の申請可否と特典表示（WBS 12-1 ／ `src/lib/membership/registration.ts`）の単体テスト。
//
// 固定する完了条件（v13 §5.10.1〜§5.10.3 ／ 2026-09-25 オーナー決定 A ＝ Issue #87）:
//  1 ゲストだけが申請できる（既存会員は本導線を通さない ／ §5.10.5 ④）
//  2 申込中の申請があるときは新規に作らない（§5.10.3 の二重申請防止）
//  3 特典の数値は `membership_plans` から来る（コードに直書きしない ／ §7）
//  4 「CB」と略さず、単位を必ず添える（§5.10.2 の [!important]）
//  5 画面文言は「決済」ではなく「申請」である（§5.10.2 末尾）

import type { Role } from "@/lib/auth/session";
import {
  buildMembershipBenefits,
  buildMembershipConfirmationLines,
  decideMembershipApplication,
  MEMBERSHIP_PAYMENT_NOTICE,
  MEMBERSHIP_SUBMIT_LABEL,
  membershipApplyDenialMessage,
  type MembershipApplyDenialReason,
  type SignupPlan,
} from "@/lib/membership/registration";

/** 現行の登録導線プラン（`0016` の `phase3`）。 */
const CURRENT_PLAN: SignupPlan = {
  planId: "00000000-0000-0000-0000-0000000000p3",
  planCode: "phase3",
  displayName: "アプリ登録（新規）",
  annualFeeYen: 30000,
  grantedStayNights: 4,
  firstCashbackUii: 5000,
};

/** 年会費 40,000円の過去プラン（キャッシュバックが 10,000 uii ／ §9 #51）。 */
const LEGACY_PLAN: SignupPlan = {
  ...CURRENT_PLAN,
  planCode: "phase1",
  displayName: "[第一弾]",
  annualFeeYen: 40000,
  grantedStayNights: 7,
  firstCashbackUii: 10000,
};

function decide(overrides: {
  actorRole: Role;
  hasActiveApplication?: boolean;
  plan?: SignupPlan | null;
}) {
  return decideMembershipApplication({
    hasActiveApplication: false,
    plan: CURRENT_PLAN,
    ...overrides,
  });
}

describe("申請できるのはゲストだけ（v13 §5.10.5 ④）", () => {
  test("ゲストは申請できる", () => {
    expect(decide({ actorRole: "guest" })).toEqual({ allowed: true });
  });

  test("★ 一般会員は申請できない（名寄せ済みの既存会員は本導線を通さない）", () => {
    expect(decide({ actorRole: "member" })).toEqual({
      allowed: false,
      reason: "already_member",
    });
  });

  test("コアメンバー・管理者も申請できない", () => {
    for (const role of ["core_member", "admin"] as Role[]) {
      expect(decide({ actorRole: role }).allowed).toBe(false);
    }
  });
});

describe("二重申請を作らない（v13 §5.10.3）", () => {
  test("申込中の申請があるときは拒否される", () => {
    expect(decide({ actorRole: "guest", hasActiveApplication: true })).toEqual({
      allowed: false,
      reason: "already_applied",
    });
  });

  test("拒否の文言が「受け付けている」と伝える（失敗として見せない）", () => {
    expect(membershipApplyDenialMessage("already_applied")).toContain("受け付けています");
  });
});

describe("プランが取れないときは申請させない", () => {
  test("プラン未取得は拒否される", () => {
    expect(decide({ actorRole: "guest", plan: null })).toEqual({
      allowed: false,
      reason: "plan_unavailable",
    });
  });
});

describe("特典の数値はプランから来る（v13 §7「コードに直書きしない」）", () => {
  test("現行プランは宿泊券4泊・キャッシュバック 5,000 コイン", () => {
    const benefits = buildMembershipBenefits(CURRENT_PLAN).join("\n");
    expect(benefits).toContain("宿泊券4枚（4泊分）");
    expect(benefits).toContain("5,000 コイン");
  });

  test("★ 40,000円プランでは 10,000 コイン・7泊になる（#51 の2段階）", () => {
    const benefits = buildMembershipBenefits(LEGACY_PLAN).join("\n");
    expect(benefits).toContain("宿泊券7枚（7泊分）");
    expect(benefits).toContain("10,000 コイン");
    expect(benefits).not.toContain("5,000");
  });

  test("確認画面の登録料もプランから来る", () => {
    expect(buildMembershipConfirmationLines(CURRENT_PLAN).join("\n")).toContain("¥30,000");
    expect(buildMembershipConfirmationLines(LEGACY_PLAN).join("\n")).toContain("¥40,000");
  });

  test("確認画面に登録種別が出る（v13 §5.10.3）", () => {
    expect(buildMembershipConfirmationLines(CURRENT_PLAN)[0]).toBe("登録種別：街人");
  });
});

describe("「CB」と略さず単位を添える（v13 §5.10.2 の [!important]）", () => {
  const texts = [
    ...buildMembershipBenefits(CURRENT_PLAN),
    ...buildMembershipConfirmationLines(CURRENT_PLAN),
  ].join("\n");

  test("「CB」という略語が現れない", () => {
    expect(texts).not.toMatch(/\bCB\b/);
  });

  test("キャッシュバックには単位（コイン／Uii）が添えられている", () => {
    const line = buildMembershipBenefits(CURRENT_PLAN).find((benefit) =>
      benefit.includes("キャッシュバック"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("コイン");
    expect(line).toContain("Uii");
  });
});

describe("画面文言は「決済」ではなく「申請」（v13 §5.10.2 末尾）", () => {
  test("確定ボタンは「承認して申請する」である", () => {
    expect(MEMBERSHIP_SUBMIT_LABEL).toBe("承認して申請する");
  });

  test("支払いは運営から案内すると書いてある", () => {
    expect(MEMBERSHIP_PAYMENT_NOTICE).toContain("運営からご案内します");
  });

  test("★ この画面で支払い情報を入力させないと明記している（#8 の方針）", () => {
    expect(MEMBERSHIP_PAYMENT_NOTICE).toContain("お支払い情報の入力は不要");
  });

  test("Phase 2 のクレジットカードを案内に混ぜていない（§5.10.7 ④）", () => {
    expect(MEMBERSHIP_PAYMENT_NOTICE).not.toContain("クレジット");
    expect(MEMBERSHIP_PAYMENT_NOTICE).not.toContain("カード");
  });
});

describe("拒否の文言に内部の識別子を出さない（CLAUDE.md §3.2）", () => {
  test("すべての理由に利用者向けの文言がある", () => {
    const reasons: MembershipApplyDenialReason[] = [
      "already_member",
      "already_applied",
      "plan_unavailable",
    ];
    for (const reason of reasons) {
      const message = membershipApplyDenialMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reason);
    }
  });
});
