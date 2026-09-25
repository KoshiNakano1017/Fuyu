"use server";

import { redirect } from "next/navigation";

import { bindAuthUserToMember } from "@/lib/auth/binding";
import { hasUsableInvitation } from "@/lib/auth/invitations";
import { decideMatching } from "@/lib/members/matching";
import {
  enqueueLinkRequest,
  findCandidatesByIdentifier,
  hasMatchableIdentifier,
  linkMemberByMatching,
} from "@/lib/members/matching-store";
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
  //
  // ★ 2026-09-25（WBS 10-2）：**名寄せの初回アクセス導線**を同じゲートへ足した。
  //   事前登録済みの会員（`pre_registered`）は招待されていなくても、
  //   自分の連絡先でログインして名寄せへ入る経路が要る（v13 §5.8.3 STEP 2）。
  //   台帳に無い＝作らせない、だけだと **370名の大半がログインできない**。
  //   どちらも「その連絡先が既知の会員のものである」ことを確かめた上での許可であり、
  //   見知らぬ相手に `auth.users` を作らせない趣旨は保たれる。
  const [invited, matchable] = await Promise.all([
    hasUsableInvitation(email),
    hasMatchableIdentifier(email),
  ]);

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // 招待していない相手に会員アカウントを作らせない。
      // 会員の作成は運営の操作（経路B）か来訪時の登録（経路A）に限る（v13 §5.2.6）。
      shouldCreateUser: invited || matchable,
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
  // まず招待台帳（経路B）を見る。台帳に行が無い相手は名寄せ（§5.8.3）へ回す。
  const bound = await bindAuthUserToMember(data.user.id, email);

  let memberId: string | null = bound.ok ? bound.memberId : null;

  if (!bound.ok) {
    if (bound.reason !== "no_member_for_email") {
      // 既に他アカウントへ結合済み等。名寄せでも解決しないため、ここで止める。
      await supabase.auth.signOut();
      return {
        status: "error",
        message: "アカウントの紐付けができませんでした。運営へお問い合わせください。",
      };
    }

    memberId = await linkByMatching(data.user.id, email);
    if (memberId === null) {
      await supabase.auth.signOut();
      return {
        status: "error",
        message:
          "お使いのメールアドレスでは連携できませんでした。運営の確認が必要な場合は、こちらから運営へご連絡ください。",
      };
    }
  }

  // 自分の行は RLS の本人ポリシーで引ける（結合済みになったため）。
  const profile = await supabase
    .from("members")
    .select("nickname")
    .eq("member_id", memberId)
    .maybeSingle();

  const nickname = (profile.data?.nickname as string | null) ?? null;
  const needsNickname = nickname === null || nickname.trim() === "";

  // ⚠️ `redirect()` は例外を投げて制御を返さない。この行より後に後処理を書かないこと。
  redirect(needsNickname ? "/nickname" : "/");
}

/**
 * 名寄せ（v13 §5.8.3 STEP 2）で結合先を決める。
 *
 * ## 何をしているか
 *
 * ログインの OTP を通ったメールアドレスを**本人確認済みの照合キー**として扱い
 * （§5.8.3 ②）、事前登録済みの会員を探す。
 *
 *   - 候補1件 → **自動で成立**させ、その `member_id` を返す
 *   - 候補2件以上 → **運営承認キューへ積み**、`null` を返す（＝待ち）
 *   - 候補0件 → `null`（招待も無いので、ここで終わり）
 *
 * ## 返り値で理由を区別しない
 *
 * 呼び出し側は `null` を「連携できなかった」として一律に扱う。
 * 「候補が2件ありました」と伝えると、**他人の登録状況を推測する手がかり**になる
 * （同姓同名・家族の連絡先共有がまさにこの状況である）。運営側はキューで理由を読める。
 */
async function linkByMatching(authUserId: string, email: string): Promise<string | null> {
  const candidates = await findCandidatesByIdentifier({ kind: "email", value: email });
  const decision = decideMatching({
    matchKind: "email",
    matchValue: email,
    candidates,
    // ここへ来た時点で `verifyOtp()` を通っている＝メールの所有が確認できている。
    isActorVerified: true,
  });

  if (decision.kind === "none") {
    return null;
  }

  if (decision.kind === "queue") {
    await enqueueLinkRequest({
      authUserId,
      kind: "email",
      value: email,
      candidateCount: decision.candidateCount,
      reason: decision.reason,
    });
    return null;
  }

  const linked = await linkMemberByMatching({
    memberId: decision.memberId,
    authUserId,
    matchBasis: decision.matchBasis,
    identifierKind: "email",
    identifierValue: email,
  });

  return linked ? decision.memberId : null;
}
