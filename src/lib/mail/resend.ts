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
 * `非機能要件詳細.md` §2-6 の 2026-09-10 注記のとおり、送信経路は2つに分かれる。
 *
 * | 経路 | 実装 | Resend の配線先 |
 * | --- | --- | --- |
 * | ログイン／サインアップの OTP | Supabase Auth（GoTrue） | **ダッシュボードの SMTP 設定** |
 * | **招待（経路B）の案内・公開予約OTP** | **アプリ側** | **このモジュール（HTTP API）** |
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
 * プレーンテキストのメールを1通送る。
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
