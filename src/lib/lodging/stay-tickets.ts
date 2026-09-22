/**
 * 宿泊券残高の読み出し（WBS 3-4 ／ v13 §5.8.5）。
 *
 * ## 残高はカラムではなく取引の積み上げである
 *
 * `stay_ticket_balance(member_id)`（`0016`）が唯一の出所である。
 * `members.stay_tickets` は取込（WBS 10-x）が埋める**集計キャッシュ**であり、
 * 再計算トリガーがまだ無い（`0016` の注記）。両方を読むと、どちらが正しいのか
 * 画面ごとに違う答えが出る。**読む場所を1つに絞る**（v13 §9 #25）。
 *
 * ## 関数は `SECURITY INVOKER` である
 *
 * 呼び出し元の RLS がそのまま効くので、他人の残高を覗く経路にはならない
 * （本人は自分の明細、staff は全員分が見える）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

/** 宿泊券の取引種別（`stay_ticket_transactions.tx_type` ／ `0016` の CHECK と同じ6値）。 */
export type StayTicketTxType =
  | "initial_grant"
  | "plan_grant"
  | "consume"
  | "gift"
  | "expiry"
  | "staff_adjust";

/** 利用者向けの表示名。内部識別子をそのまま画面へ出さない。 */
export const STAY_TICKET_TX_LABELS: Record<StayTicketTxType, string> = {
  initial_grant: "初期付与",
  plan_grant: "プラン付与",
  consume: "宿泊で使用",
  gift: "譲渡",
  expiry: "失効",
  staff_adjust: "運営による調整",
};

export type StayTicketEntry = {
  txId: string;
  txType: StayTicketTxType;
  /** 符号付きの泊数（＋＝付与／−＝消費・失効） */
  nights: number;
  note: string | null;
  createdAt: string;
};

/** 宿泊券の残高（泊）。読めなければ 0 を返す（画面を落とさない）。 */
export async function fetchStayTicketBalance(memberId: string): Promise<number> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("stay_ticket_balance", { p_member_id: memberId });

  if (error || typeof data !== "number") {
    return 0;
  }
  return data;
}

/**
 * 宿泊券の取引明細（新しい順）。
 *
 * 本人にも見せる（v13 §5.8.5「本人への反映」）。運営が調整したことを本人が知れる形にする、
 * というのが要件の趣旨であり、`0016` に `_select_self` ポリシーが置かれているのもこのためである。
 */
export async function fetchStayTicketHistory(
  memberId: string,
  limit = 20,
): Promise<StayTicketEntry[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("stay_ticket_transactions")
    .select("tx_id, tx_type, nights, note, created_at")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || data === null) {
    return [];
  }
  return (data as Record<string, unknown>[]).map((row) => ({
    txId: String(row.tx_id),
    txType: row.tx_type as StayTicketTxType,
    nights: Number(row.nights),
    note: row.note === null ? null : String(row.note),
    createdAt: String(row.created_at),
  }));
}
