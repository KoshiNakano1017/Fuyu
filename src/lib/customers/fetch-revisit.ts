/**
 * 再訪アラートの材料を読む（WBS 10-3）。判定は `revisit.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS。`check_ins` / `members` / `settlement_adjustments` のいずれも
 *   staff ポリシー越しに読む。**`service_role` は使わない**。
 *
 * ⚠️ 実名を読まない。表示名は `v_member_public`（`0009`）のニックネーム／会員番号である。
 *   このアラートは店員タブレットにも出る＝客から見える位置に表示されうる。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import { selectRevisitAlerts, type RevisitAlert } from "./revisit";

export async function fetchRevisitAlerts(): Promise<RevisitAlert[]> {
  const supabase = await createServerSupabaseClient();

  const { data: stays } = await supabase
    .from("check_ins")
    .select("member_id")
    .eq("status", "staying");

  const memberIds = [
    ...new Set(((stays ?? []) as { member_id: string }[]).map((row) => row.member_id)),
  ];
  if (memberIds.length === 0) {
    return [];
  }

  const [members, labels, adjustments] = await Promise.all([
    supabase.from("members").select("member_id, member_type, stay_tickets").in("member_id", memberIds),
    supabase.from("v_member_public").select("member_id, display_name").in("member_id", memberIds),
    supabase
      .from("settlement_adjustments")
      .select("amount_yen, orders!inner(purchaser_id)")
      .eq("status", "未処理"),
  ]);

  const labelByMember = new Map(
    ((labels.data ?? []) as { member_id: string; display_name: string | null }[]).map((row) => [
      row.member_id,
      row.display_name ?? "（表示名なし）",
    ]),
  );

  const stayingMembers = ((members.data ?? []) as {
    member_id: string;
    member_type: string;
    stay_tickets: number;
  }[]).map((row) => ({
    memberId: row.member_id,
    memberLabel: labelByMember.get(row.member_id) ?? "（表示名なし）",
    memberType: row.member_type,
    stayTickets: row.stay_tickets,
  }));

  // 差額は伝票にぶら下がっているため、会員へは `orders.purchaser_id` を介して辿る。
  // PostgREST の埋め込みは1件でも配列で来ることがあるので、どちらの形でも読めるようにする。
  const pendingAdjustments = ((adjustments.data ?? []) as unknown as {
    amount_yen: number;
    orders: unknown;
  }[]).flatMap((row) => {
    const owners = Array.isArray(row.orders) ? row.orders : [row.orders];
    return owners
      .map((owner) => (owner as { purchaser_id?: unknown } | null)?.purchaser_id)
      .filter((memberId): memberId is string => typeof memberId === "string")
      .map((memberId) => ({ memberId, amountYen: Number(row.amount_yen) }));
  });

  return selectRevisitAlerts({ stayingMembers, pendingAdjustments });
}
