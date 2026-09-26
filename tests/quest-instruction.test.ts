// 実行指示の可否判定（WBS `5-2` ／ Issue #167）の受入テスト。
//
// 根拠:
//   v13 §6 権限マトリクス L2307「クエスト審査・実行指示出し（申請中処理）」＝
//     管理者〇／コアメンバー〇／会員−／ゲスト−
//   v13 §5.3（項目3）L838「運営側が「いつ・どこで・何を任せるか」の指示を出して承認」
//   v13 §5.9.3 L1717（画面ガードと API 認可は同一のロール定義を参照する）
//
// 認可は「できる」と「できない」を対で固定する（CLAUDE.md §4.4）。
// 許可側だけを書くと、**誰が出せないか**が受入基準に入らない。
//
// ⚠️ 同じ規則は DB のトリガーにもある（`tests/db/quest-instruction.test.ts`）。
//    片方だけ変えてはならない。ここが緑でもトリガーが緩ければ直接 UPDATE で抜ける。

import { canInstruct } from "@/lib/quests/review";

/** 指示の中身。空でないことが `指示済み` への遷移条件になる（完了条件13）。 */
const INSTRUCTION_BODY = "畝の間を草刈りし、刈った草を堆肥場へ運ぶ";

describe("完了条件10: 実行指示を出せるのは admin / core_member だけ（v13 §6 L2307）", () => {
  test("管理者は実行指示を出せる", () => {
    const decision = canInstruct({
      actorRole: "admin",
      current: "申請中",
      instructionBody: INSTRUCTION_BODY,
    });
    expect(decision.allowed).toBe(true);
  });

  test("コアメンバーは実行指示を出せる", () => {
    const decision = canInstruct({
      actorRole: "core_member",
      current: "申請中",
      instructionBody: INSTRUCTION_BODY,
    });
    expect(decision.allowed).toBe(true);
  });

  test("一般会員は実行指示を出せない", () => {
    const decision = canInstruct({
      actorRole: "member",
      current: "申請中",
      instructionBody: INSTRUCTION_BODY,
    });
    expect(decision.allowed).toBe(false);
  });

  test("ゲストは実行指示を出せない", () => {
    const decision = canInstruct({
      actorRole: "guest",
      current: "申請中",
      instructionBody: INSTRUCTION_BODY,
    });
    expect(decision.allowed).toBe(false);
  });

  test("custom ロールは実行指示を出せない（運営2値に含まれないため）", () => {
    const decision = canInstruct({
      actorRole: "custom",
      current: "申請中",
      instructionBody: INSTRUCTION_BODY,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("完了条件13: 指示の中身が空なら 指示済み へ進めない（v13 §5.3 項目3 L838）", () => {
  test("指示内容が空文字なら運営でも指示済みにできない", () => {
    // 中身なしでマッチング成立にすると、受注者は何をすればよいか分からないまま待機に入る。
    const decision = canInstruct({ actorRole: "admin", current: "申請中", instructionBody: "" });
    expect(decision.allowed).toBe(false);
  });

  test("指示内容が改行・タブだけでも指示済みにできない", () => {
    const decision = canInstruct({
      actorRole: "core_member",
      current: "申請中",
      instructionBody: "\n\t ",
    });
    expect(decision.allowed).toBe(false);
  });
});
