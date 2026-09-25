// 受注申請ボタンの受入テスト（Issue #84 ／ WBS `5-2` 受注申請・運営審査・実行指示）。
//
// 固定する完了条件（決定 B ＝ サーバ層 ＋ 画面）:
//  1 クエストボードから受注申請できる（ボタンが実際に送信する）
//  2 活性の根拠はサーバが決めた `canApply` である（画面でロール・資格を見ない）
//  3 押した後も Server Action が同じ関数で再判定する（判定点を増やさない ／ v13 §5.9.3）
//  4 拒否の理由を返さない（施錠クエストの状態を推測させない ／ §5.10.6 末尾）
//  5 二重申請は「申請済み」として伝える（失敗として見せない）
//
// なぜソースを文字列として読むのか:
//   「判定を持ち込んでいない」「理由を返していない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SRC_DIR } from "./helpers/ai-sources";

const BUTTON = join(SRC_DIR, "components", "quests", "QuestApplyButton.tsx");
const CARD = join(SRC_DIR, "components", "quests", "QuestCard.tsx");
const ACTIONS = join(SRC_DIR, "app", "quests", "actions.ts");
const GATE = join(SRC_DIR, "lib", "quests", "application-gate.ts");
const ROUTE = join(SRC_DIR, "app", "api", "quests", "[questId]", "applications", "route.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("クエストボードから受注申請できる（WBS 5-2 ／ 決定 B）", () => {
  test("ボタンが form で送信される（飾りのボタンではない）", () => {
    const button = readCode(BUTTON);
    expect(button).toContain("<form action={submit}");
    expect(button).toContain('name="questId"');
  });

  test("カードが申請の受け皿を渡されたときだけ実ボタンを描く", () => {
    const card = readCode(CARD);
    expect(card).toContain("<QuestApplyButton");
    expect(card).toContain("apply === undefined");
  });

  test("申請後は「申請済み」に変わり、続けて押せない", () => {
    const button = readCode(BUTTON);
    expect(button).toContain("申請済み");
    expect(button).toContain("disabled={!canApply || isPending || applied}");
  });
});

describe("★ 判定点を増やさない（v13 §5.9.3）", () => {
  test("ボタンはロール・資格を見ない", () => {
    const button = readCode(BUTTON);
    for (const word of ["role", "certification", "guest_allowed"]) {
      expect(button).not.toContain(word);
    }
  });

  test("Server Action は `canApplyToQuest()` で再判定する", () => {
    expect(readCode(ACTIONS)).toContain("canApplyToQuest(viewer, quest)");
  });

  test("API ルートも同じ関数を使う（画面と API で条件が割れない）", () => {
    expect(readCode(ROUTE)).toContain("canApplyToQuest(viewer, quest)");
  });

  test("資格ゲートは判定関数の中にある（別の場所に書かない）", () => {
    expect(readCode(GATE)).toContain("lacksRequiredCertification");
  });
});

describe("拒否の理由を返さない（§5.10.6 末尾）", () => {
  const actions = readCode(ACTIONS);

  test("施錠・締切・資格を区別した文言を返さない", () => {
    const applySection = actions.slice(actions.indexOf("applyToQuestAction"));
    expect(applySection).toContain("このクエストは受注できません");
    for (const word of ["施錠", "資格", "締切", "guest_allowed"]) {
      expect(applySection).not.toContain(word);
    }
  });

  test("二重申請は「申請済み」として伝える（失敗として見せない）", () => {
    expect(actions).toContain("すでに申請済みです");
  });
});
