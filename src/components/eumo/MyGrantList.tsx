"use client";

import { useActionState } from "react";

import { GRANT_STATUS_LABELS, GRANT_TYPE_LABELS } from "@/lib/eumo/grants";
// 型だけを取る（`store.ts` はサーバ専用モジュール）。
import type { EumoGrant } from "@/lib/eumo/store";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type ReceiptAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * マイログの「受け取り待ちの給付」（WBS 8-4 ／ v13 §5.3.1・§5.6.6）。
 *
 * ## 本人にも見せる理由
 *
 * 運営側だけが把握していて本人が知らない給付を作らないためである。
 * 未送付のまま止まっている給付を本人が知れる形にする、というのが §5.3.1 の趣旨で、
 * `eumo_grants` に `_select_self` ポリシーが置かれているのもそのためである。
 *
 * ## 受領報告のボタンは「送付済」にだけ出す
 *
 * まだ送られていない給付に「受け取りました」を押せると、
 * 運営には**送った記録が無いのに受領済み**の行が残る。
 */
export function MyGrantList({
  grants,
  reportReceipt,
}: {
  grants: readonly EumoGrant[];
  reportReceipt: ReceiptAction;
}) {
  if (grants.length === 0) {
    return null;
  }

  return (
    <section className="rounded border border-neutral-200 bg-white p-4">
      <h2 className="text-lg font-bold">受け取り待ちのUii給付</h2>
      <ul className="mt-2 flex flex-col gap-3">
        {grants.map((grant) => (
          <MyGrantRow key={grant.grantId} grant={grant} reportReceipt={reportReceipt} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-neutral-600">
        実際の送金は eumo で行われます。届いたら「受け取りました」を押してください。
        押し間違えた場合は運営へお伝えください（本人では戻せません）。
      </p>
    </section>
  );
}

function MyGrantRow({
  grant,
  reportReceipt,
}: {
  grant: EumoGrant;
  reportReceipt: ReceiptAction;
}) {
  const [state, submit, isPending] = useActionState(reportReceipt, SUBMIT_IDLE);

  return (
    <li className="flex flex-col gap-1 rounded border border-neutral-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{grant.amountUii.toLocaleString("ja-JP")} Uii</span>
        <span className="flex items-center gap-2 text-xs">
          <span className="rounded bg-neutral-100 px-2 py-0.5">{GRANT_TYPE_LABELS[grant.grantType]}</span>
          <span className="rounded bg-neutral-200 px-2 py-0.5">{GRANT_STATUS_LABELS[grant.status]}</span>
        </span>
      </div>
      <p className="text-xs text-neutral-700">{grant.purpose}</p>

      {grant.status === "送付済" ? (
        <form action={submit} className="mt-1">
          <input type="hidden" name="grantId" value={grant.grantId} />
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {isPending ? "記録しています…" : "受け取りました"}
          </button>
        </form>
      ) : (
        <p className="text-xs text-neutral-600">運営が発行の手続きをしています。</p>
      )}

      {state.message === undefined ? null : (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-green-700"}>
          {state.message}
        </p>
      )}
    </li>
  );
}
