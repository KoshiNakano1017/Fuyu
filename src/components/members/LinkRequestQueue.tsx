"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { LinkRequestView } from "@/lib/members/link-queue-store";

export type QueueAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 名寄せの運営承認キュー（WBS 10-2 ／ v13 §5.8.3 ①）。
 *
 * ## 候補は「選ぶ」形にする（自由入力にしない）
 *
 * 承認は**誰の宿泊券・Uii残高・XP を誰へ渡すか**を決める操作である（§5.8.3 の [!warning]）。
 * 会員IDを手で打てる形にすると、打ち間違いがそのまま引き継ぎ事故になる。
 * サーバ側も、受け取った会員が**現在の候補に含まれるか**を決着の直前に確かめる。
 *
 * ## 結合済みの候補は選べない
 *
 * キューへ積んだ後に誰かが結合した場合、その候補はもう選べない
 * （名寄せを奪取の経路にしないため ／ `0040` も同じ条件で拒否する）。
 *
 * ## 照合キーは表示する
 *
 * どのメール・電話で一致したのかが分からないと運営は判断できない。
 * この画面は staff 限定であり（`0039` の RLS も同じ幅）、PII-A を出す前提の画面である。
 */
export function LinkRequestQueue({
  requests,
  kindLabels,
  approve,
  reject,
}: {
  requests: readonly LinkRequestView[];
  /** 照合キーの表示名（サーバ側の定義を渡す。画面で語を作らない） */
  kindLabels: Record<string, string>;
  approve: QueueAction;
  reject: QueueAction;
}) {
  const pending = requests.filter((request) => request.status === "保留");
  const resolved = requests.filter((request) => request.status !== "保留");

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">
          保留中
          <span className="ml-2 text-sm font-normal text-neutral-600">{pending.length}件</span>
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-neutral-600">運営の確認を待っている申請はありません。</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((request) => (
              <PendingRow
                key={request.requestId}
                request={request}
                kindLabels={kindLabels}
                approve={approve}
                reject={reject}
              />
            ))}
          </ul>
        )}
      </section>

      {resolved.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">決着済み</h2>
          <ul className="flex flex-col gap-2 text-xs text-neutral-700">
            {resolved.map((request) => (
              <li
                key={request.requestId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 px-3 py-2"
              >
                <span>
                  <span className="rounded bg-neutral-200 px-2 py-0.5">{request.status}</span>{" "}
                  {kindLabels[request.matchedKind] ?? request.matchedKind}: {request.matchedValue}
                </span>
                <span className="text-neutral-500">
                  {new Date(request.createdAt).toLocaleString("ja-JP")}
                  {request.rejectReason === null ? "" : ` ／ 理由: ${request.rejectReason}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PendingRow({
  request,
  kindLabels,
  approve,
  reject,
}: {
  request: LinkRequestView;
  kindLabels: Record<string, string>;
  approve: QueueAction;
  reject: QueueAction;
}) {
  const [approveState, submitApprove, approvePending] = useActionState(approve, SUBMIT_IDLE);
  const [rejectState, submitReject, rejectPending] = useActionState(reject, SUBMIT_IDLE);

  const selectable = request.candidates.filter(
    (candidate) => !candidate.isBound && candidate.accountStatus === "pre_registered",
  );

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {kindLabels[request.matchedKind] ?? request.matchedKind}: {request.matchedValue}
        </span>
        <span className="text-xs text-neutral-500">
          候補 {request.candidateCount}件 ／ {new Date(request.createdAt).toLocaleString("ja-JP")}
        </span>
      </div>

      <p className="text-xs text-neutral-700">{request.reason}</p>

      {selectable.length === 0 ? (
        <p className="text-xs text-amber-900">
          いま選べる候補がありません（キューへ積んだ後に結合済み・本登録済みになった可能性があります）。
          却下して、本人へ運営から連絡してください。
        </p>
      ) : (
        <form action={submitApprove} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="requestId" value={request.requestId} />
          <label className="flex flex-col text-xs">
            結合する会員
            <select
              name="memberId"
              required
              defaultValue=""
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              <option value="" disabled>
                候補から選ぶ
              </option>
              {selectable.map((candidate) => (
                <option key={candidate.memberId} value={candidate.memberId}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={approvePending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            この会員として連携する
          </button>
        </form>
      )}

      <form action={submitReject} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="requestId" value={request.requestId} />
        <input
          type="text"
          name="reason"
          required
          placeholder="却下の理由（必須）"
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
        />
        <button
          type="submit"
          disabled={rejectPending}
          className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-700"
        >
          却下する
        </button>
      </form>

      {[approveState, rejectState].map((state, index) =>
        state.status === "idle" || state.message === undefined ? null : (
          <p
            key={index}
            className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"}
          >
            {state.message}
          </p>
        ),
      )}
    </li>
  );
}
