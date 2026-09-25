"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { ApplicationListItem } from "@/lib/membership/approval-store";

export type BoardAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

export type ApplicationBoardProps = {
  applications: readonly ApplicationListItem[];
  /** 決済手段の表示名（サーバ側の定義を渡す。画面で語を作らない） */
  paymentMethodLabels: Record<string, string>;
  qrChannelLabels: Record<string, string>;
  issueQr: BoardAction;
  recordPayment: BoardAction;
  approve: BoardAction;
  reject: BoardAction;
};

/**
 * 街人登録 申請一覧（画面ID C7 ／ WBS 12-2 ／ v13 §5.10.4 Step 3〜5）。
 *
 * ## 状態ごとに分けて出す
 *
 * 運営の仕事は状態ごとに違う（QRを出す／入金を確認する／承認する）。
 * 1つの表に混ぜると、**何をすべき行なのかを毎回読み直す**ことになる
 * （`/staff/eumo` の給付一覧と同じ並べ方）。
 *
 * ## 押せる操作だけを出す
 *
 * 現金の申込にはQR発行を出さない（§5.10.7 の二重受領防止）。
 * 決済の記録が無い申込には承認を出さない（§5.10.4「受領記録・入金確認が承認の前提」）。
 * 判定はサーバ側の純関数（`approval.ts`）と同じ規則で、押した後にも必ず再判定される。
 */
export function ApplicationBoard({
  applications,
  paymentMethodLabels,
  qrChannelLabels,
  issueQr,
  recordPayment,
  approve,
  reject,
}: ApplicationBoardProps) {
  const groups = [
    { key: "申込中", label: "申込中（QRの発行・受領の記録）" },
    { key: "QR送付済み", label: "QR送付済み（入金の確認）" },
    { key: "保留", label: "保留（14日経過などで滞留）" },
    { key: "承認済み", label: "承認済み" },
    { key: "却下", label: "却下" },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const rows = applications.filter((application) => application.status === group.key);
        if (rows.length === 0) {
          return null;
        }
        return (
          <section key={group.key} className="flex flex-col gap-2">
            <h2 className="text-lg font-bold">
              {group.label}
              <span className="ml-2 text-sm font-normal text-neutral-600">{rows.length}件</span>
            </h2>
            <ul className="flex flex-col gap-3">
              {rows.map((application) => (
                <ApplicationRow
                  key={application.applicationId}
                  application={application}
                  paymentMethodLabels={paymentMethodLabels}
                  qrChannelLabels={qrChannelLabels}
                  issueQr={issueQr}
                  recordPayment={recordPayment}
                  approve={approve}
                  reject={reject}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {applications.length === 0 ? (
        <p className="text-sm text-neutral-600">街人登録の申請はまだありません。</p>
      ) : null}
    </div>
  );
}

function ApplicationRow({
  application,
  paymentMethodLabels,
  qrChannelLabels,
  issueQr,
  recordPayment,
  approve,
  reject,
}: {
  application: ApplicationListItem;
  paymentMethodLabels: Record<string, string>;
  qrChannelLabels: Record<string, string>;
  issueQr: BoardAction;
  recordPayment: BoardAction;
  approve: BoardAction;
  reject: BoardAction;
}) {
  const [qrState, submitQr, qrPending] = useActionState(issueQr, SUBMIT_IDLE);
  const [payState, submitPay, payPending] = useActionState(recordPayment, SUBMIT_IDLE);
  const [approveState, submitApprove, approvePending] = useActionState(approve, SUBMIT_IDLE);
  const [rejectState, submitReject, rejectPending] = useActionState(reject, SUBMIT_IDLE);

  const isTerminal = application.status === "承認済み" || application.status === "却下";
  const isCash = application.paymentMethod === "cash";
  const hasPaymentRecord = application.paymentMethod !== null && application.paidAt !== null;

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{application.applicantLabel}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-neutral-200 px-2 py-0.5">{application.status}</span>
          <span className="text-neutral-600">
            ¥{application.billedAmountYen.toLocaleString("ja-JP")} ／ 宿泊券
            {application.grantedNights}枚
          </span>
          <span className="text-neutral-500">
            申請 {new Date(application.appliedAt).toLocaleString("ja-JP")}
          </span>
        </span>
      </div>

      <p className="text-xs text-neutral-700">
        決済手段:{" "}
        {application.paymentMethod === null
          ? "未選択"
          : paymentMethodLabels[application.paymentMethod] ?? application.paymentMethod}
        {application.paidAt === null
          ? ""
          : ` ／ 受領 ${new Date(application.paidAt).toLocaleString("ja-JP")}`}
        {application.qrIssuedAt === null
          ? ""
          : ` ／ QR ${
              application.qrDeliveryChannel === null
                ? ""
                : qrChannelLabels[application.qrDeliveryChannel] ?? application.qrDeliveryChannel
            }で送付（${
              application.qrConsumedAt === null
                ? `期限 ${new Date(application.qrExpiresAt ?? "").toLocaleDateString("ja-JP")}`
                : "失効済み"
            }）`}
      </p>

      {application.rejectionReason === null ? null : (
        <p className="text-xs text-red-700">却下理由: {application.rejectionReason}</p>
      )}

      {isTerminal ? null : (
        <div className="flex flex-col gap-2 border-t border-neutral-100 pt-2">
          {/* Step 3: QRの発行。★ 現金の申込には出さない（二重受領の防止 ／ §5.10.7） */}
          {isCash ? (
            <p className="text-xs text-neutral-600">
              現金を選んだ申込にはQRを発行できません（二重受領を防ぐため）。
            </p>
          ) : (
            <form action={submitQr} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="applicationId" value={application.applicationId} />
              <select
                name="channel"
                required
                defaultValue=""
                className="rounded border border-neutral-300 px-2 py-1 text-xs"
              >
                <option value="" disabled>
                  送付経路
                </option>
                {Object.entries(qrChannelLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={qrPending}
                className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                決済QRを発行・送付
              </button>
            </form>
          )}

          {/* Step 4: 受領の記録。現金は受領者（操作者）も一緒に残る */}
          <form action={submitPay} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="applicationId" value={application.applicationId} />
            <select
              name="method"
              required
              defaultValue=""
              className="rounded border border-neutral-300 px-2 py-1 text-xs"
            >
              <option value="" disabled>
                受領した手段
              </option>
              {Object.entries(paymentMethodLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={payPending}
              className="rounded border border-neutral-300 px-3 py-1.5 text-xs"
            >
              受領を記録
            </button>
          </form>

          {/* Step 5: 承認。★ 決済の記録が無いうちは出さない（§5.10.4） */}
          {hasPaymentRecord ? (
            <form action={submitApprove}>
              <input type="hidden" name="applicationId" value={application.applicationId} />
              <button
                type="submit"
                disabled={approvePending}
                className="rounded bg-green-700 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                決済を確認して街人登録を完了する
              </button>
            </form>
          ) : (
            <p className="text-xs text-neutral-600">
              受領を記録すると「街人登録を完了する」が押せます（§5.10.4）。
            </p>
          )}

          {/* 却下は理由必須（§5.10.4） */}
          <form action={submitReject} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="applicationId" value={application.applicationId} />
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
        </div>
      )}

      {[qrState, payState, approveState, rejectState].map((state, index) =>
        state.status === "idle" || state.message === undefined ? null : (
          <p
            key={index}
            className={
              state.status === "error"
                ? "text-xs text-red-700"
                : "break-all text-xs text-neutral-700"
            }
          >
            {state.message}
          </p>
        ),
      )}
    </li>
  );
}
