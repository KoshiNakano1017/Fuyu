// 買い物リスト（WBS 5-8 / 5-9）の単体テスト。
//
// CLAUDE.md §4.4：認可に関わるロジックは必ずテストを書く。
// v13 §5.12 の設計判断が、そのままテスト群になっている。
//
// ⚠️ 同じ規則は DB 側にもある（`shopping_list_items_guard()` ／ 0028）。
//    片方だけ変えてはならない。ここが緑でもトリガーが緩ければ service_role 経由で抜ける。

import { canRegister, decideStatusChange } from "@/lib/shopping/status";
import { findDuplicateCandidates, normalizeItemName } from "@/lib/shopping/duplicate";
import { buildShoppingQuestDraft, type QuestableItem } from "@/lib/shopping/quest-draft";

describe("ゲストは登録できない（v13 §5.12.1 ／ 2026-09-22 オーナー確定）", () => {
  test("街人は登録できる", () => {
    expect(canRegister("member")).toBe(true);
  });

  test("コアメンバーは登録できる", () => {
    expect(canRegister("core_member")).toBe(true);
  });

  test("管理者は登録できる", () => {
    expect(canRegister("admin")).toBe(true);
  });

  test("ゲストは登録できない", () => {
    expect(canRegister("guest")).toBe(false);
  });
});

describe("「買う／見送り」の判断は運営のみ（v13 §5.12.2・§6）", () => {
  const base = { current: "希望", withdrawn: false } as const;

  test("コアメンバーは購入対象として承認できる", () => {
    const decision = decideStatusChange({ ...base, action: "decide_buy", actorRole: "core_member" });
    expect(decision).toEqual({ allowed: true, next: "買う" });
  });

  test("街人は自分の希望を自分で承認できない", () => {
    const decision = decideStatusChange({ ...base, action: "decide_buy", actorRole: "member", isOwner: true });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });

  test("ゲストは承認できない", () => {
    const decision = decideStatusChange({ ...base, action: "decide_buy", actorRole: "guest" });
    expect(decision).toEqual({ allowed: false, reason: "not_staff" });
  });
});

describe("見送りは理由が必須（v13 §5.12.2）", () => {
  test("理由があれば見送れる", () => {
    const decision = decideStatusChange({
      action: "skip",
      actorRole: "admin",
      current: "希望",
      withdrawn: false,
      reason: "在庫がまだある",
    });
    expect(decision).toEqual({ allowed: true, next: "見送り" });
  });

  test("理由が空なら見送れない", () => {
    const decision = decideStatusChange({
      action: "skip",
      actorRole: "admin",
      current: "希望",
      withdrawn: false,
      reason: "   ",
    });
    expect(decision).toEqual({ allowed: false, reason: "blank_reason" });
  });
});

describe("状態遷移の順序（v13 §5.12.2）", () => {
  test("希望のままクエスト化はできない（運営の承認を飛ばせない）", () => {
    const decision = decideStatusChange({
      action: "convert_to_quest",
      actorRole: "admin",
      current: "希望",
      withdrawn: false,
    });
    expect(decision).toEqual({ allowed: false, reason: "invalid_transition" });
  });

  test("買う からはクエスト化できる", () => {
    const decision = decideStatusChange({
      action: "convert_to_quest",
      actorRole: "admin",
      current: "買う",
      withdrawn: false,
    });
    expect(decision).toEqual({ allowed: true, next: "クエスト化済" });
  });

  test("クエストを立てずに買ってきた場合も購入済にできる", () => {
    const decision = decideStatusChange({
      action: "mark_purchased",
      actorRole: "core_member",
      current: "買う",
      withdrawn: false,
    });
    expect(decision).toEqual({ allowed: true, next: "購入済" });
  });

  test("部分購入で買えなかった分は 買う へ戻せる（v13 §5.12.3）", () => {
    const decision = decideStatusChange({
      action: "return_to_buy",
      actorRole: "core_member",
      current: "クエスト化済",
      withdrawn: false,
    });
    expect(decision).toEqual({ allowed: true, next: "買う" });
  });

  test("取下げ済みの品目は運営でも動かせない", () => {
    const decision = decideStatusChange({
      action: "decide_buy",
      actorRole: "admin",
      current: "希望",
      withdrawn: true,
    });
    expect(decision).toEqual({ allowed: false, reason: "already_withdrawn" });
  });
});

describe("取下げは登録者本人にも開ける（v13 §5.12.1）", () => {
  test("登録者本人は理由を添えて取り下げられる", () => {
    const decision = decideStatusChange({
      action: "withdraw",
      actorRole: "member",
      current: "希望",
      withdrawn: false,
      isOwner: true,
      reason: "自分で買った",
    });
    expect(decision).toEqual({ allowed: true, next: "希望" });
  });

  test("他人の品目は取り下げられない", () => {
    const decision = decideStatusChange({
      action: "withdraw",
      actorRole: "member",
      current: "希望",
      withdrawn: false,
      isOwner: false,
      reason: "不要だと思う",
    });
    expect(decision).toEqual({ allowed: false, reason: "not_owner" });
  });

  test("運営は他人の品目でも取り下げられる", () => {
    const decision = decideStatusChange({
      action: "withdraw",
      actorRole: "core_member",
      current: "買う",
      withdrawn: false,
      isOwner: false,
      reason: "重複のため統合",
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("重複検知は候補を出すだけで自動マージしない（v13 §5.12.1）", () => {
  const candidates = [
    { itemId: "i1", itemName: "食器用洗剤", status: "希望" as const, withdrawnAt: null },
    { itemId: "i2", itemName: "醤油（濃口）", status: "買う" as const, withdrawnAt: null },
    { itemId: "i3", itemName: "醤油", status: "購入済" as const, withdrawnAt: null },
    { itemId: "i4", itemName: "みりん", status: "希望" as const, withdrawnAt: "2026-09-20T00:00:00Z" },
  ];

  test("部分一致で候補を拾う", () => {
    expect(findDuplicateCandidates("醤油", candidates).map((c) => c.itemId)).toEqual(["i2"]);
  });

  test("購入済みは重複の対象にしない", () => {
    expect(findDuplicateCandidates("醤油", candidates).some((c) => c.itemId === "i3")).toBe(false);
  });

  test("取下げ済みは重複の対象にしない", () => {
    expect(findDuplicateCandidates("みりん", candidates)).toEqual([]);
  });

  test("全角・空白・大文字小文字の揺れは吸収する", () => {
    expect(normalizeItemName("ＴＯＩＬＥＴ ペーパー")).toBe("toiletペーパー");
  });

  test("空の品名では候補を出さない", () => {
    expect(findDuplicateCandidates("   ", candidates)).toEqual([]);
  });
});

describe("買い出し1回＝1クエスト（v13 §5.12.3）", () => {
  const approved: QuestableItem[] = [
    {
      itemId: "i1",
      itemName: "食器用洗剤",
      quantity: 2,
      unit: "本",
      referencePriceJpy: 300,
      status: "買う",
      withdrawnAt: null,
    },
    {
      itemId: "i2",
      itemName: "軍手",
      quantity: null,
      unit: null,
      referencePriceJpy: null,
      status: "買う",
      withdrawnAt: null,
    },
  ];

  test("複数品目から1件のクエストを組み立てる", () => {
    const result = buildShoppingQuestDraft({ items: approved, createdByMemberId: "m1" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.row.origin_type).toBe("shopping_list");
    expect(result.row.execution_mode).toBe("remote");
    expect(result.row.title).toBe("買い出し（2件）");
  });

  test("品目は本文の明細として残る", () => {
    const result = buildShoppingQuestDraft({ items: approved, createdByMemberId: "m1" });
    expect(result.ok && result.row.description).toContain("・食器用洗剤（2本 / 目安 300円）");
  });

  test("数量も価格も無い品目は品名だけを出す", () => {
    const result = buildShoppingQuestDraft({ items: approved, createdByMemberId: "m1" });
    expect(result.ok && result.row.description).toContain("・軍手\n");
  });

  test("ゲスト開放は既定で false（立替が発生し得るため）", () => {
    const result = buildShoppingQuestDraft({ items: approved, createdByMemberId: "m1" });
    expect(result.ok && result.row.guest_allowed).toBe(false);
  });

  test("運営が承認していない品目は載せられない", () => {
    const withHope: QuestableItem[] = [{ ...approved[0], status: "希望" }];
    expect(buildShoppingQuestDraft({ items: withHope, createdByMemberId: "m1" })).toEqual({
      ok: false,
      reason: "not_approved",
    });
  });

  test("品目が無ければ起案しない", () => {
    expect(buildShoppingQuestDraft({ items: [], createdByMemberId: "m1" })).toEqual({
      ok: false,
      reason: "no_items",
    });
  });
});
