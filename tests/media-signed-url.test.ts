// WBS 1-4（署名付きURL基盤）の受入テスト。
//
// 根拠: v13 §5.11.2 ①⑥（V4署名・PUT 10分／GET 5分・contentType 固定）・
//       §5.11.5（x-goog-content-length-range でストレージ側が上限を強制する）、
//       Issue #18 完了条件 B。
//
// ⚠️ 実鍵は使わない。テストの中で RSA 鍵ペアを生成し、署名 → 検証まで往復させる
//    （CLAUDE.md §3.1：鍵をリポジトリへ置かない）。

import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

import { createSignedUploadUrl, createSignedViewUrl } from "@/lib/media/signed-url";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const SERVICE_ACCOUNT = {
  clientEmail: "media-signer@example-project.iam.gserviceaccount.com",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

const BUCKET = "fuyuugai-media-private";
const OBJECT = "media/2026/09/11111111-2222-4333-8444-555555555555.jpg";
/** 署名が日時に依存するため、時刻を固定して比較可能にする。 */
const SIGNED_AT = new Date("2026-09-22T07:00:00.000Z");

function signUploadUrl(overrides: { maxBytes?: number; ttlMinutes?: number } = {}) {
  return createSignedUploadUrl({
    bucketName: BUCKET,
    objectName: OBJECT,
    contentType: "image/jpeg",
    maxBytes: overrides.maxBytes ?? 20 * 1024 * 1024,
    ttlMinutes: overrides.ttlMinutes ?? 10,
    serviceAccount: SERVICE_ACCOUNT,
    signedAt: SIGNED_AT,
  });
}

/** 発行されたURLのクエリを取り出す。 */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("アップロード用の署名付きURL（v13 §5.11.2 ①）", () => {
  test("V4 署名アルゴリズムで発行される", () => {
    expect(queryOf(signUploadUrl().url).get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
  });

  test("メソッドは PUT である", () => {
    expect(signUploadUrl().method).toBe("PUT");
  });

  test("有効期限は 10 分（600秒）である", () => {
    expect(queryOf(signUploadUrl().url).get("X-Goog-Expires")).toBe("600");
  });

  test("失効時刻は署名時刻 ＋ TTL である", () => {
    expect(signUploadUrl().expiresAt.toISOString()).toBe("2026-09-22T07:10:00.000Z");
  });

  test("★ contentType が署名対象ヘッダに固定される（v13 §5.11.5）", () => {
    expect(queryOf(signUploadUrl().url).get("X-Goog-SignedHeaders")).toContain("content-type");
  });

  test("★ x-goog-content-length-range が署名対象ヘッダに入る（v13 §5.11.5）", () => {
    expect(queryOf(signUploadUrl().url).get("X-Goog-SignedHeaders")).toContain(
      "x-goog-content-length-range",
    );
  });

  test("上限バイト数が content-length-range の上側に入る", () => {
    expect(signUploadUrl({ maxBytes: 12345 }).requiredHeaders["x-goog-content-length-range"]).toBe(
      "1,12345",
    );
  });

  test("0 バイトのオブジェクトは通らない（下限が 1 である）", () => {
    const range = signUploadUrl().requiredHeaders["x-goog-content-length-range"];
    expect(range.startsWith("1,")).toBe(true);
  });

  test("クライアントが付けるべきヘッダとして contentType を返す", () => {
    expect(signUploadUrl().requiredHeaders["content-type"]).toBe("image/jpeg");
  });

  test("host は自動で付くヘッダのため要求ヘッダには含めない", () => {
    expect(signUploadUrl().requiredHeaders.host).toBeUndefined();
  });

  test("資格情報のスコープが storage の goog4_request である", () => {
    expect(queryOf(signUploadUrl().url).get("X-Goog-Credential")).toBe(
      `${SERVICE_ACCOUNT.clientEmail}/20260922/auto/storage/goog4_request`,
    );
  });

  test("発行先はバケットとオブジェクトのパスである", () => {
    expect(new URL(signUploadUrl().url).pathname).toBe(`/${BUCKET}/${OBJECT}`);
  });

  test("★ 秘密鍵がURLへ混ざらない", () => {
    expect(signUploadUrl().url).not.toContain("PRIVATE KEY");
  });

  test("同じ入力なら同じ署名になる（署名対象が時刻以外でぶれない）", () => {
    expect(signUploadUrl().url).toBe(signUploadUrl().url);
  });

  test("上限が変われば署名も変わる（上限が署名に効いている）", () => {
    expect(signUploadUrl({ maxBytes: 100 }).url).not.toBe(signUploadUrl({ maxBytes: 200 }).url);
  });
});

describe("署名そのものの検証（公開鍵で戻せること）", () => {
  /**
   * Google の V4 署名手順どおりに署名対象文字列を組み立て直し、公開鍵で検証する。
   * 実装が同じ文字列に署名していれば通る。**署名手順の写経ではなく往復での確認**である。
   */
  test("公開鍵で署名を検証できる", () => {
    const signed = signUploadUrl();
    const url = new URL(signed.url);
    const signature = url.searchParams.get("X-Goog-Signature") ?? "";

    // 署名対象のクエリは X-Goog-Signature を除いた部分（発行時の並びをそのまま使う）。
    const canonicalQueryString = url.search.slice(1).replace(`&X-Goog-Signature=${signature}`, "");

    const canonicalRequest = [
      "PUT",
      url.pathname,
      canonicalQueryString,
      "content-type:image/jpeg\n" +
        `host:storage.googleapis.com\n` +
        `x-goog-content-length-range:${signed.requiredHeaders["x-goog-content-length-range"]}\n`,
      "content-type;host;x-goog-content-length-range",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "GOOG4-RSA-SHA256",
      "20260922T070000Z",
      "20260922/auto/storage/goog4_request",
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const isValid = createVerify("RSA-SHA256")
      .update(stringToSign)
      .verify(publicKey, Buffer.from(signature, "hex"));

    expect(isValid).toBe(true);
  });
});

describe("閲覧用の署名付きURL（v13 §5.11.2 ⑥）", () => {
  function signViewUrl(ttlMinutes: number) {
    return createSignedViewUrl({
      bucketName: BUCKET,
      objectName: OBJECT,
      ttlMinutes,
      serviceAccount: SERVICE_ACCOUNT,
      signedAt: SIGNED_AT,
    });
  }

  test("メソッドは GET である", () => {
    expect(signViewUrl(5).method).toBe("GET");
  });

  test("通常の閲覧は 5 分（300秒）である", () => {
    expect(queryOf(signViewUrl(5).url).get("X-Goog-Expires")).toBe("300");
  });

  test("内部専用は 2 分（120秒）である", () => {
    expect(queryOf(signViewUrl(2).url).get("X-Goog-Expires")).toBe("120");
  });

  test("閲覧には contentType を固定しない（署名対象は host だけ）", () => {
    expect(queryOf(signViewUrl(5).url).get("X-Goog-SignedHeaders")).toBe("host");
  });
});

describe("有効期限の歯止め", () => {
  test("0 分は発行できない", () => {
    expect(() => signUploadUrl({ ttlMinutes: 0 })).toThrow("有効期限");
  });

  test("V4 の上限（7日）を超える指定は発行できない", () => {
    expect(() => signUploadUrl({ ttlMinutes: 7 * 24 * 60 + 1 })).toThrow("有効期限");
  });
});

describe("オブジェクト名のエンコード", () => {
  test("パスの区切りは残したままセグメントだけをエンコードする", () => {
    const signed = createSignedViewUrl({
      bucketName: BUCKET,
      objectName: "media/2026/09/名前 付き.jpg",
      ttlMinutes: 5,
      serviceAccount: SERVICE_ACCOUNT,
      signedAt: SIGNED_AT,
    });
    expect(new URL(signed.url).pathname).toBe(
      `/${BUCKET}/media/2026/09/${encodeURIComponent("名前 付き.jpg")}`,
    );
  });
});
