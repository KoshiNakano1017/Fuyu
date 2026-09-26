"use server";

import { isStaff, readViewer } from "@/lib/auth/session";
import { searchKnowledge, type KnowledgeSearchHit } from "@/lib/knowledge/search";

export type KnowledgeSearchState = {
  status: "idle" | "done" | "error";
  query: string;
  hits: KnowledgeSearchHit[];
  message?: string;
};

export const INITIAL_KNOWLEDGE_SEARCH: KnowledgeSearchState = {
  status: "idle",
  query: "",
  hits: [],
};

/**
 * 横断セマンティック検索の Server Action（WBS 9-1 ／ v13 §9 #31）。
 *
 * ⚠️ **staff 以外は通さない。** 索引には Tier 2（個人に紐づく実績＝写真キャプション・議事録・
 * 作業ログ）が入っており、アプリ経路の検索はそれを返す（`0102` の `search_knowledge()` は
 * `channel = 'app'` のとき Tier を絞らない）。画面をナビから消すことは認可ではないので、
 * ここで必ず判定する（v13 §5.9.3 の二重防御）。
 *
 * ⚠️ **チャネルを受け取らない。** `searchKnowledge()` が `app` を固定しており、
 * フォームから `line` を渡せる口は作らない（§16-2 #61：判定軸はチャネル）。
 */
export async function searchKnowledgeAction(
  _prev: KnowledgeSearchState,
  formData: FormData,
): Promise<KnowledgeSearchState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return { ...INITIAL_KNOWLEDGE_SEARCH, status: "error", message: "この操作を行う権限がありません。" };
  }

  const query = String(formData.get("query") ?? "").trim();
  if (query === "") {
    return { ...INITIAL_KNOWLEDGE_SEARCH, status: "error", message: "検索語を入力してください。" };
  }

  try {
    const hits = await searchKnowledge({ query });
    return { status: "done", query, hits };
  } catch {
    // ★ 例外の中身を画面へ出さない。検索語や接続情報が混ざりうる（CLAUDE.md §3.2）。
    return {
      status: "error",
      query,
      hits: [],
      message: "検索できませんでした。時間をおいて再試行してください。",
    };
  }
}
