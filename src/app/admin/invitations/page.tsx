import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";

import { InvitationForm } from "./InvitationForm";

/**
 * 招待送信画面（経路B ／ v13 §5.2.6）。運営専用。
 *
 * ⚠️ 文言は**リンクを送らない実装**（WBS `2-1d` ／ 決定ログ §22-1）と対で維持する。
 * 運営はこの画面の説明を読んで会員へ手順を伝えるため、方式とズレると現場が詰まる。
 *
 * **判定は Server Component で行う。** 権限が無い場合、下の `InvitationForm` は
 * **一度も組み立てられない**ので、権限外の利用者に中身が一瞬見えることがない
 * （v13 §5.9.2 のフラッシュ防止）。
 */
export default async function InvitationsPage() {
  try {
    await requireStaff();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">アカウント登録の案内を送る</h1>
      <p className="text-sm text-neutral-600">
        メールアドレスを登録していない会員へ、個別に案内メールを送ります。送るのは
        <strong>ログイン画面の案内だけ</strong>です（踏めばログインできるリンクは送りません）。
        会員はログイン画面でこのアドレスを入力し、届いた6桁コードでログインします。
        <strong>送信先を誤ると、他人がその会員のアカウントにログインできます。</strong>
        宛先を必ず確認してください。
      </p>
      <InvitationForm />
    </main>
  );
}
