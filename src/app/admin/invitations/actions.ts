"use server";

import { readViewer } from "@/lib/auth/session";
import { isStaff } from "@/lib/auth/session";
import { sendInvitation } from "@/lib/auth/invitations";

export type InviteFormState = { status: "idle" | "sent" | "error"; message?: string };

/**
 * 招待送信の Server Action。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * Server Action は URL を持つエンドポイントとして公開されるため、
 * 「管理画面を出さない」だけでは防御にならない。判定をここに置くのはそのため。
 */
export async function sendInvitationAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const viewer = await readViewer();

  // ★ ここがサーバサイド認可。DOM の非表示とは独立して効く。
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return { status: "error", message: "この操作を行う権限がありません。" };
  }

  const memberId = String(formData.get("memberId") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  if (memberId === "" || email === "") {
    return { status: "error", message: "会員と送信先を指定してください。" };
  }

  const result = await sendInvitation({
    memberId,
    email,
    sentByMemberId: viewer.memberId,
  });

  if (result.ok) {
    // ⚠️ 文言は実装（リンクではなく案内メール ／ WBS `2-1d`）と対で維持する。
    return {
      status: "sent",
      message:
        "案内メールを送信しました。会員がログイン画面でこのアドレスを入力すると6桁コードが届きます（受付は24時間）。",
    };
  }

  const MESSAGE: Record<string, string> = {
    member_not_found: "指定された会員が見つかりません。",
    already_active: "この会員は既にログインできる状態のため、招待は送れません。",
    not_staff: "この操作を行う権限がありません。",
    // 招待の窓（台帳の行）は開いているため、会員が自分でログインを始めれば成立する。
    // 運営が自力で直せる失敗なので、他の失敗と文面を分ける。
    mail_not_configured:
      "メール送信の設定（Resend の API キー）が未了のため送れませんでした。招待の記録は残っています。運営管理者へ連絡してください。",
    failed: "送信に失敗しました。時間をおいて再試行してください。",
  };
  return { status: "error", message: MESSAGE[result.reason] ?? MESSAGE.failed };
}
