// 投影（各マスタ → `knowledge_chunks`）の判断だけを持つ純関数（WBS 9-1）。
//
// 根拠: v13 §9 #31（ベクトル基盤は Supabase 内の pgvector）、`CONSOLIDATED_DECISIONS.md` §17・§25-3、
//       `0100_rag_pgvector_knowledge_chunks.sql`（Tier の定義・`source_type` の値域・
//       `content_hash` による差分検知）、`0103_knowledge_projection.sql`（投影の2段階）。
//
// ## ここに DB も AI も持ち込まない
//
// Tier の割り当てとチャンク分割は「どちらに転んでも動くが、間違えると検索結果が静かに壊れる」
// 種類の判断である。DB と埋め込み API を混ぜると試験に外部依存が要るようになり、
// **結局誰も試験しない**。呼び出し側（`projection-store.ts`）が入出力を運ぶ。

import { createHash } from "node:crypto";

/**
 * 投影元の種別。`0100` の `source_type` CHECK と**同じ4値**である。
 *
 * ⚠️ **運営メモ（`member_notes`）・会員の連絡先を足さない。** §17-6 #6 の「危うい情報」は
 * 伏字化する以前に索引へ入れない、というのが `0100` の設計である（値域そのもので塞いでいる）。
 */
export const KNOWLEDGE_SOURCE_TYPES = ["media", "morning_meeting", "work_log", "quest"] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/**
 * Tier の割り当て（`0100` の定義）。
 *
 * - Tier 1 … 一般知識（レシピ・道具・FAQ）。**LINE へ書き出せる**
 * - Tier 2 … 個人に紐づく実績（写真キャプション・議事録・作業ログ）。運営のみ
 *
 * クエストだけが Tier 1 なのは、クエストの題名・手順が「やり方の知識」であって
 * 特定の誰かの実績ではないためである。⚠️ 写真・議事録・作業ログは**誰が何をしたか**が
 * 本文に残るため、Tier 1 へ上げてはならない（上げた瞬間に LINE 経路へ出る資格ができる）。
 */
export function tierFor(sourceType: KnowledgeSourceType): 1 | 2 {
  return sourceType === "quest" ? 1 : 2;
}

/**
 * 1チャンクの上限文字数。
 *
 * 埋め込みは「長すぎると主題がぼける・短すぎると文脈が消える」ため、段落単位で束ねて
 * この長さに収める。日本語は1文字の情報量が英語より大きいので、英語圏の目安（1000〜2000語）
 * ではなく**文字数**で切る。
 */
export const CHUNK_MAX_CHARS = 800;

/**
 * 本文をチャンクへ分ける。**段落の途中で切らない。**
 *
 * 文字数だけで機械的に切ると「大さじ2の塩を」で切れた断片が索引へ入り、検索で引いても
 * 意味が読めないチャンクが返る。段落（空行区切り）を単位に束ね、上限を超えるときだけ
 * 次のチャンクへ送る。**1段落が単独で上限を超える場合はその段落だけ文字数で割る**
 * （切らずに入れると埋め込みの入力上限に当たり、投影が止まる）。
 */
export function splitIntoChunks(text: string, maxChars: number = CHUNK_MAX_CHARS): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      continue;
    }
    const joined = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (joined.length > maxChars) {
      flush();
      current = paragraph;
    } else {
      current = joined;
    }
  }
  flush();

  return chunks;
}

/**
 * 差分検知のためのハッシュ（`0100` の `content_hash`）。
 *
 * 本文が変わっていなければ埋め込みを呼び直さない。埋め込みは課金対象であり、
 * 投影を定期実行にした時点で「毎回全件を投げる」実装は費用が線形に増える。
 *
 * ★ **正規化してからハッシュを取る。** 末尾の空白や改行の揺れだけで別物と判定されると、
 * 差分検知が働かず毎回再埋め込みになる（費用の話であって正しさの話ではないが、
 * 気づきにくいので揺れの側を潰しておく）。
 */
export function contentHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * LINE へ書き出してよいか。`0100` の `ck_chunk_export_tier1_only` と
 * `0102` の LINE 経路の条件を**そのまま写した**判断である。
 *
 * ⚠️ **この関数は DB の代わりではない。** 実際の値は `0103` の
 * `upsert_knowledge_chunk()` が同じ条件で決める。ここに置いてあるのは、
 * 投影を組む側が「何が LINE へ出るのか」を読めるようにするためと、試験のためである。
 * 片方だけ緩めないよう、条件を変えるときは必ず両方を直すこと。
 */
export function isExportableToLine(params: {
  tier: 1 | 2;
  scanStatus: "pending" | "clean" | "redacted" | "blocked";
  visibility: "公開" | "運営のみ";
}): boolean {
  return (
    params.tier === 1 &&
    (params.scanStatus === "clean" || params.scanStatus === "redacted") &&
    params.visibility === "公開"
  );
}
