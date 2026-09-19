// テストデータが実在の会員データ由来でないことを固定する（完了条件21）。
//
// 根拠: CLAUDE.md §3.2・§7.1（**匿名化しても禁止**）、DB物理設計 §6-8④
//       （氏名は架空のダミー、メールは `@example.invalid` を使う）。
//
// このリポジトリは public であり、一度 push した個人情報は取り消せない。
// pre-commit のパスガードも gitleaks も日本語の氏名・住所を検出できないため、
// 「フィクスチャが自作である」ことは人の注意力ではなくここで機械的に押さえる。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE_EMAILS, TEST_MEMBERS } from "./db/helpers/fixtures";

/**
 * フィクスチャ定義の置き場（`tests/` からの相対）。増えたらここへ足す。
 * 走査から漏れたファイルは守られないため、テスト名にパスを出して漏れが見えるようにする。
 */
const FIXTURE_SOURCE_PATHS = ["db/helpers/fixtures.ts", "fixtures/quest-board.ts"];

/**
 * 実データの所在。フィクスチャがここを参照していたら、その時点で §7.1 違反である。
 * 設計文書名（`会員データモデル_ユーザーテーブル定義`）と取り違えないよう、
 * ディレクトリ区切りまで含めて照合する。
 */
const FORBIDDEN_REFERENCES = ["Knowledge/浮遊街アプリ", "会員データ/", "03_seed_members", "01_schema.sql"];

describe("DB テストのフィクスチャ（完了条件21）", () => {
  test("すべてのフィクスチャのメールアドレスが @example.invalid である", () => {
    const outsiders = FIXTURE_EMAILS.filter((email) => !email.endsWith("@example.invalid"));
    expect(outsiders).toEqual([]);
  });

  test("フィクスチャのニックネームがすべて「テスト」で始まる架空の名前である", () => {
    const nicknames = Object.values(TEST_MEMBERS).map((member) => member.nickname);
    expect(nicknames.filter((nickname) => !nickname.startsWith("テスト"))).toEqual([]);
  });

  test.each(FIXTURE_SOURCE_PATHS)("%s が実データの置き場を1つも参照していない", (path) => {
    const source = readFileSync(join(__dirname, path), "utf8");
    const hits = FORBIDDEN_REFERENCES.filter((reference) => source.includes(reference));
    expect(hits).toEqual([]);
  });
});
