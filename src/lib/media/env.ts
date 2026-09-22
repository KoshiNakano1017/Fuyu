/**
 * メディア基盤（Cloud Storage）の接続情報を環境変数から取り出す。
 *
 * `src/lib/supabase/env.ts` と同じ方針で、値をモジュールのトップレベル定数にせず
 * 関数にしている。未設定のときの失敗を import 時ではなく利用時に起こし、
 * エラーの発生箇所を呼び出し元へ寄せるため。
 *
 * ⚠️ ここで扱う `GCP_SERVICE_ACCOUNT_JSON` は**署名鍵そのもの**である（CLAUDE.md §3.1）。
 *    - `NEXT_PUBLIC_` を付けない。付けた時点でブラウザへ配信される
 *    - 例外メッセージ・ログへ中身を出さない。出すのは「未設定である」という事実だけ
 */

function requireEnvValue(value: string | undefined, variableName: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `環境変数 ${variableName} が未設定です。.env.example を参照して .env を用意してください。` +
        "GCS バケットとサービスアカウントの作成は WBS 1-4（scripts/gcp/setup-media-bucket.sh）です。",
    );
  }
  return value;
}

/** メディア実体を置くバケット。**公開バケットは使わない**（v13 §5.11.2 不可侵ルール3）。 */
export function readMediaBucketName(): string {
  return requireEnvValue(process.env.GCS_BUCKET_PRIVATE, "GCS_BUCKET_PRIVATE");
}

/** 署名に使うサービスアカウント。メディア用バケット専用の鍵である（Issue #18 完了条件 C）。 */
export type MediaServiceAccount = {
  clientEmail: string;
  /** PEM 形式の秘密鍵。**ログ・レスポンス・例外メッセージへ出さない。** */
  privateKeyPem: string;
};

/**
 * サービスアカウント鍵を読む。
 *
 * 鍵は JSON ファイルを置かず、**中身を環境変数へ入れる**（`.env.example` の指示）。
 * ファイルとして置くと、デプロイ対象に混ざる・誤ってコミットされる経路が増えるため。
 */
export function readMediaServiceAccount(): MediaServiceAccount {
  const rawJson = requireEnvValue(
    process.env.GCP_SERVICE_ACCOUNT_JSON,
    "GCP_SERVICE_ACCOUNT_JSON",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // ⚠️ 原因を示すために値の一部を添えたくなるが、**鍵の断片も出さない**。
    throw new Error(
      "環境変数 GCP_SERVICE_ACCOUNT_JSON が JSON として解釈できません。" +
        "サービスアカウント鍵の JSON をそのまま1行で設定してください。",
    );
  }

  const candidate = parsed as { client_email?: unknown; private_key?: unknown };
  const clientEmail = candidate.client_email;
  const privateKey = candidate.private_key;

  if (typeof clientEmail !== "string" || clientEmail === "") {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON に client_email がありません。");
  }
  if (typeof privateKey !== "string" || privateKey === "") {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON に private_key がありません。");
  }

  return {
    clientEmail,
    // 環境変数へ1行で入れると改行が `\n` の2文字になる。PEM は改行が意味を持つため戻す。
    privateKeyPem: privateKey.replace(/\\n/g, "\n"),
  };
}

/**
 * 署名付きURLの有効期限（分）。**値は v13 §5.11.2 ⑥ の決定値**であり、
 * 環境変数は「仕様上の定数を運用で一時的に絞る」ためだけの上書き口である
 * （`.env.example` の注記「実値ではなく仕様上の定数のため、ここに書いてよい」）。
 *
 * 既定値をコード側に置いているのは、**環境変数が無い環境で TTL が伸びないようにする**ため。
 * 未設定時に長い既定へ倒れると、URL の流出被害が設定漏れで拡大する（§5.11.2 トレードオフ）。
 */
export const SIGNED_URL_TTL_SPEC_MIN = {
  /** アップロード（PUT）。v13 §5.11.2 ① */
  upload: 10,
  /** 閲覧（GET）。v13 §5.11.2 ⑥ */
  view: 5,
  /** 内部専用ナレッジの添付。v13 §5.11.2 ⑥「さらに短く」 */
  internal: 2,
} as const;

/** TTL の上限。仕様値より長い設定を環境変数から流し込めないようにする歯止め。 */
const TTL_CEILING_MIN = 60;

function readTtlMinutes(rawValue: string | undefined, specDefaultMin: number): number {
  if (rawValue === undefined || rawValue === "") {
    return specDefaultMin;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > TTL_CEILING_MIN) {
    throw new Error(
      `署名付きURLの有効期限は 1〜${TTL_CEILING_MIN} 分の整数で指定してください（受け取った値: ${rawValue}）。`,
    );
  }
  return parsed;
}

export function readUploadUrlTtlMinutes(): number {
  return readTtlMinutes(process.env.SIGNED_URL_UPLOAD_TTL_MIN, SIGNED_URL_TTL_SPEC_MIN.upload);
}

export function readViewUrlTtlMinutes(): number {
  return readTtlMinutes(process.env.SIGNED_URL_VIEW_TTL_MIN, SIGNED_URL_TTL_SPEC_MIN.view);
}

export function readInternalViewUrlTtlMinutes(): number {
  return readTtlMinutes(
    process.env.SIGNED_URL_INTERNAL_KNOWLEDGE_TTL_MIN,
    SIGNED_URL_TTL_SPEC_MIN.internal,
  );
}
