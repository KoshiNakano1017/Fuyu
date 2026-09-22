import type { SupabaseClient } from "@supabase/supabase-js";

import { readLoginUrl } from "@/lib/app-url";
import { sendPlainTextEmail } from "@/lib/mail/resend";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/**
 * 招待（経路B）の有効期限（時間）。
 *
 * **2026-09-15 の決定は当初72時間だったが、24時間へ訂正した。**
 * Supabase の Email OTP Expiration は招待リンクの期限も支配し、
 * **86,400秒（24時間）超はダッシュボードで設定できない**（Management API のみ）ため、
 * 72時間はそもそも実装できなかった。
 *
 * 24時間は「宛先を誤ったときの露出時間が最短」という理由で元々の推奨でもある。
 * 休日を挟んで開けない相手には**再送**で対応する（v13 §5.2.6 が再送を前提にしている）。
 *
 * ⚠️ **2026-09-22 のコード方式化（WBS `2-1d` ／ 決定ログ §22-1）以降、この値が支配するのは
 * 「初回ログインを許す窓」である。** 招待メールにリンクもコードも載らないため、
 * 期限が切れるのは「リンク」ではなく**台帳の行**であり、切れた時点で
 * そのアドレスは `auth.users` を作れなくなる（`hasUsableInvitation()`）。
 *
 * ⚠️ **値をここ1箇所に持つ。** 後から短くできるよう、各所へ直書きしないこと
 * （2026-09-15 オーナー指示の補償条件）。
 */
export const INVITATION_EXPIRY_HOURS = 24;

export type InviteResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_staff"
        | "member_not_found"
        | "already_active"
        | "mail_not_configured"
        | "failed";
    };

/**
 * 未消費かつ期限内の招待を1件返す（無ければ `null`）。
 *
 * **これが経路Bの関門そのものである。** 招待メールにはリンクもコードも載らないため、
 * 「招待されているか」を判定できる場所は台帳だけになった。判定は2箇所で使う。
 *
 * | 使う側 | 何のために |
 * | --- | --- |
 * | ログインのコード送信（`requestLoginCode`） | **招待済みのアドレスにだけ `auth.users` の新規作成を許す**（v13 §5.2.6 手順3・4） |
 * | 初回結合（`bindAuthUserToMember`） | どの会員へ結合するかを引く。結合後は `consumed_at` を入れる |
 *
 * ⚠️ `admin`（service_role）クライアントを渡すこと。`member_invitations` の
 * ポリシーは staff 限定であり、未ログインの相手の照会は RLS 越しには通らない。
 */
export async function findUsableInvitation(
  admin: SupabaseClient,
  email: string,
): Promise<{ invitationId: string; memberId: string } | null> {
  const invitation = await admin
    .from("member_invitations")
    .select("invitation_id, member_id")
    .eq("sent_to_email", email)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!invitation.data) {
    return null;
  }
  return {
    invitationId: invitation.data.invitation_id as string,
    memberId: invitation.data.member_id as string,
  };
}

/** そのアドレスが「いま」ログインを始めてよいか。`requestLoginCode` の判断材料。 */
export async function hasUsableInvitation(email: string): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  return (await findUsableInvitation(admin, email)) !== null;
}

/** 招待の案内メール。**リンクもコードも載せない**（載せてよい URL はログイン画面だけ）。 */
function buildInvitationMail(): { subject: string; body: string } {
  return {
    subject: "【浮遊街】アプリのアカウント登録のご案内",
    body: [
      "浮遊街アプリのアカウント登録のご案内です。",
      "",
      "下のログイン画面を開き、このメールが届いたメールアドレスを入力してください。",
      "入力すると6桁の確認コードが届きますので、そのコードを画面に入れるとログインできます。",
      "",
      `ログイン画面: ${readLoginUrl()}`,
      "",
      `※ このご案内は約${INVITATION_EXPIRY_HOURS}時間で無効になります。`,
      "　 期限が過ぎた場合は、お手数ですが運営へ再送をご依頼ください。",
      "※ パスワードはありません。毎回このメールアドレスに確認コードをお送りします。",
      "※ このメールに心当たりがない場合は、開かずに破棄してください。",
    ].join("\n"),
  };
}

/**
 * 経路B：運営が個別にアカウント登録の案内を送る（v13 §5.2.6）。
 *
 * ## ⚠️ リンクもコードも送らない（WBS `2-1d` ／ 決定ログ §22-1 ／ 2026-09-22 オーナー決定）
 *
 * 以前は `admin.auth.admin.inviteUserByEmail()` を呼び、Supabase の招待リンクを飛ばしていた。
 * リンクの戻り先は Site URL（アプリのトップ）で、**アプリに受け口（`/auth/callback`）が無く、
 * 踏んでもログイン状態にならなかった**（2026-09-21 実測）。
 *
 * 受け口を新設する案は、**2026-09-21 決定「認証メールからサインインリンクを消す」**
 * （決定ログ §20-1）と正面から衝突する。そこで招待もコード方式へ寄せた。
 * 結果として**リンクが全経路から消え、Site URL / Redirect URLs がどの経路にも影響しなくなる**。
 *
 * ## 何が起きるか（v13 §5.2.6 経路B 手順1〜2）
 *
 * 1. 台帳（`member_invitations`）へ記録する — 誰が・いつ・どの会員へ・どのアドレスへ
 * 2. そのアドレスへ**ログイン画面の案内メール**を送る（送信基盤は Resend ／ アプリ側の HTTP API）
 *
 * 続く手順3〜5（会員がログイン画面で6桁コードを受け取り、`auth.users` が作られ、
 * 台帳の宛先と一致することを確認して `members.auth_user_id` へ結合する）は
 * `src/app/login/actions.ts` と `src/lib/auth/binding.ts` の担当である。
 *
 * ## 呼び出し側の責務
 *
 * **この関数は認可をしない。** 呼び出し元（Server Action）が `viewerIsStaff()` で
 * 判定してから呼ぶこと。ここで認可まで持つと、「認可済みの文脈から呼ぶ」以外の
 * 使い方ができなくなり、テストが書きにくくなる。
 *
 * ## v13 §5.2.6 の danger が必須とする4項目
 *
 * | 要件 | どこで満たすか |
 * | --- | --- |
 * | 送信を `admin`/`core_member` に限定 | 呼び出し元の `viewerIsStaff()`（サーバサイド） |
 * | 誰が・いつ・どの会員へ・どのアドレスへ | `member_invitations` の行 |
 * | 有効期限 | `expires_at`（24時間） |
 * | **`active` な会員には送れない** | 下記の検査 |
 *
 * 最後の1つが乗っ取り経路を塞ぐ。既に使えているアカウントへ招待を送れると、
 * 運営権限を持つ者が任意のアドレスで他人のアカウントへ入れてしまう。
 * **送達手段を変えてもこの4項目は1つも緩めていない**（§22-1 理由③）。
 */
export async function sendInvitation(params: {
  memberId: string;
  email: string;
  sentByMemberId: string;
}): Promise<InviteResult> {
  const { memberId, email, sentByMemberId } = params;
  const admin = createAdminSupabaseClient();

  const target = await admin
    .from("members")
    .select("member_id, account_status")
    .eq("member_id", memberId)
    .maybeSingle();

  if (!target.data) {
    return { ok: false, reason: "member_not_found" };
  }

  // ★ 乗っ取り経路を塞ぐ（v13 §5.2.6 経路B danger 第4項）
  if (target.data.account_status === "active") {
    return { ok: false, reason: "already_active" };
  }

  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000);

  // 監査記録を**先に**残す。メール送信が成功してから記録すると、
  // 送信済みなのに記録が無い状態（＝追跡できない誤送信）が生まれうる。
  const recorded = await admin.from("member_invitations").insert({
    member_id: memberId,
    sent_to_email: email,
    sent_by: sentByMemberId,
    sent_at: sentAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  });

  if (recorded.error) {
    return { ok: false, reason: "failed" };
  }

  const mail = buildInvitationMail();
  const sent = await sendPlainTextEmail({ to: email, subject: mail.subject, body: mail.body });

  if (!sent.ok) {
    // 台帳の行は残す。**送信を試みた事実も監査の対象**であり、
    // 消すと「送ったのに記録が無い」の裏返し（記録が消える）が起きる。
    // 失敗しても招待の窓は開いているため、会員が自分でログインを始めれば成立する。
    return {
      ok: false,
      reason: sent.reason === "not_configured" ? "mail_not_configured" : "failed",
    };
  }

  return { ok: true };
}
