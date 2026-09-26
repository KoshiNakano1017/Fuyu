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

/** 取り消し（キャンセル・ノーショー）を断る理由。 */
export type StayCancelRejection = "not_staff" | "already_arrived" | "already_cancelled";

export type StayCancelDecision =
  | { allowed: true }
  | { allowed: false; reason: StayCancelRejection };

/**
 * 取り消しの対象になる状態か ＝ **入館前の予約だけ**（v13 §5.2.2「対象」）。
 *
 * 画面（取り消しフォームを出すか）と Server Action（実行してよいか）の両方が
 * この1つの述語を通る。片方だけ条件が古くなると、
 * **フォームは出るのに押すと拒否される**（あるいはその逆）という食い違いになる。
 */
export function isCancellableStayStatus(status: string): boolean {
  return status === "pre_registered" || status === "confirmed";
}

/**
 * 予約を取り消してよいか（WBS 3-3 ／ v13 §5.2.2）。
 *
 * ## なぜ純関数へ出すのか
 *
 * 取り消しの操作場所は**顧客管理画面**（§5.2.2「操作場所」）とチェックイン板の2箇所にあり、
 * 条件を各 Server Action へ直接書くと**2箇所が別々に古くなる**。
 * とりわけ「入館前だけ取り消せる」は DB 側が縛っていない（`0014` は `status` の値域しか
 * 見ておらず、遷移の向きを見ていない）ため、ここで固定しないと試験でも押さえられない。
 *
 * ⚠️ **入館済み（`staying` / `checked_out`）は対象にしない。** 途中退去は「退館」であって
 * キャンセルではなく、キャンセルにすると滞在の記録が通算来訪回数・宿泊履歴（§5.6.8）から
 * 抜け落ちる。
 *
 * 街人・ゲストは実行できない（v13 §6 L2344 の権限行が `−`）。
 */
export function decideStayCancellation(params: {
  actorRole: string;
  status: CheckInStatus;
}): StayCancelDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.status === "cancelled") {
    return { allowed: false, reason: "already_cancelled" };
  }
  if (!isCancellableStayStatus(params.status)) {
    return { allowed: false, reason: "already_arrived" };
  }
  return { allowed: true };
}

/**
 * キャンセル理由の種別（WBS 3-3 ／ v13 §7 ／ `0014` の CHECK 制約と同じ3値）。
 *
 * ★ **この値域を `cancellation.ts` ではなくここへ置く。**
 *   `cancellation.ts` はサーバ専用（`createServerSupabaseClient()` を import する）であり、
 *   選択肢を描くだけのクライアント部品がそこから値を取ると、
 *   **サーバ用の Supabase クライアントがブラウザ側のバンドルへ引き込まれてビルドが落ちる**
 *   （2026-09-22 に Vercel のプレビューで実際に落ちた）。
 *   値域は判定と同じ「純粋な知識」なので、純関数モジュールに置くのが自然である。
 */
export type CancelReasonType = "会員都合" | "ノーショー" | "運営都合";

export const CANCEL_REASON_TYPES: readonly CancelReasonType[] = [
  "会員都合",
  "ノーショー",
  "運営都合",
];

/**
 * 本人向けの表示文言（WBS 3-3 ／ v13 §5.2.2「本人への表示」）。
 *
 * ★ **「運営によりキャンセル」と書く。** 本人が自分で取り消せる導線は Phase 1 に無く、
 *   この取り消しは必ず運営の操作である。状態名（`cancelled`）をそのまま出すと、
 *   本人には**自分が取り消したのか運営が取り消したのかが区別できない**。
 */
export const CANCELLED_BY_OPERATOR_LABEL = "運営によりキャンセル";

/**
 * キャンセル日時の表示。顧客管理画面と本人のマイページで**同じ書式**にするために関数へ寄せる。
 * 解釈できない値はそのまま返す（表示のために事実を捨てない）。
 *
 * ★ **タイムゾーンを `Asia/Tokyo` に固定する。** この関数はサーバ側（Vercel ＝ UTC）で
 *   レンダリングされるため、実行環境の既定時刻に任せると表示が JST−9時間になり、
 *   **夜間のキャンセルは日付まで前日へずれる**。「いつ取り消されたか」は本人への説明と
 *   監査の材料であり（v13 §5.2.2「本人への表示」）、9時間ずれた日時は事実として誤りである。
 */
const CANCELLED_AT_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatCancelledAt(cancelledAt: string): string {
  const parsed = new Date(cancelledAt);
  if (Number.isNaN(parsed.getTime())) {
    return cancelledAt;
  }
  return CANCELLED_AT_FORMAT.format(parsed);
}
