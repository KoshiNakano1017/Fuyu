/**
 * 受注者本人の申請と完了報告を読む（WBS 5-3）。
 *
 * ★ anon キー ＋ RLS。行を絞るのは `0017` の `quest_applications_select_self` /
 *   `work_logs_select_self` であり、他人の申請は返らない。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { QuestApplicationStatus, WorkLogApprovalStatus } from "./review";

/** 報告画面に並べる自分の受注。 */
export type MyApplication = {
  applicationId: string;
  questId: string;
  questTitle: string;
  status: QuestApplicationStatus;
  /** 実行指示の本文（いつ・どこで・何を）。未指示なら null */
  instructionBody: string | null;
  instructionPlace: string | null;
  scheduledStartAt: string | null;
  /** 提出済みの報告（差戻し後の再提出は新しい行として積まれる） */
  workLogs: {
    logId: string;
    approvalStatus: WorkLogApprovalStatus;
    workedAt: string;
    workHours: number | null;
    rejectionReason: string | null;
  }[];
};

export async function fetchMyApplications(memberId: string): Promise<MyApplication[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("quest_applications")
    .select(
      "application_id, quest_id, status, instruction_body, instruction_place, scheduled_start_at, " +
        "quests(title), work_logs(log_id, approval_status, worked_at, work_hours, rejection_reason)",
    )
    .eq("member_id", memberId)
    .order("applied_at", { ascending: false });

  if (error || data === null) {
    return [];
  }

  return (data as unknown as Record<string, unknown>[]).map((row) => {
    // PostgREST の埋め込みは1件でも配列で来ることがある。どちらの形でも読めるようにする
    const embedded = row.quests as unknown;
    const quest = (Array.isArray(embedded) ? embedded[0] : embedded) as { title?: unknown } | null;

    const logs = (row.work_logs ?? []) as Record<string, unknown>[];

    return {
      applicationId: String(row.application_id),
      questId: String(row.quest_id),
      questTitle: typeof quest?.title === "string" ? quest.title : "（クエスト名なし）",
      status: row.status as QuestApplicationStatus,
      instructionBody: row.instruction_body === null ? null : String(row.instruction_body),
      instructionPlace: row.instruction_place === null ? null : String(row.instruction_place),
      scheduledStartAt: row.scheduled_start_at === null ? null : String(row.scheduled_start_at),
      workLogs: logs
        .map((log) => ({
          logId: String(log.log_id),
          approvalStatus: log.approval_status as WorkLogApprovalStatus,
          workedAt: String(log.worked_at),
          workHours: log.work_hours === null ? null : Number(log.work_hours),
          rejectionReason: log.rejection_reason === null ? null : String(log.rejection_reason),
        }))
        // 新しい報告を先頭へ（差戻し → 再提出の順が読めるように）
        .sort((left, right) => right.workedAt.localeCompare(left.workedAt)),
    };
  });
}

export type SubmitWorkLogRow = {
  application_id: string;
  member_id: string;
  quest_id: string;
  work_hours: number | null;
  before_photo_media_id: string;
  after_photo_media_id: string;
  notes: string | null;
  issue_flag: boolean;
  issue_note: string | null;
};

/**
 * 完了報告を1件作る。
 *
 * ⚠️ **既存の報告を書き換えない。** 差戻し後の再提出は**別の行**として積む
 * （`0017` の設計）。上書きにすると、何を直したのかが追えなくなる。
 */
export async function insertWorkLog(row: SubmitWorkLogRow): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("work_logs").insert(row);
  return error === null;
}

/** 申請の現在の状態（報告の可否を判定する材料）。 */
export async function fetchApplicationForReport(
  applicationId: string,
  memberId: string,
): Promise<{ status: QuestApplicationStatus; questId: string } | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("quest_applications")
    .select("status, quest_id")
    .eq("application_id", applicationId)
    // 他人の申請に報告を付けられないよう、読み出しの時点で本人に限る
    // （RLS も同じ条件で絞るが、ここで確認しておくと「見つからない」として扱える）
    .eq("member_id", memberId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return { status: data.status as QuestApplicationStatus, questId: String(data.quest_id) };
}
