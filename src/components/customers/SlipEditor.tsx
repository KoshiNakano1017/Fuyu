"use client";

import { useActionState } from "react";

import type { CustomerOrder } from "@/lib/customers/fetch-customers";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

export type SlipAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

export type StayOption = { checkinId: string; memberId: string; memberLabel: string };

/**
 * 伝票1件の編集（WBS 7-2 ／ v13 §5.6.2〜§5.6.5）。
 *
 * ## 精算済みの伝票にも編集欄を出す
 *
 * v13 §5.6.5 が「会計済みの伝票も編集可能とする」と明示している。
 * ただし冒頭に警告を出し（§5.6.5-1）、確定すると差額が「未処理」として残る（§5.6.5-3）。
 * 編集を塞いでしまうと、現場は「伝票を取り消して作り直す」という、
 * 履歴がさらに読めなくなる手段を採る。
 *
 * ## 理由欄を1つにまとめている
 *
 * 明細編集・付替・取消・ステータス変更のどれも理由が必須である（§5.6.4）。
 * 操作ごとに別の理由欄を置くと、どれに書けばよいか分からなくなるため、
 * フォームごとに1つだけ置いて必ず送る。
 */
export function SlipEditor({
  order,
  stayOptions,
  editSlip,
  reassign,
  cancelOrder,
  issueQr,
  toggleSettlement,
}: {
  order: CustomerOrder;
  stayOptions: readonly StayOption[];
  editSlip: SlipAction;
  reassign: SlipAction;
  cancelOrder: SlipAction;
  issueQr: SlipAction;
  toggleSettlement: SlipAction;
}) {
  const [editState, submitEdit, editPending] = useActionState(editSlip, SUBMIT_IDLE);
  const [reassignState, submitReassign] = useActionState(reassign, SUBMIT_IDLE);
  const [cancelState, submitCancel] = useActionState(cancelOrder, SUBMIT_IDLE);
  const [qrState, submitQr] = useActionState(issueQr, SUBMIT_IDLE);
  const [statusState, submitStatus] = useActionState(toggleSettlement, SUBMIT_IDLE);

  const isCancelled = order.status === "取消";
  const isSettled = order.status === "精算済み";

  return (
    <li className={`rounded border p-4 ${isCancelled ? "border-neutral-200 bg-neutral-50" : "border-neutral-300"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={isCancelled ? "font-medium line-through" : "font-medium"}>
          {new Date(order.createdAt).toLocaleString("ja-JP")}
          {order.orderChannel === "staff_proxy" ? "（代理注文）" : ""}
        </span>
        <span className="flex items-center gap-2 text-xs">
          <span className="rounded bg-neutral-200 px-2 py-0.5">{order.status}</span>
          <span className="rounded bg-neutral-100 px-2 py-0.5">
            {toServingStatusDisplayLabel(order.servingStatus)}
          </span>
          <span className="text-neutral-700">
            {order.totalAmountUii.toLocaleString("ja-JP")} Uii（¥
            {order.totalAmountYen.toLocaleString("ja-JP")}）
          </span>
        </span>
      </div>

      {isCancelled ? (
        <p className="mt-2 text-xs text-neutral-600">取消理由: {order.cancelReason ?? "（記録なし）"}</p>
      ) : null}

      {isSettled ? (
        <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
          この伝票は精算済みです。修正すると差額が生じ、「未処理の差額」として残ります（v13 §5.6.5）。
        </p>
      ) : null}

      {isCancelled ? null : (
        <form action={submitEdit} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="orderId" value={order.orderId} />
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-neutral-600">
                <th className="py-1">品目</th>
                <th className="py-1">単価（円）</th>
                <th className="py-1">数量</th>
                <th className="py-1">取消</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.itemId}>
                  <td className="py-1">{line.productName}</td>
                  <td className="py-1">
                    <input
                      type="number"
                      name={`unitPrice_${line.itemId}`}
                      min={0}
                      defaultValue={line.unitPriceYen}
                      className="w-24 rounded border border-neutral-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1">
                    <input
                      type="number"
                      name={`quantity_${line.itemId}`}
                      min={1}
                      defaultValue={line.quantity}
                      className="w-16 rounded border border-neutral-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1">
                    <input type="checkbox" name="voidItemId" value={line.itemId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="flex flex-col gap-1 text-xs">
            編集理由（必須）
            <input
              type="text"
              name="reason"
              required
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={editPending}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {editPending ? "保存しています…" : "明細を保存する"}
            </button>
            <button
              type="submit"
              formAction={submitCancel}
              className="rounded border border-red-400 px-3 py-1.5 text-xs text-red-700"
            >
              伝票を取り消す
            </button>
            <button
              type="submit"
              formAction={submitStatus}
              className="rounded border border-neutral-400 px-3 py-1.5 text-xs"
            >
              {isSettled ? "未会計へ戻す" : "精算済みにする"}
            </button>
            {isSettled ? null : (
              <button
                type="submit"
                formAction={submitQr}
                className="rounded border border-neutral-400 px-3 py-1.5 text-xs"
              >
                精算QRを発行する
              </button>
            )}
          </div>
          <Message state={editState} />
          <Message state={cancelState} />
          <Message state={statusState} />
          <Message state={qrState} />
        </form>
      )}

      {isCancelled || stayOptions.length === 0 ? null : (
        <form action={submitReassign} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="orderId" value={order.orderId} />
          <label className="flex flex-col gap-1 text-xs">
            注文者の付け替え先（滞在中）
            <select name="stay" required defaultValue="" className="rounded border border-neutral-300 px-2 py-1">
              <option value="" disabled>
                選んでください
              </option>
              {stayOptions.map((option) => (
                <option key={option.checkinId} value={`${option.checkinId}:${option.memberId}`}>
                  {option.memberLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            理由（必須）
            <input type="text" name="reason" required className="rounded border border-neutral-300 px-2 py-1" />
          </label>
          <button type="submit" className="rounded border border-neutral-400 px-3 py-1.5 text-xs">
            付け替える
          </button>
          <Message state={reassignState} />
        </form>
      )}
    </li>
  );
}

function Message({ state }: { state: SubmitState }) {
  if (state.message === undefined) {
    return null;
  }
  return (
    <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-green-700"}>
      {state.message}
    </p>
  );
}
