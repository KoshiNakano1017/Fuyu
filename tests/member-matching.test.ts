// 名寄せの判定（WBS 10-2 ／ `src/lib/members/matching.ts`）の単体テスト。
//
// 固定する完了条件（v13 §5.8.3 ／ 2026-09-25 オーナー決定 B）:
//  1 候補1件 ＋ 本人確認済み → 自動で成立する
//  2 候補2件以上 → 自動連携せず運営承認キューへ回す（同姓同名・家族間の連絡先共有）
//  3 本人確認（OTP）を通っていない照合では成立させない
//  4 既に結合済み・`active` の会員は名寄せの対象にしない（奪取の経路にしない）
//  5 候補0件は何もしない（招待台帳の経路へ任せる）
//  6 監査ログに残す根拠（`matchBasis`）が必ず付く
//
// ⚠️ 名寄せの成立は**他人の宿泊券・Uii残高・XP の引き継ぎ**を意味する。
//    ここは「成立させない判断」を持つ場所であり、緩めた瞬間に取り返しのつかない事故になる。

import {
  approvalMatchBasis,
  decideMatching,
  matchKindLabel,
  normalizeMatchValue,
  type MatchCandidate,
} from "@/lib/members/matching";

/** 名寄せの対象になり得る候補（事前登録済み・未結合）。 */
function linkable(memberId: string): MatchCandidate {
  return {
    memberId,
    isBound: false,
    accountStatus: "pre_registered",
    isIdentifierVerified: true,
  };
}

function decide(overrides: {
  candidates: readonly MatchCandidate[];
  isActorVerified?: boolean;
}) {
  return decideMatching({
    matchKind: "email",
    matchValue: "Fuyu-Member@Example.Invalid ",
    isActorVerified: true,
    ...overrides,
  });
}

describe("候補1件は自動で成立する（v13 §5.8.3 STEP 2）", () => {
  test("成立した会員IDを返す", () => {
    const decision = decide({ candidates: [linkable("member-1")] });
    expect(decision.kind).toBe("auto");
    expect(decision.kind === "auto" ? decision.memberId : null).toBe("member-1");
  });

  test("★ 監査ログに残す根拠が付く（誰の判断か後から読める）", () => {
    const decision = decide({ candidates: [linkable("member-1")] });
    const basis = decision.kind === "auto" ? decision.matchBasis : "";
    expect(basis).toContain("本人確認済み");
    expect(basis).toContain("メールアドレス");
    // 正規化した値を残す（照合に使った値そのものを追えるようにする）
    expect(basis).toContain("fuyu-member@example.invalid");
  });
});

describe("★ 候補2件以上は自動連携しない（§5.8.3 の [!warning] ①）", () => {
  test("運営承認キューへ回す", () => {
    const decision = decide({ candidates: [linkable("member-1"), linkable("member-2")] });
    expect(decision.kind).toBe("queue");
    expect(decision.kind === "queue" ? decision.candidateCount : 0).toBe(2);
  });

  test("キューへ回した理由が人に読める文である", () => {
    const decision = decide({ candidates: [linkable("a"), linkable("b"), linkable("c")] });
    const reason = decision.kind === "queue" ? decision.reason : "";
    expect(reason).toContain("3件");
    expect(reason).toContain("メールアドレス");
  });
});

describe("★ 本人確認を通っていない照合では成立させない（§5.8.3 の [!warning] ②）", () => {
  test("候補1件でもキューへ回す", () => {
    const decision = decide({ candidates: [linkable("member-1")], isActorVerified: false });
    expect(decision.kind).toBe("queue");
    expect(decision.kind === "queue" ? decision.reason : "").toContain("本人確認");
  });
});

describe("★ 名寄せを奪取の経路にしない", () => {
  test("既に結合済みの会員は候補から外れる", () => {
    const bound: MatchCandidate = { ...linkable("member-1"), isBound: true };
    expect(decide({ candidates: [bound] })).toEqual({ kind: "none" });
  });

  test("`active` の会員は候補から外れる（本登録済みの相手を乗っ取らない）", () => {
    const active: MatchCandidate = { ...linkable("member-1"), accountStatus: "active" };
    expect(decide({ candidates: [active] })).toEqual({ kind: "none" });
  });

  test("結合済みが混ざっていても、残る候補が1件なら成立する", () => {
    const bound: MatchCandidate = { ...linkable("member-9"), isBound: true };
    const decision = decide({ candidates: [bound, linkable("member-1")] });
    expect(decision.kind).toBe("auto");
    expect(decision.kind === "auto" ? decision.memberId : null).toBe("member-1");
  });

  test("★ 結合済みを先に外す（運営が選べない候補をキューへ出さない）", () => {
    // 判定の順番が「件数 → 結合済み」だと、ここが candidateCount 2 のキューになってしまう。
    const bound: MatchCandidate = { ...linkable("member-9"), isBound: true };
    const decision = decide({ candidates: [bound, linkable("member-1")] });
    expect(decision.kind).not.toBe("queue");
  });
});

describe("候補0件は何もしない（招待台帳の経路へ任せる）", () => {
  test("`none` を返す", () => {
    expect(decide({ candidates: [] })).toEqual({ kind: "none" });
  });
});

describe("照合値の正規化（`member_identifiers.value_normalized` と同じ規則）", () => {
  test("前後の空白と大文字小文字を落とす", () => {
    expect(normalizeMatchValue(" Fuyu@Example.Invalid ")).toBe("fuyu@example.invalid");
  });

  test("正規化しても中身は変えない（別人にしない）", () => {
    expect(normalizeMatchValue("a.b+c@example.invalid")).toBe("a.b+c@example.invalid");
  });
});

describe("表示名と承認時の根拠（内部識別子を出さない ／ CLAUDE.md §3.2）", () => {
  test("照合キーの種別に日本語の表示名がある", () => {
    expect(matchKindLabel("email")).toBe("メールアドレス");
    expect(matchKindLabel("phone")).toBe("電話番号");
  });

  test("運営承認の根拠に件数と種別が入る", () => {
    expect(approvalMatchBasis({ matchKind: "phone", candidateCount: 2 })).toBe(
      "運営承認（電話番号の一致 2件から選択）",
    );
  });
});
