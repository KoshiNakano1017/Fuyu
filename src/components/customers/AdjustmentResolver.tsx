"use client";

import { useActionState } from "react";

import { Money } from "@/components/ui/Money";
import type { PendingAdjustment } from "@/lib/customers/fetch-customers";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type ResolveAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 未処理差額の消し込み（画面ID C11 の一部 ／ WBS 8-3 ／ v13 §5.6.6）。
 *
 * ## 「精算済み」と「免除」を別のボタンにする
 *
 * 前者は**受け取った**（現地で現金・QR・返金のいずれかで渡した）、後者は**諦めた**である。
 * 1つのボタンにまとめると、後から回収率も未収の実態も読めない。
 *
 * ## 滞留した行は消し込みの対象にしない
 *
 * `isStale`（後続の修正で意味を失った行）には操作を出さない。無効になった請求を
 * 「精算済み」として記録すると、**実際に受け取ったのかが後から読めなくなる**。
 * 旗として見せるだけにする（v13 §5.6.6 の滞留アラート）。
 *
 * ## 繰越は消込ではない
 *
 * §5.6.6 の [!important]：繰越を選んでも差額は未処理のまま残る。
 * 「繰越」ボタンを置かないのはそのためで、**消えるのは精算か免除の時点だけ**である。
 */
export function AdjustmentResolver({
  memberId,
  adjustments,
  resolve,
}: {
  memberId: string;
  adjustments: readonly PendingAdjustment[];
  resolve: ResolveAction;
}) {
  if (adjustments.length === 0) {
    return <p className="text-sm text-neutral-600">未処理の差額はありません。</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {adjustments.map((adjustment) => (
        <AdjustmentRow
          key={adjustment.adjustmentId}
          memberId={memberId}
          adjustment={adjustment}
          resolve={resolve}
        />
      ))}
    </ul>
  );
}

function AdjustmentRow({
  memberId,
  adjustment,
  resolve,
}: {
  memberId: string;
  adjustment: PendingAdjustment;
  resolve: ResolveAction;
}) {
  const [state, submit, isPending] = useActionState(resolve, SUBMIT_IDLE);

  return (
    <li className="flex flex-col gap-1 rounded border border-neutral-200 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm">
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">{adjustment.category}</span>{" "}
          <Money priceYen={Math.abs(adjustment.amountYen)} />
        </span>
        <span className="text-xs text-neutral-500">
          {new Date(adjustment.occurredAt).toLocaleDateString("ja-JP")}
          {adjustment.isStale ? (
            <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-amber-900">
              後続の修正で無効
            </span>
          ) : null}
        </span>
      </div>

      <p className="text-xs text-neutral-700">{adjustment.reason}</p>

      {adjustment.isStale ? (
        <p className="text-xs text-neutral-600">
          この行は後続の修正で意味を失っています（消し込みの対象外）。
        </p>
      ) : (
        <form action={submit} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="adjustmentId" value={adjustment.adjustmentId} />
          <input type="hidden" name="memberId" value={memberId} />
          <button
            type="submit"
            name="resolution"
            value="settle"
            disabled={isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            精算済みにする
          </button>
          <button
            type="submit"
            name="resolution"
            value="waive"
            disabled={isPending}
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs"
          >
            免除する
          </button>
        </form>
      )}

      {state.status === "idle" || state.message === undefined ? null : (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"}>
          {state.message}
        </p>
      )}
    </li>
  );
}
