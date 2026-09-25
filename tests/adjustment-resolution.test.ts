// 差額の消し込み（WBS 8-3 ／ `src/lib/billing/adjustment.ts`）の単体テスト。
//
// 固定する完了条件（v13 §5.6.6）:
//  1 精算済みにできるのは運営（admin / core_member）
//  2 免除もコアメンバーに許す（2026-08-16 回答。admin 限定に戻すと現場の判断が止まる）
//  3 既に精算済み・免除の行は動かさない（二重の消し込みを作らない）
//  4 `is_stale`（後続の修正で無効になった行）は消し込みの対象にしない
//  5 未会計額には未処理の差額を含め続ける（繰越は消込ではない）

import type { Role } from "@/lib/auth/session";
import {
  adjustmentResolveDenialMessage,
  decideAdjustmentResolution,
  outstandingAdjustmentYen,
  type Adjustment,
  type AdjustmentResolveDenialReason,
} from "@/lib/billing/adjustment";

function decide(overrides: {
  actorRole: Role;
  resolution?: "settle" | "waive";
  status?: "未処理" | "精算済み" | "免除";
  isStale?: boolean;
}) {
  return decideAdjustmentResolution({
    resolution: "settle",
    status: "未処理",
    isStale: false,
    ...overrides,
  });
}

describe("消し込みは運営の操作である（v13 §5.6.6）", () => {
  test("管理者は精算済みにできる", () => {
    expect(decide({ actorRole: "admin" })).toEqual({ allowed: true });
  });

  test("★ コアメンバーも精算済みにできる", () => {
    expect(decide({ actorRole: "core_member" })).toEqual({ allowed: true });
  });

  test("★ コアメンバーも免除できる（2026-08-16 回答）", () => {
    expect(decide({ actorRole: "core_member", resolution: "waive" })).toEqual({ allowed: true });
  });

  test("一般会員・ゲストはどちらもできない", () => {
    for (const role of ["member", "guest"] as Role[]) {
      for (const resolution of ["settle", "waive"] as const) {
        expect(decide({ actorRole: role, resolution })).toEqual({
          allowed: false,
          reason: "not_permitted",
        });
      }
    }
  });
});

describe("二重の消し込みを作らない", () => {
  test("精算済みの行は動かせない", () => {
    expect(decide({ actorRole: "admin", status: "精算済み" })).toEqual({
      allowed: false,
      reason: "already_resolved",
    });
  });

  test("免除済みの行は動かせない", () => {
    expect(decide({ actorRole: "admin", status: "免除", resolution: "waive" })).toEqual({
      allowed: false,
      reason: "already_resolved",
    });
  });
});

describe("★ 無効になった差額を「精算済み」として記録しない", () => {
  test("is_stale の行は消し込めない", () => {
    expect(decide({ actorRole: "admin", isStale: true })).toEqual({
      allowed: false,
      reason: "stale",
    });
  });

  test("免除でも同じ（旗が立った行は放置でよい）", () => {
    expect(decide({ actorRole: "admin", resolution: "waive", isStale: true })).toEqual({
      allowed: false,
      reason: "stale",
    });
  });
});

describe("繰越は消込ではない（§5.6.6 の [!important]）", () => {
  // `Adjustment` は判定に要る3項目だけを持つ（`adjustment.ts`）。
  // 画面用の型（`PendingAdjustment`）と混ぜないのは、純関数が余分な項目に依存しないようにするため。
  const adjustment = (
    status: "未処理" | "精算済み" | "免除",
    amountYen: number,
  ): Adjustment => ({
    amountYen,
    status,
    occurredAt: "2026-09-01T00:00:00Z",
  });

  test("未処理の差額は未会計額に残り続ける", () => {
    expect(outstandingAdjustmentYen([adjustment("未処理", 1200)])).toBe(1200);
  });

  test("精算済み・免除は未会計額から外れる", () => {
    expect(
      outstandingAdjustmentYen([adjustment("精算済み", 1200), adjustment("免除", 800)]),
    ).toBe(0);
  });
});

describe("拒否の文言に内部の識別子を出さない（CLAUDE.md §3.2）", () => {
  test("すべての理由に利用者向けの文言がある", () => {
    const reasons: AdjustmentResolveDenialReason[] = ["not_permitted", "already_resolved", "stale"];
    for (const reason of reasons) {
      const message = adjustmentResolveDenialMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(reason);
    }
  });
});
