/**
 * メディアの運営措置（非表示化・論理削除）の判定（WBS 14-3 ／ v13 §5.11.7 ③）。
 *
 * ## なぜ Phase 1 で要るのか
 *
 * v13 §5.11.7 の警告がそのまま理由である。アップロードは**ゲストを含む全ロール**へ
 * 開いた（`14-2`）。ということは、**不適切な画像・第三者が写り込んだ写真が投入され得る**。
 * 公開機能だけを出して措置の手段を出さないと、通報を受けても止める操作が無い状態になる。
 *
 * ## 措置は2段ある（消すこととと隠すことを混ぜない）
 *
 * | 措置 | 何が起きるか | 使う場面 |
 * | --- | --- | --- |
 * | **非表示化**（`visibility = '運営のみ'`） | 一般会員・ゲストから見えなくなる。運営には残る | 判断に迷うもの・本人へ確認中のもの |
 * | **削除**（`deleted_at` の論理削除） | 全員から見えなくなる（運営の一覧にも「削除済み」として残る） | 明らかに出してはいけないもの |
 *
 * 非表示化を挟めるようにしているのは、**取り消せる措置を先に置く**ためである。
 * 「まず消す」しか無いと、判断に迷う投稿がそのまま公開され続ける（消すのは重いので躊躇する）。
 *
 * ## 判定はここに1箇所だけ置く
 *
 * 行の可視・不可視は `0027` の RLS が、列の整合は同じマイグレーションの CHECK が守る。
 * ここが持つのは**利用者へ理由を返すための事前判定**であり、DB の代わりではない
 * （画面を経由しない PostgREST 直アクセスは RLS が拒否する）。
 */

import { isStaff, type Role } from "@/lib/auth/session";

export type MediaVisibility = "公開" | "運営のみ";

/** 運営措置の種別。`unhide` は非表示化の取り消しである（削除の取り消しは無い）。 */
export type ModerationAction = "hide" | "unhide" | "delete";

export type ModerationDenialReason =
  | "not_permitted"
  | "already_deleted"
  | "already_hidden"
  | "already_public"
  | "reason_required";

export type ModerationDecision =
  | { allowed: true; requiresReason: boolean }
  | { allowed: false; reason: ModerationDenialReason };

export type ModerationRequest = {
  actorRole: Role;
  /** 措置の対象が操作者自身の投稿か */
  isOwnPost: boolean;
  action: ModerationAction;
  currentVisibility: MediaVisibility;
  isDeleted: boolean;
  /** 入力された理由。未入力は空文字で渡す */
  reason: string;
};

export const MODERATION_ACTION_LABELS: Record<ModerationAction, string> = {
  hide: "非表示にする",
  unhide: "公開に戻す",
  delete: "削除する",
};

/**
 * 措置の可否を決める。
 *
 * - **自分の投稿**は全ロールが削除・公開範囲の変更をできる（v13 §5.11.7 ③ の表）
 * - **他人の投稿**へ手を入れられるのは運営（`admin` / `core_member`）だけである
 * - ★ 運営が**他人の投稿**へ措置するときは理由を必須にする。自分の投稿の取り下げには要らない
 *   （自分のものを下げる判断に説明責任は生じない）
 */
export function decideModeration(request: ModerationRequest): ModerationDecision {
  const staff = isStaff(request.actorRole);

  if (!request.isOwnPost && !staff) {
    return { allowed: false, reason: "not_permitted" };
  }

  // 削除済みの投稿は、もう措置の対象にならない（復元の操作は用意しない）。
  // ストレージ実体の削除はライフサイクルジョブの担当であり（v13 §5.11.4）、
  // 「戻せるつもり」でいられる状態を画面に作らないため。
  if (request.isDeleted) {
    return { allowed: false, reason: "already_deleted" };
  }

  if (request.action === "hide" && request.currentVisibility === "運営のみ") {
    return { allowed: false, reason: "already_hidden" };
  }

  if (request.action === "unhide" && request.currentVisibility === "公開") {
    return { allowed: false, reason: "already_public" };
  }

  const requiresReason = requiresModerationReason(request.action, request.isOwnPost, staff);
  if (requiresReason && request.reason.trim() === "") {
    return { allowed: false, reason: "reason_required" };
  }

  return { allowed: true, requiresReason };
}

/**
 * 理由の入力を要求するか。
 *
 * 運営が**他人の**投稿を非表示化・削除するときだけ必須にする。
 * `unhide`（公開へ戻す）は状態を元へ戻す操作なので求めない。
 */
export function requiresModerationReason(
  action: ModerationAction,
  isOwnPost: boolean,
  actorIsStaff: boolean,
): boolean {
  if (action === "unhide") {
    return false;
  }
  return actorIsStaff && !isOwnPost;
}

/** 拒否の理由を利用者向けの文言にする。内部の識別子は出さない（CLAUDE.md §3.2）。 */
export function moderationDenialMessage(reason: ModerationDenialReason): string {
  switch (reason) {
    case "not_permitted":
      return "他の人の投稿へ措置できるのは運営だけです。";
    case "already_deleted":
      return "この投稿は既に削除されています。";
    case "already_hidden":
      return "この投稿は既に非表示です。";
    case "already_public":
      return "この投稿は既に公開されています。";
    case "reason_required":
      return "他の人の投稿へ措置するときは理由を入力してください。";
  }
}

export type ModerationOffer = {
  action: ModerationAction;
  label: string;
  requiresReason: boolean;
};

/**
 * その投稿へ出せる操作を並べる（画面が出すボタンの出どころ）。
 *
 * ★ **画面にロールを渡さずに済ませるためにある。** クライアント側で判定すると
 * 利用者の手元で書き換えられるので、ボタンの有無はサーバで決めて結果だけを渡す。
 * `decideModeration()` と同じ規則をここでもう一度書かないよう、可否の核はそちらへ委ねる
 * （理由の未入力は「操作を出さない」理由にはならないため、判定用の値を渡している）。
 */
export function listModerationOffers(params: {
  actorRole: Role;
  isOwnPost: boolean;
  currentVisibility: MediaVisibility;
  isDeleted: boolean;
}): ModerationOffer[] {
  const candidates: ModerationAction[] =
    params.currentVisibility === "公開" ? ["hide", "delete"] : ["unhide", "delete"];

  return candidates.flatMap((action) => {
    const decision = decideModeration({
      actorRole: params.actorRole,
      isOwnPost: params.isOwnPost,
      action,
      currentVisibility: params.currentVisibility,
      isDeleted: params.isDeleted,
      // 理由が空でも操作自体は出す（押した時点で必須入力として弾かれる）。
      reason: REASON_PLACEHOLDER_FOR_OFFER,
    });
    if (!decision.allowed) {
      return [];
    }
    return [{ action, label: MODERATION_ACTION_LABELS[action], requiresReason: decision.requiresReason }];
  });
}

/**
 * 操作の一覧を組むときだけ使う仮の理由。
 * 実際の保存には使わない（`moderateMediaAction()` が受け取った入力だけを保存する）。
 */
const REASON_PLACEHOLDER_FOR_OFFER = "(判定用)";
