"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE } from "@/lib/forms/submit-state";
import { pendingCandidates } from "@/lib/morning-meetings/quest-candidates";
import type { MeetingSummary } from "@/lib/morning-meetings/store";

import { QuestCandidateCard, type CandidateAction } from "./QuestCandidateCard";

/**
 * 投入済みの朝会議事録と、そこから起案されたクエスト候補の板（WBS 4-2・4-3）。
 *
 * 投入フォーム（4-1）と同じ画面に置くのは、運営の動線が
 * 「貼り付ける → 構造化する → 候補を確認して公開する」と一続きだからである。
 * 画面を分けると、貼り付けた直後に構造化を押す人が別ページを探すことになる。
 */
export function MinutesBoard({
  meetings,
  structure,
  publish,
  dismiss,
}: {
  meetings: readonly MeetingSummary[];
  structure: CandidateAction;
  publish: CandidateAction;
  dismiss: CandidateAction;
}) {
  if (meetings.length === 0) {
    return <p className="text-sm text-neutral-600">投入済みの議事録はまだありません。</p>;
  }

  return (
    <ul className="flex flex-col gap-4">
      {meetings.map((meeting) => (
        <MeetingCard
          key={meeting.meetingId}
          meeting={meeting}
          structure={structure}
          publish={publish}
          dismiss={dismiss}
        />
      ))}
    </ul>
  );
}

function MeetingCard({
  meeting,
  structure,
  publish,
  dismiss,
}: {
  meeting: MeetingSummary;
  structure: CandidateAction;
  publish: CandidateAction;
  dismiss: CandidateAction;
}) {
  const [state, submit, isPending] = useActionState(structure, SUBMIT_IDLE);
  const structured = meeting.summaryText !== null;
  const pendingCount = pendingCandidates(meeting.candidates).length;

  return (
    <li className="rounded border border-neutral-300 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{meeting.heldOn} の朝会</h2>
        <span className="text-xs text-neutral-600">
          {structured ? `構造化済み ／ 未処理の候補 ${pendingCount} 件` : "未構造化"}
        </span>
      </div>

      <form action={submit} className="mt-2 flex flex-wrap items-center gap-3">
        <input type="hidden" name="meetingId" value={meeting.meetingId} />
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          // 再実行は候補の状態（公開済み・却下）を捨てる。押し間違いで
          // 同じ議事録から二重に起案できてしまうため、ここだけ確認を挟む。
          onClick={(event) => {
            if (structured && !window.confirm("再実行すると、いまの候補と処理状況が置き換わります。よろしいですか？")) {
              event.preventDefault();
            }
          }}
        >
          {isPending ? "構造化しています…（最大60秒）" : structured ? "再構造化する" : "AIで構造化する"}
        </button>
        {state.message === undefined ? null : (
          <span className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
            {state.message}
          </span>
        )}
      </form>

      {meeting.summaryText === null ? null : (
        <pre className="mt-3 whitespace-pre-wrap rounded bg-neutral-50 p-3 text-sm">
          {meeting.summaryText}
        </pre>
      )}

      {meeting.candidates.length === 0 ? null : (
        <>
          <h3 className="mt-4 text-sm font-semibold">クエスト候補</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {meeting.candidates.map((candidate) => (
              <QuestCandidateCard
                key={candidate.candidateId}
                meetingId={meeting.meetingId}
                candidate={candidate}
                publish={publish}
                dismiss={dismiss}
              />
            ))}
          </ul>
        </>
      )}
    </li>
  );
}
