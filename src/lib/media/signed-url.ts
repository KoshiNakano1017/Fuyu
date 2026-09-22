import { createHash, createSign } from "node:crypto";

import type { MediaServiceAccount } from "./env";

/**
 * Cloud Storage の V4 署名付きURLを組み立てる（v13 §5.11.2 ①⑥）。
 *
 * ## なぜ `@google-cloud/storage` を入れないのか
 *
 * 必要なのは「1本のURLへ署名する」ことだけで、SDK が持つバケット操作・再試行・
 * ストリーミングは一切使わない。この1機能のために数十MBの依存を Vercel の関数へ載せると、
 * コールドスタートと監査対象が増える。署名そのものは RSA-SHA256 と正規化された文字列の
 * 組み立てだけで完結し、鍵の取り回しも `node:crypto` で足りる。
 *
 * その代わり**仕様どおりであることをテストで固定する**（`tests/media-signed-url.test.ts`）。
 * 実鍵を使わずに鍵ペアを生成して署名・検証まで往復させ、署名対象の文字列が
 * Google の定める正規化リクエストと一致することを確かめている。
 *
 * ## 参照した仕様
 *
 * Google Cloud Storage の「V4 署名プロセス」。要点は次の3つ。
 *   1. 正規化リクエスト（メソッド・パス・クエリ・ヘッダ・署名対象ヘッダ・ペイロード）
 *   2. 署名文字列（アルゴリズム・日時・スコープ・正規化リクエストの SHA-256）
 *   3. 署名を16進小文字で `X-Goog-Signature` としてクエリへ足す
 */

const GCS_HOST = "storage.googleapis.com";
const SIGNING_ALGORITHM = "GOOG4-RSA-SHA256";

/** 署名付きURLではペイロードのハッシュを取らない（本体は後から PUT されるため）。 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** V4 署名の有効期限の上限は7日。仕様値（10分・5分・2分）はこれを大きく下回る。 */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SignedUrl = {
  url: string;
  method: "PUT" | "GET";
  /**
   * クライアントがそのまま付けて送らなければならないヘッダ。
   * **1つでも欠けるか値が違うと署名が一致せず、ストレージ側が拒否する。**
   * これが v13 §5.11.5 の「クライアント側検証のみに依存しない」の実体である。
   */
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
};

/**
 * アップロード用の署名付きURL（PUT）。
 *
 * `contentType` と `x-goog-content-length-range` を**署名に焼き込む**ため、
 * 署名時と違う形式・上限超過のファイルはストレージ側で拒否される（v13 §5.11.5）。
 */
export function createSignedUploadUrl(params: {
  bucketName: string;
  objectName: string;
  contentType: string;
  maxBytes: number;
  ttlMinutes: number;
  serviceAccount: MediaServiceAccount;
  signedAt: Date;
}): SignedUrl {
  // 下限を 1 にしているのは、0 バイトのオブジェクトで枠だけ埋める投稿を弾くため。
  const contentLengthRange = `1,${params.maxBytes}`;

  return buildSignedUrl({
    method: "PUT",
    bucketName: params.bucketName,
    objectName: params.objectName,
    headers: {
      host: GCS_HOST,
      "content-type": params.contentType,
      "x-goog-content-length-range": contentLengthRange,
    },
    ttlMinutes: params.ttlMinutes,
    serviceAccount: params.serviceAccount,
    signedAt: params.signedAt,
  });
}

/** 閲覧用の署名付きURL（GET）。TTL は呼び出し側が公開範囲に応じて決める（v13 §5.11.2 ⑥）。 */
export function createSignedViewUrl(params: {
  bucketName: string;
  objectName: string;
  ttlMinutes: number;
  serviceAccount: MediaServiceAccount;
  signedAt: Date;
}): SignedUrl {
  return buildSignedUrl({
    method: "GET",
    bucketName: params.bucketName,
    objectName: params.objectName,
    headers: { host: GCS_HOST },
    ttlMinutes: params.ttlMinutes,
    serviceAccount: params.serviceAccount,
    signedAt: params.signedAt,
  });
}

function buildSignedUrl(params: {
  method: "PUT" | "GET";
  bucketName: string;
  objectName: string;
  headers: Record<string, string>;
  ttlMinutes: number;
  serviceAccount: MediaServiceAccount;
  signedAt: Date;
}): SignedUrl {
  const ttlSeconds = params.ttlMinutes * 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`署名付きURLの有効期限が範囲外です（${params.ttlMinutes} 分）。`);
  }

  const timestamp = formatIso8601Basic(params.signedAt);
  const datestamp = timestamp.slice(0, 8);
  const credentialScope = `${datestamp}/auto/storage/goog4_request`;

  const canonicalHeaders = buildCanonicalHeaders(params.headers);
  const signedHeaders = buildSignedHeaderNames(params.headers);

  const canonicalQueryString = buildCanonicalQueryString({
    "X-Goog-Algorithm": SIGNING_ALGORITHM,
    "X-Goog-Credential": `${params.serviceAccount.clientEmail}/${credentialScope}`,
    "X-Goog-Date": timestamp,
    "X-Goog-Expires": String(ttlSeconds),
    "X-Goog-SignedHeaders": signedHeaders,
  });

  const resourcePath = buildResourcePath(params.bucketName, params.objectName);

  const canonicalRequest = [
    params.method,
    resourcePath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [
    SIGNING_ALGORITHM,
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createSign("RSA-SHA256")
    .update(stringToSign)
    .sign(params.serviceAccount.privateKeyPem, "hex");

  return {
    url: `https://${GCS_HOST}${resourcePath}?${canonicalQueryString}&X-Goog-Signature=${signature}`,
    method: params.method,
    requiredHeaders: withoutHostHeader(params.headers),
    expiresAt: new Date(params.signedAt.getTime() + ttlSeconds * 1000),
  };
}

/** `YYYYMMDD'T'HHMMSS'Z'`。秒より細かい桁は署名に使わない。 */
function formatIso8601Basic(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/** 各行は `名前:値\n`。名前は小文字、値は前後の空白を落として辞書順に並べる。 */
function buildCanonicalHeaders(headers: Record<string, string>): string {
  return sortedHeaderEntries(headers)
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
}

function buildSignedHeaderNames(headers: Record<string, string>): string {
  return sortedHeaderEntries(headers)
    .map(([name]) => name)
    .join(";");
}

function sortedHeaderEntries(headers: Record<string, string>): [string, string][] {
  return Object.entries(headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * `host` はクライアントが明示的に付けるヘッダではない（HTTP が自動で付ける）。
 * 署名対象には含めるが、呼び出し側へ「付けてください」と返す必要はない。
 */
function withoutHostHeader(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "host"));
}

/** クエリはエンコード済みの名前で辞書順に並べる。 */
function buildCanonicalQueryString(queryParams: Record<string, string>): string {
  return Object.entries(queryParams)
    .map(([name, value]): [string, string] => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** パスは区切りの `/` を残したまま、各セグメントをエンコードする。 */
function buildResourcePath(bucketName: string, objectName: string): string {
  const encodedObject = objectName.split("/").map(encodeRfc3986).join("/");
  return `/${encodeRfc3986(bucketName)}/${encodedObject}`;
}

/**
 * RFC 3986 のパーセントエンコード。
 * `encodeURIComponent` は `!'()*` を素通しするため、署名がずれないよう明示的に潰す。
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
