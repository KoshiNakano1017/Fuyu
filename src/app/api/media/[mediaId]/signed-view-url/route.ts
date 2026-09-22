import { NextResponse } from "next/server";

import { readViewer } from "@/lib/auth/session";
import {
  readInternalViewUrlTtlMinutes,
  readMediaBucketName,
  readMediaServiceAccount,
  readViewUrlTtlMinutes,
} from "@/lib/media/env";
import { createSignedViewUrl } from "@/lib/media/signed-url";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ mediaId: string }>;
};

/**
 * `POST /api/media/{id}/signed-view-url` — 閲覧用の署名付きURL発行（v13 §5.11.2 ⑤⑥）。
 *
 * ## 認可は RLS に委ねる（判定を二重に書かない）
 *
 * v13 §5.11.2 の不可侵ルール4 は「ロール判定の実装箇所は Supabase（RLS ＋ Edge Function）のみ」
 * と定める。ここで `visibility` や `role` を見て分岐すると、同じ規則が
 * `0021_media_assets.sql` の RLS とこのファイルの2箇所に散る。
 *
 * そこで**行が引けたこと自体を認可の結果として扱う**。RLS が
 * 「本人 ＋ staff は全件／それ以外は `公開` かつ未削除のみ」を既に表現しているため、
 * 引けなければ 404 を返せばよい。**存在するが見えない**のか**存在しない**のかを
 * 呼び出し側へ区別させないのも意図的である（他人の投稿の存在を推測させない）。
 *
 * ## GET ではなく POST である理由
 *
 * 署名付きURLは**発行するたびに新しい鍵を配る**副作用のある操作であり、
 * ブラウザやプロキシに結果をキャッシュされると失効済みのURLが再利用される。
 * API設計 §2-10 には本エンドポイントの記載が無いため、同§の発行系
 * （`POST /api/media/signed-upload-url`）に合わせた。
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { mediaId } = await context.params;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("media_assets")
    .select("storage_path, visibility, upload_state, deleted_at")
    .eq("media_id", mediaId)
    .maybeSingle();

  if (error || data === null) {
    return NextResponse.json({ error: "メディアが見つかりません" }, { status: 404 });
  }

  // 論理削除済みは staff の目にも「閲覧できるもの」としては映らない。
  // 運営措置で非表示にした実体へURLを配ると、非表示化の意味が無くなる（v13 §7 ／ WBS 14-3）。
  if (data.deleted_at !== null) {
    return NextResponse.json({ error: "メディアが見つかりません" }, { status: 404 });
  }

  // 実体がまだ着いていない（`pending`）行にURLを出しても 404 が返るだけなので、
  // 「まだ処理中である」ことが分かる応答にする。
  if (data.upload_state !== "stored") {
    return NextResponse.json({ error: "アップロードが完了していません" }, { status: 409 });
  }

  const signedUrl = createSignedViewUrl({
    bucketName: readMediaBucketName(),
    objectName: data.storage_path as string,
    ttlMinutes: resolveViewTtlMinutes(data.visibility as string),
    serviceAccount: readMediaServiceAccount(),
    signedAt: new Date(),
  });

  // ⚠️ 署名付きURLをログへ出さない（v13 §5.11.2 トレードオフ）。
  return NextResponse.json({
    viewUrl: signedUrl.url,
    expiresAt: signedUrl.expiresAt.toISOString(),
  });
}

/**
 * 公開範囲に応じて TTL を決める（v13 §5.11.2 ⑥）。
 *
 * 正本は「内部専用ナレッジの添付は有効期限をさらに短く（2分）」と書くが、
 * **ナレッジ本体のテーブルはまだ無い**（`0100` の `knowledge_chunks` は chunk 単位の
 * ベクトル表であり、`target_role` を持つナレッジ本体ではない）。そのため
 * 現時点で「内部専用か」を判定できる唯一の列は `visibility` である。
 *
 * `運営のみ` を内部専用とみなして2分を当てる。ナレッジ本体が実装されたら
 * §5.11.5「公開範囲の継承」に従って本体の `target_role` を見る形へ寄せること
 * （本文は非公開なのに画像URLだけ辿れる穴を作らない）。
 */
function resolveViewTtlMinutes(visibility: string): number {
  return visibility === "運営のみ" ? readInternalViewUrlTtlMinutes() : readViewUrlTtlMinutes();
}
