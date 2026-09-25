/**
 * 街人登録の申請可否と特典表示（WBS 12-1 ／ v13 §5.10.1〜§5.10.3）。
 *
 * ## 特典の数値をここに書かない
 *
 * 30,000円・宿泊券4泊・キャッシュバック 5,000 uii はいずれも `membership_plans`
 * （`0016` の `is_current_signup_plan = true` の1行）から来る。v13 §7 が
 * 「付与数は `membership_plans` マスタから取得し、**コードに直書きしない**」と定めている。
 * ここが持つのは**並べ方と言い回し**だけである。
 *
 * ## 「CB」と略さない・単位を必ず添える（v13 §5.10.2 の [!important]）
 *
 * 8/25 レビューの「街人登録画面で CB 5,000 では分かりにくい」への対応であり、
 * 画面・帳票・通知のいずれでも略さない。数字だけを置くと
 * 「5,000円なのか 5,000 コインなのか」が読み手に判別できない。
 */

import type { Role } from "@/lib/auth/session";

/** 登録導線で提示するプラン（`membership_plans` の1行ぶん）。 */
export type SignupPlan = {
  planId: string;
  planCode: string;
  displayName: string;
  annualFeeYen: number;
  grantedStayNights: number;
  firstCashbackUii: number;
};

export type MembershipApplyDenialReason =
  | "already_member"
  | "already_applied"
  | "plan_unavailable";

export type MembershipApplyDecision =
  | { allowed: true }
  | { allowed: false; reason: MembershipApplyDenialReason };

/**
 * 申請できるか。
 *
 * - **ゲストだけが通る導線である。** 既存会員（`pre_registered` から名寄せされたユーザー）は
 *   本導線を通さない（v13 §5.10.5 ④。名寄せ完了時点で `member` として起動する）
 * - **申込中の申請があれば新規に作らない**（v13 §5.10.3 の二重申請防止）。
 *   DB 側も部分一意索引（`ux_membership_app_active_per_member` ／ `0037`）で塞いでいる
 */
export function decideMembershipApplication(params: {
  actorRole: Role;
  hasActiveApplication: boolean;
  plan: SignupPlan | null;
}): MembershipApplyDecision {
  if (params.actorRole !== "guest") {
    return { allowed: false, reason: "already_member" };
  }
  if (params.hasActiveApplication) {
    return { allowed: false, reason: "already_applied" };
  }
  if (params.plan === null) {
    return { allowed: false, reason: "plan_unavailable" };
  }
  return { allowed: true };
}

export function membershipApplyDenialMessage(reason: MembershipApplyDenialReason): string {
  switch (reason) {
    case "already_member":
      return "すでに街人として登録されています。";
    case "already_applied":
      return "申請はすでに受け付けています。運営からのご案内をお待ちください。";
    case "plan_unavailable":
      return "登録プランを読み込めませんでした。時間をおいて再試行してください。";
  }
}

/**
 * Step 1 に並べる特典（v13 §5.10.2 の表）。
 *
 * 文言は「特典1〜4」の順序そのままにする。金額・泊数・キャッシュバック額は
 * 引数のプランから組む（直書きしない）。
 */
export function buildMembershipBenefits(plan: SignupPlan): readonly string[] {
  return [
    `宿泊券${plan.grantedStayNights}枚（${plan.grantedStayNights}泊分）を登録時に付与`,
    `キャッシュバック ${plan.firstCashbackUii.toLocaleString("ja-JP")} コイン（＝${plan.firstCashbackUii.toLocaleString("ja-JP")} Uii）を付与`,
    "すべてのクエスト受注・申請が解禁（農作業、DIY、まかない補助など全領域）",
    "XP（経験値）・貢献バッジ・Uii（地域通貨）が貯まる",
  ];
}

/** Step 2（確認）に出す確認事項（v13 §5.10.3）。 */
export function buildMembershipConfirmationLines(plan: SignupPlan): readonly string[] {
  return [
    "登録種別：街人",
    `登録料：¥${plan.annualFeeYen.toLocaleString("ja-JP")}`,
    `付与内容：宿泊券${plan.grantedStayNights}枚 ＋ キャッシュバック ${plan.firstCashbackUii.toLocaleString("ja-JP")} コイン・全クエスト解禁`,
  ];
}

/**
 * ★ 支払いの案内文（v13 §5.10.3 の補足表示）。
 *
 * この画面では**支払い情報を入力させない**（#8 の方針）。「申請したのに請求が来ない」
 * 「押した瞬間に課金された」という双方向の誤解を防ぐため、手段は運営から案内すると明示する。
 * 手段は3経路（精算QR・現金・Uii QR ／ §5.10.7）で、クレジットカードは Phase 2 である。
 */
export const MEMBERSHIP_PAYMENT_NOTICE =
  "お支払い方法は、運営からご案内します（QRコード決済・現金・Uii のいずれか）。" +
  "この画面ではお支払い情報の入力は不要です。";

/**
 * ★ 画面文言では「決済」ではなく「申請」と表現する（v13 §5.10.2 の末尾）。
 *
 * この時点では課金が発生せず、実際の決済は管理者からのQR送付後に行われる。
 */
export const MEMBERSHIP_SUBMIT_LABEL = "承認して申請する";
