/**
 * チェックイン／チェックアウト操作の判定（WBS 3-2 ／ v13 §5.2.2）。
 *
 * `check_ins.status` の5値（`0014`）が表す状態遷移を、ここ1箇所で定義する。
 *
 * ```
 *   pre_registered ─┐
 *                   ├─► staying ─► checked_out
 *   confirmed ──────┘
 *   （どの段階からでも）─► cancelled   ← WBS 3-3 の担当（本ファイルでは扱わない）
 * ```
 *
 * ## なぜ判定を純関数へ出すのか
 *
 * 遷移の条件が Server Action の中に埋まっていると、**「退館済みの滞在をもう一度
 * チェックインできないこと」**のような性質を試験で固定できない。
 * DB 側は `status` の CHECK（値域）しか縛っておらず、遷移の向きは縛っていない。
 */

export type CheckInStatus =
  | "pre_registered"
  | "confirmed"
  | "staying"
  | "checked_out"
  | "cancelled";

export type CheckInOpRejection =
  | "not_staff"
  | "already_staying"
  | "already_checked_out"
  | "cancelled"
  | "not_staying";

export type CheckInOpDecision = { allowed: true } | { allowed: false; reason: CheckInOpRejection };

function isStaffRole(role: string): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * チェックインしてよいか。
 *
 * 予約段階（`pre_registered` / `confirmed`）からのみ入れる。
 * **退館済みからは戻さない** — 同じ滞在を再開すると、宿泊日数・通算来訪回数の集計が
 * 1回の来訪として潰れる（v13 §5.10.8 の初回判定は来訪記録を数えている）。
 * 連泊のやり直しは新しい `check_ins` を起こす運用である。
 */
export function decideCheckIn(params: {
  actorRole: string;
  status: CheckInStatus;
}): CheckInOpDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "staying") {
    return { allowed: false, reason: "already_staying" };
  }
  if (params.status === "checked_out") {
    return { allowed: false, reason: "already_checked_out" };
  }
  if (params.status === "cancelled") {
    return { allowed: false, reason: "cancelled" };
  }
  return { allowed: true };
}

/** チェックアウトしてよいか。滞在中のものだけを退館させる。 */
export function decideCheckOut(params: {
  actorRole: string;
  status: CheckInStatus;
}): CheckInOpDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "checked_out") {
    return { allowed: false, reason: "already_checked_out" };
  }
  if (params.status !== "staying") {
    return { allowed: false, reason: "not_staying" };
  }
  return { allowed: true };
}

/** 当日の板に出す滞在か（v13 §5.2.2：当日の到着・滞在中・当日の退館）。 */
export function isTodaysStay(params: {
  status: CheckInStatus;
  checkInDate: string;
  checkOutDate: string;
  today: string;
}): boolean {
  if (params.status === "cancelled") {
    return false;
  }
  if (params.status === "staying") {
    // 滞在中は、予定日を過ぎていても板から消さない。消すと延泊・退館忘れが見えなくなる
    return true;
  }
  if (params.status === "checked_out") {
    return params.checkOutDate === params.today;
  }
  return params.checkInDate === params.today;
}
