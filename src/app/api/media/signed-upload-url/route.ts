import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { readViewer } from "@/lib/auth/session";
import {
  readMediaBucketName,
  readMediaServiceAccount,
  readUploadUrlTtlMinutes,
} from "@/lib/media/env";
import { createSignedUploadUrl } from "@/lib/media/signed-url";
import {
  buildMediaObjectName,
  decideUploadPolicy,
  normalizeCaptureMetadata,
} from "@/lib/media/upload-policy";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * `POST /api/media/signed-upload-url` — アップロード用の署名付きURL発行（API設計 §2-10 L285）。
 *
 * v13 §5.11.2 ①の実装。順番に意味がある。
 *
 *   1. ログインを確かめる（未認証には発行しない／§5.11.5）
 *   2. `contentType`・サイズ上限・用途タグを検証する（§5.11.5・§5.11.7 ②）
 *   3. `media_assets` へ `pending` を**先に**作る（§5.11.2 ①-b）
 *   4. 署名付きURL（PUT・10分・`contentType` 固定・`x-goog-content-length-range` 付き）を返す
 *
 * ## なぜレコードを先に作るのか
 *
 * アップロード完了の記録は**クライアントの完了通知ではなく Object Finalize を起点**にする
 * （§5.11.2 note）。通信断やアプリ離脱で通知が来なくても、実体と突き合わせる相手が
 * DB 側に無いと「実体はあるのに記録が無い孤児ファイル」になり、課金だけが残る。
 * 逆に実体が現れなかった `pending` 行は定期ジョブが `expired` にする。
 *
 * ## ロールで分岐しない
 *
 * アップロードは**全ロール（ゲストを含む）に開放**されている（v13 §5.11.7 ①）。
 * 「誰の投稿になるか」は RLS（`media_assets_insert_self`）が本人に固定するため、
 * ここで `member_id` を受け取らない。受け取ると他人名義の投稿を要求する窓ができる。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const body = await readJsonBody(request);
  if (body === null) {
    return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  }

  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const purposeTags = Array.isArray(body.purposeTags)
    ? body.purposeTags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const declaredSizeBytes =
    typeof body.declaredSizeBytes === "number" ? body.declaredSizeBytes : undefined;

  const decision = decideUploadPolicy({ contentType, purposeTags, declaredSizeBytes });
  if (!decision.accepted) {
    return NextResponse.json({ error: decision.rejectionReason }, { status: 400 });
  }

  // 撮影日時・位置は画面が Exif から読んで送ってくる（v13 §5.11.7 ③）。
  // ⚠️ クライアント由来の値であり、形だけを検証して受ける。読めない値は黙って捨てる
  //    （補助情報のためにアップロードそのものを失敗させない）。
  const capture = normalizeCaptureMetadata({
    takenAt: body.takenAt,
    geoLocation: body.geoLocation,
  });

  const mediaId = randomUUID();
  const signedAt = new Date();
  const objectName = buildMediaObjectName({
    mediaId,
    extension: decision.extension,
    uploadedAt: signedAt,
  });

  // RLS 越しに入れる。service_role を使うと「本人名義でしか作れない」保証が消える。
  const supabase = await createServerSupabaseClient();
  const { error: insertError } = await supabase.from("media_assets").insert({
    media_id: mediaId,
    member_id: viewer.memberId,
    media_type: decision.mediaType,
    content_type: contentType,
    storage_path: objectName,
    purpose_tags: decision.normalizedPurposeTags,
    // ⚠️ `geo_location` は PII-B（DB物理設計 §6-1 #22）。ログへ出さない。
    taken_at: capture.takenAt,
    geo_location: capture.geoLocation,
    // `upload_state` と `visibility` は DB の既定値（pending ／ 公開）に委ねる。
    // 既定を2箇所に書くと、片方を直したときにもう片方が取り残される。
  });

  if (insertError) {
    // ⚠️ 失敗の詳細（DB のメッセージ）をそのまま返さない。制約名・列名から
    //    スキーマの形が読めるため（CLAUDE.md §3.2 のログ方針と同じ理由）。
    return NextResponse.json({ error: "アップロードの受付に失敗しました" }, { status: 500 });
  }

  const signedUrl = createSignedUploadUrl({
    bucketName: readMediaBucketName(),
    objectName,
    contentType,
    maxBytes: decision.maxBytes,
    ttlMinutes: readUploadUrlTtlMinutes(),
    serviceAccount: readMediaServiceAccount(),
    signedAt,
  });

  // ⚠️ **署名付きURLをログへ出さない**（v13 §5.11.2 トレードオフ ／ `非機能要件詳細.md` §2-7）。
  //    失効までURLを知る者なら誰でも開けるため、ログに残った時点で流出経路になる。
  return NextResponse.json({
    mediaId,
    storagePath: objectName,
    uploadUrl: signedUrl.url,
    method: signedUrl.method,
    requiredHeaders: signedUrl.requiredHeaders,
    expiresAt: signedUrl.expiresAt.toISOString(),
    maxBytes: decision.maxBytes,
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
