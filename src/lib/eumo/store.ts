/**
 * Eumo給付の DB 往復（WBS 5-5・5-7・12-4）。判定は `grants.ts`（純関数）が持つ。
 *
 * ★ anon キー ＋ RLS で読み書きする。行を絞るのは `0023` の `eumo_select_self` /
 *   `eumo_select_staff` / `eumo_insert_staff` / `eumo_update_staff` であり、
 *   **`service_role` は使わない**。
 *
 * ⚠️ `sent_to`（送付先メール／LINE ID）は PII-A である（`0023` のコメント）。
 *   staff の一覧にだけ出し、**ログへは出さない**（CLAUDE.md §3.2）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { GrantStatus, GrantType, SentChannel } from "./grants";

export type EumoGrant = {
  grantId: string;
  memberId: string;
  memberLabel: string;
  amountUii: number;
  grantType: GrantType;
  purpose: string;
  status: GrantStatus;
  sentTo: string | null;
  sentChannel: SentChannel | null;
  sentAt: string | null;
  failureReason: string | null;
  createdAt: string;
};

const GRANT_COLUMNS =
  "grant_id, member_id, amount_uii, grant_type, purpose, status, sent_to, sent_channel, sent_at, failure_reason, created_at";

/** 給付一覧（画面ID B10）。新しい順。RLS が staff には全件、本人には自分の分だけを返す。 */
export async function fetchGrants(): Promise<EumoGrant[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("eumo_grants")
    .select(GRANT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error || data === null) {
    return [];
  }

  const rows = data as unknown as Record<string, unknown>[];
  const labels = await fetchMemberLabels(rows.map((row) => String(row.member_id)));

  return rows.map((row) => ({
    grantId: String(row.grant_id),
    memberId: String(row.member_id),
    memberLabel: labels.get(String(row.member_id)) ?? "（表示名なし）",
    amountUii: Number(row.amount_uii),
    grantType: row.grant_type as GrantType,
    purpose: String(row.purpose),
    status: row.status as GrantStatus,
    sentTo: row.sent_to === null ? null : String(row.sent_to),
    sentChannel: (row.sent_channel as SentChannel | null) ?? null,
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    createdAt: String(row.created_at),
  }));
}

/**
 * 表示名をまとめて引く。
 *
 * 読み先は `members` ではなく `v_member_public`（`0009`）である。
 * 他者向けの表示はニックネーム／会員番号であり、`full_name` へのフォールバックは禁止されている
 * （v13 §5.9.5 ／ `src/lib/orders/fetch-orders.ts` と同じ作法）。
 */
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

/** 1件の現在の状態（操作の前に読む）。 */
export async function fetchGrantStatus(grantId: string): Promise<GrantStatus | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("eumo_grants")
    .select("status")
    .eq("grant_id", grantId)
    .maybeSingle();

  return error || data === null ? null : (data.status as GrantStatus);
}

/** 「送付した」と記録する（v13 §5.3.1）。`sent_at` / `sent_by` は DB の CHECK が必須にしている。 */
export async function markGrantSent(params: {
  grantId: string;
  staffId: string;
  sentChannel: SentChannel;
  sentTo: string;
  eumoUrl: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("eumo_grants")
    .update({
      status: "送付済",
      sent_channel: params.sentChannel,
      sent_to: params.sentTo === "" ? null : params.sentTo,
      eumo_url: params.eumoUrl === "" ? null : params.eumoUrl,
      sent_by: params.staffId,
      sent_at: now,
      // 再送の場合は前回の失敗理由を残さない（今回は成功しているため）
      failure_reason: null,
      updated_at: now,
    })
    .eq("grant_id", params.grantId);

  return error === null;
}

/** 受領を確認する（Phase 1 は手動 ／ 本人の受領報告でも可）。 */
export async function markGrantReceived(params: {
  grantId: string;
  confirmedBy: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("eumo_grants")
    .update({
      status: "受領確認済",
      received_confirmed_by: params.confirmedBy,
      received_confirmed_at: now,
      updated_at: now,
    })
    .eq("grant_id", params.grantId);

  return error === null;
}

/** 送付失敗として記録する。理由は `0023` の CHECK が必須にしている。 */
export async function markGrantFailed(params: {
  grantId: string;
  failureReason: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("eumo_grants")
    .update({
      status: "送付失敗",
      failure_reason: params.failureReason,
      updated_at: new Date().toISOString(),
    })
    .eq("grant_id", params.grantId);

  return error === null;
}

export type NewGrant = {
  member_id: string;
  amount_uii: number;
  grant_type: GrantType;
  purpose: string;
  quest_id?: string;
  log_id?: string;
};

/** 給付を1件起こす。ステータスは DB の既定（未送付＝発行依頼）に委ねる。 */
export async function insertGrant(grant: NewGrant): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("eumo_grants").insert(grant);
  return error === null;
}

/**
 * クエスト報酬の給付が既にあるか（二重起票の防止 ／ v13 §7 L2594）。
 *
 * 作業報告（`log_id`）単位で見る。同じクエストでも報告が別なら別の給付である
 * （差戻し後の再提出は別行として積まれる ／ `0017`）。
 */
export async function hasQuestRewardGrant(logId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("eumo_grants")
    .select("grant_id")
    .eq("log_id", logId)
    .eq("grant_type", "quest_reward")
    .limit(1);

  return (data ?? []).length > 0;
}

/**
 * 本人のキャッシュバック給付の状態（v13 §5.10.8 ①③）。
 *
 * 初回来訪・街人登録のどちらの種別も「キャッシュバックを受け取った」ことを表すため、
 * **2種別をまとめて**見る。片方だけ見ると、登録キャッシュバック済みの人に
 * 初回来訪分をもう一度起票してしまう。
 */
export async function fetchCashbackStatus(memberId: string): Promise<GrantStatus | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("eumo_grants")
    .select("status")
    .eq("member_id", memberId)
    .in("grant_type", ["first_visit_cashback", "registration_cashback"])
    .limit(1);

  const rows = (data ?? []) as { status: GrantStatus }[];
  return rows.length === 0 ? null : rows[0].status;
}

/**
 * 通算の来訪回数（v13 §5.10.8 ①：**保存カラムを持たず都度算出**）。
 *
 * 数えるのは「実際に滞在に入った記録」だけである。予約（`pre_registered` /
 * `confirmed`）やキャンセルを数えると、来ていない人が再訪扱いになり、
 * 初回来訪キャッシュバックが**永久に起票されない**。
 */
export async function countVisits(memberId: string): Promise<number> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("check_ins")
    .select("checkin_id, status")
    .eq("member_id", memberId)
    .in("status", ["staying", "checked_out"]);

  return (data ?? []).length;
}

/** 会員の立場と移行由来かどうか（キャッシュバック判定の材料）。 */
export async function fetchMemberOrigin(
  memberId: string,
): Promise<{ memberType: string; isImportedMember: boolean } | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("members")
    .select("member_type, imported_from")
    .eq("member_id", memberId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return {
    memberType: String(data.member_type),
    isImportedMember: data.imported_from !== null,
  };
}

/**
 * 新規登録者に当てるキャッシュバック額（v13 §5.10.8 ② ／ `membership_plans`）。
 *
 * ## プランを会員から引けない
 *
 * `members` には加入プランの列が無い（`0001`）。移行データの年会費額でプランを判別する
 * という仕様（§5.10.8 ②）は、**取り込み済み会員の付帯情報がアプリ側に無い**ため成立しない。
 * したがってここで引けるのは「**いま新規登録したらどのプランになるか**」だけである。
 *
 * アプリ経由で登録した会員（`imported_from` が空）には、この現行プランの額を当てる。
 * 移行由来の会員には当てない——`judgeFirstVisitCashback()` が「要確認」を返す
 * （#59 論点2 ／ 2026-09-22 決着）。
 */
export async function fetchCurrentSignupCashbackUii(): Promise<number | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("membership_plans")
    .select("first_cashback_uii")
    .eq("is_current_signup_plan", true)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  const amount = Number(data.first_cashback_uii);
  return Number.isInteger(amount) && amount > 0 ? amount : null;
}

/**
 * 本人の未受領給付（マイログ表示 ／ WBS 8-4 ／ v13 §5.3.1）。
 *
 * 出すのは「発行依頼（未送付）」と「発行済み・未受領（送付済）」の2つである。
 * 受領済みまで並べると、**いま自分が何かする必要があるのか**が読めなくなる。
 * 行を絞るのは `0023` の `eumo_select_self` であり、他人の給付は返らない。
 */
export async function fetchMyPendingGrants(memberId: string): Promise<EumoGrant[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("eumo_grants")
    .select(GRANT_COLUMNS)
    .eq("member_id", memberId)
    .in("status", ["未送付", "送付済"])
    .order("created_at", { ascending: false });

  if (error || data === null) {
    return [];
  }

  return (data as unknown as Record<string, unknown>[]).map((row) => ({
    grantId: String(row.grant_id),
    memberId: String(row.member_id),
    // 本人の画面なので表示名は引かない（自分の名前を自分へ出しても意味が無い）
    memberLabel: "自分",
    amountUii: Number(row.amount_uii),
    grantType: row.grant_type as GrantType,
    purpose: String(row.purpose),
    status: row.status as GrantStatus,
    sentTo: row.sent_to === null ? null : String(row.sent_to),
    sentChannel: (row.sent_channel as SentChannel | null) ?? null,
    sentAt: row.sent_at === null ? null : String(row.sent_at),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    createdAt: String(row.created_at),
  }));
}
