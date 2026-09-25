"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import {
  fetchCurrentSignupPlan,
  fetchMyActiveApplication,
  insertMembershipApplication,
} from "@/lib/membership/store";
import {
  decideMembershipApplication,
  membershipApplyDenialMessage,
} from "@/lib/membership/registration";
import { canApplyToQuest } from "@/lib/quests/application-gate";
import { createQuestApplication, type CreateApplicationResult } from "@/lib/quests/applications";
import { fetchQuestById, readQuestBoardViewer } from "@/lib/quests/fetch-board";

/**
 * 街人登録の申請（WBS 12-1 の Step 2 ／ v13 §5.10.3）。
 *
 * ## 受け取る入力が無い
 *
 * フォームからは何も読まない。**申請者は `auth.uid()` から引く**（`member_id` を
 * 受け取ると他人名義の申請を作れる）。金額・付与泊数・プラン・状態は
 * `membership_applications_guard()`（`0037`）がプランから決める。
 * つまりこの Action が外へ開いているのは「自分の申請を1件作る」ことだけである。
 *
 * ## Step 1 の入力欄を保存しない
 *
 * §5.10.2 の入力欄（ニックネーム・連絡先・誕生年月）は**この導線では永続化しない**
 * （2026-09-25 オーナー決定 A ／ Issue #87）。ニックネームは本登録時に必須化済み
 * （WBS `2-7`）、連絡先は `member_identifiers`（`0025`）が持ち、いずれも名寄せ（`10-2`）の
 * 領域である。ここで別経路から書き込むと、同じ情報の出どころが2つになる。
 *
 * ## 二重申請
 *
 * 申込中があれば作らない（§5.10.3）。判定はここで先に返し、同時タップは
 * `ux_membership_app_active_per_member`（`0037`）が DB で止める。
 */
// ★ 引数を1つも取らない。`useActionState` は (前の状態, FormData) で呼ぶが、
//    **この Action は両方とも読まない**（申請者はセッションから引き、他の値は DB が決める）。
//    受け取る口を用意すると「読んでいるのでは」と疑わせるため、宣言自体を空にする。
export async function applyForMembershipAction(): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: "ログインが必要です。" };
  }

  const [plan, active] = await Promise.all([
    fetchCurrentSignupPlan(),
    fetchMyActiveApplication(viewer.memberId),
  ]);

  const decision = decideMembershipApplication({
    actorRole: viewer.role,
    hasActiveApplication: active !== null,
    plan,
  });
  if (!decision.allowed) {
    return { status: "error", message: membershipApplyDenialMessage(decision.reason) };
  }

  const saved = await insertMembershipApplication(viewer.memberId);
  if (!saved) {
    // 同時タップで部分一意索引に当たった場合もここへ来る。二重申請は失敗ではないので、
    // 「受け付けている」と伝える（利用者から見た結果は同じである）。
    const retry = await fetchMyActiveApplication(viewer.memberId);
    if (retry !== null) {
      return { status: "done", message: "申請を受け付けています。運営からのご案内をお待ちください。" };
    }
    return { status: "error", message: "申請できませんでした。時間をおいて再試行してください。" };
  }

  revalidatePath("/quests");
  revalidatePath("/me");
  return {
    status: "done",
    message: "申請を受け付けました。運営からのご案内をお待ちください。",
  };
}

/**
 * 受注申請（WBS 5-2 ／ v13 §5.3-2）。
 *
 * ## 判定は `canApplyToQuest()` ただ1箇所である
 *
 * 画面の申請ボタンの活性（`board.ts`）・`POST /api/quests/{id}/applications`・この Action が
 * **同じ関数**を根拠にする。別の場所へ資格判定を書くと、片方だけ緩い状態が生まれる（v13 §5.9.3）。
 *
 * ## 拒否の理由を返さない
 *
 * 施錠なのか締切なのか資格なのかを返すと、**詳細を伏せている施錠クエストの状態を推測する
 * 手がかり**になる（§5.10.6 末尾）。API ルートと同じ一律の文言にする。
 */
export async function applyToQuestAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readQuestBoardViewer();
  if (viewer === null) {
    return { status: "error", message: "ログインが必要です。" };
  }

  const questId = String(formData.get("questId") ?? "").trim();
  const quest = await fetchQuestById(questId);
  if (quest === null) {
    return { status: "error", message: "クエストが見つかりません。" };
  }

  if (!canApplyToQuest(viewer, quest)) {
    return { status: "error", message: "このクエストは受注できません。" };
  }

  const result = await createQuestApplication({ questId, memberId: viewer.memberId });
  if (!result.ok) {
    return { status: "error", message: applyDenialMessage(result.reason) };
  }

  revalidatePath("/quests");
  revalidatePath("/reports");
  return { status: "done", message: "受注を申請しました。運営の指示をお待ちください。" };
}

/**
 * 登録が通らなかった理由を文言に写す（`applyToQuestAction` の下位問題）。
 *
 * 二重申請だけは別の文言でよい。本人が自分の状態を知るだけで、クエストの内情は漏れない。
 * それ以外（`unavailable` ＝ 0041 の上限ガードに当たった場合を含む）は、
 * ゲート拒否と**同じ一律の文言**にする（v13 §5.10.6 末尾）。
 */
function applyDenialMessage(
  reason: Exclude<CreateApplicationResult, { ok: true }>["reason"],
): string {
  if (reason === "duplicate") {
    return "このクエストにはすでに申請済みです。運営の指示をお待ちください。";
  }
  if (reason === "unavailable") {
    return "このクエストは受注できません。";
  }
  return "申請できませんでした。時間をおいて再試行してください。";
}
