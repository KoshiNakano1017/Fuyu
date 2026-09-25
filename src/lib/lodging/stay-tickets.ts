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
  /** 調整理由。`staff_adjust` では必ず入る（`0016` の CHECK） */
  reason: string | null;
  /** 操作者。自動消費（`consume`）では NULL */
  operatorId: string | null;
  /** 操作者の表示名（`v_member_public` 由来。実名は含まない） */
  operatorLabel: string | null;
  /** ★ この取引の**直前**の残高。差分だけを保存しているため積み上げて導く（v13 §5.8.5） */
  balanceBefore: number;
  occurredAt: string;
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
 * 宿泊券の取引明細（新しい順）＋ 各行の直前残高。
 *
 * 本人にも見せる（v13 §5.8.5「本人への反映」）。運営が調整したことを本人が知れる形にする、
 * というのが要件の趣旨であり、`0016` に `_select_self` ポリシーが置かれているのもこのためである。
 *
 * ## ⚠️ 2026-09-25 修正：`note` という列は存在しない
 *
 * 以前は `note` を select しており、**列が無いので毎回エラーになり、明細が常に空だった**
 * （エラー時に `[]` を返す作りのため、画面は「まだ取引がありません」と出ていた）。
 * 実列は `reason`（`0016`）である。WBS 10-4 の調整ログは理由を出すことが要件なので、
 * ここが空だと要件そのものが成立しない。
 *
 * ## 直前残高の導き方
 *
 * 全件を古い順に積み上げてから新しい順へ並べ替える。`limit` は**表示件数**にだけ効かせ、
 * 積み上げには全件を使う（途中から足すと「いくつからいくつへ」がずれる）。
 */
export async function fetchStayTicketHistory(
  memberId: string,
  limit = 20,
): Promise<StayTicketEntry[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("stay_ticket_transactions")
    .select("tx_id, tx_type, nights, reason, operator_id, occurred_at, created_at")
    .eq("member_id", memberId)
    .order("occurred_at", { ascending: true });

  if (error || data === null) {
    return [];
  }

  const rows = data as Record<string, unknown>[];
  const labels = await fetchOperatorLabels(
    rows.map((row) => (row.operator_id === null ? null : String(row.operator_id))),
  );

  let running = 0;
  const ascending = rows.map((row) => {
    const nights = Number(row.nights);
    const balanceBefore = running;
    running += nights;
    return {
      txId: String(row.tx_id),
      txType: row.tx_type as StayTicketTxType,
      nights,
      reason: row.reason === null ? null : String(row.reason),
      operatorId: row.operator_id === null ? null : String(row.operator_id),
      operatorLabel:
        row.operator_id === null ? null : labels.get(String(row.operator_id)) ?? "（表示名なし）",
      balanceBefore,
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at),
    };
  });

  return ascending.reverse().slice(0, limit);
}

/**
 * 運営による手動増減を1行積む（WBS 10-4 ／ v13 §5.8.5）。
 *
 * ★ `tx_type = 'staff_adjust'` 固定である。呼び出し側に種別を選ばせない
 * （`plan_grant` を名乗った手動付与が混ざると、付与の出どころが追えなくなる）。
 * 理由と操作者は `0016` の CHECK が必須にしているため、ここで省くと DB が拒否する。
 */
export async function insertStayTicketAdjustment(params: {
  memberId: string;
  nights: number;
  reason: string;
  operatorId: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("stay_ticket_transactions").insert({
    member_id: params.memberId,
    tx_type: "staff_adjust",
    nights: params.nights,
    reason: params.reason,
    operator_id: params.operatorId,
  });

  return error === null;
}

async function fetchOperatorLabels(
  operatorIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(operatorIds.filter((id): id is string => id !== null))];
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
