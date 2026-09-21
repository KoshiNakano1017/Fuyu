"use client";

import { useActionState, useState } from "react";

import { Money } from "@/components/ui/Money";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { AccommodationType } from "@/lib/lodging/fetch-lodging";

/**
 * 宿泊料金の登録フォーム（画面ID C13 ／ WBS 3-9）。
 *
 * ★ **Uii の入力欄を置かない。** v13 §5.5 は `floor(単価×0.8)` と定めており、
 * `accommodation_rates` は Uii 列を持たない（`0021`）。カフェメニューと同じ作法である。
 *
 * ★ **既存行を編集する欄を置かない。** 改定は「期間を区切って新しい行を足す」であり
 * （v13 §5.4.2②）、上書きにすると過去の予約が現在価格で再計算される。
 * 旧料金を終わらせたいときは、終了日を入れた新しい行を足す運用になる。
 */
export function RateMasterForm({
  types,
  action,
}: {
  types: AccommodationType[];
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  const [state, submit] = useActionState(action, SUBMIT_IDLE);
  const [priceYen, setPriceYen] = useState(0);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          宿泊形態
          <select name="roomType" required className="rounded border border-neutral-300 px-3 py-2">
            {types.map((type) => (
              <option key={type.roomType} value={type.roomType}>
                {type.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          会員区分
          <select
            name="memberCategory"
            required
            defaultValue="member"
            className="rounded border border-neutral-300 px-3 py-2"
          >
            <option value="member">会員</option>
            <option value="non_member">非会員</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        1泊あたり単価（円）
        <input
          type="number"
          name="pricePerNightYen"
          min={0}
          required
          value={priceYen}
          onChange={(event) => setPriceYen(Number.parseInt(event.target.value, 10) || 0)}
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <span className="text-xs text-neutral-600">
          表示価格: <Money priceYen={priceYen} />
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          適用開始日
          <input
            type="date"
            name="effectiveFrom"
            required
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          適用終了日（空欄＝現行）
          <input type="date" name="effectiveUntil" className="rounded border border-neutral-300 px-3 py-2" />
        </label>
      </div>

      <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-white">
        追加する
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
