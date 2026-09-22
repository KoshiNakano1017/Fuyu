import Link from "next/link";
import { redirect } from "next/navigation";

import { readViewer } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { NicknameForm } from "./NicknameForm";

/**
 * ニックネーム設定画面（WBS `2-7` ／ v13 §9 #62）。
 *
 * **移行370名の入口がここである。** 実データに `nickname` の列が無いため
 * 全員が未設定で入り（`会員データモデル` §6.2）、2026-09-22 のオーナー決定で
 * **次回ログイン時に設定を求める**ことになった。`src/app/login/actions.ts` が
 * 初回ログイン後にここへ送る。
 *
 * ⚠️ **強制はしない。** 「設定されるまでの間だけ会員番号で表示する」という決定であり、
 * 設定せずに使い続けられる。スキップの導線をこの画面に置くのはそのためである
 * （置かないと、決定に無い「設定するまでアプリを使えない」仕様になる）。
 *
 * 🚫 **本名を初期値に入れない**（`会員データモデル` §5.2c の不可侵ルール）。
 * ここで `full_name` を既定値に置くと、その1行で個人情報の分離が壊れる。
 */
export default async function NicknamePage() {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    redirect("/login");
  }

  const supabase = await createServerSupabaseClient();
  const profile = await supabase
    .from("members")
    .select("nickname")
    .eq("member_id", viewer.memberId)
    .maybeSingle();

  const currentNickname = (profile.data?.nickname as string | null) ?? null;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">ニックネームを決めてください</h1>
      <p className="text-sm text-neutral-600">
        クエストボードなど<strong>他の方に見える画面で使う名前</strong>です。
        本名は使われません。未設定のままでも利用できますが、その間は会員番号で表示されます。
      </p>
      <NicknameForm currentNickname={currentNickname} />
      <Link href="/" className="text-sm text-neutral-600 underline">
        あとで設定する
      </Link>
    </main>
  );
}
