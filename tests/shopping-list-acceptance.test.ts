// 買い物リストのドメインロジック受入テスト（Issue #147 ／ WBS `5-8` 買い物リスト（ほしいものリスト））。
//
// 固定する完了条件:
//   9 街人（`member`）は `希望` → `買う` へ変更できない
//  10 管理者・コアメンバーは `希望` → `買う`、および `見送り`（理由つき）へ変更できる
//  11 取下げは理由を伴わなければ拒否される（論理削除であることは DB 側で固定する）
//  13 ゲストの登録が**サーバサイドで**拒否される
//  20 登録時に、未購入の既存品目を品名で部分一致検索した候補が提示される
//  21 重複候補が提示されても自動でマージされない
//
// 根拠: v13 §5.12.1（登録ロール・重複の扱い・自動マージしない・取下げは理由必須）／
//       §5.12.2（買う・見送りの判断者）／ §6 権限マトリクス L2357〜2362。
//
// ⚠️ 同じ規則は DB 側（RLS ＋ ガードトリガー）にもある。
//    片方だけ変えてはならない。ここが緑でも DB が緩ければ直接リクエストで抜ける（v13 §5.9.3）。
//    DB 側は `tests/db/shopping-list-authz.test.ts` が受け持つ。

import { canRegister, decideStatusChange } from "@/lib/shopping/status";
import { findDuplicateCandidates } from "@/lib/shopping/duplicate";

describe("登録できるロール（完了条件13 ／ v13 §5.12.1・§9 #65②）", () => {
  test("管理者は登録できる", () => {
    expect(canRegister("admin")).toBe(true);
  });

  test("コアメンバーは登録できる", () => {
    expect(canRegister("core_member")).toBe(true);
  });

  test("街人は登録できる", () => {
    expect(canRegister("member")).toBe(true);
  });

  test("ゲストは登録できない", () => {
    expect(canRegister("guest")).toBe(false);
  });
});

describe("「買う」の判断は運営だけができる（完了条件9・10 ／ v13 §5.12.2・§6）", () => {
  const hoped = { current: "希望", withdrawn: false } as const;

  test("管理者は 希望 から 買う へ変更できる", () => {
    expect(decideStatusChange({ ...hoped, action: "decide_buy", actorRole: "admin" })).toEqual({
      allowed: true,
      next: "買う",
    });
  });

  test("コアメンバーは 希望 から 買う へ変更できる", () => {
    expect(decideStatusChange({ ...hoped, action: "decide_buy", actorRole: "core_member" })).toEqual({
      allowed: true,
      next: "買う",
    });
  });

  test("街人は自分が登録した品目でも 買う へ変更できない", () => {
    const decision = decideStatusChange({ ...hoped, action: "decide_buy", actorRole: "member", isOwner: true });
    expect(decision.allowed).toBe(false);
  });

  test("ゲストは 買う へ変更できない", () => {
    expect(decideStatusChange({ ...hoped, action: "decide_buy", actorRole: "guest" }).allowed).toBe(false);
  });
});

describe("見送りは運営が理由を添えて行う（完了条件10 ／ v13 §5.12.2）", () => {
  const skipBy = (actorRole: "admin" | "core_member" | "member", reason: string) =>
    decideStatusChange({ action: "skip", actorRole, current: "希望", withdrawn: false, reason });

  test("管理者は理由を添えて 見送り にできる", () => {
    expect(skipBy("admin", "在庫がまだある")).toEqual({ allowed: true, next: "見送り" });
  });

  test("コアメンバーも理由を添えて 見送り にできる", () => {
    expect(skipBy("core_member", "在庫がまだある")).toEqual({ allowed: true, next: "見送り" });
  });

  test("街人は 見送り にできない", () => {
    expect(skipBy("member", "要らないと思う").allowed).toBe(false);
  });

  test("運営でも理由が無ければ 見送り にできない", () => {
    expect(skipBy("admin", "   ").allowed).toBe(false);
  });
});

describe("取下げは理由を伴う（完了条件11・19 ／ v13 §5.12.1）", () => {
  const withdrawBy = (isOwner: boolean, reason: string) =>
    decideStatusChange({ action: "withdraw", actorRole: "member", current: "希望", withdrawn: false, isOwner, reason });

  test("登録者本人は理由を添えて取り下げられる", () => {
    expect(withdrawBy(true, "自分で買った").allowed).toBe(true);
  });

  test("理由が空なら取り下げられない", () => {
    expect(withdrawBy(true, "   ").allowed).toBe(false);
  });

  test("他人の品目は取り下げられない", () => {
    expect(withdrawBy(false, "要らないと思う").allowed).toBe(false);
  });
});

describe("重複候補の提示（完了条件20 ／ v13 §5.12.1）", () => {
  // フィクスチャは自作の架空データ（CLAUDE.md §7.1）。実在の会員・品目を一切参照しない。
  const existingItems = [
    { itemId: "i1", itemName: "食器用洗剤（詰替）", status: "希望" as const, withdrawnAt: null },
    { itemId: "i2", itemName: "軍手", status: "買う" as const, withdrawnAt: null },
    { itemId: "i3", itemName: "醤油", status: "購入済" as const, withdrawnAt: null },
    { itemId: "i4", itemName: "みりん", status: "希望" as const, withdrawnAt: "2026-09-20T00:00:00Z" },
  ];

  test("品名の部分一致で既存の品目を候補に出す", () => {
    expect(findDuplicateCandidates("食器用洗剤", existingItems).map((item) => item.itemId)).toEqual(["i1"]);
  });

  test("買う まで進んだ品目も候補に出す（まだ買われていないため）", () => {
    expect(findDuplicateCandidates("軍手", existingItems).map((item) => item.itemId)).toEqual(["i2"]);
  });

  test("購入済みの品目は候補に出さない", () => {
    expect(findDuplicateCandidates("醤油", existingItems)).toEqual([]);
  });

  test("取下げ済みの品目は候補に出さない", () => {
    expect(findDuplicateCandidates("みりん", existingItems)).toEqual([]);
  });

  test("似た品目が無ければ候補は空になる", () => {
    expect(findDuplicateCandidates("土のう袋", existingItems)).toEqual([]);
  });
});

describe("重複候補があっても自動マージしない（完了条件21 ／ v13 §5.12.1）", () => {
  const existingItems = [{ itemId: "i1", itemName: "食器用洗剤", status: "希望" as const, withdrawnAt: null }];

  test("候補の検索は既存の品目を書き換えない", () => {
    // 「同じ洗剤」でも容量違いが別物であることが多いため、統合は人が決める。
    findDuplicateCandidates("食器用洗剤", existingItems);
    expect(existingItems).toEqual([{ itemId: "i1", itemName: "食器用洗剤", status: "希望", withdrawnAt: null }]);
  });

  test("候補は提示されるだけで、登録そのものを止める結果にはならない", () => {
    expect(findDuplicateCandidates("食器用洗剤", existingItems).map((item) => item.itemId)).toEqual(["i1"]);
  });
});
