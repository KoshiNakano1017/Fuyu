"use server";

import { revalidatePath } from "next/cache";

import type { SubmitState } from "@/lib/forms/submit-state";
import { readViewer } from "@/lib/auth/session";
import { buildQuestRewardGrant } from "@/lib/eumo/grants";
import { hasQuestRewardGrant, insertGrant } from "@/lib/eumo/store";
import {
  canInstruct,
  decideReview,
  nextApprovalStatus,
  type ReviewAction,
  type WorkLogApprovalStatus,
} from "@/lib/quests/review";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const MESSAGE: Record<string, string> = {
  not_staff: "この操作を行う権限がありません。",
  not_admin: "最終承認は管理者のみが行えます。",
  already_finalized: "この報告は既に確定しています。",
  blank_reason: "差戻しには理由の入力が必要です。",
  blank_instruction: "指示の内容を入力してください。",
  failed: "処理できませんでした。時間をおいて再試行してください。",
};

/**
 * 受注申請へ実行指示を出す（WBS 5-2 ／ v13 §5.3-3）。
 *
 * 指示の中身（いつ・どこで・何を）が空のまま「指示済み」にできると、
 * 受注者は何をすればよいか分からないまま承認待ちに入る。判定は `canInstruct()` に委ねる。
 */
export async function instructApplicationAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.not_staff };
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const instructionBody = String(formData.get("instructionBody") ?? "").trim();
  const instructionPlace = String(formData.get("instructionPlace") ?? "").trim();
  const scheduledStartAt = String(formData.get("scheduledStartAt") ?? "").trim();

  const decision = canInstruct({
    actorRole: viewer.role,
    current: "申請中",
    instructionBody,
  });
  if (!decision.allowed) {
    return { status: "error", message: MESSAGE[decision.reason] ?? MESSAGE.failed };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("quest_applications")
    .update({
      status: "指示済み",
      instruction_body: instructionBody,
      instruction_place: instructionPlace === "" ? null : instructionPlace,
      // `datetime-local` は秒もタイムゾーンも持たない。空なら列を埋めない
      scheduled_start_at: scheduledStartAt === "" ? null : new Date(scheduledStartAt).toISOString(),
      reviewed_by: viewer.memberId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId)
    // 既に指示済みのものを二度押しで上書きしない（板の取り合いを防ぐ）
    .eq("status", "申請中");

  if (error) {
    return { status: "error", message: MESSAGE.failed };
  }
  revalidatePath("/staff/quests");
  return { status: "done", message: "実行指示を登録しました。" };
}

/**
 * 完了報告の審査（WBS 5-4・5-6 ／ v13 §5.3.2 の二段階承認）。
 *
 * ## 判定を2箇所に置いている理由
 *
 * ここ（`decideReview()`）で止めるのは**利用者に理由を返すため**である。
 * 本当の防壁は DB のトリガー `work_logs_guard_approval()`（`0017`）で、
 * コアメンバーが `承認完了` を書こうとすると 42501 で落ちる。
 * RLS の `USING (is_staff())` だけでは止まらない（`core_member` も `admin` も
 * 同じ `authenticated` ロールであるため）。**画面側を外しても DB で止まる。**
 */
export async function reviewWorkLogAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.not_staff };
  }

  const logId = String(formData.get("logId") ?? "").trim();
  const action = String(formData.get("action") ?? "") as ReviewAction;
  const current = String(formData.get("current") ?? "") as WorkLogApprovalStatus;
  const reason = String(formData.get("reason") ?? "").trim();

  const decision = decideReview({ action, actorRole: viewer.role, current, reason });
  if (!decision.allowed) {
    return { status: "error", message: MESSAGE[decision.reason] ?? MESSAGE.failed };
  }

  const now = new Date().toISOString();
  const nextStatus = nextApprovalStatus(action);

  // 列の埋め方はステージごとに違う。`0017` の CHECK 制約が
  // 「差戻しには理由と実行者」「承認完了には承認者と時刻」を要求している。
  const patch: Record<string, unknown> = {
    approval_status: nextStatus,
    reviewed_by: viewer.memberId,
    reviewed_at: now,
  };
  if (action === "approve") {
    patch.approved_by = viewer.memberId;
    patch.approved_at = now;
  }
  if (action === "reject") {
    patch.rejected_by = viewer.memberId;
    patch.rejected_at = now;
    patch.rejection_reason = reason;
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("work_logs")
    .update(patch)
    .eq("log_id", logId)
    // 待ち行列に載っていたステージのままであることを条件にする。
    // 別の運営が先に動かしていたら何も起きない（上書きしない）
    .eq("approval_status", current);

  if (error) {
    // トリガーが 42501 で弾いた場合もここへ来る。理由を作り分けず、
    // 画面側の判定と同じ文言に寄せる（内部のエラー文を出さない／CLAUDE.md §3.2）
    return { status: "error", message: MESSAGE.not_admin };
  }

  // 2人目以降のコアメンバー確認は遷移させず確認ログへ積む（v13 §5.3.2）。
  if (action === "core_confirm") {
    await supabase
      .from("work_log_reviews")
      .insert({ log_id: logId, reviewer_id: viewer.memberId });
  }

  // ★ 最終承認と同時に Eumo 給付を起票する（WBS 5-5 ／ v13 §7 L2594）。
  //   起票を運営の別操作にすると、承認したのに報酬の依頼が立っていない報告が積み上がる。
  //   **コアメンバー確認済の段階では起こさない** — 最終承認を admin に限った意味が消えるため。
  const grantNote = action === "approve" ? await issueQuestRewardGrant(logId) : null;

  revalidatePath("/staff/quests");
  return {
    status: "done",
    message: grantNote === null ? "審査を記録しました。" : `審査を記録しました。${grantNote}`,
  };
}

/**
 * 承認完了した作業報告から Eumo 給付（`quest_reward`）を起こす。
 *
 * 戻り値は画面へ足す一文である。**起票できなかったことを黙って飲み込まない**
 * （報酬額が未設定のクエストは朝会からの自動起案で普通に生まれる）。
 * 二重起票は `hasQuestRewardGrant()` が報告単位で防ぐ（差戻し後の再提出は別の報告である）。
 */
async function issueQuestRewardGrant(logId: string): Promise<string | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("work_logs")
    .select("member_id, quest_id, quests(title, reward_uii)")
    .eq("log_id", logId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  if (await hasQuestRewardGrant(logId)) {
    return null;
  }

  // PostgREST の埋め込みは1件でも配列で来ることがある。どちらの形でも読めるようにする。
  const embedded = data.quests as unknown;
  const quest = (Array.isArray(embedded) ? embedded[0] : embedded) as
    | { title?: unknown; reward_uii?: unknown }
    | null
    | undefined;

  const grant = buildQuestRewardGrant({
    memberId: String(data.member_id),
    questId: String(data.quest_id),
    questTitle: typeof quest?.title === "string" ? quest.title : "（クエスト名なし）",
    logId,
    rewardUii: typeof quest?.reward_uii === "number" ? quest.reward_uii : null,
  });

  if (grant === null) {
    return "⚠️ このクエストは報酬額が未設定のため、Eumo給付は起票していません。";
  }
  const saved = await insertGrant(grant);
  return saved
    ? `Eumo給付 ${grant.amount_uii} Uii を発行依頼として起票しました。`
    : "⚠️ Eumo給付の起票に失敗しました。給付一覧から手動で起票してください。";
}
