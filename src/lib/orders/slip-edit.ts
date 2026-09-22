/**
 * 伝票の編集・付替・取消の判定（WBS 7-2 ／ v13 §5.6.2〜§5.6.6）。
 *
 * DB へ触らない純関数だけを置く。実際の書き込みは `edit-slip-store.ts`、
 * 画面からの入口は `src/app/admin/customers/[memberId]/actions.ts` が持つ。
 *
 * ## ここが守っているもの
 *
 * | 仕様 | 実体 |
 * | --- | --- |
 * | §5.6.4 編集理由の必須入力 | `requireReason()` を全操作の入口に置く |
 * | §5.6.3-5 編集したら旧QRを自動失効 | `planSlipEdit()` が `revokeQr` を返す |
 * | §5.6.5-2 精算済み伝票の差額を明示 | `planSlipEdit()` が `adjustment` を返す |
 * | §5.6.5-3 差額は未処理として残す | 区分は `categoryOf()`（`billing/adjustment.ts`）と同じ規則 |
 * | §5.6.2 取消は論理削除 | `decideCancel()` は削除を返さない。取消理由と操作者を要求する |
 *
 * ## なぜ「差額」を編集処理の中で決めるのか
 *
 * 精算済みの伝票を直すと、**既に受け取った金額と帳簿がずれる**。
 * ずれを後から別画面で手入力させると、直した人と差額を立てた人が別になり、
 * 「直したのに差額が立っていない」状態が生まれる。編集の結果として必ず出る値なので、
 * 編集の計画（`planSlipEdit`）が同時に返す。
 */

import type { Role } from "@/lib/auth/session";
import { categoryOf, toSignedUii, type AdjustmentCategory } from "@/lib/billing/adjustment";

import { calculateOrderTotals, type OrderLine, type OrderTotals } from "./totals";

export type OrderStatus = "未会計" | "精算済み" | "取消";

export type EditRejection =
  | "not_staff"
  | "blank_reason"
  | "order_cancelled"
  | "empty_lines"
  | "invalid_quantity"
  | "invalid_price"
  | "same_purchaser";

export type EditDecision = { allowed: true } | { allowed: false; reason: EditRejection };

/** 編集で生じた差額（v13 §5.6.5-2）。精算済みの伝票を直したときだけ生まれる。 */
export type SettlementDifference = {
  amountYen: number;
  amountUii: number;
  category: AdjustmentCategory;
};

export type SlipEditPlan = {
  totals: OrderTotals;
  /** 精算済みの伝票への編集か（v13 §5.6.5 の警告・監査の対象） */
  isRetroactive: boolean;
  /** 差額。0 円なら `null`（0 円の調整行は作らない＝`chk_settlement_adj_amount_not_zero`） */
  difference: SettlementDifference | null;
  /** 旧QRを失効させるか（v13 §5.6.3-5） */
  revokeQr: boolean;
};

/**
 * 編集してよいか。
 *
 * **精算済みでも編集できる**（v13 §5.6.5 が明示的に許可している）。止めるのは取消済みだけで、
 * 取り消した伝票を直せると「取消なのに金額が動く」履歴が残ってしまう。
 */
export function decideSlipEdit(params: {
  actorRole: Role;
  orderStatus: OrderStatus;
  reason: string;
  lines: readonly OrderLine[];
}): EditDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.reason.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  if (params.orderStatus === "取消") {
    return { allowed: false, reason: "order_cancelled" };
  }
  if (params.lines.length === 0) {
    // 明細を全部消すのは「取消」であって編集ではない（§5.6.2 は別の操作として定める）。
    // 0円の伝票を残すと、未会計一覧に金額 0 の行が並び、取消済みと見分けがつかない。
    return { allowed: false, reason: "empty_lines" };
  }
  if (params.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) {
    return { allowed: false, reason: "invalid_quantity" };
  }
  if (params.lines.some((line) => !Number.isInteger(line.unitPriceYen) || line.unitPriceYen < 0)) {
    // 単価の上書きは特例値引き・イベント価格のために認められている（§5.6.2）。
    // ただし負の単価は「返金を明細で表現する」ことになり、差額（§5.6.6）の経路と二重になる。
    return { allowed: false, reason: "invalid_price" };
  }
  return { allowed: true };
}

/**
 * 編集の結果を組み立てる。**判定（`decideSlipEdit`）を通ったことが前提**である。
 *
 * `settledAmountYen` は「既に精算した金額」＝編集前の伝票合計である。
 * 未会計の伝票では差額の概念が無いため使わない（請求額が変わるだけ）。
 */
export function planSlipEdit(params: {
  lines: readonly OrderLine[];
  orderStatus: OrderStatus;
  settledAmountYen: number;
  hasActiveQr: boolean;
}): SlipEditPlan {
  const totals = calculateOrderTotals(params.lines);
  const isRetroactive = params.orderStatus === "精算済み";
  const differenceYen = isRetroactive ? totals.totalAmountYen - params.settledAmountYen : 0;

  return {
    totals,
    isRetroactive,
    difference:
      differenceYen === 0
        ? null
        : {
            amountYen: differenceYen,
            amountUii: toSignedUii(differenceYen),
            category: categoryOf(differenceYen),
          },
    // 失効させるのは「生きているQRがある」ときだけ。無い伝票にまで失効時刻を書くと、
    // 「発行していないのに失効している」という読めない状態が残る。
    revokeQr: params.hasActiveQr,
  };
}

/**
 * 注文者の付け替え（v13 §5.6.2「代理注文の誤選択を救済」）。
 *
 * 付替先が同じ人なら何もしない。理由の必須は他の編集と同じである。
 */
export function decideReassign(params: {
  actorRole: Role;
  orderStatus: OrderStatus;
  reason: string;
  currentPurchaserId: string;
  nextPurchaserId: string;
}): EditDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.reason.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  if (params.orderStatus === "取消") {
    return { allowed: false, reason: "order_cancelled" };
  }
  if (params.nextPurchaserId === "" || params.nextPurchaserId === params.currentPurchaserId) {
    return { allowed: false, reason: "same_purchaser" };
  }
  return { allowed: true };
}

/**
 * 伝票の取消（v13 §5.6.2 ／ §5.6.5-5）。
 *
 * **精算済みの伝票も取り消せる。** その場合は精算額の全額が返金差額になる
 * （§5.6.5-5）。金額の算出は `planCancellation()` が行う。
 */
export function decideCancel(params: {
  actorRole: Role;
  orderStatus: OrderStatus;
  reason: string;
}): EditDecision {
  if (!isStaffRole(params.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (params.reason.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  if (params.orderStatus === "取消") {
    return { allowed: false, reason: "order_cancelled" };
  }
  return { allowed: true };
}

/**
 * 取消に伴う差額（v13 §5.6.5-5「精算額全額を返金差額として計上する」）。
 *
 * 未会計の伝票を取り消しても差額は生まれない（まだ受け取っていない）。
 */
export function planCancellation(params: {
  orderStatus: OrderStatus;
  settledAmountYen: number;
}): SettlementDifference | null {
  if (params.orderStatus !== "精算済み" || params.settledAmountYen === 0) {
    return null;
  }
  const amountYen = -params.settledAmountYen;
  return {
    amountYen,
    amountUii: toSignedUii(amountYen),
    category: categoryOf(amountYen),
  };
}

function isStaffRole(role: Role): boolean {
  return role === "admin" || role === "core_member";
}
