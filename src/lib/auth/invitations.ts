import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/**
 * 招待リンクの有効期限（時間）。
 *
 * **2026-09-15 の決定は当初72時間だったが、24時間へ訂正した。**
 * Supabase の Email OTP Expiration は招待リンクの期限も支配し、
 * **86,400秒（24時間）超はダッシュボードで設定できない**（Management API のみ）ため、
 * 72時間はそもそも実装できなかった。
 *
 * 24時間は「宛先を誤ったときの露出時間が最短」という理由で元々の推奨でもある。
 * 休日を挟んで開けない相手には**再送**で対応する（v13 §5.2.6 が再送を前提にしている）。
 *
 * ⚠️ **値をここ1箇所に持つ。** 後から短くできるよう、各所へ直書きしないこと
 * （2026-09-15 オーナー指示の補償条件）。
 */
export const INVITATION_EXPIRY_HOURS = 24;

export type InviteResult =
  | { ok: true }
  | { ok: false; reason: "not_staff" | "member_not_found" | "already_active" | "failed" };

/**
 * 経路B：運営が個別にアカウント作成リンクを送る（v13 §5.2.6）。
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

  // Supabase Auth の招待メールを送る。送信基盤は Resend（2026-09-10 決着）で、
  // Supabase 側の SMTP 設定として構成する（組み込み SMTP は 2通/時で足りない）。
  const invited = await admin.auth.admin.inviteUserByEmail(email);
  if (invited.error) {
    return { ok: false, reason: "failed" };
  }

  return { ok: true };
}
