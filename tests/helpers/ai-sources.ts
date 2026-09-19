// AI クライアント層（`src/lib/ai/`）の受入テストが共通で使うソース走査ヘルパ。
//
// なぜソースを文字列として読むのか:
//   「NEXT_PUBLIC_ 接頭辞を持たない」「呼び出し側が SDK へ直接依存しない」
//   「音声・GCS URI を渡す口を持たない」は、いずれも**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえられない。人の目で毎回確かめる種類の条件は機械で押さえる
//   （CLAUDE.md §4.4 ／ `tests/fixtures-are-synthetic.test.ts` と同じ考え方）。

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** リポジトリのルート（`tests/helpers/` から2つ上）。 */
export const REPO_ROOT = join(__dirname, "..", "..");

/** アプリのソース全体。 */
export const SRC_DIR = join(REPO_ROOT, "src");

/**
 * AI クライアント層。**ここだけ**が AI の SDK へ依存してよい。
 * 根拠: v13 §9 #45「AI呼び出しは抽象化して差し替え可能にしておけばよい」
 */
export const AI_LAYER_DIR = join(SRC_DIR, "lib", "ai");

/**
 * AI の SDK として扱うパッケージ名。
 * レガシーの `@google/generative-ai`（2025-11-30 deprecated）と、
 * 自律ループ専用の `@anthropic-ai/claude-agent-sdk` も、アプリ本体へ漏れたときに
 * 検出したいので列挙する。
 */
export const AI_SDK_PACKAGES = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@google/genai",
  "@google/generative-ai",
] as const;

/** AI クライアント層の1ファイルを読む。存在しなければ例外になる（＝未実装ならテストは落ちる）。 */
export function readAiLayerSource(fileName: string): string {
  return readFileSync(join(AI_LAYER_DIR, fileName), "utf8");
}

/**
 * AI クライアント層の全ソースを1つの文字列に連結して返す。
 * 1ファイルも無いときに空文字を返すと「含まれていないこと」を見るテストが素通りするため、例外にする。
 */
export function readAiLayerSources(): string {
  const files = listTypeScriptFiles(AI_LAYER_DIR);
  if (files.length === 0) {
    throw new Error(`AI クライアント層（${AI_LAYER_DIR}）にソースが1つもありません`);
  }
  return files.map((path) => readFileSync(path, "utf8")).join("\n");
}

/** `dir` 配下の `.ts` / `.tsx` を再帰的に列挙する。`dir` が無ければ空配列を返す。 */
export function listTypeScriptFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `source` が `packageName` を import しているか。引用符の種類を問わず照合する。 */
export function importsPackage(source: string, packageName: string): boolean {
  return [`"${packageName}"`, `'${packageName}'`].some((quoted) => source.includes(quoted));
}

/**
 * AI クライアント層の**外側**で AI の SDK を import しているファイルを、
 * リポジトリルートからの相対パスで返す。
 */
export function findAiSdkImportsOutsideAiLayer(): string[] {
  return listTypeScriptFiles(SRC_DIR)
    .filter((path) => !path.startsWith(AI_LAYER_DIR))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return AI_SDK_PACKAGES.some((packageName) => importsPackage(source, packageName));
    })
    .map((path) => relative(REPO_ROOT, path));
}

/** AI クライアント層のうち `packageName` を import しているファイル名を返す。 */
export function findAiLayerFilesImporting(packageName: string): string[] {
  return listTypeScriptFiles(AI_LAYER_DIR)
    .filter((path) => importsPackage(readFileSync(path, "utf8"), packageName))
    .map((path) => relative(AI_LAYER_DIR, path));
}

/**
 * `.env.example` の、指定した変数の直前に付いているコメント行をまとめて返す。
 * 変数が見つからない場合は例外にする（黙って空文字を返すとテストが素通りするため）。
 */
export function readEnvExampleComment(variableName: string): string {
  const lines = readFileSync(join(REPO_ROOT, ".env.example"), "utf8").split(/\r?\n/);
  const definitionIndex = lines.findIndex((line) => line.startsWith(`${variableName}=`));
  if (definitionIndex < 0) {
    throw new Error(`.env.example に ${variableName} の定義がありません`);
  }

  const comment: string[] = [];
  for (let i = definitionIndex - 1; i >= 0 && lines[i].startsWith("#"); i -= 1) {
    comment.unshift(lines[i]);
  }
  return comment.join("\n");
}
