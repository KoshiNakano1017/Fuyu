"use server";

import { redirect } from "next/navigation";

import { readViewer } from "@/lib/auth/session";
import { validateNickname } from "@/lib/members/nickname";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type NicknameFormState = { status: "idle" | "error"; message?: string };

/**
 * 自分のニックネームを設定する（WBS `2-7` ／ v13 §9 #62）。
 *
 * ## なぜ service_role を使わないのか
 *
 * `nickname` は**本人が変更してよい列**であり、`0005_rls_policies.sql` の
 * `GRANT UPDATE (nickname, skills, certifications, line_joined, discord_joined)` に入っている。
 * RLS 越しに本人の行だけが更新できるため、ここで RLS を迂回する理由が無い
 * （`src/lib/supabase/admin.ts` の注記：service_role は用途を限る）。
 *
 * ## 認可
 *
 * Server Action は URL を持つ公開エンドポイントである。画面を出さないだけでは防御にならないため、
 * **ここでもログイン済みかを見る**（v13 §5.9.3 の二重防御）。
 * ただし「誰の行を更新するか」は `member_id` をリクエストから受け取らず、
 * **サーバ側で引いた `viewer.memberId` だけ**を使う。受け取ると他人の表示名を書き換える口になる。
 */
export async function saveNicknameAction(
  _prev: NicknameFormState,
  formData: FormData,
): Promise<NicknameFormState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: "ログインしてからお試しください。" };
  }

  const validation = validateNickname(String(formData.get("nickname") ?? ""));
  if (!validation.ok) {
    return { status: "error", message: validation.message };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("members")
    .update({ nickname: validation.normalized })
    .eq("member_id", viewer.memberId);

  if (error) {
    return {
      status: "error",
      message: "保存できませんでした。時間をおいてお試しください。",
    };
  }

  redirect("/");
}
