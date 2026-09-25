/**
 * 名寄せの運営承認キューの読み出しと決着（WBS 10-2 ／ `0039`・`0040`）。
 *
 * ★ **一覧は anon キー ＋ RLS で読む**（`member_link_requests_select_staff`）。
 *   候補の照会と結合だけが `service_role` を要する（照合対象は未結合の会員であり、
 *   運営の RLS では `members` の他人の行を引けても `auth.users` 側は辿れないため、
 *   `matching-store.ts` の関数を使う）。
 *
 * ⚠️ 照合キー（メール・電話）は PII-A である。**ログへ出さない**（CLAUDE.md §3.2）。
 */

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import { findCandidatesByIdentifier, type MatchKind } from "./matching-store";

export type LinkRequestStatus = "保留" | "承認" | "却下";

/** キューに出す候補1件（運営が選ぶ対象）。 */
export type LinkCandidateView = {
  memberId: string;
  /** 表示名（`v_member_public`）。実名は出さない（CLAUDE.md §7.1） */
  displayName: string;
  accountStatus: string;
  isBound: boolean;
};

export type LinkRequestView = {
  requestId: string;
  authUserId: string;
  matchedKind: MatchKind;
  matchedValue: string;
  candidateCount: number;
  reason: string;
  status: LinkRequestStatus;
  createdAt: string;
  rejectReason: string | null;
  /** 保留のときだけ引く（決着済みの申請に選択肢を出さない） */
  candidates: readonly LinkCandidateView[];
};

const REQUEST_COLUMNS =
  "request_id, auth_user_id, matched_kind, matched_value, candidate_count, reason, status, reject_reason, created_at";

/**
 * 承認キューの一覧（v13 §5.8.3 ①）。新しい順。
 *
 * 保留の行についてだけ**候補を引き直す**。キューへ積んだ時点の候補を保存していないのは、
 * その間に結合された会員・退会した会員が混ざるためで、**運営が見るのは常に「いまの候補」**である。
 */
export async function fetchLinkRequests(limit = 50): Promise<LinkRequestView[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("member_link_requests")
    .select(REQUEST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || data === null) {
    return [];
  }

  const rows = data as unknown as Record<string, unknown>[];

  return Promise.all(
    rows.map(async (row) => {
      const status = row.status as LinkRequestStatus;
      const matchedKind = row.matched_kind as MatchKind;
      const matchedValue = String(row.matched_value);

      return {
        requestId: String(row.request_id),
        authUserId: String(row.auth_user_id),
        matchedKind,
        matchedValue,
        candidateCount: Number(row.candidate_count),
        reason: String(row.reason),
        status,
        createdAt: String(row.created_at),
        rejectReason: row.reject_reason === null ? null : String(row.reject_reason),
        candidates:
          status === "保留"
            ? await fetchCandidateViews({ kind: matchedKind, value: matchedValue })
            : [],
      };
    }),
  );
}

/** 保留中の申請1件（決着の事前判定に使う）。 */
export async function fetchLinkRequestState(requestId: string): Promise<{
  status: LinkRequestStatus;
  authUserId: string;
  matchedKind: MatchKind;
  matchedValue: string;
  candidateCount: number;
} | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("member_link_requests")
    .select("status, auth_user_id, matched_kind, matched_value, candidate_count")
    .eq("request_id", requestId)
    .maybeSingle();

  if (data === null) {
    return null;
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    status: row.status as LinkRequestStatus,
    authUserId: String(row.auth_user_id),
    matchedKind: row.matched_kind as MatchKind,
    matchedValue: String(row.matched_value),
    candidateCount: Number(row.candidate_count),
  };
}

/** 却下（理由必須 ／ `0039` の CHECK が DB 側でも要求する）。 */
export async function rejectLinkRequest(params: {
  requestId: string;
  reason: string;
  resolvedBy: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("member_link_requests")
    .update({
      status: "却下",
      reject_reason: params.reason,
      resolved_by: params.resolvedBy,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("request_id", params.requestId)
    .eq("status", "保留")
    .select("request_id");

  return error === null && data !== null && data.length > 0;
}

/**
 * 候補の表示名を引く。
 *
 * ★ `v_member_public`（表示名だけのビュー）から引く。**実名は出さない**
 * （CLAUDE.md §7.1 ／ `member_profiles_private` は覗かない）。
 * 運営は表示名・会員番号で人を特定する運用である（v13 §5.6.1）。
 */
async function fetchCandidateViews(params: {
  kind: MatchKind;
  value: string;
}): Promise<LinkCandidateView[]> {
  const candidates = await findCandidatesByIdentifier(params);
  if (candidates.length === 0) {
    return [];
  }

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("v_member_public")
    .select("member_id, display_name")
    .in(
      "member_id",
      candidates.map((candidate) => candidate.memberId),
    );

  const labels = new Map(
    ((data ?? []) as { member_id: string; display_name: string | null }[]).map((row) => [
      row.member_id,
      row.display_name ?? "（表示名なし）",
    ]),
  );

  return candidates.map((candidate) => ({
    memberId: candidate.memberId,
    displayName: labels.get(candidate.memberId) ?? "（表示名なし）",
    accountStatus: candidate.accountStatus,
    isBound: candidate.isBound,
  }));
}
