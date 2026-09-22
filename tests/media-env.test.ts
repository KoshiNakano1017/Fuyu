// メディア基盤の環境変数の読み出し（WBS 1-4）。
//
// 根拠: v13 §5.11.2 ①⑥（TTL の決定値）、CLAUDE.md §3.1・§3.2（鍵を露出させない）。

import {
  readInternalViewUrlTtlMinutes,
  readMediaBucketName,
  readMediaServiceAccount,
  readUploadUrlTtlMinutes,
  readViewUrlTtlMinutes,
  SIGNED_URL_TTL_SPEC_MIN,
} from "@/lib/media/env";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("バケット名", () => {
  test("環境変数が設定されていればその値を返す", () => {
    process.env.GCS_BUCKET_PRIVATE = "fuyuugai-media-private";
    expect(readMediaBucketName()).toBe("fuyuugai-media-private");
  });

  test("未設定なら変数名を含む例外を投げる", () => {
    delete process.env.GCS_BUCKET_PRIVATE;
    expect(() => readMediaBucketName()).toThrow("GCS_BUCKET_PRIVATE");
  });
});

describe("サービスアカウント鍵", () => {
  // ⚠️ PEM の見出し行（`-----BEGIN ...`）をテストへ**書かない**。
  //    中身は架空でも、秘密情報スキャン（gitleaks／CLAUDE.md §3.3）が鍵の混入として
  //    検出してコミットを止める。ここで確かめたいのは改行の復元だけなので、
  //    改行を含む適当な文字列で足りる。
  const validKeyJson = JSON.stringify({
    client_email: "media-signer@example-project.iam.gserviceaccount.com",
    private_key: "1行目\\n2行目\\n",
  });

  test("client_email を取り出す", () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON = validKeyJson;
    expect(readMediaServiceAccount().clientEmail).toBe(
      "media-signer@example-project.iam.gserviceaccount.com",
    );
  });

  test("★ 1行で入れた鍵の改行（\\n の2文字）を実際の改行へ戻す", () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON = validKeyJson;
    expect(readMediaServiceAccount().privateKeyPem).toBe("1行目\n2行目\n");
  });

  test("未設定なら変数名を含む例外を投げる", () => {
    delete process.env.GCP_SERVICE_ACCOUNT_JSON;
    expect(() => readMediaServiceAccount()).toThrow("GCP_SERVICE_ACCOUNT_JSON");
  });

  test("JSON として壊れていれば例外を投げる", () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON = "{壊れている";
    expect(() => readMediaServiceAccount()).toThrow("JSON");
  });

  test("★ 壊れた鍵の例外メッセージに値の中身を含めない（CLAUDE.md §3.2）", () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON = "{秘密の断片";
    expect(() => readMediaServiceAccount()).not.toThrow("秘密の断片");
  });

  test("private_key が欠けていれば例外を投げる", () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "a@example.invalid" });
    expect(() => readMediaServiceAccount()).toThrow("private_key");
  });
});

describe("署名付きURLの有効期限（v13 §5.11.2 ⑥）", () => {
  test("アップロードの既定は 10 分", () => {
    delete process.env.SIGNED_URL_UPLOAD_TTL_MIN;
    expect(readUploadUrlTtlMinutes()).toBe(10);
  });

  test("閲覧の既定は 5 分", () => {
    delete process.env.SIGNED_URL_VIEW_TTL_MIN;
    expect(readViewUrlTtlMinutes()).toBe(5);
  });

  test("内部専用の既定は 2 分", () => {
    delete process.env.SIGNED_URL_INTERNAL_KNOWLEDGE_TTL_MIN;
    expect(readInternalViewUrlTtlMinutes()).toBe(2);
  });

  test("既定値は仕様値の表と一致する", () => {
    expect(SIGNED_URL_TTL_SPEC_MIN).toEqual({ upload: 10, view: 5, internal: 2 });
  });

  test("環境変数で短くできる", () => {
    process.env.SIGNED_URL_VIEW_TTL_MIN = "3";
    expect(readViewUrlTtlMinutes()).toBe(3);
  });

  test("★ 歯止め（60分）を超える指定は例外にする（設定ミスで TTL が伸びない）", () => {
    process.env.SIGNED_URL_VIEW_TTL_MIN = "1440";
    expect(() => readViewUrlTtlMinutes()).toThrow("有効期限");
  });

  test("0 分は指定できない", () => {
    process.env.SIGNED_URL_UPLOAD_TTL_MIN = "0";
    expect(() => readUploadUrlTtlMinutes()).toThrow("有効期限");
  });

  test("数値でない指定は例外にする", () => {
    process.env.SIGNED_URL_UPLOAD_TTL_MIN = "ten";
    expect(() => readUploadUrlTtlMinutes()).toThrow("有効期限");
  });
});
