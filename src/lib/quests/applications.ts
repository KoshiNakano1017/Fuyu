// 受注申請の登録と、運営審査の材料の読み出し（WBS 5-2・5-4・5-6）。
//
// 判定そのものは `review.ts`（純関数）と `application-gate.ts` が持つ。
// ここは DB との往復だけを担当する。
//
// ★ anon キー＋RLS で読み書きする。行を絞るのは `0017` の `_self` / `_staff` ポリシーであり、
//   最終承認を `admin` に限っているのは**トリガー** `work_logs_guard_approval()` である
//   （RLS の `USING (is_staff())` だけでは core_member の最終承認を止められない）。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { QuestApplicationStatus, WorkLogApprovalStatus } from "./review";

export type CreateApplicationResult =
  | { ok: true; applicationId: string }
  | { ok: false; reason: "duplicate" | "failed" };

/**
 * 受注申請を1件作る。
 *
 * ## 二重申請を弾く
 *
 * 同じクエストに対して生きている申請（`申請中` / `指示済み` / `承認`）があれば作らない。
 * DB に一意制約が無いため**アプリ側で見る**。競合すると2件入りうるが、
 * その場合は運営の審査画面（画面ID B5）で同じ人の申請が並んで見えるため気づける。
 */
export async function createQuestApplication(params: {
  questId: string;
  memberId: string;
}): Promise<CreateApplicationResult> {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("quest_applications")
    .select("application_id")
    .eq("quest_id", params.questId)
    .eq("member_id", params.memberId)
    .in("status", ["申請中", "指示済み", "承認"])
    .limit(1);

  if (existing !== null && existing.length > 0) {
    return { ok: false, reason: "duplicate" };
  }

  const { data, error } = await supabase
    .from("quest_applications")
    .insert({ quest_id: params.questId, member_id: params.memberId, status: "申請中" })
    .select("application_id")
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, applicationId: data.application_id as string };
}

/** 審査画面に並べる受注申請。 */
export type ReviewableApplication = {
  applicationId: string;
  questId: string;
  questTitle: string;
  applicantLabel: string;
  status: QuestApplicationStatus;
  appliedAt: string;
  instructionBody: string | null;
};

/** 審査画面に並べる完了報告。 */
export type ReviewableWorkLog = {
  logId: string;
  questTitle: string;
  workerLabel: string;
  approvalStatus: WorkLogApprovalStatus;
  workHours: number | null;
  notes: string | null;
  workedAt: string;
};

/**
 * 審査待ちの受注申請（`申請中`）を読む。
 *
 * `指示済み` 以降は審査の待ち行列から外す。板に残すと「もう指示した」ものが
 * 毎朝目に入り、未対応との区別が付かなくなる。
 */
export async function fetchPendingApplications(): Promise<ReviewableApplication[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("quest_applications")
    .select("application_id, quest_id, member_id, status, applied_at, instruction_body, quests(title)")
    .eq("status", "申請中")
    .order("applied_at", { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as {
    application_id: string;
    quest_id: string;
    member_id: string;
    status: QuestApplicationStatus;
    applied_at: string;
    instruction_body: string | null;
    // PostgREST の埋め込みリレーションは**配列**で返る（1対1に見えても要素0件がありうる）。
    quests: { title: string }[] | null;
  }[];

  const labels = await fetchMemberLabels(rows.map((row) => row.member_id));

  return rows.map((row) => ({
    applicationId: row.application_id,
    questId: row.quest_id,
    questTitle: row.quests?.[0]?.title ?? "（クエスト名を取得できません）",
    applicantLabel: labels.get(row.member_id) ?? "（表示名なし）",
    status: row.status,
    appliedAt: row.applied_at,
    instructionBody: row.instruction_body,
  }));
}

/**
 * 承認待ちの完了報告を読む（`報告済み` / `コアメンバー確認済`）。
 *
 * `承認完了` と `差戻し` は板から外す。承認完了は §5.3.1 の給付予定が既に起票されており、
 * 差戻しは受注者のボールである。
 */
export async function fetchPendingWorkLogs(): Promise<ReviewableWorkLog[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("work_logs")
    .select("log_id, member_id, approval_status, work_hours, notes, worked_at, quests(title)")
    .in("approval_status", ["報告済み", "コアメンバー確認済"])
    .order("worked_at", { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as {
    log_id: string;
    member_id: string;
    approval_status: WorkLogApprovalStatus;
    work_hours: number | null;
    notes: string | null;
    worked_at: string;
    quests: { title: string }[] | null;
  }[];

  const labels = await fetchMemberLabels(rows.map((row) => row.member_id));

  return rows.map((row) => ({
    logId: row.log_id,
    questTitle: row.quests?.[0]?.title ?? "（クエスト名を取得できません）",
    workerLabel: labels.get(row.member_id) ?? "（表示名なし）",
    approvalStatus: row.approval_status,
    workHours: row.work_hours,
    notes: row.notes,
    workedAt: row.worked_at,
  }));
}

/** 表示名をまとめて引く。他者向けの表示規則（v13 §5.9.5）はビュー側が持っている。 */
async function fetchMemberLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name")
    .in("member_id", unique);

  const labels = new Map<string, string>();
  for (const row of (data ?? []) as { member_id: string; display_name: string | null }[]) {
    if (row.display_name !== null) {
      labels.set(row.member_id, row.display_name);
    }
  }
  return labels;
}
