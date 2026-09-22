/**
 * アップロードの受け入れ判定（v13 §5.11.5・§5.11.7）。
 *
 * ## ここは「署名に何を焼き込むか」を決める場所である
 *
 * v13 §5.11.5 は **クライアント側検証のみに依存しない**ことを求めている。
 * したがって本ファイルが返す `contentType` と `maxBytes` は、画面の入力チェックではなく
 * **署名付きURLへ焼き込まれてストレージ側で強制される値**になる
 * （`Content-Type` の固定と `x-goog-content-length-range`）。
 * ここを緩めると、緩めた分がそのままストレージの受け入れ条件になる。
 */

/** 正本 v13 §7 の3値（2026-09-22 オーナー決定 C）。DB の `media_assets.media_type` と同じ値域。 */
export type MediaType = "image" | "video" | "pdf";

/**
 * ファイルサイズ上限（2026-09-22 オーナー決定 A ／ `QUESTIONS.md`
 * 「[2026-09-19] アップロード署名付きURLのファイルサイズ上限の具体値」）。
 *
 * 画像 20MB ／ 動画 200MB。HEIC の原寸と 1〜2分の 4K 動画が通る水準であり、
 * スマートフォンで撮ったままの動画が拒否されると Phase 1 の「撮る・貯める」
 * （v13 §5.11.3 note）が成立しないため、この水準になっている。
 * ストレージ側のコストはライフサイクル（§5.11.4）と予算アラートで抑える。
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/**
 * ⚠️ **PDF の上限はオーナー決定に含まれていない**（決定 A は画像・動画の2種だけを挙げている）。
 * 画像と同じ 20MB を当てている。PDF は §5.11.7 のアップロードUI（カメラロール／その場で撮影）
 * ではなくナレッジ添付の経路で入る書類であり、動画側（200MB）へ寄せる理由が無いため。
 * 運用で不足したら `QUESTIONS.md` へ起票して決め直すこと（推測で広げない）。
 */
export const MAX_PDF_BYTES = MAX_IMAGE_BYTES;

type ContentTypeRule = {
  mediaType: MediaType;
  /** オブジェクト名に付ける拡張子。ストレージ上で中身を推測しやすくするためだけのもの */
  extension: string;
  maxBytes: number;
};

/**
 * 受け入れる `Content-Type` の許可リスト。**列挙にないものは弾く**（v13 §5.11.5
 * 「署名に `contentType` を固定し、実行可能ファイル等の投入を防ぐ」）。
 *
 * 画像・動画の形式は v13 §5.11.7「対応形式」（JPEG / PNG / HEIC / WebP、MP4 / MOV）。
 * PDF は v13 L1274・L1315（ナレッジの添付は「写真・PDF」「画像・動画・PDFは Cloud Storage へ格納」）
 * に基づき、決定 C（正本 §7 の全面採用）で受け入れる。
 */
const ALLOWED_CONTENT_TYPES: Readonly<Record<string, ContentTypeRule>> = {
  "image/jpeg": { mediaType: "image", extension: "jpg", maxBytes: MAX_IMAGE_BYTES },
  "image/png": { mediaType: "image", extension: "png", maxBytes: MAX_IMAGE_BYTES },
  "image/heic": { mediaType: "image", extension: "heic", maxBytes: MAX_IMAGE_BYTES },
  "image/heif": { mediaType: "image", extension: "heif", maxBytes: MAX_IMAGE_BYTES },
  "image/webp": { mediaType: "image", extension: "webp", maxBytes: MAX_IMAGE_BYTES },
  "video/mp4": { mediaType: "video", extension: "mp4", maxBytes: MAX_VIDEO_BYTES },
  "video/quicktime": { mediaType: "video", extension: "mov", maxBytes: MAX_VIDEO_BYTES },
  "application/pdf": { mediaType: "pdf", extension: "pdf", maxBytes: MAX_PDF_BYTES },
};

/**
 * 用途タグのプリセット（v13 §5.11.7 ②）。
 *
 * ⚠️ **許可リストではない。** タグ語彙はマスタで固定せず運用の中で増える
 * （フォークソノミー／v13 §5.11.3）。ここにない語を弾いてはならない。
 * 画面の選択肢の既定値として使う。
 */
export const MEDIA_PURPOSE_PRESETS = [
  "インスタグラム投稿",
  "ブログ・資料作成",
  "クエスト報告",
  "施設紹介",
  "作業手順",
  "イベント記録",
  "メニュー写真",
] as const;

/** 1件あたりの用途タグの上限。無制限にすると索引（gin）と画面表示が壊れるため置く歯止め。 */
const MAX_PURPOSE_TAGS = 10;
const MAX_PURPOSE_TAG_LENGTH = 40;

export type UploadRequest = {
  contentType: string;
  purposeTags: readonly string[];
  /**
   * クライアントが申告するバイト数（任意）。
   * ⚠️ **これは検証の主役ではない。** 実際の上限強制は署名へ焼き込む
   * `x-goog-content-length-range` が行う（v13 §5.11.5）。ここで見るのは、
   * 明らかに超える要求に対して署名を発行する前に断るための早期リターンである。
   */
  declaredSizeBytes?: number;
};

export type UploadPolicyDecision =
  | {
      accepted: true;
      mediaType: MediaType;
      extension: string;
      maxBytes: number;
      /** 重複と空白を落とした保存用のタグ */
      normalizedPurposeTags: string[];
    }
  | { accepted: false; rejectionReason: string };

/**
 * アップロード要求を受け入れてよいか判定する。
 *
 * 判定は**ロールを見ない**。アップロードは全ロール（ゲストを含む）に開放されているため
 * （v13 §5.11.7 ①）、ここで見るのはファイルの属性だけである。
 * 「誰が投稿したことにするか」は RLS（`media_assets_insert_self`）が本人に固定する。
 */
export function decideUploadPolicy(request: UploadRequest): UploadPolicyDecision {
  const rule = ALLOWED_CONTENT_TYPES[request.contentType];
  if (rule === undefined) {
    return {
      accepted: false,
      rejectionReason: `この形式（${request.contentType}）はアップロードできません。`,
    };
  }

  const normalizedPurposeTags = normalizePurposeTags(request.purposeTags);
  if (normalizedPurposeTags.length === 0) {
    // 用途タグを任意にしない（v13 §5.11.3 note「後から遡って付け直すことは実質不可能」）。
    return { accepted: false, rejectionReason: "用途タグを1つ以上選んでください。" };
  }
  if (normalizedPurposeTags.length > MAX_PURPOSE_TAGS) {
    return {
      accepted: false,
      rejectionReason: `用途タグは ${MAX_PURPOSE_TAGS} 個までです。`,
    };
  }
  if (normalizedPurposeTags.some((tag) => tag.length > MAX_PURPOSE_TAG_LENGTH)) {
    return {
      accepted: false,
      rejectionReason: `用途タグは1つ ${MAX_PURPOSE_TAG_LENGTH} 文字までです。`,
    };
  }

  const declaredSizeBytes = request.declaredSizeBytes;
  if (declaredSizeBytes !== undefined) {
    if (!Number.isInteger(declaredSizeBytes) || declaredSizeBytes <= 0) {
      return { accepted: false, rejectionReason: "ファイルサイズの申告が不正です。" };
    }
    if (declaredSizeBytes > rule.maxBytes) {
      return {
        accepted: false,
        rejectionReason: `ファイルが大きすぎます（上限 ${formatMegabytes(rule.maxBytes)}）。`,
      };
    }
  }

  return {
    accepted: true,
    mediaType: rule.mediaType,
    extension: rule.extension,
    maxBytes: rule.maxBytes,
    normalizedPurposeTags,
  };
}

function normalizePurposeTags(purposeTags: readonly string[]): string[] {
  const trimmed = purposeTags.map((tag) => tag.trim()).filter((tag) => tag !== "");
  return [...new Set(trimmed)];
}

function formatMegabytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)}MB`;
}

/**
 * ストレージ上のオブジェクト名を組み立てる。
 *
 * ## なぜ会員IDをパスに入れないのか
 *
 * 署名付きURLは失効までURLを知る者なら誰でも開ける（v13 §5.11.2 トレードオフ）。
 * パスに会員IDを入れると、URL が1本漏れただけで「誰の投稿か」まで漏れる。
 * 投稿者は `media_assets.member_id` が持っており、そちらは RLS で守られる。
 *
 * 年月で分けているのは、ライフサイクルルール（v13 §5.11.4）を接頭辞で当てやすくするため。
 */
export function buildMediaObjectName(params: {
  mediaId: string;
  extension: string;
  uploadedAt: Date;
}): string {
  const year = params.uploadedAt.getUTCFullYear();
  const month = String(params.uploadedAt.getUTCMonth() + 1).padStart(2, "0");
  return `media/${year}/${month}/${params.mediaId}.${params.extension}`;
}

/**
 * 撮影メタデータ（Exif 由来）の受け入れ判定。
 *
 * ## クライアントから来る値であることを忘れない
 *
 * 撮影日時・位置は**画面が Exif から読んで送ってくる**（`src/lib/media/exif.ts`）。
 * つまり利用者が自由に差し替えられる値であり、サーバは形だけを検証して受ける。
 * 「この写真は本当にその場所で撮られた」ことの保証ではない——そこまでを保証する手段は
 * Phase 1 には無く、保証したかのように扱わないことが重要である。
 *
 * ## 形が違うものは 400 ではなく `null` にする
 *
 * 撮影メタデータは**あれば便利な補助情報**であり、アップロードの成否を左右しない。
 * 端末や画像編集アプリによって Exif の書き方は揺れるので、読めない値でアップロードを
 * 失敗させると、利用者には「なぜか写真が上げられない」としか見えない。
 */
export type CaptureMetadata = { takenAt: string | null; geoLocation: string | null };

/** `"35.681200,139.767050"` の形。緯度は ±90、経度は ±180 の範囲。 */
const GEO_LOCATION_PATTERN = /^-?\d{1,3}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$/;

export function normalizeCaptureMetadata(input: {
  takenAt?: unknown;
  geoLocation?: unknown;
}): CaptureMetadata {
  return {
    takenAt: normalizeTakenAt(input.takenAt),
    geoLocation: normalizeGeoLocation(input.geoLocation),
  };
}

function normalizeTakenAt(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // 未来の日時は撮影日時として成立しない（端末の時計ずれ・改変）。
  // 1日分の余裕を持たせるのは、タイムゾーンのずれた端末を弾きすぎないため。
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  return parsed.getTime() > tomorrow ? null : parsed.toISOString();
}

function normalizeGeoLocation(value: unknown): string | null {
  if (typeof value !== "string" || !GEO_LOCATION_PATTERN.test(value.trim())) {
    return null;
  }
  const [latitude, longitude] = value.trim().split(",").map(Number);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}
