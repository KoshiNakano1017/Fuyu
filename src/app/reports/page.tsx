import Link from "next/link";

import { WorkLogForm } from "@/components/quests/WorkLogForm";
import { requireSignedIn } from "@/lib/auth/guard";
import { fetchMyApplications, type MyApplication } from "@/lib/quests/fetch-my-applications";

import { submitWorkLogAction } from "./actions";

/**
 * 作業報告（画面ID A4 ／ WBS 5-3 ／ v13 §5.3-4）。
 *
 * ## 受注者が「次に何をすればよいか」だけを出す
 *
 * 自分の受注申請を、**運営の指示が出ているもの**と**それ以外**に分けて並べる。
 * クエストボード（`/quests`）は「これから受ける仕事」の板で、ここは「受けた仕事」の板である。
 * 混ぜると、申請したことを忘れたまま同じクエストへもう一度申請する動線ができる。
 *
 * ## 差戻しの理由を必ず見せる
 *
 * 差し戻された報告は**別の行として積まれる**（`0017`）。再提出のときに
 * 「なぜ戻されたか」が見えていないと、同じ形でもう一度出すことになる。
 */
export default async function ReportsPage() {
  const viewer = await requireSignedIn();
  const applications = await fetchMyApplications(viewer.memberId);

  const actionable = applications.filter(
    (application) => application.status === "指示済み" || application.status === "承認",
  );
  const waiting = applications.filter(
    (application) => application.status !== "指示済み" && application.status !== "承認",
  );

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">作業報告</h1>
      <p className="text-sm text-neutral-600">
        受注したクエストの完了報告を出す画面です。
        <strong>作業前・作業後の写真</strong>を添えて提出します（v13 §5.3-4）。
      </p>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">報告できる受注（{actionable.length}件）</h2>
        {actionable.length === 0 ? (
          <p className="text-sm text-neutral-600">
            いま報告できる受注はありません。
            <Link href="/quests" className="ml-1 underline">
              クエストボードを見る
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {actionable.map((application) => (
              <li key={application.applicationId} className="rounded border border-neutral-300 p-4">
                <ApplicationHeader application={application} />
                <WorkLogForm application={application} submit={submitWorkLogAction} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">申請中・完了した受注（{waiting.length}件）</h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-neutral-600">ありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {waiting.map((application) => (
              <li key={application.applicationId} className="rounded border border-neutral-200 p-3">
                <ApplicationHeader application={application} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ApplicationHeader({ application }: { application: MyApplication }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{application.questTitle}</span>
        <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs">{application.status}</span>
      </div>

      {application.instructionBody === null ? null : (
        <p className="text-xs text-neutral-700">
          指示: {application.instructionBody}
          {application.instructionPlace === null ? "" : `（場所: ${application.instructionPlace}）`}
          {application.scheduledStartAt === null
            ? ""
            : `／ 予定: ${new Date(application.scheduledStartAt).toLocaleString("ja-JP")}`}
        </p>
      )}

      {application.workLogs.length === 0 ? null : (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-neutral-700">
          {application.workLogs.map((log) => (
            <li key={log.logId}>
              {new Date(log.workedAt).toLocaleDateString("ja-JP")} の報告: {log.approvalStatus}
              {log.workHours === null ? "" : `（${log.workHours}時間）`}
              {log.rejectionReason === null ? null : (
                <span className="text-red-700">／ 差戻し理由: {log.rejectionReason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
