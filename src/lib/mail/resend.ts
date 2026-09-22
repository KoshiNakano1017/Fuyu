/**
 * Resend（メール送信基盤）の最小クライアント。
 *
 * ## なぜ SDK を入れないのか
 *
 * 送るのは**プレーンテキスト1通**だけであり、HTTP API を1回叩けば足りる。
 * 依存を1つ増やすと、Vercel のバンドルとサプライチェーンの監査対象も増える。
 *
 * ## 2系統あるメール経路のうち「アプリ側」がここ
 *
 * `非機能要件詳細.md` §2-6 の 2026-09-10 注記・v13 §5.2.6 の決着表のとおり、送信経路は2つに分かれる。
 * 同じ Resend アカウント・同じ送信ドメインを、次の2経路が使う。**設定箇所だけが分かれる。**
 *
 * | 経路 | 実装 | Resend の配線先 |
 * | --- | --- | --- |
 * | ログイン／サインアップの6桁OTP | Supabase Auth（GoTrue） | **ダッシュボードの SMTP 設定**（このモジュールは通らない） |
 * | **招待（経路B）の案内**（`sendPlainTextEmail`） | アプリ側 | このモジュール（HTTP API） |
 * | **公開予約ページ `/reserve` の本人確認OTP**（`sendReservationOtpMail`） | アプリ側 | このモジュール（HTTP API） |
 *
 * 取り違えると「設定したのに飛ばない」の原因が分からなくなる。
 *
 * ⚠️ **本文にログイン用のリンク・トークンを入れないこと**（v13 §5.2.6 ／ 決定ログ §20-1・§22-1）。
 * 認証はすべて6桁コードに寄せてあり、URL を載せる場所はログイン画面の案内までである。
 *
 * ⚠️ **宛先アドレスをログへ出さない**（CLAUDE.md §3.2）。失敗時も理由だけを返す。
 */

/** 送信元。`fuyugai.jp` は Resend 側で SPF/DKIM を通したドメイン（`非機能要件詳細.md` §2-6）。 */
const DEFAULT_FROM_ADDRESS = "浮遊街アプリ <no-reply@fuyugai.jp>";

export type MailResult = { ok: true } | { ok: false; reason: "not_configured" | "send_failed" };

/**
 * プレーンテキストのメールを1通送る（招待メール等の汎用送信）。
 *
 * `not_configured` を `send_failed` と分けているのは、**運営が自力で直せるかどうかが違う**ため。
 * 未設定はオーナーが API キーを入れれば直り、送信失敗は時間をおく以外にできることがない。
 * 呼び出し元はこの差を画面の文言へそのまま出す。
 */
export async function sendPlainTextEmail(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return { ok: false, reason: "not_configured" };
  }

  const from = process.env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        text: params.body,
      }),
    });

    if (!response.ok) {
      // ⚠️ レスポンス本文をそのままログへ出さない。宛先が含まれることがある。
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true };
  } catch {
    // ネットワーク断・タイムアウト。理由を潰して返す（呼び出し元の分岐は同じ）。
    return { ok: false, reason: "send_failed" };
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function requireEnvValue(value: string | undefined, variableName: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `環境変数 ${variableName} が未設定です。.env.example を参照してください。` +
        "Resend の API キーと送信元アドレスは、送信ドメインの DNS 認証を済ませてから取得します。",
    );
  }
  return value;
}

export type SendMailResult = { ok: true } | { ok: false; reason: "not_configured" | "failed" };

/**
 * 予約の本人確認コードを送る（公開予約ページ `/reserve` 専用・WBS 3-5b）。
 *
 * 失敗の詳細（Resend の応答本文）を戻り値に含めない。呼び出し元が画面へ流すと、
 * 送信基盤の構成が利用者に見える。記録が要るときは Vercel の Runtime Logs へ
 * **ステータスコードだけ**を出す。
 */
export async function sendReservationOtpMail(params: {
  to: string;
  code: string;
  expiryMinutes: number;
}): Promise<SendMailResult> {
  let apiKey: string;
  let from: string;
  try {
    apiKey = requireEnvValue(process.env.RESEND_API_KEY, "RESEND_API_KEY");
    from = requireEnvValue(process.env.RESEND_FROM_EMAIL, "RESEND_FROM_EMAIL");
  } catch {
    // 未設定は「送れない」であって「送って失敗した」ではない。呼び出し側が文面を変えられるよう分ける
    console.error("[reserve] Resend が未設定のため本人確認コードを送信できません");
    return { ok: false, reason: "not_configured" };
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: "【浮遊街】宿泊予約の確認コード",
      text: [
        "浮遊街の宿泊予約を受け付けています。",
        "",
        `確認コード: ${params.code}`,
        "",
        `このコードは ${params.expiryMinutes} 分で使えなくなります。`,
        "お心当たりがない場合は、このメールを破棄してください。",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    // 本文は出さない。宛先も出さない（CLAUDE.md §3.2）
    console.error(`[reserve] 本人確認コードの送信に失敗しました（HTTP ${response.status}）`);
    return { ok: false, reason: "failed" };
  }
  return { ok: true };
}
