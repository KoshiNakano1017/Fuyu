/**
 * 宿泊券の手動増減の判定（WBS 10-4 ／ v13 §5.8.5「運営による手動増減」）。
 *
 * ## 残高を上書きしない
 *
 * 増減は `stay_ticket_transactions` へ **`staff_adjust` の1行を積む**ことで表す
 * （`0016`）。チェックアウト時の自動消費と手動調整が同一残高へ作用するため、
 * 残高は取引の積み上げで算出する（同節「消費との整合」）。**保存された残高を
 * 直接書き換える口はどこにも作らない。**
 *
 * ## 操作できるのは admin と core_member（2026-09-25 決定 §23-3）
 *
 * 正本 v13 §5.8.5 が「管理者・コアメンバーが顧客管理画面から加算／減算できる」と定めており、
 * 認可の実体である RLS（`0016` の `stay_tx_insert_staff`）も staff で一致している。
 * `API設計.md` と `画面設計.md` C8 が `admin` のみと書いていた食い違いは、
 * 同決定で正本側に合わせて訂正済み（Issue #95）。
 *
 * ## 理由は必須である
 *
 * v13 §5.8.5「増減操作時は理由の入力を必須とする」。ここで弾くのは利用者へ理由を返すためで、
 * 実体は `0016` の `chk_stay_tx_manual_needs_reason`（`staff_adjust` には
 * 理由と操作者の両方を要求する CHECK）である。画面を経由しない経路でも通らない。
 */

import { isStaff, type Role } from "@/lib/auth/session";

export type StayTicketAdjustDenialReason =
  | "not_permitted"
  | "zero_nights"
  | "not_integer"
  | "reason_required"
  | "would_go_negative";

export type StayTicketAdjustDecision =
  | { allowed: true; nightsAfter: number }
  | { allowed: false; reason: StayTicketAdjustDenialReason };

export type StayTicketAdjustRequest = {
  actorRole: Role;
  /** 符号付きの増減。＋＝加算／−＝減算 */
  nights: number;
  reason: string;
  /** 調整前の残高（`stay_ticket_balance()` の値） */
  currentBalance: number;
};

/** 増減の上限。1回で動かせる幅を絞る（桁の打ち間違いを1回で通さない）。 */
export const STAY_TICKET_ADJUST_MAX_NIGHTS = 100;

export function decideStayTicketAdjustment(
  request: StayTicketAdjustRequest,
): StayTicketAdjustDecision {
  if (!isStaff(request.actorRole)) {
    return { allowed: false, reason: "not_permitted" };
  }

  if (!Number.isInteger(request.nights) || Math.abs(request.nights) > STAY_TICKET_ADJUST_MAX_NIGHTS) {
    return { allowed: false, reason: "not_integer" };
  }

  // 0 泊の調整は記録としても意味を持たない（`0016` の CHECK も 0 を弾く）。
  if (request.nights === 0) {
    return { allowed: false, reason: "zero_nights" };
  }

  if (request.reason.trim() === "") {
    return { allowed: false, reason: "reason_required" };
  }

  const nightsAfter = request.currentBalance + request.nights;

  // ★ 残高をマイナスにしない。宿泊券は「泊まれる権利」であり、負の権利は存在しない
  //   （マイナス残高を許すと、次の付与が先に借金の返済へ消えて付与の意味が変わる）。
  //   ⚠️ 正本はここまで定めていない。誤登録の訂正で消費済みぶんを超えて減らしたい場合に
  //   足りなくなるため、`QUESTIONS.md` へ論点として起票済み（2026-09-25）。
  if (nightsAfter < 0) {
    return { allowed: false, reason: "would_go_negative" };
  }

  return { allowed: true, nightsAfter };
}

/** 拒否の理由を利用者向けの文言にする。内部の識別子は出さない（CLAUDE.md §3.2）。 */
export function stayTicketAdjustDenialMessage(reason: StayTicketAdjustDenialReason): string {
  switch (reason) {
    case "not_permitted":
      return "宿泊券の増減は運営（管理者・コアメンバー）のみが行えます。";
    case "zero_nights":
      return "増減する泊数を入力してください（0 は記録できません）。";
    case "not_integer":
      return `増減は ±${STAY_TICKET_ADJUST_MAX_NIGHTS} 泊までの整数で入力してください。`;
    case "reason_required":
      return "調整の理由を入力してください（v13 §5.8.5 で必須です）。";
    case "would_go_negative":
      return "残高がマイナスになる減算はできません。減らせるのは残っている泊数までです。";
  }
}

/**
 * 監査ログの1行に出す「いくつからいくつへ」を組む（v13 §5.8.5「調整ログ」）。
 *
 * ★ 差分（`nights`）だけを保存しているため、**前後の残高は取引の積み上げから導く**。
 * 保存時点の残高を列に持つと、後から過去の取引を訂正したときに整合が崩れる
 * （イベントソーシングでスナップショットを持つときの典型的な事故）。
 */
export function formatBalanceTransition(nightsBefore: number, nights: number): string {
  return `${nightsBefore} → ${nightsBefore + nights} 泊`;
}
