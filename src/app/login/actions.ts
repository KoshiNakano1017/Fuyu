"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { bindAuthUserToMember } from "@/lib/auth/binding";

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

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // 招待していない相手に会員アカウントを作らせない。
      // 会員の作成は運営の操作（経路B）か来訪時の登録（経路A）に限る（v13 §5.2.6）。
      shouldCreateUser: false,
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

  return { status: "idle" };
}
