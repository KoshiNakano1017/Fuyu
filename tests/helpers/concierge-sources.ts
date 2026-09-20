// 「浮遊街コンシェルジュ管理画面への導線」（WBS `9-2` line-rag-bot管理画面への導線（外部リンクのみ）／
// Issue #94）の受入テストが共通で使うソース走査ヘルパ。
//
// なぜソースを文字列として読むのか:
//   完了条件5「アプリ側にナレッジ登録フォーム・エスカレーション一覧・line-rag-bot API 呼び出しが
//   存在しない」は**書かれていないこと**を固定する条件であり、実行時の振る舞いでは捕まえられない。
//   サーバサイド認可の併置（v13 §5.9.3「DOM非表示は認可ではない」）も、ページが `requireStaff()` を
//   通しているかという「書かれていること」の検査になるため、同じ手段で押さえる。
//   `tests/helpers/ai-sources.ts`・`tests/fixtures-are-synthetic.test.ts` と同じ考え方
//   （CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT, SRC_DIR, listTypeScriptFiles } from "./ai-sources";

/**
 * 店員向けナレッジ導線ページ（B9 ／ `画面設計.md` §4）。
 * 未実装なら読み出しの時点で例外になる（＝実装が無い間テストは赤になる）。
 */
export const STAFF_KNOWLEDGE_PAGE = join(SRC_DIR, "app", "staff", "knowledge", "page.tsx");

/** `/staff/knowledge` のページのソースを返す。 */
export function readStaffKnowledgePage(): string {
  return readFileSync(STAFF_KNOWLEDGE_PAGE, "utf8");
}

/**
 * `src/` 配下の全 TypeScript ソースを「リポジトリルートからの相対パス」と中身の組で返す。
 * 1件も無いときに空配列を返すと「含まれていないこと」を見るテストが素通りするため、例外にする。
 */
export function readAllSrcSources(): { path: string; source: string }[] {
  const files = listTypeScriptFiles(SRC_DIR);
  if (files.length === 0) {
    throw new Error(`アプリのソース（${SRC_DIR}）が1つもありません`);
  }
  return files.map((path) => ({
    path: relative(REPO_ROOT, path),
    source: readFileSync(path, "utf8"),
  }));
}

/**
 * `src/` 配下で `pattern` に一致する中身を持つファイルの相対パスを返す。
 * `pattern` に `g` フラグを付けないこと（`RegExp.test` が `lastIndex` を持ち越し、
 * 2件目以降の判定を取りこぼすため）。
 */
export function findSrcFilesMatching(pattern: RegExp): string[] {
  return readAllSrcSources()
    .filter(({ source }) => pattern.test(source))
    .map(({ path }) => path);
}

/** `src/` 配下でパス自体が `pattern` に一致するファイルの相対パスを返す。 */
export function findSrcPathsMatching(pattern: RegExp): string[] {
  return readAllSrcSources()
    .map(({ path }) => path)
    .filter((path) => pattern.test(path));
}
