import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { buildCalendar, datesOfMonth, headcountOn, needsAttention } from "@/lib/lodging/calendar";
import {
  fetchAccommodationTypes,
  fetchAvailability,
  fetchStaysOverlapping,
} from "@/lib/lodging/fetch-lodging";
import { fetchMealReservationsBetween } from "@/lib/lodging/meal-reservation-store";
import {
  MEAL_SLOT_LABELS,
  summarizeMealCounts,
  totalMeals,
} from "@/lib/lodging/meal-reservations";

/**
 * 宿泊予定カレンダー（画面ID C10 ／ WBS 3-6・3-8）。
 *
 * ## 残枠は保存せず都度算出する
 *
 * v13 §5.2.5① の要求。表示は `v_room_availability`（`0015`）を読むだけで、
 * 画面側で在庫を持たない。保存値を持つと、予約のキャンセルや部屋のメンテ入りで
 * **静かにずれた在庫**が残る。
 *
 * ## 人数で出す
 *
 * 件数ではなく人数（大人＋子ども）を出す。食事の仕込みも寝具も人数で決まるため、
 * 「3件」とだけ出しても現場では使えない。
 *
 * ⚠️ **実名を出さない。** カレンダーは運営PCに開きっぱなしになるため、
 * 表示名（ニックネーム／会員番号）に留める（CLAUDE.md §7.1）。
 *
 * ## 日別の食数サマリー（2026-09-26 ／ WBS 3-5c ／ v13 §5.4.1b）
 *
 * 朝・昼・夜の**食数**（数量の合計）を日ごとに併記する。前日の時点で翌日の仕込み数が出せることが
 * カフェ事前予約の実質的な価値であり、この画面がその出口である。
 * ⚠️ 誰が予約したかは出さない（食数だけで足り、行レベルの情報を増やさない）。
 */
export default async function StaffCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  try {
    await requireStaff();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  const { month: requestedMonth } = await searchParams;
  const month = normalizeMonth(requestedMonth);
  const dates = datesOfMonth(month);
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  const [types, availability, stays, meals] = await Promise.all([
    fetchAccommodationTypes(),
    fetchAvailability({ fromDate, toDate }),
    fetchStaysOverlapping({ fromDate, toDate }),
    // 日別の食数サマリー（v13 §5.4.1b「管理画面」／ WBS 3-5c）。
    // **前日の時点で翌日の仕込み数が出せること**が事前予約の実質的な価値である。
    fetchMealReservationsBetween({ fromDate, toDate }),
  ]);

  const displayNameOf = new Map(types.map((type) => [type.roomType, type.displayName]));
  const days = buildCalendar({ dates, stays, availability });
  const mealCounts = summarizeMealCounts(meals);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">宿泊予定カレンダー</h1>
        <nav className="flex gap-2 text-sm">
          <Link className="underline" href={`/staff/calendar?month=${shiftMonth(month, -1)}`}>
            前の月
          </Link>
          <span>{month}</span>
          <Link className="underline" href={`/staff/calendar?month=${shiftMonth(month, 1)}`}>
            次の月
          </Link>
        </nav>
      </div>

      {availability.length === 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          この月の残枠は算出できません。残枠ビューは今日から180日先までしか持ちません。
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {days.map((day) => {
          const attention = needsAttention(day);
          return (
            <li
              key={day.date}
              className={
                attention
                  ? "rounded border border-amber-400 bg-amber-50 p-3"
                  : "rounded border border-neutral-200 bg-white p-3"
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {day.date}
                  {attention && (
                    <span className="ml-2 rounded bg-amber-200 px-2 py-0.5 text-xs text-amber-900">
                      要確認（満室の形態あり）
                    </span>
                  )}
                </span>
                <span className="text-sm text-neutral-600">
                  滞在 {headcountOn(day)}名 / {day.stays.length}件
                </span>
              </div>

              {/*
                食数サマリー（v13 §5.4.1b）。★ **数量の合計**で出す（件数ではない）。
                4人分1件と1人分1件を同じ「1」にすると仕込みが足りない。
              */}
              <p className="mt-1 text-xs text-neutral-700">
                {totalMeals(mealCounts.get(day.date)) === 0
                  ? "食事の事前予約なし"
                  : (["breakfast", "lunch", "dinner"] as const)
                      .map(
                        (slot) =>
                          `${MEAL_SLOT_LABELS[slot]} ${mealCounts.get(day.date)?.[slot] ?? 0}食`,
                      )
                      .join(" ／ ")}
              </p>

              <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                {day.availability.map((row) => (
                  <li
                    key={`${day.date}-${row.roomType}`}
                    className={
                      row.available === 0
                        ? "rounded bg-neutral-700 px-2 py-0.5 text-white"
                        : "rounded bg-neutral-100 px-2 py-0.5"
                    }
                  >
                    {displayNameOf.get(row.roomType) ?? row.roomType} 残 {row.available}/{row.total}
                  </li>
                ))}
              </ul>

              {day.stays.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-700">
                  {day.stays.map((stay) => (
                    <li key={`${day.date}-${stay.checkinId}`} className="rounded border px-2 py-0.5">
                      {stay.memberLabel}（{displayNameOf.get(stay.roomType) ?? stay.roomType} ／{" "}
                      {stay.adultsCount + stay.childrenCount}名 ／ {stay.status}）
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/** `YYYY-MM` の形でなければ今月に倒す。URL から任意の文字列が来るため。 */
function normalizeMonth(candidate: string | undefined): string {
  if (candidate !== undefined && /^\d{4}-\d{2}$/.test(candidate)) {
    return candidate;
  }
  return new Date().toISOString().slice(0, 7);
}

/** 月を前後に動かす。年またぎは `Date` に任せる（自前の繰り上がりを書かない）。 */
function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split("-").map((part) => Number.parseInt(part, 10));
  const shifted = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}
