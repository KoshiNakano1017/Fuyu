"use client";

import { useActionState } from "react";

import { GRANT_STATUS_LABELS, GRANT_TYPE_LABELS, isStaleSentGrant } from "@/lib/eumo/grants";
// ⚠️ 型だけを取る。`store.ts` は `next/headers` に依存するサーバ専用モジュールであり、
//    値を import するとクライアントバンドルへ引き込まれる（`import type` はコンパイル時に消える）。
import type { EumoGrant } from "@/lib/eumo/store";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type GrantAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * Eumo給付一覧（画面ID B10 ／ WBS 5-5・5-7 ／ v13 §5.3.1）。
 *
 * ## 呼称は画面だけで読み替える
 *
 * 保存値は `未送付` / `送付済` / `受領確認済` / `送付失敗` のままで、
 * 画面には 2026-08-29 レビューの用語（発行依頼／発行済み・未受領／受領済み）を出す。
 * DB の値を用語に合わせて作り直すと、既存の行と突き合わせられなくなる。
 *
 * ## 「送付済のまま14日」を目立たせる
 *
 * 送ったのに受け取られていない給付は、放っておくと誰も気づかない（v13 §5.3.1）。
 * 一覧の並びではなく**行の見た目**で出すのは、件数が増えても視線が届くようにするためである。
 */
export function GrantBoard({
  grants,
  markSent,
  confirmReceipt,
  markFailed,
}: {
  grants: readonly EumoGrant[];
  markSent: GrantAction;
  confirmReceipt: GrantAction;
  markFailed: GrantAction;
}) {
  if (grants.length === 0) {
    return <p className="text-sm text-neutral-600">給付はまだありません。</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {grants.map((grant) => (
        <GrantRow
          key={grant.grantId}
          grant={grant}
          markSent={markSent}
          confirmReceipt={confirmReceipt}
          markFailed={markFailed}
        />
      ))}
    </ul>
  );
}

function GrantRow({
  grant,
  markSent,
  confirmReceipt,
  markFailed,
}: {
  grant: EumoGrant;
  markSent: GrantAction;
  confirmReceipt: GrantAction;
  markFailed: GrantAction;
}) {
  const [sentState, submitSent] = useActionState(markSent, SUBMIT_IDLE);
  const [receiptState, submitReceipt] = useActionState(confirmReceipt, SUBMIT_IDLE);
  const [failedState, submitFailed] = useActionState(markFailed, SUBMIT_IDLE);

  const stale = isStaleSentGrant({ status: grant.status, sentAt: grant.sentAt, now: new Date() });

  return (
    <li className={`rounded border p-3 ${stale ? "border-amber-400 bg-amber-50" : "border-neutral-300"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {grant.memberLabel} ／ {grant.amountUii.toLocaleString("ja-JP")} Uii
        </span>
        <span className="flex items-center gap-2 text-xs">
          <span className="rounded bg-neutral-200 px-2 py-0.5">{GRANT_TYPE_LABELS[grant.grantType]}</span>
          <span className="rounded bg-neutral-100 px-2 py-0.5">{GRANT_STATUS_LABELS[grant.status]}</span>
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-700">用途: {grant.purpose}</p>
      {stale ? (
        <p className="mt-1 text-xs text-amber-900">
          ⚠️ 送付から14日を超えても受領確認がありません。届いているか確認してください。
        </p>
      ) : null}
      {grant.failureReason === null ? null : (
        <p className="mt-1 text-xs text-red-700">送付失敗: {grant.failureReason}</p>
      )}

      {grant.status === "受領確認済" ? null : (
        <div className="mt-3 flex flex-col gap-3">
          {grant.status === "送付済" ? null : (
            <form action={submitSent} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="grantId" value={grant.grantId} />
              <label className="flex flex-col gap-1 text-xs">
                送付経路
                <select
                  name="sentChannel"
                  required
                  defaultValue=""
                  className="rounded border border-neutral-300 px-2 py-1"
                >
                  <option value="" disabled>
                    選んでください
                  </option>
                  <option value="email">メール</option>
                  <option value="line">LINE</option>
                  <option value="in_person">対面</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                送付先（任意）
                <input type="text" name="sentTo" className="rounded border border-neutral-300 px-2 py-1" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                eumo のURL（任意）
                <input type="url" name="eumoUrl" className="rounded border border-neutral-300 px-2 py-1" />
              </label>
              <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white">
                送付済みにする
              </button>
            </form>
          )}

          {grant.status === "送付済" ? (
            <form action={submitReceipt}>
              <input type="hidden" name="grantId" value={grant.grantId} />
              <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white">
                受領を確認した
              </button>
            </form>
          ) : null}

          <form action={submitFailed} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="grantId" value={grant.grantId} />
            <label className="flex flex-col gap-1 text-xs">
              送付失敗の理由
              <input
                type="text"
                name="failureReason"
                required
                className="rounded border border-neutral-300 px-2 py-1"
              />
            </label>
            <button type="submit" className="rounded border border-neutral-400 px-3 py-1.5 text-xs">
              送付失敗として記録する
            </button>
          </form>
        </div>
      )}

      <Message state={sentState} />
      <Message state={receiptState} />
      <Message state={failedState} />
    </li>
  );
}

function Message({ state }: { state: SubmitState }) {
  if (state.message === undefined) {
    return null;
  }
  return (
    <p className={state.status === "error" ? "mt-2 text-xs text-red-700" : "mt-2 text-xs text-green-700"}>
      {state.message}
    </p>
  );
}
