import { GoogleGenAI } from "@google/genai";

import { readGeminiApiKey, redactApiKeys } from "./env";
import type { EmbeddingAiClient, StructuredTextRequest, TextAiClient } from "./types";

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

/**
 * 埋め込みのモデルと次元。**`knowledge_chunks.embedding` の `vector(768)` と対である。**
 *
 * 768 に揃える理由は `0100` のコメントのとおり、`line-rag-bot`（`gemini-embedding-001` /
 * 768次元）と**同一のベクトル空間**を共有するためである（v13 §9 #31 の 2026-09-11 限定改訂）。
 * 次元を変えると全件再埋め込みになり、pgvector の HNSW も 2000 次元までしか張れない。
 */
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Gemini の埋め込みクライアント。**SDK を import するのはこのファイルだけ**（v13 §9 #45）。
 *
 * `outputDimensionality` を明示するのは、モデルの既定次元が 768 とは限らないためである。
 * 既定に任せると、モデルの更新でベクトル空間が黙って変わり、**既存の索引と新しいチャンクの
 * 距離が比較できなくなる**（検索結果が静かに壊れ、例外は出ない）。
 * 受け取った次元もその場で確かめ、違えば投影を止める。
 */
export function createGeminiEmbeddingClient(): EmbeddingAiClient {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    model: EMBEDDING_MODEL,

    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      const client = new GoogleGenAI({ apiKey: readGeminiApiKey() });

      const response = await client.models
        .embedContent({
          model: EMBEDDING_MODEL,
          contents: [...texts],
          config: { outputDimensionality: EMBEDDING_DIMENSIONS },
        })
        .catch((error: unknown) => {
          throw new Error(redactApiKeys(`Gemini の埋め込み呼び出しに失敗しました: ${String(error)}`));
        });

      const vectors = (response.embeddings ?? []).map((embedding) => embedding.values ?? []);

      if (vectors.length !== texts.length) {
        throw new Error(
          `埋め込みの件数が入力と合いません（入力 ${texts.length}件 / 応答 ${vectors.length}件）。`,
        );
      }
      for (const vector of vectors) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          // 次元が違うベクトルを保存すると、以後の近傍検索が黙って壊れる。ここで止める。
          throw new Error(
            `埋め込みの次元が ${EMBEDDING_DIMENSIONS} ではありません（${vector.length} 次元）。`,
          );
        }
      }
      return vectors;
    },
  };
}
