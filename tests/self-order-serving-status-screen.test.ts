// セルフ注文（A5）の提供ステータス表示の受入テスト（Issue #4 ／ WBS `6-5` 提供ステータス）。
//
// 固定する完了条件（Issue #4 の本文そのまま）:
//  1 ユーザー向け表示に使う文言が「調理中」「提供済み」の2種類のみである
//  2 上記以外の表記（Cooking／Ready／準備中／Now Preparing 等）を含まない
//  3 会計ステータスを提供ステータスの代わりに使っていない（v13 §5.4.1 の警告）
//
// 根拠: v13 §5.4.1「★ 提供ステータス」の表「本人への表示」と、同節の
//       「**提供ステータスと会計ステータスは独立した2軸である**」という警告。
//
// なぜソースを文字列として読むのか:
//   「その語を書いていない」は**書かれていないこと**を固定する条件であり、実行時の
//   振る舞いでは捕まえられない（`tests/serving-status.test.ts` が対応表の側を、
//   本ファイルが画面の側を押さえる ／ CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SERVING_STATUS_DISPLAY_LABELS } from "@/lib/serving-status";

import { SRC_DIR } from "./helpers/ai-sources";

const ORDERS_PAGE = join(SRC_DIR, "app", "orders", "page.tsx");
const ORDERS_ACTIONS = join(SRC_DIR, "app", "orders", "actions.ts");

/**
 * コメントを落としたソース。
 *
 * 表示語は**説明としてコメントに書く**（なぜその語なのかを残すため）。
 * 「画面に直書きしていない」を見るには、コメントを外してから探す必要がある。
 */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const SELF_ORDER_SOURCES = [ORDERS_PAGE, ORDERS_ACTIONS];

describe("表示語は共通定義から取る（v13 §5.4.1）", () => {
  test("セルフ注文の画面と Server Action が変換関数を通している", () => {
    for (const path of SELF_ORDER_SOURCES) {
      expect(readCode(path)).toContain("toServingStatusDisplayLabel(");
    }
  });

  test("表示語「調理中」をセルフ注文側へ直書きしていない", () => {
    // 直書きすると、正本が語を変えたときに1箇所直しても画面が追随しない。
    for (const path of SELF_ORDER_SOURCES) {
      expect(readCode(path)).not.toContain(SERVING_STATUS_DISPLAY_LABELS["未提供"]);
    }
  });

  test("本人向けの表示語は2種類だけである", () => {
    expect(Object.values(SERVING_STATUS_DISPLAY_LABELS)).toEqual(["調理中", "提供済み"]);
  });
});

describe("正本に無い表記を使っていない（Issue #4 完了条件2）", () => {
  // Issue #4 が例示した表記ゆれ。英語・略語・言い換えのいずれも正本に無い。
  const forbidden = ["Cooking", "Ready", "Now Preparing", "Preparing", "準備中", "お待ちください"];

  for (const word of forbidden) {
    test(`「${word}」がセルフ注文の画面に現れない`, () => {
      for (const path of SELF_ORDER_SOURCES) {
        expect(readCode(path)).not.toContain(word);
      }
    });
  }
});

describe("会計ステータスを提供ステータスの代わりに使わない（§5.4.1 の警告）", () => {
  const page = readCode(ORDERS_PAGE);

  test("提供状況の一覧が会計ステータスを描画していない", () => {
    // `order.status` は未会計／精算済み／取消（会計の軸）である。
    // 提供の一覧へ混ぜると、客は「精算済み＝出てきた」と読む。
    expect(page).not.toContain("{order.status}");
  });

  test("「精算済み」を提供済みの代わりに書いていない", () => {
    expect(page).not.toContain("精算済み");
  });

  test("提供状況の一覧であることが画面の文言から読める", () => {
    // 金額が並ぶ一覧なので、何の一覧なのかを明示しないと会計と混同される。
    expect(readFileSync(ORDERS_PAGE, "utf8")).toContain("提供の状況だけ");
  });
});
