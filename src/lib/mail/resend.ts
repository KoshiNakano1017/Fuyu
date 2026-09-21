// メール送信（Resend）。WBS 3-5b（公開予約ページの OTP）。
//
// ── 送信基盤は1つ、呼び出し側は2つ ──────────────────────────────────
//
// v13 §5.2.6 の決着表が「OTP の送信基盤は **Resend** ／ **送信基盤を新設しない**」と
// 定めている（`QUESTIONS.md` 2026-09-10 決着）。同じ Resend アカウント・同じ送信ドメインを、
// 次の2経路が使う。**設定箇所だけが分かれる。**
//
//   ① 会員ログインの6桁OTP・招待リンク（経路B）
//      → Supabase Auth (GoTrue) の機能。Supabase ダッシュボードの
//        Authentication → SMTP Settings に Resend の SMTP 資格情報を入れる（WBS 1-1e）。
//        **このモジュールは通らない。**
//   ② 公開予約ページ `/reserve` の本人確認OTP（ここ）
//      → 未ログインでアカウントも作らない導線のため Auth を使えない。
//        アプリから Resend の HTTP API を直接叩く。
//
// ⚠️ 本文にコードを載せる。**ログには載せない**（CLAUDE.md §3.2）。
//    メールアドレスもログへ出さない（`user_id` は可、`email` は不可）。

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
 * 予約の本人確認コードを送る。
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
