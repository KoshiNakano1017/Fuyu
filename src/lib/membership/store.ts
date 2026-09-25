/**
 * 街人登録申込の DB 往復（WBS 12-1・12-2 ／ `0037_membership_applications.sql`）。
 * 判定は `registration.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS で読み書きする。**`service_role` は使わない。**
 *   行を絞るのは `0037` の `membership_app_select_self` / `_select_admin` /
 *   `_insert_self` / `_update_admin` であり、金額と状態を守るのは同マイグレーションの
 *   `membership_applications_guard()` トリガーである。
 *
 * ⚠️ **金額・付与泊数を INSERT に含めない。** トリガーがプランから写して上書きするため、
 *   ここで渡す値は無意味であり、渡すと「アプリが金額を決めている」ように読める。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { SignupPlan } from "./registration";

export type ApplicationStatus = "申込中" | "QR送付済み" | "承認済み" | "却下" | "保留";

/** 申込中として扱う状態（`0037` の部分一意索引と同じ3値）。 */
export const ACTIVE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "申込中",
  "QR送付済み",
  "保留",
];

export type MembershipApplication = {
  applicationId: string;
  memberId: string;
  status: ApplicationStatus;
  billedAmountYen: number;
  grantedNights: number;
  appliedAt: string;
};

const APPLICATION_COLUMNS =
  "application_id, member_id, status, billed_amount_yen, granted_nights, applied_at";

/**
 * 現行の登録導線プラン（v13 §5.10.2）。
 *
 * `is_current_signup_plan = true` は1行だけである（`0016`）。年会費額で引くと
 * 30,000円の2行（`phase2_standard` / `phase3`）のどちらが当たるか不定になる。
 */
export async function fetchCurrentSignupPlan(): Promise<SignupPlan | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("membership_plans")
    .select("plan_id, plan_code, display_name, annual_fee_yen, granted_stay_nights, first_cashback_uii")
    .eq("is_current_signup_plan", true)
    .maybeSingle();

  if (data === null) {
    return null;
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    planId: String(row.plan_id),
    planCode: String(row.plan_code),
    displayName: String(row.display_name),
    annualFeeYen: Number(row.annual_fee_yen),
    grantedStayNights: Number(row.granted_stay_nights),
    firstCashbackUii: Number(row.first_cashback_uii),
  };
}

/**
 * 本人の「申込中」の申請（v13 §5.10.3 の二重申請防止）。
 *
 * 既にあるなら**新規に作らず既存を表示する**のが仕様である。
 * RLS の `membership_app_select_self` が他人の行を返さないため、member_id で絞る必要はないが、
 * 明示して読む（他人の行が混ざらないことを読み手に示すため）。
 */
export async function fetchMyActiveApplication(
  memberId: string,
): Promise<MembershipApplication | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("membership_applications")
    .select(APPLICATION_COLUMNS)
    .eq("member_id", memberId)
    .in("status", ACTIVE_APPLICATION_STATUSES as string[])
    .order("applied_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data === null ? null : toApplication(data as unknown as Record<string, unknown>);
}

/**
 * 申請を1件作る（v13 §5.10.3 Step 2 の「承認して申請する」）。
 *
 * ★ 送るのは `member_id` だけである。プラン・金額・付与泊数・状態はすべて
 * `membership_applications_guard()`（`0037`）が決める。二重申請は部分一意索引が弾くため、
 * アプリ側の存在チェックをすり抜けた同時タップも DB で止まる（そのとき `false` が返る）。
 */
export async function insertMembershipApplication(memberId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("membership_applications").insert({
    member_id: memberId,
    // NOT NULL だがトリガーが上書きする。0 を置くのは「ここで決めていない」ことを示すため。
    billed_amount_yen: 0,
    granted_nights: 0,
  });

  return error === null;
}

function toApplication(row: Record<string, unknown>): MembershipApplication {
  return {
    applicationId: String(row.application_id),
    memberId: String(row.member_id),
    status: row.status as ApplicationStatus,
    billedAmountYen: Number(row.billed_amount_yen),
    grantedNights: Number(row.granted_nights),
    appliedAt: String(row.applied_at),
  };
}
