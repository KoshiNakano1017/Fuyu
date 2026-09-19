import Anthropic from "@anthropic-ai/sdk";

import { readAnthropicApiKey, redactApiKeys } from "./env";
import type { StructuredTextRequest, TextAiClient } from "./types";

/**
 * Claude のテキスト用クライアント。**Anthropic の SDK を import するのはこのファイルだけ。**
 *
 * 呼び出し側は `TextAiClient` にしか依存しない。差し替えが必要になったとき、直すのが
 * このモジュール1つと依存1件で済む状態を保つため（v13 §9 #45）。
 *
 * エージェントループもツール実行も要らない（テキストを渡して構造化応答を1回得るだけ）ので、
 * 上位レイヤーの Claude Agent SDK ではなく Messages API のクライアントを使っている。
 *
 * ブラウザ実行を許可するオプションは**設定しない**。既定で無効であることが、キーが
 * 利用者へ露出しないための防壁になっている（CLAUDE.md §3.2）。
 * デバッグレベルのログも有効にしない。リクエスト／レスポンスのボディごと出力され、
 * ボディ内の機密が見えうると公式に明記されているため。
 */

/** 既定のモデル。用途ごとに変える想定があるため、呼び出し側から差し替えられる形にしている。 */
const DEFAULT_MODEL = "claude-opus-5";

/** 議事録サマリー＋クエスト候補＋ナレッジ候補を1回で返せる程度の上限。 */
const DEFAULT_MAX_TOKENS = 8192;

export type ClaudeTextClientOptions = {
  model?: string;
  maxTokens?: number;
  /**
   * SDK の既定タイムアウトは10分で、§8 の「60秒以内」に対して過大である。
   * ただし SLA の起点が正本で未整理なため、値の確定は呼び出し側（WBS 4-2）へ委ねる。
   */
  timeoutMs?: number;
};

/**
 * 出力を JSON だけに閉じ込める指示。スキーマは Claude 側の機能ではなく指示文で伝える。
 * 1回の呼び出しで完結させるため、検証と再問い合わせのラウンドトリップを挟まない
 * （v13 §5.1 ③・§5.7.4 ②）。
 */
function buildSystemPrompt(request: StructuredTextRequest): string {
  return [
    `あなたは "${request.schemaName}" という名前の JSON を出力する。`,
    "出力は次の JSON Schema に厳密に従った JSON オブジェクトだけとし、前後に説明文やコードフェンスを付けない。",
    JSON.stringify(request.jsonSchema),
  ].join("\n");
}

export function createClaudeTextClient(options: ClaudeTextClientOptions = {}): TextAiClient {
  return {
    async generateStructured<T>(request: StructuredTextRequest): Promise<T> {
      // キーの読み出しを呼び出し時点まで遅らせ、未設定の失敗を「使ったとき」に起こす
      // （`src/lib/supabase/env.ts` と同じ作法）。
      const client = new Anthropic({
        apiKey: readAnthropicApiKey(),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });

      const message = await client.messages
        .create({
          model: options.model ?? DEFAULT_MODEL,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: buildSystemPrompt(request),
          messages: [{ role: "user", content: request.prompt }],
        })
        .catch((error: unknown) => {
          // SDK やプロキシのエラー文へキーが混ざる事故を、外へ出す前に必ず塞ぐ。
          throw new Error(redactApiKeys(`Claude の呼び出しに失敗しました: ${String(error)}`));
        });

      const jsonText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      return parseStructuredJson<T>(jsonText, request.schemaName);
    },
  };
}

/** パースできなかった本文は例外に載せない。プロンプトの中身が丸ごとログへ出るのを避けるため。 */
function parseStructuredJson<T>(jsonText: string, schemaName: string): T {
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    throw new Error(`Claude の応答を "${schemaName}" の JSON として解釈できませんでした。`);
  }
}
