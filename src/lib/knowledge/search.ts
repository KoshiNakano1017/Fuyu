// アプリ内の横断セマンティック検索（WBS 9-1 ／ v13 §9 #31）。
//
// 根拠: `CONSOLIDATED_DECISIONS.md` §17-6 #5（検索時スコープは DB 層に固定）・§16-2 #61
//       （判定軸はロールではなくチャネル）、`0102`（`rag.search_knowledge()`）・
//       `0103`（`public.search_knowledge()` ＝ PostgREST からの入口）。
//
// ## ★ スコープをここで書かない
//
// Tier・公開範囲・削除追随・走査状態の条件は `0102` の関数に固定してある。
// 呼び出し側が渡せるのは**チャネルと件数**だけであり、この層に `WHERE` 相当の判断を足すと
// 「スコープが2箇所にある」状態になる。片方だけ直したとき、**広い方が勝つ**。
//
// ## チャネルを引数にしない
//
// このモジュールはアプリ内検索の入口なので、チャネルは `app` に固定する。
// LINE 経路（浮遊街コンシェルジュ）は `line-rag-bot` 側が自分で `line` を指定して呼ぶ。
// ⚠️ **ここに `channel` 引数を足さないこと。** 足すと、アプリの画面から `line` を、
// あるいは将来の呼び出し元から誤ったチャネルを渡せる口ができる。
//
// ## エンドユーザー向けの AI チャットではない
//
// v13 §9 #31 は「本体はエンドユーザー向け AI チャット UI を持たない」を維持している
// （2026-09-11 の限定改訂でも維持）。ここが提供するのは**クエスト起票・評価のための内部検索**
// であり、対象は staff である（画面側で `requireStaff()` を通す）。

import { createGeminiEmbeddingClient } from "@/lib/ai/gemini";
import type { EmbeddingAiClient } from "@/lib/ai/types";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/** 検索結果1件。**投影元を辿れる情報までで、会員を指す列は含まない。** */
export type KnowledgeSearchHit = {
  chunkId: string;
  tier: 1 | 2;
  sourceType: string;
  sourceId: string;
  contentType: string;
  /** 伏字化後の本文（`0100` は伏字化前のテキストを保存しない）。 */
  chunkText: string;
  /** コサイン類似度（1 が最も近い）。式は DB 側が持つ（呼び出し側で再発明しない）。 */
  similarity: number;
};

/** 既定の件数。`0102` が 1〜50 に丸めるため、ここでの値は「使いやすい既定」でしかない。 */
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 10;

type SearchRow = {
  chunk_id: string;
  tier: number;
  source_type: string;
  source_id: string;
  content_type: string;
  chunk_text: string;
  similarity: number;
};

/**
 * 語句で索引を引く。空の問い合わせは**埋め込みを呼ばずに**空配列を返す。
 *
 * 空文字で呼ばれたときに API を叩くと、画面の初期表示（まだ何も入力されていない状態）で
 * 毎回課金される。ここで止めるのは費用の話であり、正しさの話ではない。
 */
export async function searchKnowledge(
  params: { query: string; limit?: number },
  embeddingClient: EmbeddingAiClient = createGeminiEmbeddingClient(),
): Promise<KnowledgeSearchHit[]> {
  const query = params.query.trim();
  if (query === "") {
    return [];
  }

  const [queryVector] = await embeddingClient.embed([query]);
  if (queryVector === undefined) {
    return [];
  }

  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc("search_knowledge", {
    // pgvector へは JSON 配列の文字列として渡す（PostgREST 経由の `vector` の入力表現）。
    p_query_embedding: JSON.stringify(queryVector),
    // ★ 固定。引数にしない（モジュール冒頭の理由）。
    p_channel: "app",
    p_limit: params.limit ?? KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  });

  if (error) {
    // ★ 検索語をエラー文へ載せない。運営が会員の氏名で引いた場合、その語がログへ残る。
    throw new Error(`検索に失敗しました: ${error.code ?? error.message}`);
  }

  return ((data ?? []) as SearchRow[]).map((row) => ({
    chunkId: row.chunk_id,
    tier: row.tier === 1 ? 1 : 2,
    sourceType: row.source_type,
    sourceId: row.source_id,
    contentType: row.content_type,
    chunkText: row.chunk_text,
    similarity: row.similarity,
  }));
}

/** 投影元の種別を日本語で見せる。内部識別子をそのまま画面へ出さない（CLAUDE.md §4.1）。 */
export function sourceTypeLabel(sourceType: string): string {
  const LABELS: Record<string, string> = {
    media: "写真・動画",
    morning_meeting: "朝会議事録",
    work_log: "作業ログ",
    quest: "クエスト",
  };
  return LABELS[sourceType] ?? sourceType;
}

/** 類似度の見せ方。小数を並べても読めないため百分率へ丸める。 */
export function similarityLabel(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}
