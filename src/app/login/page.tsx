import { redirect } from "next/navigation";

import { readViewer } from "@/lib/auth/session";

import { LoginForm } from "./LoginForm";

/**
 * ログイン画面（v13 §5.2.6）。
 *
 * ⚠️ **パスワードの入力欄を置かない。** v13 §5.2.6 が「パスワードは発行も保存もしない」
 * と定めている。DB が実名・住所を保持する（§7）ため、保存すべき秘密を作らないことが
 * そのまま防御になる。
 *
 * 画面の見た目（画面ID・レイアウト）は `画面設計.md` に**ログイン画面が存在しない**ため
 * 定義できない。ここでは振る舞いだけを実装し、画面IDを発明しない（WBS 18-2 の範囲）。
 */
export default async function LoginPage() {
  const viewer = await readViewer();
  if (viewer.signedIn) {
    redirect("/");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6 sm:p-8">
      <div className="flex flex-col gap-6 rounded-lg border border-neutral-200 p-6 sm:p-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">ログイン</h1>
          <p className="text-sm text-neutral-600">
            登録されているメールアドレスへ、6桁の確認コードをお送りします。
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
