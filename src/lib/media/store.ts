/**
 * メディア台帳（`media_assets` ／ `0027`）の DB 往復（WBS 14-3）。判定は `moderation.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS で読み書きする。**`service_role` は使わない。**
 *   行を絞るのは `0027` の `media_assets_select_self` / `_select_staff` / `_select_public` と
 *   `_update_self` / `_update_staff` である。ここで `createAdminSupabaseClient()` を使うと、
 *   「一般会員には公開のものだけ」という境界がアプリのコード頼みになる。
 *
 * ⚠️ `storage_path` を画面へ出すときは**署名付きURLに替えてから**にする（v13 §5.11.2・§5.11.5）。
 *   本モジュールはパスを返すが、それは措置の対象を一意に示すためであり、閲覧経路ではない。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { MediaVisibility } from "./moderation";

export type MediaAsset = {
  mediaId: string;
  memberId: string;
  /** 投稿者の表示名（`v_member_public`）。実名は出さない（CLAUDE.md §7.1） */
  uploaderLabel: string;
  mediaType: string;
  contentType: string;
  storagePath: string;
  purposeTags: readonly string[];
  visibility: MediaVisibility;
  isDeleted: boolean;
  deleteReason: string | null;
  createdAt: string;
};

const MEDIA_COLUMNS =
  "media_id, member_id, media_type, content_type, storage_path, purpose_tags, visibility, deleted_at, delete_reason, created_at";

/**
 * 最近の投稿を新しい順に返す。
 *
 * **ロールで分岐しない。** 何件返るかは RLS が決める（運営は全件、本人＋公開分はそれ以外）。
 * ここでロールを見て条件を足すと、境界が2箇所に分かれて食い違う余地ができる。
 */
export async function fetchRecentMedia(limit = 30): Promise<MediaAsset[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("media_assets")
    .select(MEDIA_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || data === null) {
    return [];
  }

  const rows = data as unknown as Record<string, unknown>[];
  const labels = await fetchUploaderLabels(rows.map((row) => String(row.member_id)));

  return rows.map((row) => ({
    mediaId: String(row.media_id),
    memberId: String(row.member_id),
    uploaderLabel: labels.get(String(row.member_id)) ?? "（表示名なし）",
    mediaType: String(row.media_type),
    contentType: String(row.content_type),
    storagePath: String(row.storage_path),
    purposeTags: ((row.purpose_tags as string[] | null) ?? []).map(String),
    visibility: row.visibility as MediaVisibility,
    isDeleted: row.deleted_at !== null,
    deleteReason: row.delete_reason === null ? null : String(row.delete_reason),
    createdAt: String(row.created_at),
  }));
}

/** 措置の対象1件の現況。判定に要る最小限だけを読む。 */
export async function fetchMediaState(
  mediaId: string,
): Promise<{ memberId: string; visibility: MediaVisibility; isDeleted: boolean } | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("media_assets")
    .select("member_id, visibility, deleted_at")
    .eq("media_id", mediaId)
    .maybeSingle();

  if (data === null) {
    return null;
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    memberId: String(row.member_id),
    visibility: row.visibility as MediaVisibility,
    isDeleted: row.deleted_at !== null,
  };
}

/** 公開範囲を切り替える（非表示化・公開へ戻す）。 */
export async function setMediaVisibility(params: {
  mediaId: string;
  visibility: MediaVisibility;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("media_assets")
    .update({ visibility: params.visibility, updated_at: new Date().toISOString() })
    .eq("media_id", params.mediaId);

  return error === null;
}

/**
 * 論理削除する（v13 §5.11.7「削除は論理削除」）。
 *
 * ★ `deleted_by` を必ず入れる。`0027` の CHECK が
 * 「`deleted_at` があるなら `deleted_by` も要る」を強制しており、
 * 誰が下げたか分からない措置を残さないためである。
 * ストレージ実体はライフサイクルジョブが消す（§5.11.4）。
 */
export async function softDeleteMedia(params: {
  mediaId: string;
  deletedBy: string;
  reason: string | null;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("media_assets")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: params.deletedBy,
      delete_reason: params.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("media_id", params.mediaId);

  return error === null;
}

async function fetchUploaderLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name")
    .in("member_id", unique);

  const labels = new Map<string, string>();
  for (const row of (data ?? []) as { member_id: string; display_name: string | null }[]) {
    if (row.display_name !== null) {
      labels.set(row.member_id, row.display_name);
    }
  }
  return labels;
}
