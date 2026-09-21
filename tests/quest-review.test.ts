// クエストの審査・二段階承認（WBS 5-2 / 5-4 / 5-6）の単体テスト。
//
// CLAUDE.md §4.4：認可に関わるロジックは必ずテストを書く。
// v13 §5.3.2 の4つの確定論点が、そのまま4つのテスト群になっている。
//
// ⚠️ 同じ規則は DB のトリガー（`work_logs_guard_approval()` ／ 0017）にもある。
//    片方だけ変えてはならない。ここが緑でもトリガーが緩ければ service_role 経由で抜ける。

import {
  canInstruct,
  decideReview,
  nextApprovalStatus,
  skipsCoreConfirmation,
} from "@/lib/quests/review";

describe("最終承認は管理者のみが行える（v13 §5.3.2）", () => {
  test("管理者は最終承認できる", () => {
    const decision = decideReview({ action: "approve", actorRole: "admin", current: "コアメンバー確認済" });
    expect(decision.allowed).toBe(true);
  });

  test("コアメンバーは最終承認できない", () => {
    const decision = decideReview({
      action: "approve",
      actorRole: "core_member",
      current: "コアメンバー確認済",
    });
    expect(decision).toEqual({ allowed: false, reason: "not_admin" });
  });

  test("一般会員は最終承認できない", () => {
    const decision = decideReview({ action: "approve", actorRole: "member", current: "報告済み" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("ゲストは最終承認できない", () => {
    const decision = decideReview({ action: "approve", actorRole: "guest", current: "報告済み" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });
});

describe("コアメンバー確認は運営が行える（v13 §5.3.2）", () => {
  test("コアメンバーは確認できる", () => {
    const decision = decideReview({ action: "core_confirm", actorRole: "core_member", current: "報告済み" });
    expect(decision.allowed).toBe(true);
  });

  test("管理者も確認できる", () => {
    const decision = decideReview({ action: "core_confirm", actorRole: "admin", current: "報告済み" });
    expect(decision.allowed).toBe(true);
  });

  test("一般会員は確認できない", () => {
    const decision = decideReview({ action: "core_confirm", actorRole: "member", current: "報告済み" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("custom ロールは確認できない（運営2値に含まれないため）", () => {
    const decision = decideReview({ action: "core_confirm", actorRole: "custom", current: "報告済み" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });
});

describe("管理者はコアメンバー確認を飛ばせるが、飛ばしたことが記録される（v13 §5.3.2）", () => {
  test("報告済みから直接承認できる", () => {
    const decision = decideReview({ action: "approve", actorRole: "admin", current: "報告済み" });
    expect(decision.allowed).toBe(true);
  });

  test("報告済みから直接承認した場合はスキップとして記録する", () => {
    expect(skipsCoreConfirmation({ action: "approve", current: "報告済み" })).toBe(true);
  });

  test("コアメンバー確認済から承認した場合はスキップにならない", () => {
    expect(skipsCoreConfirmation({ action: "approve", current: "コアメンバー確認済" })).toBe(false);
  });

  test("差戻しはスキップの記録対象ではない", () => {
    expect(skipsCoreConfirmation({ action: "reject", current: "報告済み" })).toBe(false);
  });
});

describe("差戻しは理由の入力が必須である（v13 §5.3.2）", () => {
  test("理由があれば差し戻せる", () => {
    const decision = decideReview({
      action: "reject",
      actorRole: "core_member",
      current: "報告済み",
      reason: "After写真が作業前の状態のままである",
    });
    expect(decision.allowed).toBe(true);
  });

  test("理由が未入力なら差し戻せない", () => {
    const decision = decideReview({ action: "reject", actorRole: "core_member", current: "報告済み" });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });

  test("理由が空白文字だけなら差し戻せない", () => {
    const decision = decideReview({
      action: "reject",
      actorRole: "admin",
      current: "報告済み",
      reason: "   ",
    });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });
});

describe("承認完了した報告は動かせない（給付予定が起票済みのため）", () => {
  test("承認完了から差し戻せない", () => {
    const decision = decideReview({
      action: "reject",
      actorRole: "admin",
      current: "承認完了",
      reason: "やはり不備があった",
    });
    expect(decision).toEqual({ allowed: false, reason: "already_finalized" });
  });

  test("承認完了から再度承認できない", () => {
    const decision = decideReview({ action: "approve", actorRole: "admin", current: "承認完了" });
    expect(decision).toEqual({ allowed: false, reason: "already_finalized" });
  });
});

describe("操作後の承認ステージ", () => {
  test("コアメンバー確認はコアメンバー確認済へ進む", () => {
    expect(nextApprovalStatus("core_confirm")).toBe("コアメンバー確認済");
  });

  test("最終承認は承認完了へ進む", () => {
    expect(nextApprovalStatus("approve")).toBe("承認完了");
  });

  test("差戻しは差戻しへ進む", () => {
    expect(nextApprovalStatus("reject")).toBe("差戻し");
  });
});

describe("実行指示（WBS 5-2 ／ v13 §5.3-3）", () => {
  test("運営は申請中のクエストへ指示を出せる", () => {
    const decision = canInstruct({
      actorRole: "core_member",
      current: "申請中",
      instructionBody: "東の畑の畝の間を草刈りし、刈った草を堆肥場へ運ぶ",
    });
    expect(decision.allowed).toBe(true);
  });

  test("一般会員は実行指示を出せない", () => {
    const decision = canInstruct({
      actorRole: "member",
      current: "申請中",
      instructionBody: "草刈り",
    });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("指示内容が空のまま指示済みにできない", () => {
    const decision = canInstruct({ actorRole: "admin", current: "申請中", instructionBody: "  " });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });

  test("既に指示済みの申請へ二重に指示は出せない", () => {
    const decision = canInstruct({
      actorRole: "admin",
      current: "指示済み",
      instructionBody: "草刈り",
    });
    expect(decision).toEqual({ allowed: false, reason: "already_finalized" });
  });
});
