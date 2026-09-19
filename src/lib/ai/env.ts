/**
 * AI 基盤の API キーを環境変数から取り出す。
 *
 * どちらのキーにも `NEXT_PUBLIC_` 接頭辞を付けない。付けた時点で Next.js が値を
 * ブラウザのバンドルへ焼き込み、利用者が抽出できる状態になる（CLAUDE.md §3.2）。
 *
 * 値をトップレベル定数にせず関数にしているのは、未設定のときの失敗を import 時ではなく
 * 利用時に起こし、エラーの発生箇所を呼び出し元へ寄せるため（`src/lib/supabase/env.ts` と同じ作法）。
 */

function requireEnvValue(value: string | undefined, variableName: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `環境変数 ${variableName} が未設定です。.env.example を参照して .env を用意してください。`,
    );
  }
  return value;
}

export function readAnthropicApiKey(): string {
  return requireEnvValue(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
}

/**
 * Gemini の API キー。
 *
 * SDK は `GEMINI_API_KEY` と `GOOGLE_API_KEY` の両方を暗黙に読み、両方あれば後者を優先する。
 * どちらのキーで喋っているか分からない状態を作らないため、暗黙の解決には任せず
 * ここで読んだ値を SDK へ明示的に渡す（`gemini.ts`）。
 */
export function readGeminiApiKey(): string {
  return requireEnvValue(process.env.GEMINI_API_KEY, "GEMINI_API_KEY");
}

/** キーの値が混ざった文字列を外へ出すときの置換先。 */
const REDACTED = "[REDACTED]";

/**
 * 文字列に含まれる API キーの値を伏せる。
 *
 * SDK やプロキシが返すエラー文には `x-api-key` の値ごと載ることがある。本リポジトリは public で
 * Actions のログも公開されるため（CLAUDE.md §6.4）、キーを含みうる文字列は再送出する前にここを通す。
 * キーの読み出しと同じモジュールに置いているのは、伏せる対象が増えたときの直し漏れを防ぐため。
 */
export function redactApiKeys(text: string): string {
  const secrets = [process.env.ANTHROPIC_API_KEY, process.env.GEMINI_API_KEY];

  return secrets.reduce<string>(
    (redacted, secret) =>
      secret === undefined || secret === "" ? redacted : redacted.split(secret).join(REDACTED),
    text,
  );
}
