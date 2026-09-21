/**
 * クエストの審査・二段階承認の状態機械（WBS 5-2 / 5-4 / 5-6）。
 *
 * 根拠: v13 §5.3.2「★ クエスト承認の二段階化」の遷移図と4つの確定論点、
 *       v13 §6 権限マトリクス（最終承認は `admin` のみ）。
 *
 * ```text
 * 申請中 → 指示済み → 報告済み → コアメンバー確認済 → 承認完了
 *                        │              │
 *                        └──────────────┴──→ 差戻し
 * ```
 *
 * ## ここが「判定の正本」ではない
 *
 * 最終的な強制は DB のトリガー（`work_logs_guard_approval()` ／ 0017）が行う。
 * `service_role` が RLS も GRANT も迂回するため、アプリ側だけでは守れないからである。
 * 本モジュールは**画面のボタン活性と、API が 403 を返す判断**のために同じ規則を持つ。
 * 規則が2箇所にあるのは冗長ではなく二重防御である（v13 §5.9.3）。
 * ⚠️ 片方だけ変更してはならない。変えるときは 0017 のトリガーと必ず対で直す。
 */

import type { Role } from "@/lib/auth/session";

/** 受注申請のステータス（`quest_applications.status` ／ v13 §7 L2407）。 */
export type QuestApplicationStatus =
  | "申請中"
  | "指示済み"
  | "承認"
  | "差戻し"
  | "完了"
  | "キャンセル";

/** 完了報告の承認ステージ（`work_logs.approval_status` ／ v13 §5.3.2）。 */
export type WorkLogApprovalStatus = "報告済み" | "コアメンバー確認済" | "承認完了" | "差戻し";

/** 審査の操作。画面のボタン1つに対応する。 */
export type ReviewAction = "core_confirm" | "approve" | "reject";

export type ReviewDenialReason =
  | "not_staff"
  | "not_admin"
  | "already_finalized"
  | "blank_reason";

export type ReviewDecision = { allowed: true } | { allowed: false; reason: ReviewDenialReason };

/** 運営（`admin` / `core_member`）か。`isStaff()` と同じ定義を審査文脈で読めるようにした別名。 */
function isReviewer(role: Role): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * 最終承認が済んだ報告は、もう動かさない。
 *
 * 承認完了の瞬間に §5.3.1 の給付予定（`eumo_grants`）が起票されるため、
 * 後から差し戻すと**給付予定だけが残る**。取り消しが要る場合は給付側で行う。
 */
function isFinalized(current: WorkLogApprovalStatus): boolean {
  return current === "承認完了";
}

/**
 * その操作をこのロールが行ってよいか（v13 §5.3.2 の確定論点そのまま）。
 *
 * | 論点 | 確定内容 |
 * | --- | --- |
 * | コアメンバーは最終承認できるか | **できない**。最終承認は `admin` のみ |
 * | 管理者はコアメンバー確認を飛ばせるか | **飛ばせる**（少人数運営で詰まらないようにするため） |
 * | 複数のコアメンバーが確認した場合 | 1人目の確認で遷移。2人目以降は確認ログへ積む |
 */
export function decideReview(params: {
  action: ReviewAction;
  actorRole: Role;
  current: WorkLogApprovalStatus;
  /** 差戻しの理由。`reject` のときだけ見る */
  reason?: string;
}): ReviewDecision {
  const { action, actorRole, current, reason } = params;

  if (!isReviewer(actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (isFinalized(current)) {
    return { allowed: false, reason: "already_finalized" };
  }

  // ★ 最終承認だけは `admin` に限る。ここを `isReviewer` に緩めてはならない。
  if (action === "approve" && actorRole !== "admin") {
    return { allowed: false, reason: "not_admin" };
  }

  // 差戻しは理由が必須（v13 §5.3.2「理由の入力を必須とし、受注者へ通知する」）。
  if (action === "reject" && (reason ?? "").trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }

  return { allowed: true };
}

/** 操作後の承認ステージ。`decideReview()` が許可した場合にのみ使う。 */
export function nextApprovalStatus(action: ReviewAction): WorkLogApprovalStatus {
  switch (action) {
    case "core_confirm":
      return "コアメンバー確認済";
    case "approve":
      return "承認完了";
    case "reject":
      return "差戻し";
  }
}

/**
 * その承認がコアメンバー確認を飛ばしたか（v13 §5.3.2「ログに残す」）。
 *
 * DB のトリガーも同じ判定で `review_skipped` を立てる。こちらは
 * **保存前に画面へ「確認を飛ばして承認します」と出す**ために要る。
 */
export function skipsCoreConfirmation(params: {
  action: ReviewAction;
  current: WorkLogApprovalStatus;
}): boolean {
  return params.action === "approve" && params.current !== "コアメンバー確認済";
}

/**
 * 受注申請に実行指示を出してよいか（WBS 5-2 ／ v13 §5.3-3）。
 *
 * 指示の中身（いつ・どこで・何を）が空のまま「指示済み」にできると、
 * 受注者は何をすればよいか分からないまま承認待ちに入る。
 */
export function canInstruct(params: {
  actorRole: Role;
  current: QuestApplicationStatus;
  instructionBody: string;
}): ReviewDecision {
  if (!isReviewer(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.current !== "申請中") {
    return { allowed: false, reason: "already_finalized" };
  }
  if (params.instructionBody.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  return { allowed: true };
}
