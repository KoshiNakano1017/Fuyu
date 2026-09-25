/**
 * 街人登録申請の運営操作の DB 往復（WBS 12-2 Step 3〜5 ／ `0037`・`0038`）。
 * 判定は `approval.ts`（純関数）が持つ。
 *
 * ★ 読み取りと QR 発行・却下は **anon キー ＋ RLS** で行う（`membership_app_select_admin` /
 *   `_update_admin`）。**承認だけが `service_role` を使う** — role 昇格は `0003` のガードが
 *   `app.operator_id` / `app.change_reason` の申告を同じトランザクション内で要求するため、
 *   `approve_membership_application()`（`0038`）に閉じてあり、その関数は
 *   `service_role` からしか呼べない。
 *
 * 申請者名は `v_member_public`（表示名のみ）から引く。実名は出さない（CLAUDE.md §7.1）。
 */

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { ApplicationStatus } from "./store";

export type ApplicationListItem = {
  applicationId: string;
  memberId: string;
  /** 申請者の表示名（`v_member_public` 由来。実名を含まない） */
  applicantLabel: string;
  status: ApplicationStatus;
  billedAmountYen: number;
  grantedNights: number;
  appliedAt: string;
  paymentMethod: string | null;
  paidAt: string | null;
  qrIssuedAt: string | null;
  qrExpiresAt: string | null;
  qrConsumedAt: string | null;
  qrDeliveryChannel: string | null;
  rejectionReason: string | null;
};

const LIST_COLUMNS =
  "application_id, member_id, status, billed_amount_yen, granted_nights, applied_at, " +
  "payment_method, paid_at, qr_issued_at, qr_expires_at, qr_consumed_at, qr_delivery_channel, " +
  "rejection_reason";

/**
 * 申請一覧（画面ID C7 ／ v13 §5.10.4 Step 3）。新しい順。
 *
 * ★ **ロールで絞らない。** 何件返るかは `0037` の RLS が決める
 * （admin は全件 ／ それ以外は自分の申請だけ）。ここで条件を足すと境界が2箇所に分かれる。
 */
export async function fetchApplications(limit = 50): Promise<ApplicationListItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("membership_applications")
    .select(LIST_COLUMNS)
    .order("applied_at", { ascending: false })
    .limit(limit);

  if (error || data === null) {
    return [];
  }

  const rows = data as unknown as Record<string, unknown>[];
  const labels = await fetchApplicantLabels(rows.map((row) => String(row.member_id)));

  return rows.map((row) => ({
    applicationId: String(row.application_id),
    memberId: String(row.member_id),
    applicantLabel: labels.get(String(row.member_id)) ?? "（表示名なし）",
    status: row.status as ApplicationStatus,
    billedAmountYen: Number(row.billed_amount_yen),
    grantedNights: Number(row.granted_nights),
    appliedAt: String(row.applied_at),
    paymentMethod: row.payment_method === null ? null : String(row.payment_method),
    paidAt: row.paid_at === null ? null : String(row.paid_at),
    qrIssuedAt: row.qr_issued_at === null ? null : String(row.qr_issued_at),
    qrExpiresAt: row.qr_expires_at === null ? null : String(row.qr_expires_at),
    qrConsumedAt: row.qr_consumed_at === null ? null : String(row.qr_consumed_at),
    qrDeliveryChannel: row.qr_delivery_channel === null ? null : String(row.qr_delivery_channel),
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason),
  }));
}

/** 申請1件の現況（操作の事前判定に使う最小限）。読めなければ `null`（他人の申請も同じ）。 */
export async function fetchApplicationState(applicationId: string): Promise<{
  status: ApplicationStatus;
  paymentMethod: string | null;
  paidAt: string | null;
} | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("membership_applications")
    .select("status, payment_method, paid_at")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (data === null) {
    return null;
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    status: row.status as ApplicationStatus,
    paymentMethod: row.payment_method === null ? null : String(row.payment_method),
    paidAt: row.paid_at === null ? null : String(row.paid_at),
  };
}

/**
 * 入金QRを発行して「QR送付済み」へ進める（§5.10.4 Step 3）。
 *
 * ★ 保存するのは**ハッシュだけ**である。平文は呼び出し側が1度だけ画面へ返す
 * （2026-09-10 A案 ／ 精算QRと同一規格）。
 */
export async function issueMembershipQr(params: {
  applicationId: string;
  tokenHash: string;
  expiresAt: Date;
  channel: string;
  issuedBy: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("membership_applications")
    .update({
      status: "QR送付済み",
      qr_token_hash: params.tokenHash,
      qr_issued_by: params.issuedBy,
      qr_issued_at: new Date().toISOString(),
      qr_expires_at: params.expiresAt.toISOString(),
      qr_delivery_channel: params.channel,
      payment_method: "settlement_qr",
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", params.applicationId);

  return error === null;
}

/**
 * 決済の記録（§5.10.7）。
 *
 * ★ 現金のときだけ `received_by` を入れる（`0037` の CHECK が受領者を要求する）。
 * 現金へ切り替えた時点で、発行済みQRは `0037` のトリガーが失効させる（二重受領の防止）。
 */
export async function recordPayment(params: {
  applicationId: string;
  method: string;
  receivedBy: string | null;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("membership_applications")
    .update({
      payment_method: params.method,
      paid_at: new Date().toISOString(),
      received_by: params.method === "cash" ? params.receivedBy : null,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", params.applicationId);

  return error === null;
}

/** 却下（§5.10.4「理由を入力し、ユーザーへ通知する」）。理由は `0037` の CHECK が必須にしている。 */
export async function rejectApplication(params: {
  applicationId: string;
  reason: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("membership_applications")
    .update({
      status: "却下",
      rejection_reason: params.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", params.applicationId);

  return error === null;
}

/**
 * 承認（§5.10.4 Step 5 ＋ §5.10.5 の完了処理）。
 *
 * ★ **ここだけ `service_role` を使う。** 承認は「申請の更新 ＋ role 昇格 ＋ 宿泊券付与 ＋
 * キャッシュバック起票」の4つが揃って初めて意味を持ち、分割すると「権限は上がったが宿泊券が無い」
 * 「申込中のまま付与済み」が残る（後者は**二重付与**に直結する）。
 * したがって処理は `approve_membership_application()`（`0038`）が1トランザクションで行う。
 *
 * 関数側も**申告された操作者が admin かを自分で確かめる**ので、
 * 呼び出し側の判定を通しても通さなくても DB で止まる（二重防御 ／ v13 §5.9.3）。
 */
export async function approveApplication(params: {
  applicationId: string;
  operatorId: string;
}): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin.rpc("approve_membership_application", {
    p_application_id: params.applicationId,
    p_operator_id: params.operatorId,
  });

  // ⚠️ DB 側の例外メッセージを画面へ出さない（内部の識別子が混ざる／CLAUDE.md §3.2）。
  return error === null;
}

async function fetchApplicantLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
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
