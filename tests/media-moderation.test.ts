// メディアの運営措置（WBS 14-3 ／ `src/lib/media/moderation.ts`）の単体テスト。
//
// 根拠: v13 §5.11.7 ③（ロール別の権限）とその [!warning]（全ロールに開放することの副作用）。
//
// ⚠️ ここで固定しているのは**誰が他人の投稿へ手を出せるか**である。
//    実体の認可は `0027` の RLS（`media_assets_update_self` / `_update_staff`）にあり、
//    このテストは画面・Server Action が同じ境界を先に返すことを保証する。

import {
  decideModeration,
  listModerationOffers,
  moderationDenialMessage,
  requiresModerationReason,
  type ModerationAction,
} from "@/lib/media/moderation";
import type { Role } from "@/lib/auth/session";

function request(overrides: {
  actorRole: Role;
  isOwnPost: boolean;
  action: ModerationAction;
  currentVisibility?: "公開" | "運営のみ";
  isDeleted?: boolean;
  reason?: string;
}) {
  return {
    currentVisibility: "公開" as const,
    isDeleted: false,
    reason: "不適切な内容のため",
    ...overrides,
  };
}

describe("自分の投稿は全ロールが下げられる（v13 §5.11.7 ③ の表）", () => {
  const roles: Role[] = ["admin", "core_member", "member", "guest"];

  for (const role of roles) {
    test(`${role} は自分の投稿を削除できる`, () => {
      const decision = decideModeration(
        request({ actorRole: role, isOwnPost: true, action: "delete" }),
      );
      expect(decision.allowed).toBe(true);
    });

    test(`${role} は自分の投稿を非表示にできる`, () => {
      const decision = decideModeration(
        request({ actorRole: role, isOwnPost: true, action: "hide" }),
      );
      expect(decision.allowed).toBe(true);
    });
  }

  test("自分の投稿を下げるのに理由は要らない", () => {
    const decision = decideModeration(
      request({ actorRole: "guest", isOwnPost: true, action: "delete", reason: "" }),
    );
    expect(decision).toEqual({ allowed: true, requiresReason: false });
  });
});

describe("他人の投稿へ手を出せるのは運営だけ（v13 §5.11.7 の警告1点目）", () => {
  test("管理者は他人の投稿を非表示にできる", () => {
    expect(
      decideModeration(request({ actorRole: "admin", isOwnPost: false, action: "hide" })).allowed,
    ).toBe(true);
  });

  test("コアメンバーも他人の投稿を削除できる", () => {
    expect(
      decideModeration(request({ actorRole: "core_member", isOwnPost: false, action: "delete" }))
        .allowed,
    ).toBe(true);
  });

  test("一般会員は他人の投稿へ措置できない", () => {
    expect(
      decideModeration(request({ actorRole: "member", isOwnPost: false, action: "delete" })),
    ).toEqual({ allowed: false, reason: "not_permitted" });
  });

  test("ゲストは他人の投稿へ措置できない", () => {
    expect(
      decideModeration(request({ actorRole: "guest", isOwnPost: false, action: "hide" })),
    ).toEqual({ allowed: false, reason: "not_permitted" });
  });

  test("★ `member_type` が上位でも `role` が member なら措置できない（v13 §2）", () => {
    // 親方（`member_type = '親方'`）であっても `role` が member なら運営ではない。
    // 判定に渡せるのは `role` だけなので、この試験は「立場を渡す口が無い」ことの確認でもある。
    expect(
      decideModeration(request({ actorRole: "member", isOwnPost: false, action: "delete" }))
        .allowed,
    ).toBe(false);
  });
});

describe("運営が他人の投稿へ措置するときは理由が必須", () => {
  test("理由が空だと拒否される", () => {
    expect(
      decideModeration(
        request({ actorRole: "admin", isOwnPost: false, action: "delete", reason: "" }),
      ),
    ).toEqual({ allowed: false, reason: "reason_required" });
  });

  test("空白文字だけの理由も拒否される", () => {
    expect(
      decideModeration(
        request({ actorRole: "admin", isOwnPost: false, action: "hide", reason: "  　 " }),
      ),
    ).toEqual({ allowed: false, reason: "reason_required" });
  });

  test("公開へ戻すときは理由を求めない（状態を元へ戻す操作）", () => {
    expect(
      requiresModerationReason("unhide", false, true),
    ).toBe(false);
  });

  test("自分の投稿なら理由を求めない", () => {
    expect(requiresModerationReason("delete", true, true)).toBe(false);
  });
});

describe("同じ措置を二重に適用させない", () => {
  test("削除済みの投稿へは何もできない", () => {
    expect(
      decideModeration(
        request({ actorRole: "admin", isOwnPost: false, action: "hide", isDeleted: true }),
      ),
    ).toEqual({ allowed: false, reason: "already_deleted" });
  });

  test("非表示の投稿をもう一度非表示にはできない", () => {
    expect(
      decideModeration(
        request({
          actorRole: "admin",
          isOwnPost: false,
          action: "hide",
          currentVisibility: "運営のみ",
        }),
      ),
    ).toEqual({ allowed: false, reason: "already_hidden" });
  });

  test("公開中の投稿を公開へ戻すことはできない", () => {
    expect(
      decideModeration(request({ actorRole: "admin", isOwnPost: false, action: "unhide" })),
    ).toEqual({ allowed: false, reason: "already_public" });
  });
});

describe("画面へ出す操作はサーバで決める（listModerationOffers）", () => {
  test("公開中の他人の投稿に運営が見るのは「非表示」と「削除」", () => {
    const offers = listModerationOffers({
      actorRole: "admin",
      isOwnPost: false,
      currentVisibility: "公開",
      isDeleted: false,
    });
    expect(offers.map((offer) => offer.action)).toEqual(["hide", "delete"]);
    expect(offers.every((offer) => offer.requiresReason)).toBe(true);
  });

  test("非表示の投稿には「公開に戻す」が出る", () => {
    const offers = listModerationOffers({
      actorRole: "core_member",
      isOwnPost: false,
      currentVisibility: "運営のみ",
      isDeleted: false,
    });
    expect(offers.map((offer) => offer.action)).toEqual(["unhide", "delete"]);
    // 公開へ戻す操作だけは理由を求めない
    expect(offers.find((offer) => offer.action === "unhide")?.requiresReason).toBe(false);
  });

  test("★ 一般会員には他人の投稿の操作が1つも出ない", () => {
    expect(
      listModerationOffers({
        actorRole: "member",
        isOwnPost: false,
        currentVisibility: "公開",
        isDeleted: false,
      }),
    ).toEqual([]);
  });

  test("自分の投稿には理由なしで押せる操作が出る", () => {
    const offers = listModerationOffers({
      actorRole: "guest",
      isOwnPost: true,
      currentVisibility: "公開",
      isDeleted: false,
    });
    expect(offers.map((offer) => offer.action)).toEqual(["hide", "delete"]);
    expect(offers.every((offer) => offer.requiresReason)).toBe(false);
  });

  test("削除済みの投稿には操作が出ない", () => {
    expect(
      listModerationOffers({
        actorRole: "admin",
        isOwnPost: false,
        currentVisibility: "公開",
        isDeleted: true,
      }),
    ).toEqual([]);
  });
});

describe("拒否の文言に内部の識別子を出さない（CLAUDE.md §3.2）", () => {
  test("すべての理由に利用者向けの文言がある", () => {
    const reasons = [
      "not_permitted",
      "already_deleted",
      "already_hidden",
      "already_public",
      "reason_required",
    ] as const;

    for (const reason of reasons) {
      const message = moderationDenialMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // 内部の識別子（英小文字＋アンダースコア）がそのまま出ていないこと
      expect(message).not.toContain(reason);
    }
  });
});
