/**
 * 名寄せの DB 往復（WBS 10-2 ／ `0025`・`0039`・`0040`）。判定は `matching.ts`（純関数）が持つ。
 *
 * ## ★ ここは `service_role` を使う（使わざるを得ない）
 *
 * 名寄せの実行時点で、本人は**まだ `members` へ結合されていない**。
 * `auth.uid()` から自分の行を引けないため、RLS 越しには候補を探すことも結合することも
 * できない（`0004` の `bindAuthUserToMember()` と同じ鶏と卵の関係）。
 *
 * したがって**この層に置く SQL は最小限にする**。判定はすべて純関数へ出し、
 * ここでは「引く」「積む」「呼ぶ」だけを行う。
 *
 * ⚠️ 照合キー（メール・電話）は PII-A である。**ログへ出さない**（CLAUDE.md §3.2）。
 */

import { SYSTEM_OPERATOR_MEMBER_ID } from "@/lib/auth/binding";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

import { normalizeMatchValue, type MatchCandidate, type MatchKind } from "./matching";

/**
 * 照合キーから候補を探す（v13 §5.8.3「`contact_info` を第1優先」）。
 *
 * ★ 正規化値（`value_normalized`）で引く。大文字小文字・前後の空白の違いで
 * 同一人物を取りこぼさないためで、正規化の規則は DB の生成列と `normalizeMatchValue()` で揃えてある。
 */
export async function findCandidatesByIdentifier(params: {
  kind: MatchKind;
  value: string;
}): Promise<MatchCandidate[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("member_identifiers")
    .select("member_id, is_verified, members!inner(auth_user_id, account_status)")
    .eq("kind", params.kind)
    .eq("value_normalized", normalizeMatchValue(params.value));

  if (error || data === null) {
    return [];
  }

  return (data as unknown as Record<string, unknown>[]).map((row) => {
    const member = row.members as { auth_user_id: string | null; account_status: string };
    return {
      memberId: String(row.member_id),
      isBound: member.auth_user_id !== null,
      accountStatus: member.account_status,
      isIdentifierVerified: row.is_verified === true,
    };
  });
}

/**
 * 名寄せを成立させる（`0040` の RPC）。
 *
 * ★ 結合と監査記録を**1トランザクション**で行う。分けると「結合したが根拠が残っていない」
 * 行が生まれ、他人の宿泊券・残高を引き継いだ経緯を追えなくなる（v13 §5.8.3 ③）。
 *
 * `operatorId` はガードへ申告する操作者である。自動成立ではシステム操作者
 * （`0004` が作る人ではない member）を使い、`decidedBy` は NULL のままにする
 * （＝「システムが決めた」という意味）。
 */
export async function linkMemberByMatching(params: {
  memberId: string;
  authUserId: string;
  matchBasis: string;
  /** 運営承認の場合の決定者。自動成立では渡さない */
  decidedBy?: string;
  requestId?: string;
  /** 照合に使った連絡先（渡すと本人確認済みへ昇格する） */
  identifierKind?: MatchKind;
  identifierValue?: string;
}): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin.rpc("link_member_by_matching", {
    p_member_id: params.memberId,
    p_auth_user_id: params.authUserId,
    p_operator_id: params.decidedBy ?? SYSTEM_OPERATOR_MEMBER_ID,
    p_match_basis: params.matchBasis,
    p_request_id: params.requestId ?? null,
    p_decided_by: params.decidedBy ?? null,
    // 照合に使った連絡先を本人確認済みへ昇格させる（v13 §5.8.3 ②）。
    // 一意制約に当たった場合は関数ごと例外になる（＝候補1件の前提が崩れている状態）。
    p_identifier_kind: params.identifierKind ?? null,
    p_identifier_value: params.identifierValue ?? null,
  });

  // ⚠️ DB 側の例外メッセージを呼び出し側へ返さない（PII と内部識別子が混ざる）。
  return error === null;
}

/**
 * 運営承認キューへ積む（v13 §5.8.3 ①）。
 *
 * ★ 同じ Auth ユーザーの保留は1件だけである（`ux_link_request_pending_per_auth_user`）。
 * ログインを繰り返すたびに積み上がると、運営のキューが同じ人で埋まる。
 * 既に保留があるときは**積まずに成功として返す**（利用者から見た結果は同じ＝待ちである）。
 */
export async function enqueueLinkRequest(params: {
  authUserId: string;
  kind: MatchKind;
  value: string;
  candidateCount: number;
  reason: string;
}): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin.from("member_link_requests").insert({
    auth_user_id: params.authUserId,
    matched_kind: params.kind,
    matched_value: params.value,
    candidate_count: params.candidateCount,
    reason: params.reason,
  });

  if (error === null) {
    return true;
  }

  // 23505 ＝ 保留が既にある（部分一意索引）。待ちであることは変わらないので成功として扱う。
  return error.code === "23505";
}

/**
 * そのメールアドレスが**名寄せの候補を持つか**（ログインのコード送信ゲート）。
 *
 * ★ `requestLoginCode()` は招待台帳の行が無いと `auth.users` を作らせない。
 * それだけだと **§5.8.3 の初回アクセス導線が成立しない** — 事前登録済みの会員は
 * 招待されていなくても、自分の連絡先でログインして名寄せへ入る経路が要る。
 *
 * ⚠️ 判定結果を画面のメッセージに出さない（存在の有無が漏れる）。
 * 呼び出し側は `shouldCreateUser` の値にだけ使う。
 */
export async function hasMatchableIdentifier(email: string): Promise<boolean> {
  const candidates = await findCandidatesByIdentifier({ kind: "email", value: email });
  return candidates.some(
    (candidate) => !candidate.isBound && candidate.accountStatus === "pre_registered",
  );
}

/** その Auth ユーザーの保留中の申請があるか（ログイン画面の文言を決めるのに使う）。 */
export async function hasPendingLinkRequest(authUserId: string): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("member_link_requests")
    .select("request_id")
    .eq("auth_user_id", authUserId)
    .eq("status", "保留")
    .limit(1);

  return data !== null && data.length > 0;
}
