import { GoogleGenAI } from "@google/genai";

import { readGeminiApiKey, redactApiKeys } from "./env";
import type { StructuredTextRequest, TextAiClient } from "./types";

/**
 * Gemini のテキスト用クライアント。**Gemini の SDK を import するのはこのファイルだけ**
 * （差し替え可能性の担保 ／ v13 §9 #45）。
 *
 * **テキストしか受け取らない。** 入力型 `StructuredTextRequest` にファイルやストレージ上の
 * 場所を渡す口を持たせていないのは、v13 §9 #63（2026-09-05 オーナー決定）でアプリが
 * 録音データを扱わないこと・入力は文字起こし済みテキストであることが確定しているため。
 * 実装しないだけでは後から踏み越えられるので、型として口を塞いでいる。
 *
 * レガシーの `@google/generative-ai` は 2025-11-30 付で deprecated のため採らない。
 */

/** 既定のモデル。呼び出し側から差し替えられる形にしている。 */
const DEFAULT_MODEL = "gemini-2.5-flash";

export type GeminiTextClientOptions = {
  model?: string;
};

export function createGeminiTextClient(options: GeminiTextClientOptions = {}): TextAiClient {
  return {
    async generateStructured<T>(request: StructuredTextRequest): Promise<T> {
      // SDK は GEMINI_API_KEY と GOOGLE_API_KEY の両方を暗黙に読み、両方あれば後者を優先する。
      // どちらのキーで喋っているか分からない状態にしないため、明示的に渡す。
      const client = new GoogleGenAI({ apiKey: readGeminiApiKey() });

      const response = await client.models
        .generateContent({
          model: options.model ?? DEFAULT_MODEL,
          contents: request.prompt,
          config: {
            // 構造化出力はモデル側の機能で強制する。1回の呼び出しで
            // 議事録サマリー・クエスト候補・ナレッジ候補を同時に得るため（v13 §5.1 ③・§5.7.4 ②）。
            responseMimeType: "application/json",
            responseJsonSchema: request.jsonSchema,
          },
        })
        .catch((error: unknown) => {
          // SDK やプロキシのエラー文へキーが混ざる事故を、外へ出す前に必ず塞ぐ。
          throw new Error(redactApiKeys(`Gemini の呼び出しに失敗しました: ${String(error)}`));
        });

      return parseStructuredJson<T>(response.text ?? "", request.schemaName);
    },
  };
}

/** パースできなかった本文は例外に載せない。プロンプトの中身が丸ごとログへ出るのを避けるため。 */
function parseStructuredJson<T>(jsonText: string, schemaName: string): T {
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    throw new Error(`Gemini の応答を "${schemaName}" の JSON として解釈できませんでした。`);
  }
}
