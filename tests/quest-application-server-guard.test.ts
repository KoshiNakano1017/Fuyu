// 受注申請の「サーバ側で止まること」「二度目が失敗に見えないこと」の受入テスト
// （WBS `5-2` ／ Issue #167）。
//
// 根拠:
//   v13 §5.10.6 L1887「サーバ側でも `guest_allowed = false` のクエストに対するゲストの
//     受注申請APIを拒否する（表示制御のみに依存しない）」
//   v13 §5.10.6 L1893「施錠表示するクエストであっても、詳細な内容（報酬額・指示内容・
//     担当者情報）はゲストに返さない」
//   `0017_quest_applications_and_work_logs.sql` L78-80 `uq_quest_app_per_member UNIQUE (quest_id, member_id)`
//     （**ステータスを問わない全行が対象**）
//
// なぜソースを文字列として読むのか:
//   ① 「拒否の判定が INSERT より前に置かれていること」は**順序**の条件であり、
//      戻り値だけを見ても「行が増えなかった」ことと区別できない。
//   ② 「理由を区別した文言を返さない」は**書かれていないこと**の条件である。
//   既存の `tests/quest-application-screen.test.ts` が同じ作法を採っている（CLAUDE.md §4.4）。
//
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。`src/` は読んでいない。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SRC_DIR } from "./helpers/ai-sources";

const ROUTE = join(SRC_DIR, "app", "api", "quests", "[questId]", "applications", "route.ts");
const ACTIONS = join(SRC_DIR, "app", "quests", "actions.ts");
const APPLICATIONS = join(SRC_DIR, "lib", "quests", "applications.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** コメントを落とした本体。「書かれていないこと」を見る検査が、注記の語で誤検出しないようにする。 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("完了条件1: 拒否が申請行の作成より前に効く（v13 §5.10.6 L1887）", () => {
  const route = readCode(ROUTE);

  test("API ルートが判定関数を呼んでから受注申請を作る（拒否時に行が増えない）", () => {
    // 逆順（作ってから判定する）だと、拒否されたゲストの申請行が残る。
    expect(route.indexOf("canApplyToQuest(")).toBeLessThan(route.indexOf("createQuestApplication("));
  });

  test("拒否は 403 で返る（画面を経由しない直叩きでも止まる）", () => {
    expect(route).toContain("403");
  });
});

describe("完了条件9: 拒否の理由を区別した文言を返さない（v13 §5.10.6 L1893）", () => {
  /** 拒否の理由を推測させる語。どれで落ちたかを返すと、クエストの内情がゲストへ渡る。 */
  const REASON_WORDS = ["施錠", "資格", "募集", "締切", "guest_allowed"];

  test("API ルートが施錠・資格・募集終了を区別した文言を返さない", () => {
    expect(REASON_WORDS.filter((word) => readCode(ROUTE).includes(word))).toEqual([]);
  });

  test("Server Action が施錠・資格・募集終了を区別した文言を返さない", () => {
    // 受注申請の Server Action 以降だけを見る（同じファイルの別の操作を巻き込まないため。
    // 既存 `tests/quest-application-screen.test.ts` と同じ切り出し方）。
    const actions = readCode(ACTIONS);
    const applySection = actions.slice(actions.indexOf("applyToQuestAction"));
    expect(REASON_WORDS.filter((word) => applySection.includes(word))).toEqual([]);
  });
});

describe("完了条件7: 二度目の受注申請が処理失敗にならない（`uq_quest_app_per_member`）", () => {
  test("一意制約違反（23505）を重複として扱う", () => {
    // `差戻し` / `キャンセル` を経た行が残っている組み合わせでは、生きているステータスだけを見る
    // 事前チェックが素通りし、INSERT が一意制約に当たる。ここを汎用の失敗にまとめると
    // 「すでに申請済み」であるはずの操作が「時間をおいて再試行してください」になる。
    expect(readCode(APPLICATIONS)).toContain("23505");
  });

  test("「DB に一意制約が無い」という前提の注記が残っていない", () => {
    // `0017` L80 に `uq_quest_app_per_member` があり、注記は事実と食い違っている（調査結果 矛盾①）。
    expect(read(APPLICATIONS)).not.toContain("DB に一意制約が無い");
  });
});
