"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { ReviewableApplication, ReviewableWorkLog } from "@/lib/quests/applications";

type Action = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * クエスト承認ダッシュボード（画面ID B5 ／ WBS 5-2・5-4・5-6）。
 *
 * ## 最終承認ボタンを admin にしか出さない
 *
 * v13 §5.3.2 の確定論点「コアメンバーは最終承認できない」。
 * ただし**ボタンを隠すことは防壁ではない**（v13 §5.9.3）。実際に止めているのは
 * DB のトリガー `work_logs_guard_approval()` で、Server Action を直接叩いても落ちる。
 * ここで出し分けるのは、押せないボタンを並べないためである。
 */
export function ReviewBoard({
  applications,
  workLogs,
  isAdmin,
  instruct,
  review,
}: {
  applications: ReviewableApplication[];
  workLogs: ReviewableWorkLog[];
  isAdmin: boolean;
  instruct: Action;
  review: Action;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">
          受注申請
          <span className="ml-2 text-sm font-normal text-neutral-600">{applications.length}件</span>
        </h2>
        {applications.length === 0 ? (
          <p className="text-sm text-neutral-600">審査待ちの申請はありません。</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {applications.map((application) => (
              <InstructionCard
                key={application.applicationId}
                application={application}
                instruct={instruct}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">
          完了報告
          <span className="ml-2 text-sm font-normal text-neutral-600">{workLogs.length}件</span>
        </h2>
        {workLogs.length === 0 ? (
          <p className="text-sm text-neutral-600">承認待ちの報告はありません。</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {workLogs.map((workLog) => (
              <ReviewCard
                key={workLog.logId}
                workLog={workLog}
                isAdmin={isAdmin}
                review={review}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InstructionCard({
  application,
  instruct,
}: {
  application: ReviewableApplication;
  instruct: Action;
}) {
  const [state, submit] = useActionState(instruct, SUBMIT_IDLE);

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{application.questTitle}</span>
        <span className="text-sm text-neutral-600">{application.applicantLabel}</span>
      </div>

      <form action={submit} className="flex flex-col gap-2">
        <input type="hidden" name="applicationId" value={application.applicationId} />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            いつ
            <input
              type="datetime-local"
              name="scheduledStartAt"
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            どこで
            <input
              type="text"
              name="instructionPlace"
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          何を（必須）
          <textarea
            name="instructionBody"
            required
            rows={2}
            className="rounded border border-neutral-300 px-2 py-1"
          />
        </label>
        <button type="submit" className="self-start rounded bg-neutral-900 px-3 py-1 text-sm text-white">
          実行指示を出す
        </button>
      </form>

      {state.status === "done" && state.message && (
        <p className="text-sm text-green-700">{state.message}</p>
      )}
      {state.status === "error" && state.message && (
        <p className="text-sm text-red-700">{state.message}</p>
      )}
    </li>
  );
}

function ReviewCard({
  workLog,
  isAdmin,
  review,
}: {
  workLog: ReviewableWorkLog;
  isAdmin: boolean;
  review: Action;
}) {
  const [state, submit] = useActionState(review, SUBMIT_IDLE);

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{workLog.questTitle}</span>
        <span className="flex items-center gap-2 text-sm text-neutral-600">
          {workLog.workerLabel}
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
            {workLog.approvalStatus}
          </span>
        </span>
      </div>

      {workLog.workHours !== null && (
        <span className="text-sm text-neutral-600">作業時間 {workLog.workHours} 時間</span>
      )}
      {workLog.notes !== null && <p className="text-sm">{workLog.notes}</p>}

      <form action={submit} className="flex flex-col gap-2">
        <input type="hidden" name="logId" value={workLog.logId} />
        <input type="hidden" name="current" value={workLog.approvalStatus} />
        <label className="flex flex-col gap-1 text-sm">
          差戻しの理由（差し戻すときは必須）
          <input type="text" name="reason" className="rounded border border-neutral-300 px-2 py-1" />
        </label>
        <div className="flex flex-wrap gap-2">
          {workLog.approvalStatus === "報告済み" && (
            <button
              type="submit"
              name="action"
              value="core_confirm"
              className="rounded border border-neutral-400 px-3 py-1 text-sm"
            >
              コアメンバー確認
            </button>
          )}
          {/* 最終承認は admin のみ。防壁は DB のトリガー側にある（v13 §5.3.2） */}
          {isAdmin && (
            <button
              type="submit"
              name="action"
              value="approve"
              className="rounded bg-neutral-900 px-3 py-1 text-sm text-white"
            >
              最終承認
            </button>
          )}
          <button
            type="submit"
            name="action"
            value="reject"
            className="rounded border border-red-400 px-3 py-1 text-sm text-red-700"
          >
            差し戻す
          </button>
        </div>
      </form>

      {state.status === "done" && state.message && (
        <p className="text-sm text-green-700">{state.message}</p>
      )}
      {state.status === "error" && state.message && (
        <p className="text-sm text-red-700">{state.message}</p>
      )}
    </li>
  );
}
