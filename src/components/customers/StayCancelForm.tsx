"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
// ⚠️ 値域は純関数モジュールから取る。`cancellation.ts` はサーバ専用であり、
//    ここから import するとサーバ用 Supabase クライアントがブラウザ側へ引き込まれる。
import { CANCEL_REASON_TYPES } from "@/lib/lodging/checkin-ops";

export type StayCancelAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 予約のキャンセル・ノーショー（画面ID C11 の「宿泊」タブ ／ WBS 3-3 ／ v13 §5.2.2）。
 *
 * 正本は操作場所を**顧客管理画面**と定めている（§5.2.2「操作場所」／ §6 の権限マトリクス）。
 * チェックイン板（`/staff/checkins`）にも同じ操作があるが、あちらは当日の板であり、
 * **日付を跨いだ先の予約はそもそも並ばない**。
 *
 * ## 種別と理由を両方必須にする
 *
 * 種別だけでは「なぜ取り消したか」が残らず、自由記述だけでは集計できない（§5.2.2「理由入力」）。
 * 画面側の `required` は入力補助であり、判定の正はサーバ（`validateCancellation()`）と
 * DB の `chk_check_ins_cancel_complete` にある。
 */
export function StayCancelForm({
  checkinId,
  cancelStay,
}: {
  checkinId: string;
  cancelStay: StayCancelAction;
}) {
  const [state, submit, pending] = useActionState(cancelStay, SUBMIT_IDLE);

  return (
    <div className="mt-2">
      <form action={submit} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="checkinId" value={checkinId} />
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
          disabled={pending}
          className="rounded border border-red-400 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50"
        >
          {pending ? "処理しています…" : "キャンセル／ノーショーにする"}
        </button>
      </form>

      {state.message === undefined ? null : (
        <p
          className={
            state.status === "error" ? "mt-2 text-xs text-red-700" : "mt-2 text-xs text-green-700"
          }
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
