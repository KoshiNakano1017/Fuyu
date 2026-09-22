"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { StoredQuestCandidate } from "@/lib/morning-meetings/quest-candidates";

export type CandidateAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * クエスト候補1件のプレビュー・補正・起案（WBS 4-3 ／ v13 §5.1 ③）。
 *
 * ## 発言根拠を必ず見せる
 *
 * AI が抽出した候補には、朝会で誰も言っていない作業が混ざりうる。
 * 運営が「本当にその話が出たか」を確かめられるよう、根拠になった発言をカード上に出す
 * （`quest-candidates.ts` の `buildDescription()` が同じ文をクエスト本文にも残す）。
 *
 * ## 報酬額の欄を空のままにできる
 *
 * 空欄のまま公開すると `reward_uii` は未設定のままボードに載る。
 * 「AI が出した額」を初期値として入れてしまうと、誰も確認していない金額が
 * そのまま受注申請の根拠になる（`toQuestInsertRow()` の注記）。
 */
export function QuestCandidateCard({
  meetingId,
  candidate,
  publish,
  dismiss,
}: {
  meetingId: string;
  candidate: StoredQuestCandidate;
  publish: CandidateAction;
  dismiss: CandidateAction;
}) {
  const [publishState, submitPublish, publishPending] = useActionState(publish, SUBMIT_IDLE);
  const [dismissState, submitDismiss, dismissPending] = useActionState(dismiss, SUBMIT_IDLE);

  const handled = candidate.status !== "pending";

  return (
    <li className="rounded border border-neutral-300 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{candidate.title}</p>
        <StatusBadge status={candidate.status} />
      </div>

      {candidate.sourceQuote === "" ? null : (
        <p className="mt-1 text-xs text-neutral-600">発言根拠:「{candidate.sourceQuote}」</p>
      )}
      {candidate.assigneeCandidates.length === 0 ? null : (
        <p className="mt-1 text-xs text-neutral-600">
          担当候補: {candidate.assigneeCandidates.join("・")}
        </p>
      )}

      {handled ? null : (
        <form action={submitPublish} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="candidateId" value={candidate.candidateId} />

          <label className="flex flex-col gap-1 text-xs">
            クエスト名
            <input
              type="text"
              name="title"
              required
              defaultValue={candidate.title}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              募集人数
              <input
                type="number"
                name="headcount"
                min={1}
                defaultValue={candidate.headcount}
                className="rounded border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              想定時間（分）
              <input
                type="number"
                name="estimatedMinutes"
                min={1}
                defaultValue={candidate.estimatedMinutes}
                className="rounded border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              報酬（Uii・任意）
              <input
                type="number"
                name="rewardUii"
                min={0}
                placeholder="未設定"
                className="rounded border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
          </div>

          <p className="text-xs text-neutral-500">
            公開しても<strong>ゲストには開放されません</strong>（v13 §5.10.6）。
            開放はクエスト編集から運営が明示的に行います。
          </p>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={publishPending || dismissPending}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {publishPending ? "公開しています…" : "クエストとして公開する"}
            </button>
          </div>
        </form>
      )}

      {handled ? null : (
        <form action={submitDismiss} className="mt-2">
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="candidateId" value={candidate.candidateId} />
          <button
            type="submit"
            disabled={publishPending || dismissPending}
            className="text-xs text-neutral-600 underline disabled:opacity-50"
          >
            {dismissPending ? "却下しています…" : "この候補を却下する"}
          </button>
        </form>
      )}

      <FormMessage state={publishState} />
      <FormMessage state={dismissState} />
    </li>
  );
}

function StatusBadge({ status }: { status: StoredQuestCandidate["status"] }) {
  const label = { pending: "未処理", published: "公開済み", dismissed: "却下" }[status];
  const tone =
    status === "published"
      ? "bg-green-100 text-green-800"
      : status === "dismissed"
        ? "bg-neutral-200 text-neutral-700"
        : "bg-amber-100 text-amber-800";

  return <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${tone}`}>{label}</span>;
}

function FormMessage({ state }: { state: SubmitState }) {
  if (state.message === undefined) {
    return null;
  }
  return (
    <p className={state.status === "error" ? "mt-2 text-xs text-red-700" : "mt-2 text-xs text-green-700"}>
      {state.message}
    </p>
  );
}
