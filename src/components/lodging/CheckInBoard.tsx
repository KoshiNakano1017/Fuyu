"use client";

import Link from "next/link";
import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
// ⚠️ 値域は純関数モジュールから取る。`cancellation.ts` はサーバ専用であり、
//    ここから import するとサーバ用 Supabase クライアントがブラウザ側へ引き込まれる。
import { CANCEL_REASON_TYPES } from "@/lib/lodging/checkin-ops";
// 型だけを取る（`fetch-checkin-board.ts` はサーバ専用モジュール）。
import type { CheckInBoardRow } from "@/lib/lodging/fetch-checkin-board";

export type CheckInAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

const STATUS_LABELS: Record<CheckInBoardRow["status"], string> = {
  pre_registered: "予約受付",
  confirmed: "予約確定",
  staying: "滞在中",
  checked_out: "退館済み",
  cancelled: "キャンセル",
};

/**
 * チェックイン板（画面ID A1 ／ WBS 3-2 ／ v13 §5.2.2）。
 *
 * ## 名簿が済んでいるかを必ず出す
 *
 * 宿泊者名簿（氏名・住所・前泊地）は**宿泊法に基づく義務**であり、
 * 取り損ねると後から本人に会えない（v13 §5.2.7）。
 * 板の上で「未登録」が見えていれば、入館の流れの中で拾える。
 *
 * ## 実名はここに出さない
 *
 * 表示はニックネーム／会員番号である。名簿の中身は専用画面
 * （`/admin/checkins/{id}/lodging-register`）でだけ開く。
 */
export function CheckInBoard({
  rows,
  checkIn,
  checkOut,
  cancelStay,
}: {
  rows: readonly CheckInBoardRow[];
  checkIn: CheckInAction;
  checkOut: CheckInAction;
  cancelStay: CheckInAction;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-600">本日の到着・滞在はありません。</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <CheckInRow
          key={row.checkinId}
          row={row}
          checkIn={checkIn}
          checkOut={checkOut}
          cancelStay={cancelStay}
        />
      ))}
    </ul>
  );
}

function CheckInRow({
  row,
  checkIn,
  checkOut,
  cancelStay,
}: {
  row: CheckInBoardRow;
  checkIn: CheckInAction;
  checkOut: CheckInAction;
  cancelStay: CheckInAction;
}) {
  const [checkInState, submitCheckIn, checkInPending] = useActionState(checkIn, SUBMIT_IDLE);
  const [checkOutState, submitCheckOut, checkOutPending] = useActionState(checkOut, SUBMIT_IDLE);
  const [cancelState, submitCancel, cancelPending] = useActionState(cancelStay, SUBMIT_IDLE);

  const canCheckIn = row.status === "pre_registered" || row.status === "confirmed";
  const canCheckOut = row.status === "staying";

  return (
    <li className="rounded border border-neutral-300 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{row.memberLabel}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-neutral-200 px-2 py-0.5">{STATUS_LABELS[row.status]}</span>
          <span className="rounded bg-neutral-100 px-2 py-0.5">{row.roomType}</span>
          <span className="text-neutral-600">
            {row.checkInDate} 〜 {row.checkOutDate} ／ 大人{row.adultsCount}名
            {row.childrenCount === 0 ? "" : ` ／ 子ども${row.childrenCount}名`}
          </span>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {canCheckIn ? (
          <form action={submitCheckIn}>
            <input type="hidden" name="checkinId" value={row.checkinId} />
            <button
              type="submit"
              disabled={checkInPending}
              className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {checkInPending ? "処理しています…" : "チェックインする"}
            </button>
          </form>
        ) : null}

        {canCheckOut ? (
          <form action={submitCheckOut}>
            <input type="hidden" name="checkinId" value={row.checkinId} />
            <button
              type="submit"
              disabled={checkOutPending}
              className="rounded border border-neutral-400 px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {checkOutPending ? "処理しています…" : "チェックアウトする"}
            </button>
          </form>
        ) : null}

        {row.hasLodgingRegister ? (
          <span className="text-xs text-neutral-600">宿泊者名簿 登録済み</span>
        ) : (
          <Link
            href={`/admin/checkins/${row.checkinId}/lodging-register`}
            className="text-xs text-amber-800 underline"
          >
            ⚠️ 宿泊者名簿が未登録です（登録する）
          </Link>
        )}
      </div>

      {/*
        キャンセル・ノーショー（WBS 3-3 ／ v13 §5.2.2）。**入館前の予約にだけ**出す。
        途中退去は「退館」であってキャンセルではない（キャンセルにすると滞在の記録が
        通算来訪回数・宿泊履歴から抜け落ちる）。
      */}
      {canCheckIn ? (
        <form action={submitCancel} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="checkinId" value={row.checkinId} />
          <label className="flex flex-col gap-1 text-xs">
            キャンセル種別
            <select
              name="reasonType"
              required
              defaultValue=""
              className="rounded border border-neutral-300 px-2 py-1"
            >
              <option value="" disabled>
                選んでください
              </option>
              {CANCEL_REASON_TYPES.map((reasonType) => (
                <option key={reasonType} value={reasonType}>
                  {reasonType}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            理由（必須）
            <input
              type="text"
              name="reason"
              required
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
          <button
            type="submit"
            disabled={cancelPending}
            className="rounded border border-red-400 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50"
          >
            {cancelPending ? "処理しています…" : "キャンセル／ノーショーにする"}
          </button>
        </form>
      ) : null}

      <Message state={checkInState} />
      <Message state={checkOutState} />
      <Message state={cancelState} />
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
