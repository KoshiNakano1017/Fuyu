"use client";

import { useActionState } from "react";

import { GRANT_STATUS_LABELS, visitBadgeLabel, type CashbackJudgement } from "@/lib/eumo/grants";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type CashbackAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 初回来訪キャッシュバックのバッジと起票（WBS 12-4 ／ v13 §5.10.8 ①②）。
 *
 * ## 3つのバッジを必ず並べる
 *
 * 仕様が求めるのは「街人か否か」「初回か再訪（通算◯回目）か」「キャッシュバックの発行状態」の
 * 3点である（§5.10.8 ①）。**1つでも欠けると判断できない** — 例えば「初回」だけ見て起票すると、
 * 既に登録キャッシュバックを受け取っている人へ二重に送ることになる。
 *
 * ## 「要確認」は止めるためではなく、運営に渡すために出す
 *
 * #59 の決着（2026-09-22）で、移行由来の街人は**一律「要確認」**になった。
 * ここで操作そのものを塞ぐと、正当な未受領者へ永久に送れない。
 * 額を運営が入れて起票できる形にし、判断だけを人へ渡す。
 */
export function CashbackPanel({
  memberId,
  memberType,
  visitCount,
  judgement,
  issue,
}: {
  memberId: string;
  memberType: string;
  visitCount: number;
  judgement: CashbackJudgement;
  issue: CashbackAction;
}) {
  const [state, submit, isPending] = useActionState(issue, SUBMIT_IDLE);

  return (
    <section className="flex flex-col gap-2 rounded border border-neutral-300 p-4">
      <h2 className="text-sm font-semibold">初回来訪キャッシュバック（v13 §5.10.8）</h2>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-neutral-200 px-2 py-0.5">{memberType}</span>
        <span className="rounded bg-neutral-100 px-2 py-0.5">{visitBadgeLabel(visitCount)}</span>
        <span className="rounded bg-neutral-100 px-2 py-0.5">{cashbackBadge(judgement)}</span>
      </div>

      <p className="text-xs text-neutral-700">{describeJudgement(judgement)}</p>

      {judgement.kind === "auto_draft" || judgement.kind === "needs_review" ? (
        <form action={submit} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="memberId" value={memberId} />
          {judgement.kind === "needs_review" ? (
            <label className="flex flex-col gap-1 text-xs">
              給付額（Uii）
              <input
                type="number"
                name="amountUii"
                min={1}
                required
                className="w-28 rounded border border-neutral-300 px-2 py-1"
              />
            </label>
          ) : null}
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {isPending ? "起票しています…" : "発行依頼として起票する"}
          </button>
        </form>
      ) : null}

      {state.message === undefined ? null : (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-green-700"}>
          {state.message}
        </p>
      )}
    </section>
  );
}

/** 発行状態のバッジ（§5.10.8 ①の3値）。 */
function cashbackBadge(judgement: CashbackJudgement): string {
  if (judgement.kind === "already_issued") {
    return `キャッシュバック${GRANT_STATUS_LABELS[judgement.status]}`;
  }
  return judgement.kind === "needs_review" ? "要確認" : "キャッシュバック未発行";
}

function describeJudgement(judgement: CashbackJudgement): string {
  switch (judgement.kind) {
    case "auto_draft":
      return `初回来訪の街人です。${judgement.amountUii.toLocaleString("ja-JP")} Uii を発行依頼として起票できます。`;
    case "needs_review":
      return judgement.note;
    case "not_applicable":
      return judgement.note;
    case "already_issued":
      return "既にキャッシュバックの給付があります。二重には起票しません。";
  }
}
