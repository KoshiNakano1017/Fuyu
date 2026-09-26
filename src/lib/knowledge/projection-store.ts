// 投影の実行（WBS 9-1）。`0103_knowledge_projection.sql` の RPC を呼ぶだけの層。
//
// 根拠: `CONSOLIDATED_DECISIONS.md` §17-6 #5・#6・§25-3、`0100`・`0102`・`0103`。
//
// ## なぜ service_role なのか
//
// `public.knowledge_chunks` は `0100` が **`service_role` にしか GRANT を与えていない**
// （RLS はポリシー0本＝`authenticated` からは常に0行）。投影は「誰かの代わりに書く」処理では
// なく索引の更新なので、利用者のセッションで書く筋がない。
//
// ⚠️ **だからこそ、この層に判断を置かない。** RLS が守ってくれない場所なので、
// 走査・伏字化・LINE 書き出し可否は `0103` の RPC 側に固定してある（`SECURITY DEFINER`）。
// ここがやるのは「テキストを渡す・ベクトルを受け取って渡す」だけである。
//
// ## ★ 埋め込むのは伏字化後のテキストである
//
// `upsert_knowledge_chunk()` の戻り値 `text_to_embed` を**そのまま**埋め込む。
// 呼び出し側が持っている生テキストを埋め込むと、本文は伏字なのにベクトルだけが PII を
// 含む状態になり、近傍検索から復元されうる（§17-6 #6 の目的が崩れる）。

import { createGeminiEmbeddingClient } from "@/lib/ai/gemini";
import type { EmbeddingAiClient } from "@/lib/ai/types";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

import {
  contentHashOf,
  splitIntoChunks,
  tierFor,
  type KnowledgeSourceType,
} from "./projection";

export type ProjectionRequest = {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  /** `knowledge_chunks.content_type`（`line-rag-bot` の `metadata.type` に対応）。 */
  contentType: string;
  /** 投影元の本文。**生テキストでよい**（伏字化は DB 側の走査が行う）。 */
  text: string;
  visibility?: "公開" | "運営のみ";
  targetRole?: "guest" | "member" | "core_member" | "admin";
  categoryId?: string | null;
};

export type ProjectionResult = {
  chunkCount: number;
  /** 埋め込みを付けた（＝検索に出る）チャンク数。 */
  embeddedCount: number;
  /** 走査で `blocked` になり、人間の確認へ回したチャンク数。 */
  blockedCount: number;
};

type UpsertRow = {
  chunk_id: string;
  scan_status: string;
  pii_hit_count: number;
  text_to_embed: string | null;
  needs_embedding: boolean;
};

/**
 * 1件の投影元を `knowledge_chunks` へ投影する。
 *
 * ## 走査 → 埋め込み の順を崩さない
 *
 * `0100` の `ck_chunk_embedding_requires_scan` が「走査を通っていないチャンクは embedding を
 * 持てない」と定めている。したがって先に本文を入れて走査状態を確定させ、**そのあとで**
 * ベクトルを付ける。逆順にすると DB に拒否される（拒否されるのは正しい）。
 *
 * ## 埋め込みは1回にまとめる
 *
 * チャンクごとに API を呼ぶと呼び出し回数がチャンク数に比例する。`needs_embedding` の
 * ものだけを集め、1回の `embed()` で済ませる（`EmbeddingAiClient` を配列で受ける設計の理由）。
 */
export async function projectToKnowledgeChunks(
  request: ProjectionRequest,
  embeddingClient: EmbeddingAiClient = createGeminiEmbeddingClient(),
): Promise<ProjectionResult> {
  const chunks = splitIntoChunks(request.text);
  if (chunks.length === 0) {
    return { chunkCount: 0, embeddedCount: 0, blockedCount: 0 };
  }

  const supabase = createAdminSupabaseClient();
  const tier = tierFor(request.sourceType);

  const pending: { chunkId: string; text: string }[] = [];
  let blockedCount = 0;

  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const { data, error } = await supabase.rpc("upsert_knowledge_chunk", {
      p_source_type: request.sourceType,
      p_source_id: request.sourceId,
      p_chunk_index: chunkIndex,
      p_content_type: request.contentType,
      p_chunk_text: chunkText,
      p_content_hash: contentHashOf(chunkText),
      p_tier: tier,
      p_target_role: request.targetRole ?? "core_member",
      p_visibility: request.visibility ?? "公開",
      p_category_id: request.categoryId ?? null,
    });

    if (error) {
      // ★ エラー文に本文を載せない。投影元は議事録・写真キャプションであり、
      //   走査前の生テキストがログへ出ると PII がログ側へ漏れる（CLAUDE.md §3.2）。
      throw new Error(
        `チャンクの投影に失敗しました（${request.sourceType} / index ${chunkIndex}）: ${error.code ?? error.message}`,
      );
    }

    const row = (Array.isArray(data) ? data[0] : data) as UpsertRow | null;
    if (row === null) {
      continue;
    }
    if (row.scan_status === "blocked") {
      blockedCount += 1;
      continue;
    }
    if (row.needs_embedding && row.text_to_embed !== null) {
      // ★ 渡すのは DB が返した伏字化後のテキスト。`chunkText`（生）ではない。
      pending.push({ chunkId: row.chunk_id, text: row.text_to_embed });
    }
  }

  if (pending.length === 0) {
    return { chunkCount: chunks.length, embeddedCount: 0, blockedCount };
  }

  const vectors = await embeddingClient.embed(pending.map((entry) => entry.text));

  let embeddedCount = 0;
  for (const [index, entry] of pending.entries()) {
    const { error } = await supabase.rpc("set_knowledge_chunk_embedding", {
      p_chunk_id: entry.chunkId,
      p_embedding: JSON.stringify(vectors[index]),
      p_embedding_model: embeddingClient.model,
    });
    if (error) {
      throw new Error(`埋め込みの保存に失敗しました: ${error.code ?? error.message}`);
    }
    embeddedCount += 1;
  }

  return { chunkCount: chunks.length, embeddedCount, blockedCount };
}

/**
 * 投影元が消えた／戻ったことを索引へ反映する（`0103` の ④）。
 *
 * 運営が非表示化した写真が検索に出続けないようにする（v13 §5.11 の運営措置 ／ WBS 14-3）。
 * ★ **行は消さない。** 消すと再投影のたびに同じ判断をやり直すことになる。
 */
export async function markKnowledgeSourceDeleted(params: {
  sourceType: KnowledgeSourceType;
  sourceId: string;
  deleted?: boolean;
}): Promise<number> {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc("mark_knowledge_source_deleted", {
    p_source_type: params.sourceType,
    p_source_id: params.sourceId,
    p_deleted: params.deleted ?? true,
  });

  if (error) {
    throw new Error(`索引の削除追随に失敗しました: ${error.code ?? error.message}`);
  }
  return typeof data === "number" ? data : 0;
}

/**
 * 投影を「失敗しても本処理を止めない」形で呼ぶ（WBS 9-1）。
 *
 * ## なぜ例外を飲むのか
 *
 * 索引は**投影であってマスタではない**（`0100` の COMMENT）。議事録の保存やクエストの起票が
 * 本処理であり、索引が1件遅れることと、運営の操作が失敗として返ることを比べれば、
 * 後者のほうが現場で重い（初回来訪キャッシュバックの自動起票を「チェックインを巻き戻さない」
 * 形にしたのと同じ判断 ／ WBS 3-2）。
 *
 * ⚠️ **飲むのは投影の失敗だけである。** 走査で `blocked` になったチャンクは失敗ではなく
 * 「人間の確認へ回した」結果なので、`projectToKnowledgeChunks()` は例外にせず件数で返す。
 *
 * ⚠️ **本文をログへ出さない。** 投影元は議事録・写真キャプションであり、走査前の生テキストが
 * ログへ出ると PII がログ側へ漏れる（CLAUDE.md §3.2）。出すのは種別と識別子までにする。
 */
export async function projectToKnowledgeChunksQuietly(
  request: ProjectionRequest,
): Promise<ProjectionResult | null> {
  try {
    return await projectToKnowledgeChunks(request);
  } catch (caught) {
    console.warn(
      `索引への投影に失敗しました（${request.sourceType} / ${request.sourceId}）。本処理は続行します。`,
      caught instanceof Error ? caught.message : "",
    );
    return null;
  }
}
