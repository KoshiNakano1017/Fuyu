import { isStaff, type Role } from "@/lib/auth/session";

/**
 * 買い物リストの状態遷移判定（v13 §5.12.2）。
 *
 * ## ここが遷移順序の正本である
 *
 * DB（`0030_shopping_list_items.sql`）が守るのは「**誰が**状態を変えてよいか」だけで、
 * 「`希望` の次は `買う`」という業務順序は持っていない。0017（クエスト承認）と同じ分担で、
 * トリガーはロール判定が要る禁止事項の専用、業務遷移はアプリ層という切り分けである。
 *
 * ## なぜ例外を投げないのか
 *
 * 認可・バリデーションの判定は**判別可能ユニオンで返す**（`review.ts` と同じ形）。
 * 理由コードは内部識別子であり、利用者向けの文言への変換は呼び出し側が持つ。
 * 判定の試験に DB もセッションも要らない状態を保つため、ここには副作用を置かない。
 */

/** v13 §5.12.2 の5状態。 */
export type ShoppingItemStatus = "希望" | "買う" | "クエスト化済" | "購入済" | "見送り";

export type ShoppingAction =
  /** 運営が購入対象として認める（`希望 → 買う`）。 */
  | "decide_buy"
  /** 運営が買わないと判断する（理由必須）。 */
  | "skip"
  /** 買い出しクエストへ載せる（`買う → クエスト化済`）。 */
  | "convert_to_quest"
  /** 実際に買われた（`クエスト化済` または `買う` → `購入済`）。 */
  | "mark_purchased"
  /** 部分購入で買えなかった分を戻す（`クエスト化済 → 買う`）。 */
  | "return_to_buy"
  /** 登録者本人または運営による取下げ（理由必須）。 */
  | "withdraw";

export type ShoppingDenialReason =
  | "not_staff"
  | "not_owner"
  | "invalid_transition"
  | "blank_reason"
  | "blank_name"
  | "already_withdrawn";

export type ShoppingDecision =
  | { allowed: true; next: ShoppingItemStatus }
  | { allowed: false; reason: ShoppingDenialReason };

/** 各アクションが出発点として許す状態と、到達する状態。 */
const TRANSITIONS: Record<ShoppingAction, { from: readonly ShoppingItemStatus[]; to: ShoppingItemStatus }> = {
  decide_buy: { from: ["希望"], to: "買う" },
  skip: { from: ["希望", "買う"], to: "見送り" },
  convert_to_quest: { from: ["買う"], to: "クエスト化済" },
  // 誰かがクエストを立てずに買ってきた場合も拾えるよう `買う` からも許す（§5.12.3）。
  mark_purchased: { from: ["買う", "クエスト化済"], to: "購入済" },
  // 部分購入。買えなかった品目を `買う` へ戻し、クエスト自体は完了させる（§5.12.3）。
  return_to_buy: { from: ["クエスト化済"], to: "買う" },
  // 取下げは状態を動かさない（`withdrawn_at` を立てる論理削除）。to は形式上の現状維持。
  withdraw: { from: ["希望", "買う", "クエスト化済"], to: "希望" },
};

/** 理由の入力を必須とするアクション（v13 §5.12.2「見送りは理由必須」・§5.12.1 取下げ）。 */
const REASON_REQUIRED: readonly ShoppingAction[] = ["skip", "withdraw"];

function hasText(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * その操作を通してよいか。
 *
 * @param params.isOwner 登録者本人か。取下げの判定にのみ使う。
 */
export function decideStatusChange(params: {
  action: ShoppingAction;
  actorRole: Role;
  current: ShoppingItemStatus;
  withdrawn: boolean;
  isOwner?: boolean;
  reason?: string;
}): ShoppingDecision {
  const { action, actorRole, current, withdrawn, isOwner = false, reason } = params;

  // 取下げ済みは運営でも動かさない。復活させたいなら登録し直す方が履歴が正しくなる。
  if (withdrawn) {
    return { allowed: false, reason: "already_withdrawn" };
  }

  if (action === "withdraw") {
    // 取下げだけは本人にも開ける。自分が言い出した希望を引っ込める操作であるため。
    if (!isOwner && !isStaff(actorRole)) {
      return { allowed: false, reason: "not_owner" };
    }
  } else if (!isStaff(actorRole)) {
    // 「買う／見送り」の判断は運営のみ（v13 §5.12.2・§6）。
    // 自分の希望を自分で承認できると、運営が一度フィルタを通す意味が消える。
    return { allowed: false, reason: "not_staff" };
  }

  const transition = TRANSITIONS[action];
  if (!transition.from.includes(current)) {
    return { allowed: false, reason: "invalid_transition" };
  }

  if (REASON_REQUIRED.includes(action) && !hasText(reason)) {
    return { allowed: false, reason: "blank_reason" };
  }

  return { allowed: true, next: action === "withdraw" ? current : transition.to };
}

export type ShoppingEditDecision = { allowed: true } | { allowed: false; reason: ShoppingDenialReason };

/**
 * 内容を直せる状態（v13 §5.12.1「編集・取下げ」）。
 *
 * `購入済` と `見送り` を外しているのは、どちらも**結論が出た記録**だからである。
 * 買った後に品名や数量を書き換えられると、購入の記録が何に対するものだったか分からなくなり、
 * 見送った後に書き換えられると、見送り理由（§5.12.2 で必須）が別の品目の理由になる。
 * 直したいときは登録し直す方が、言い出した時点と決まった時点の両方が残る。
 */
const EDITABLE_STATUSES: readonly ShoppingItemStatus[] = ["希望", "買う", "クエスト化済"];

/**
 * 品目の内容（品名・数量・優先度等）を直してよいか（v13 §5.12.1「編集・取下げ」）。
 *
 * 状態遷移とは別の判定にしてある。編集は**誰が言い出したか**を動かさない操作であり、
 * 「買う／見送り」のような運営の判断（`decideStatusChange()`）とは通す相手が違う
 * （§6「自分が登録した品目の編集・取下げ」＝本人と運営）。
 */
export function decideEdit(params: {
  actorRole: Role;
  current: ShoppingItemStatus;
  withdrawn: boolean;
  isOwner?: boolean;
  itemName?: string;
}): ShoppingEditDecision {
  const { actorRole, current, withdrawn, isOwner = false, itemName } = params;

  if (withdrawn) {
    return { allowed: false, reason: "already_withdrawn" };
  }

  if (!isOwner && !isStaff(actorRole)) {
    return { allowed: false, reason: "not_owner" };
  }

  if (!EDITABLE_STATUSES.includes(current)) {
    return { allowed: false, reason: "invalid_transition" };
  }

  // 必須は品名のみ（§5.12.1）。編集で空にできると、必須の意味が登録時だけになる。
  if (!hasText(itemName)) {
    return { allowed: false, reason: "blank_name" };
  }

  return { allowed: true };
}

/**
 * ゲストは登録できない（v13 §5.12.1・§6 ／ 2026-09-22 オーナー確定）。
 *
 * ナビの非表示（`navigation.ts`）・RLS・ガードトリガーと合わせて3重に置く。
 * 画面から導線を消しても、Server Action を直接叩かれれば通ってしまうため。
 */
export function canRegister(role: Role): boolean {
  return role !== "guest";
}
