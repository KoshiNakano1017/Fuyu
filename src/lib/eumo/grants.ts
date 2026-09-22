/**
 * Eumo給付の判定（WBS 5-5・5-7・12-4）。DB へ触らない純関数だけを置く。
 *
 * 根拠: v13 §5.3.1（給付種別・用途・手動起票・本人の受領報告 ／ 発行依頼→発行済み未受領→受領済み）、
 *       v13 §5.10.8（初回来訪キャッシュバックのチェックイン連動 ／ 二重付与の防止）、
 *       `CONSOLIDATED_DECISIONS.md` 2026-09-22（#59 全面決着）、
 *       `supabase/migrations/0023_eumo_grants.sql`（3ステータス・4種別・CHECK 制約）。
 *
 * ## 「送付した」と「受け取られた」を混ぜない
 *
 * `0023` のコメントがそのまま設計方針である。Phase 1 の受領確認は**人の操作**であり、
 * eumo 側の API で自動確認する手段は無い（Phase 2）。したがって
 * 「送ったつもりで届いていない」給付が必ず生まれる。2つを別の事実として持ち、
 * 送付済のまま滞留しているものを一覧で拾えるようにする（§5.3.1）。
 */

/** 保存値（`eumo_grants.status`）。 */
export type GrantStatus = "未送付" | "送付済" | "受領確認済" | "送付失敗";

/** 給付の種別（`eumo_grants.grant_type`）。 */
export type GrantType = "quest_reward" | "first_visit_cashback" | "registration_cashback" | "manual";

/** 送付経路（`eumo_grants.sent_channel`）。 */
export type SentChannel = "email" | "line" | "in_person";

/**
 * 画面に出す呼称（v13 §5.3.1 の 2026-08-29 レビュー用語）。
 *
 * **保存値は変えない。** 「発行依頼」という語で DB を作り直すと、
 * 既に入っている行と突き合わせられなくなる。対応づけだけを1箇所に置く。
 */
export const GRANT_STATUS_LABELS: Record<GrantStatus, string> = {
  未送付: "発行依頼",
  送付済: "発行済み・未受領",
  受領確認済: "受領済み",
  送付失敗: "送付失敗",
};

export const GRANT_TYPE_LABELS: Record<GrantType, string> = {
  quest_reward: "クエスト報酬",
  first_visit_cashback: "初回来訪キャッシュバック",
  registration_cashback: "街人登録キャッシュバック",
  manual: "手動起票",
};

/** 送付済のまま滞留とみなす日数（v13 §5.3.1）。 */
export const STALE_SENT_THRESHOLD_DAYS = 14;

export type GrantRejection =
  | "not_staff"
  | "already_sent"
  | "already_received"
  | "not_sent_yet"
  | "blank_channel"
  | "blank_reason"
  | "invalid_amount"
  | "blank_purpose";

export type GrantDecision = { allowed: true } | { allowed: false; reason: GrantRejection };

function isStaffRole(role: string): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * 「送付した」と記録してよいか。
 *
 * 送付済・受領確認済のものを再度「送付した」にできると、`sent_at` が上書きされ、
 * **滞留の起算点が押し戻される**（14日経っても一覧に出てこない）。
 * 送り直しが要るのは `送付失敗` の場合であり、そちらは通す。
 */
export function decideSend(params: {
  actorRole: string;
  status: GrantStatus;
  sentChannel: string;
}): GrantDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "送付済") {
    return { allowed: false, reason: "already_sent" };
  }
  if (params.status === "受領確認済") {
    return { allowed: false, reason: "already_received" };
  }
  if (!isSentChannel(params.sentChannel)) {
    return { allowed: false, reason: "blank_channel" };
  }
  return { allowed: true };
}

function isSentChannel(candidate: string): candidate is SentChannel {
  return candidate === "email" || candidate === "line" || candidate === "in_person";
}

/**
 * 受領確認してよいか。
 *
 * **送る前に「受領確認済」にはできない。** `0023` の `chk_eumo_sent_complete` が
 * DB 側でも同じことを要求している（受領確認済には送付者と送付時刻が要る）。
 */
export function decideConfirmReceipt(params: {
  actorRole: string;
  status: GrantStatus;
  /** 本人の受領報告か（v13 §5.3.1 拡張：本人の報告でも受領確認済にできる） */
  isRecipientSelf?: boolean;
}): GrantDecision {
  if (!isStaffRole(params.actorRole) && params.isRecipientSelf !== true) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "受領確認済") {
    return { allowed: false, reason: "already_received" };
  }
  if (params.status !== "送付済") {
    return { allowed: false, reason: "not_sent_yet" };
  }
  return { allowed: true };
}

/** 送付失敗として記録してよいか。理由が無い失敗は再送の判断ができない（`0023` の CHECK と同じ）。 */
export function decideMarkFailed(params: {
  actorRole: string;
  status: GrantStatus;
  failureReason: string;
}): GrantDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "受領確認済") {
    return { allowed: false, reason: "already_received" };
  }
  if (params.failureReason.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  return { allowed: true };
}

/** 手動起票（v13 §5.3.1 ／ #59 論点1：過去発行分は個別の手動起票で取り込む）。 */
export function decideManualGrant(params: {
  actorRole: string;
  amountUii: number;
  purpose: string;
}): GrantDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (!Number.isInteger(params.amountUii) || params.amountUii <= 0) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (params.purpose.trim() === "") {
    // 用途が空の給付は、後から「何のために送ったのか」を誰も再現できない（§5.3.1）
    return { allowed: false, reason: "blank_purpose" };
  }
  return { allowed: true };
}

/** 送付済のまま滞留しているか（v13 §5.3.1）。 */
export function isStaleSentGrant(params: {
  status: GrantStatus;
  sentAt: string | null;
  now: Date;
}): boolean {
  if (params.status !== "送付済" || params.sentAt === null) {
    return false;
  }
  const elapsedDays = (params.now.getTime() - new Date(params.sentAt).getTime()) / 86_400_000;
  return elapsedDays > STALE_SENT_THRESHOLD_DAYS;
}

/** クエスト報酬の給付行（WBS 5-5 ／ 最終承認で自動起票する）。 */
export type QuestRewardGrant = {
  member_id: string;
  quest_id: string;
  log_id: string;
  amount_uii: number;
  grant_type: "quest_reward";
  purpose: string;
};

/**
 * 承認完了した作業報告から給付行を作る。
 *
 * ## 報酬額が未設定なら起票しない
 *
 * `quests.reward_uii` は NULL を許す（朝会から起案した候補は報酬未設定のままボードに載る
 * ／`src/lib/morning-meetings/quest-candidates.ts`）。額の無い給付を 0 Uii で起こすと、
 * `0023` の `chk_eumo_amount_positive` に弾かれる前に**「送るものがある」一覧に並んでしまう**。
 * 額が決まっていない時点では起票せず、運営が報酬を入れてから手動で起こす。
 */
export function buildQuestRewardGrant(params: {
  memberId: string;
  questId: string;
  questTitle: string;
  logId: string;
  rewardUii: number | null;
}): QuestRewardGrant | null {
  if (params.rewardUii === null || params.rewardUii <= 0) {
    return null;
  }
  return {
    member_id: params.memberId,
    quest_id: params.questId,
    log_id: params.logId,
    amount_uii: params.rewardUii,
    grant_type: "quest_reward",
    purpose: `クエスト報酬「${params.questTitle}」`,
  };
}

/** 初回来訪キャッシュバックの判定結果（v13 §5.10.8 ①③）。 */
export type CashbackJudgement =
  | { kind: "auto_draft"; amountUii: number }
  | { kind: "needs_review"; note: string }
  | { kind: "not_applicable"; note: string }
  | { kind: "already_issued"; status: GrantStatus };

/**
 * 初回来訪キャッシュバックを自動起票してよいか（WBS 12-4 ／ v13 §5.10.8）。
 *
 * ## 初回かどうかは都度算出する
 *
 * 「初回来訪」を保存カラムで持たない（§5.10.8 ①）。来訪記録（`check_ins`）から数える。
 * 保存すると、チェックインの取消・名寄せのやり直しで実態とずれ、**ずれたことに誰も気づけない**。
 *
 * ## 判定が疑わしい会員は自動起票しない（#59 論点2 ／ 2026-09-22 決着）
 *
 * 街人リストの列（コイン残高等）を根拠にした一括判定ロジックは**作らない**と決まった。
 * 移行で取り込んだ会員（`imported_from` が入っている＝システム導入前から居る街人）は、
 * 既にキャッシュバックを受け取っている可能性を**アプリ側からは判定できない**。
 * したがって `eumo_grants` に記録が無い限り一律「要確認」を返し、運営の個別判断に回す。
 * 自動起票してしまうと**二重付与**になり、後から取り消せない（eumo 側の送金はアプリ外）。
 */
export function judgeFirstVisitCashback(params: {
  memberType: string;
  /** `check_ins` から数えた来訪回数（今回を含む） */
  visitCount: number;
  /** 既存のキャッシュバック給付（first_visit_cashback / registration_cashback） */
  existingCashbackStatus: GrantStatus | null;
  /** 移行データ由来の会員か（`members.imported_from` が入っているか） */
  isImportedMember: boolean;
  /** 所属プランのキャッシュバック額。判別できなければ null */
  planCashbackUii: number | null;
}): CashbackJudgement {
  if (params.existingCashbackStatus !== null) {
    // 二重付与の防止（§5.10.8 ③）。状態は画面のバッジにそのまま出す
    return { kind: "already_issued", status: params.existingCashbackStatus };
  }
  if (params.memberType === "ゲスト") {
    return { kind: "not_applicable", note: "ゲストは初回来訪キャッシュバックの対象外です。" };
  }
  if (params.visitCount > 1) {
    return {
      kind: "not_applicable",
      note: `再訪（通算${params.visitCount}回目）のため対象外です。`,
    };
  }
  if (params.isImportedMember) {
    return {
      kind: "needs_review",
      note: "システム導入前からの街人です。過去にキャッシュバックを受け取っていないか運営が確認してください（#59）。",
    };
  }
  if (params.planCashbackUii === null || params.planCashbackUii <= 0) {
    return {
      kind: "needs_review",
      note: "加入プランを判別できないため、給付額を確定できません（v13 §5.10.8 ②）。",
    };
  }
  return { kind: "auto_draft", amountUii: params.planCashbackUii };
}

/** 来訪バッジの文言（v13 §5.10.8 ①）。 */
export function visitBadgeLabel(visitCount: number): string {
  return visitCount <= 1 ? "🌱 初回来訪" : `再訪（通算${visitCount}回目）`;
}
