"use client";

import { useActionState } from "react";

import { Money } from "@/components/ui/Money";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import {
  indexByDateAndSlot,
  MEAL_SLOT_LABELS,
  mealDaysForStay,
  type MealReservation,
  type MealSlot,
  type PreOrderableItem,
} from "@/lib/lodging/meal-reservations";

export type SaveMealPreOrdersAction = (
  prev: SubmitState,
  formData: FormData,
) => Promise<SubmitState>;

/** 1滞在ぶんの表示材料。 */
export type MealPreOrderView = {
  checkinId: string;
  checkInDate: string;
  checkOutDate: string;
  status: string;
  reservations: readonly MealReservation[];
};

/**
 * カフェの事前予約注文（WBS 3-5c ／ v13 §5.4.1b ／ 画面ID A11 のステップ④・C11「宿泊」）。
 *
 * ## 滞在日ぶんの枠を出す（当日分だけではない）
 *
 * **朝ごはんはチェックイン翌朝**であり、2泊すれば夕食2回・朝食2回になる（§5.4.1b の [!note]）。
 * 到着日は昼・夜、中日は朝・昼・夜、**退去日は朝**を出す。
 * 退去日を落とすと最終日の朝の仕込みが毎回抜ける。
 *
 * ## すべて任意である
 *
 * 未選択でも宿泊予約は成立する（2026-08-23 オーナー確定）。したがって
 * 「選択しない」を既定の選択肢として必ず置き、必須マークを付けない。
 *
 * ## 金額は出すが、ここでは請求しない
 *
 * 予約の時点で伝票（`orders`）は作らない（§5.4.1b の [!important]）。
 * 当日「提供」を操作した時点で伝票になる（WBS `6-5`）。画面でも**見込み額**として出す。
 */
export function MealPreOrderSection({
  view,
  items,
  canEdit,
  save,
}: {
  view: MealPreOrderView;
  items: readonly PreOrderableItem[];
  /** 本人がチェックイン後に触れないようにするための表示制御（判定の正はサーバ側） */
  canEdit: boolean;
  save: SaveMealPreOrdersAction;
}) {
  const [state, submit, isPending] = useActionState(save, SUBMIT_IDLE);

  const days = mealDaysForStay(view);
  const selected = indexByDateAndSlot(view.reservations);
  const itemsBySlot = (slot: MealSlot) => items.filter((item) => item.mealSlot === slot);

  const plannedYen = [...selected.values()].reduce((total, reservation) => {
    const item = items.find((candidate) => candidate.menuItemId === reservation.menuItemId);
    return total + (item?.unitPriceYen ?? 0) * reservation.quantity;
  }, 0);

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">
          食事の事前予約（{view.checkInDate} 〜 {view.checkOutDate}）
        </h3>
        {plannedYen === 0 ? (
          <span className="text-xs text-neutral-600">予約なし</span>
        ) : (
          <span className="text-xs text-neutral-700">
            見込み <Money priceYen={plannedYen} />
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-neutral-600">
          事前予約できるメニューが登録されていません（マスタ管理で「事前予約可」の商品を登録してください）。
        </p>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="checkinId" value={view.checkinId} />

          <ul className="flex flex-col gap-2">
            {days.map((day) => (
              <li key={day.date} className="flex flex-col gap-1">
                <span className="text-xs font-medium">{day.date}</span>
                <div className="grid gap-2 sm:grid-cols-3">
                  {day.slots.map((slot) => {
                    const current = selected.get(`${day.date}_${slot}`);
                    return (
                      <label key={slot} className="flex flex-col gap-1 text-xs">
                        {MEAL_SLOT_LABELS[slot]}
                        <select
                          name={`item_${day.date}_${slot}`}
                          defaultValue={current?.menuItemId ?? ""}
                          disabled={!canEdit || current?.convertedAt != null}
                          className="rounded border border-neutral-300 px-2 py-1 disabled:bg-neutral-100"
                        >
                          <option value="">選択しない</option>
                          {itemsBySlot(slot).map((item) => (
                            <option key={item.menuItemId} value={item.menuItemId}>
                              {item.name}（¥{item.unitPriceYen.toLocaleString("ja-JP")}）
                              {item.isSoldOut ? "／品切れ" : ""}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          name={`qty_${day.date}_${slot}`}
                          min={1}
                          max={20}
                          defaultValue={current?.quantity ?? 1}
                          disabled={!canEdit || current?.convertedAt != null}
                          className="w-16 rounded border border-neutral-300 px-2 py-1 disabled:bg-neutral-100"
                          aria-label={`${day.date} ${MEAL_SLOT_LABELS[slot]}の数量`}
                        />
                        {current?.convertedAt == null ? null : (
                          <span className="text-[0.7rem] text-neutral-500">提供済み（伝票あり）</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={isPending}
                className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              >
                食事の予約を保存する
              </button>
              <span className="text-[0.7rem] text-neutral-500">
                すべて任意です。ここで選んでも会計は<strong>提供した時点</strong>で発生します。
              </span>
            </div>
          ) : (
            <p className="text-xs text-neutral-600">
              チェックイン後の変更は現地で承ります（運営が代理で直せます）。
            </p>
          )}

          {state.status !== "idle" && state.message !== undefined ? (
            <p
              className={
                state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"
              }
            >
              {state.message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
