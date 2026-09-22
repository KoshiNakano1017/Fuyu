"use server";

import { redirect } from "next/navigation";

import { bindAuthUserToMember } from "@/lib/auth/binding";
import { hasUsableInvitation } from "@/lib/auth/invitations";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "code_sent" | "error"; message?: string };

/**
 * メールアドレスへ6桁の OTP を送る（v13 §5.2.6「方式」）。
 *
 * ⚠️ **失敗しても「そのアドレスの会員が居るか」を漏らさない。** 存在の有無で
 * メッセージを変えると、総当たりで会員のメールアドレスを特定できてしまう。
 * 実名・住所を保持する DB（v13 §7）なので、この差分は攻撃者にとって価値がある。
 *
 * ⚠️ **ログにメールアドレスを出さない**（CLAUDE.md §3.2）。
 */
export async function requestLoginCode(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  if (email === "") {
    return { status: "error", message: "メールアドレスを入力してください。" };
  }

  // ★ 招待（経路B）の入口。**ここだけが `auth.users` の新規作成を許す条件である。**
  //
  // 2026-09-22 のコード方式化（WBS `2-1d` ／ 決定ログ §22-1）で、招待メールから
  // リンクもコードも消えた。会員は「案内メールを見てログイン画面に来る」ため、
  // **初回は `auth.users` がまだ無い**（v13 §5.2.6 手順3・4：`auth.users` は
  // 会員自身のログインで作られ、その後に台帳の宛先と突き合わせて結合する）。
  //
  // 台帳に未消費・期限内の行があるアドレスにだけ作成を許す。
  // ここを無条件 `true` にすると、**誰でもメールアドレスさえあれば会員枠を持たない
  // Auth ユーザーを作れる**（結合は `bindAuthUserToMember()` が拒むので会員にはなれないが、
  // Resend の送信枠＝100通/日を他人に枯らされる。`非機能要件詳細.md` §2-6a ①）。
  const invited = await hasUsableInvitation(email);

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // 招待していない相手に会員アカウントを作らせない。
      // 会員の作成は運営の操作（経路B）か来訪時の登録（経路A）に限る（v13 §5.2.6）。
      shouldCreateUser: invited,
    },
  });

  if (error) {
    // 理由を問わず同じ文面を返す（存在の有無を漏らさないため）。
    return { status: "code_sent" };
  }
  return { status: "code_sent" };
}

/**
 * 6桁コードを検証し、初回なら `members` へ結合する。
 *
 * 成功後の行き先は**ニックネームの設定状況で変える**（v13 §9 #62 ／ WBS `2-7`）。
 * 移行370名は `nickname` が未設定で入るため（`会員データモデル` §6.2）、
 * **次回ログイン時に設定を求める**とオーナーが 2026-09-22 に決めている。
 * 「設定されるまで会員番号で表示する」ので**強制はしないが、必ず一度は通す**。
 */
export async function verifyLoginCode(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();

  if (email === "" || token === "") {
    return { status: "error", message: "コードを入力してください。" };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });

  if (error || !data.user) {
    return { status: "error", message: "コードが正しくないか、有効期限が切れています。" };
  }

  // 初回ログインなら auth.users と members を結合する（冪等）。
  const bound = await bindAuthUserToMember(data.user.id, email);
  if (!bound.ok) {
    await supabase.auth.signOut();
    return {
      status: "error",
      message:
        "アカウントの紐付けができませんでした。運営へお問い合わせください。",
    };
  }

  // 自分の行は RLS の本人ポリシーで引ける（結合済みになったため）。
  const profile = await supabase
    .from("members")
    .select("nickname")
    .eq("member_id", bound.memberId)
    .maybeSingle();

  const nickname = (profile.data?.nickname as string | null) ?? null;
  const needsNickname = nickname === null || nickname.trim() === "";

  // ⚠️ `redirect()` は例外を投げて制御を返さない。この行より後に後処理を書かないこと。
  redirect(needsNickname ? "/nickname" : "/");
}
