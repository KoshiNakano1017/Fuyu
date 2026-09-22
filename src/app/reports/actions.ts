"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import { fetchApplicationForReport, insertWorkLog } from "@/lib/quests/fetch-my-applications";
import { decideWorkLogSubmission, parseWorkHours } from "@/lib/quests/work-log-report";

/**
 * 完了報告の提出（WBS 5-3 ／ v13 §5.3-4）。
 *
 * ## 代筆させない
 *
 * `0017` の `work_logs_insert_self` は「申請者本人の行であること」を WITH CHECK で要求する。
 * 運営が代筆できると「本人が報告した」という事実そのものが壊れるためで、
 * ここでも `member_id` を**セッションから取る**（フォームから受け取らない）。
 *
 * ## 写真は先にアップロードされている
 *
 * 画面（`WorkLogForm`）が署名付きURL経由で先に送り、**`media_id` だけ**をここへ渡す。
 * 画像の実体はアプリのサーバを通らない（v13 §5.11.2 不可侵ルール1）。
 */

const MESSAGE: Record<string, string> = {
  not_signed_in: "ログインが必要です。",
  not_found: "対象の受注が見つかりません。",
  not_instructed: "運営からの実行指示が出てから報告してください。",
  missing_before_photo: "作業前の写真を添付してください。",
  missing_after_photo: "作業後の写真を添付してください。",
  invalid_work_hours: "作業時間は0より大きく24以内で入力してください。",
  blank_issue_note: "気づいた問題の内容を書いてください。",
  failed: "提出できませんでした。時間をおいて再試行してください。",
};

function fail(reason: string): SubmitState {
  return { status: "error", message: MESSAGE[reason] ?? MESSAGE.failed };
}

export async function submitWorkLogAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return fail("not_signed_in");
  }

  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const application = await fetchApplicationForReport(applicationId, viewer.memberId);
  if (application === null) {
    return fail("not_found");
  }

  const workHours = parseWorkHours(String(formData.get("workHours") ?? ""));
  if (workHours === "invalid") {
    return fail("invalid_work_hours");
  }

  const beforePhotoMediaId = emptyToNull(formData.get("beforePhotoMediaId"));
  const afterPhotoMediaId = emptyToNull(formData.get("afterPhotoMediaId"));
  const issueFlag = formData.get("issueFlag") === "on";
  const issueNote = String(formData.get("issueNote") ?? "");

  const decision = decideWorkLogSubmission({
    applicationStatus: application.status,
    beforePhotoMediaId,
    afterPhotoMediaId,
    workHours,
    issueFlag,
    issueNote,
  });
  if (!decision.allowed) {
    return fail(decision.reason);
  }

  const saved = await insertWorkLog({
    application_id: applicationId,
    member_id: viewer.memberId,
    quest_id: application.questId,
    work_hours: workHours,
    // 判定を通っている＝どちらも null ではない
    before_photo_media_id: beforePhotoMediaId as string,
    after_photo_media_id: afterPhotoMediaId as string,
    notes: emptyToNull(formData.get("notes")),
    issue_flag: issueFlag,
    issue_note: issueFlag ? issueNote.trim() : null,
  });
  if (!saved) {
    return fail("failed");
  }

  revalidatePath("/reports");
  revalidatePath("/staff/quests");
  return {
    status: "done",
    message: "完了報告を提出しました。運営の確認をお待ちください。",
  };
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}
