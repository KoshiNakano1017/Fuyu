// 提供ステータスの保存値 → 本人（客）向け表示文言の対応を固定する。
//
// 根拠: v13 §5.4.1「★ 提供ステータス（キッチン・ホール連携）」の表「本人への表示」行
//       ——「セルフ注文後の画面に『調理中』／『提供済み』を表示し、カウンターへ聞きに
//       行かなくても状態が分かるようにする」。保存値そのものは v13 §7 データ要件
//       （`serving_status`: `未提供`/`提供済み`）と DB物理設計の CHECK 制約で2値に閉じている。
//
// `docs/spec/detailed-design/画面設計.md` L319 は本人向けの行を「未提供／提供済み」と
// 書いているが、CLAUDE.md §1.1 により矛盾時は正本が勝つため「調理中」を採る
// （QUESTIONS.md「[2026-09-03] 提供ステータス表示文言の仕様内不整合（v13 §5.4.1 #39）」は
// 未回答のまま、正本優先で進行中）。
//
// 変換関数は未知の保存値も受け取れるよう `string` を引数に取る前提で書いている。
// 引数型を2値のユニオンに絞ると、未知値のテストが `tsc --noEmit`（CI）で落ちるため。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SERVING_STATUS_DISPLAY_LABELS, toServingStatusDisplayLabel } from "@/lib/serving-status";

const MODULE_SOURCE_PATH = join(__dirname, "../src/lib/serving-status.ts");

/** 画面実装への依存を検出するための import 先。UI から切り離された共通定義であることを固定する */
const UI_MODULE_PREFIXES = ["react", "next"];

describe("提供ステータスの本人向け表示文言（v13 §5.4.1）", () => {
  test("保存値「未提供」は本人向けに「調理中」と表示される", () => {
    expect(toServingStatusDisplayLabel("未提供")).toBe("調理中");
  });

  test("保存値「提供済み」は本人向けに「提供済み」と表示される", () => {
    expect(toServingStatusDisplayLabel("提供済み")).toBe("提供済み");
  });

  test("変換関数が返す文言は対応表の定義と一致する", () => {
    // 対応表と変換関数が別々の文言を持たない＝定義が1箇所であることを固定する
    expect(toServingStatusDisplayLabel("未提供")).toBe(SERVING_STATUS_DISPLAY_LABELS["未提供"]);
  });

  test("対応表の保存値は「未提供」と「提供済み」の2件だけである", () => {
    expect(Object.keys(SERVING_STATUS_DISPLAY_LABELS)).toEqual(["未提供", "提供済み"]);
  });

  test("未知の保存値「取消」は表示文言へ変換されず RangeError になる", () => {
    // `取消` は伝票側（`orders.status`）の値であり `serving_status` には存在しない（v13 §5.4.1）。
    // 値域の外を黙って表示すると、客の画面に根拠のない状態が出る
    expect(() => toServingStatusDisplayLabel("取消")).toThrow(RangeError);
  });

  test("表示文言「調理中」を保存値として渡すと RangeError になる", () => {
    // 表示語を保存値として書き戻す取り違えを、変換の入口で止める
    expect(() => toServingStatusDisplayLabel("調理中")).toThrow(RangeError);
  });

  test("空文字列の保存値は RangeError になる", () => {
    expect(() => toServingStatusDisplayLabel("")).toThrow(RangeError);
  });

  test("対応表の定義が React・Next.js の画面実装を参照していない", () => {
    // 画面への組み込みは別タスク（WBS 6-5）。共通定義が UI 側へ依存すると、
    // 画面を持たない文脈（テスト・サーバ側）から再利用できなくなる
    const source = readFileSync(MODULE_SOURCE_PATH, "utf8");
    const importedModules = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    const uiImports = importedModules.filter((moduleName) =>
      UI_MODULE_PREFIXES.some((prefix) => moduleName === prefix || moduleName.startsWith(`${prefix}/`)),
    );
    expect(uiImports).toEqual([]);
  });
});
