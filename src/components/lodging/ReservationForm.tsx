"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { AccommodationType, DailyAvailability } from "@/lib/lodging/fetch-lodging";

/**
 * 宿泊予約フォーム（画面ID A11 ／ WBS 3-7）。
 *
 * ## 満室の形態は選ばせない
 *
 * v13 §5.2.3 ③ が「満室の宿泊形態は選択不可にする」と定めている。
 * ただしここで見ているのは**今日の残枠**でしかなく、選んだ日程の残枠ではない。
 * 日程を含めた本当の判定は確定時にサーバが行う（`createReservationAction`）。
 * 画面側は「明らかに取れないもの」を先に落として往復を減らすだけである。
 *
 * ## 既定はゲストハウス（ドミトリー）
 *
 * v13 §5.2.4 の指定。最も枠が多く、初めての利用者が選びやすい。
 */
export function ReservationForm({
  types,
  todayAvailability,
  action,
}: {
  types: AccommodationType[];
  todayAvailability: DailyAvailability[];
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  const [state, submit] = useActionState(action, SUBMIT_IDLE);

  const remainingOf = new Map(todayAvailability.map((row) => [row.roomType, row.available]));
  const defaultRoomType =
    types.find((type) => type.roomType === "dormitory")?.roomType ?? types[0]?.roomType ?? "";

  return (
    <form action={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        宿泊形態
        <select
          name="roomType"
          required
          defaultValue={defaultRoomType}
          className="rounded border border-neutral-300 px-3 py-2"
        >
          {types.map((type) => {
            const remaining = remainingOf.get(type.roomType);
            return (
              <option key={type.roomType} value={type.roomType}>
                {type.displayName}
                {remaining !== undefined && `（本日の残 ${remaining}）`}
              </option>
            );
          })}
        </select>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          チェックイン
          <input
            type="date"
            name="checkInDate"
            required
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          チェックアウト
          <input
            type="date"
            name="checkOutDate"
            required
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          大人
          <input
            type="number"
            name="adultsCount"
            min={0}
            max={20}
            defaultValue={1}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          子ども
          <input
            type="number"
            name="childrenCount"
            min={0}
            max={20}
            defaultValue={0}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </div>

      <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
        予約する
      </button>

      {state.status === "done" && state.message && (
        <p className="text-sm text-green-700">{state.message}</p>
      )}
      {state.status === "error" && state.message && (
        <p className="text-sm text-red-700">{state.message}</p>
      )}
    </form>
  );
}
