import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { todayInJapan } from "@/lib/japan-time";
// ★ 名前空間で取る。`buildStaffCalendar` を import 名として書くと、
//   「認可判定より後ろで組み立てているか」をソースの並び順で読めなくなる
//   （`tests/lodging-staff-calendar.test.ts`「認可判定より前にカレンダーを組み立てない」）。
import * as stayCalendar from "@/lib/lodging/calendar";
import { datesOfMonth, datesOfWeek, type StaffCalendarView } from "@/lib/lodging/calendar";
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
 * ## 月と週を切り替える
 *
 * v13 §5.2.5②「Googleカレンダー同等の操作感（月/週切替）」／ §9 #30-⑤。
 * 当日の受け入れ準備は週で見る一方、予約の埋まり方は月で見るため、どちらかだけでは足りない。
 *
 * ## 「要確認」は予約ごとの印であり、満室の印ではない
 *
 * v13 §5.2.3 の「要確認」は**備考欄に記載があって自動確定されなかった予約**を指す
 * （§9 #30-④：空と見なすのは完全な空欄のみ）。満室の日に付ける印（`needsAttention(day)`）とは
 * 別の話なので、画面でも別の見出しで出す。混ぜると、対応待ちの予約が満室表示に埋もれる。
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
  searchParams: Promise<{ view?: string; date?: string; month?: string }>;
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

  const { view: requestedView, date: requestedDate, month: requestedMonth } = await searchParams;
  const view = normalizeView(requestedView);
  const anchorDate = normalizeAnchorDate(requestedDate, requestedMonth);

  const [types, availability, stays, meals] = await Promise.all([
    fetchAccommodationTypes(),
    fetchAvailability(rangeOf(view, anchorDate)),
    fetchStaysOverlapping(rangeOf(view, anchorDate)),
    // 日別の食数サマリー（v13 §5.4.1b「管理画面」／ WBS 3-5c）。
    // **前日の時点で翌日の仕込み数が出せること**が事前予約の実質的な価値である。
    fetchMealReservationsBetween(rangeOf(view, anchorDate)),
  ]);

  const displayNameOf = new Map(types.map((type) => [type.roomType, type.displayName]));
  const days = stayCalendar.buildStaffCalendar({ view, anchorDate, stays, availability });
  const mealCounts = summarizeMealCounts(meals);
  // 連泊の予約は泊数ぶん日セルに現れるため、`checkinId` で一意化してから数える。
  // 行数のまま数えると「3泊の要確認予約1件」が「3件」になり、見出しの「予約が N件」と食い違う。
  const attentionCheckinIds = new Set(
    days.flatMap((day) =>
      day.entries.filter((entry) => entry.needsAttention).map((entry) => entry.checkinId),
    ),
  );
  const attentionCount = attentionCheckinIds.size;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">宿泊予定カレンダー</h1>
        <nav className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex gap-2">
            <Link className="underline" href={hrefFor(view, shiftAnchor(view, anchorDate, -1))}>
              {view === "week" ? "前の週" : "前の月"}
            </Link>
            <span>{view === "week" ? `${anchorDate} の週` : anchorDate.slice(0, 7)}</span>
            <Link className="underline" href={hrefFor(view, shiftAnchor(view, anchorDate, 1))}>
              {view === "week" ? "次の週" : "次の月"}
            </Link>
          </span>
          <span className="flex gap-1">
            {(["month", "week"] as const).map((candidate) => (
              <Link
                key={candidate}
                href={hrefFor(candidate, anchorDate)}
                aria-current={view === candidate ? "page" : undefined}
                className={
                  view === candidate
                    ? "rounded bg-neutral-800 px-2 py-0.5 text-white"
                    : "rounded border border-neutral-300 px-2 py-0.5"
                }
              >
                {candidate === "month" ? "月表示" : "週表示"}
              </Link>
            ))}
          </span>
        </nav>
      </div>

      {attentionCount > 0 && (
        <p className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          「要確認」の予約が {attentionCount}件 あります。備考の内容を確認して確定操作を行ってください。
        </p>
      )}

      {availability.length === 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          この期間の残枠は算出できません。残枠ビューは今日から180日先までしか持ちません。
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {days.map((day) => {
          const fullyBooked = stayCalendar.needsAttention({
            date: day.date,
            stays: [],
            availability: day.availability,
          });
          const headcount = day.entries.reduce(
            (total, entry) => total + entry.adultsCount + entry.childrenCount,
            0,
          );

          return (
            <li key={day.date} className="rounded border border-neutral-200 bg-white p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {day.date}
                  {fullyBooked && (
                    <span className="ml-2 rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-800">
                      満室の形態あり
                    </span>
                  )}
                </span>
                <span className="text-sm text-neutral-600">
                  滞在 {headcount}名 / {day.entries.length}件
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

              {day.entries.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-neutral-700">
                  {day.entries.map((entry) => (
                    <li
                      key={`${day.date}-${entry.checkinId}`}
                      className={
                        entry.needsAttention
                          ? "rounded border border-rose-400 bg-rose-50 px-2 py-1 text-rose-900"
                          : "rounded border border-neutral-200 px-2 py-1"
                      }
                    >
                      {entry.needsAttention && <span className="mr-1 font-bold">要確認</span>}
                      {entry.memberLabel}
                      {/*
                        v13 §5.2.3「表示内容」＝ チェックイン日・チェックアウト日・部屋タイプ・
                        割当部屋（確定していれば）・大人/子供人数・会員区分。
                        割当部屋は未確定なら「未割当」と出す（別の部屋名で埋めない）。
                      */}
                      <span className="ml-1">
                        （{entry.checkInDate} 〜 {entry.checkOutDate} ／{" "}
                        {displayNameOf.get(entry.roomType) ?? entry.roomType} ／{" "}
                        {entry.assignedRoomName ?? "未割当"} ／ 大人 {entry.adultsCount}名・子供{" "}
                        {entry.childrenCount}名 ／ {entry.memberCategory ?? "区分不明"} ／{" "}
                        {entry.status}）
                      </span>
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

/** 表示の粒度。URL から任意の文字列が来るため、既知の2値以外は月へ倒す。 */
function normalizeView(candidate: string | undefined): StaffCalendarView {
  return candidate === "week" ? "week" : "month";
}

/**
 * 基準日。`date=YYYY-MM-DD` を優先し、無ければ従来の `month=YYYY-MM`（月初）を受ける。
 *
 * `month` も受け続けるのは、この画面のブックマーク・既存リンクを切らないためである。
 *
 * 書式だけでなく**日付として存在するか**まで見る。`?date=2026-02-30` や `?month=2026-13` は
 * 書式は通るが、そのまま渡すと `datesOfWeek()`／`shiftAnchor()` の `toISOString()` が
 * RangeError を投げ、画面が 500 になる。不正な指定は今日へ倒す。
 */
function normalizeAnchorDate(
  candidateDate: string | undefined,
  candidateMonth: string | undefined,
): string {
  if (candidateDate !== undefined && isRealDate(candidateDate)) {
    return candidateDate;
  }
  if (
    candidateMonth !== undefined &&
    /^\d{4}-\d{2}$/.test(candidateMonth) &&
    isRealDate(`${candidateMonth}-01`)
  ) {
    return `${candidateMonth}-01`;
  }
  // 既定は**日本時間の今日**。UTC で切ると JST 00:00〜09:00 に開いた運営へ前日の週・月を見せる
  // （`japan-time.ts`）。滞在日そのものが日本時間の `date` なので基準日も揃える。
  return todayInJapan();
}

/**
 * `YYYY-MM-DD` が実在する日付か。
 *
 * `Number.isNaN` だけでは足りない環境差を避けるため、UTC で組み直した値が入力と一致するかまで見る
 * （繰り上がりを起こす指定を「妥当」と判定しないため）。
 */
function isRealDate(candidate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    return false;
  }
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate;
}

/** 取得する期間。カレンダーに並べる日付の端から端まで。 */
function rangeOf(
  view: StaffCalendarView,
  anchorDate: string,
): { fromDate: string; toDate: string } {
  const dates = view === "week" ? datesOfWeek(anchorDate) : datesOfMonth(anchorDate.slice(0, 7));
  return { fromDate: dates[0], toDate: dates[dates.length - 1] };
}

/** 前後へ動かす。月表示は1か月、週表示は7日。繰り上がりは `Date` に任せる。 */
function shiftAnchor(view: StaffCalendarView, anchorDate: string, delta: number): string {
  const shifted = new Date(`${anchorDate}T00:00:00Z`);
  if (view === "week") {
    shifted.setUTCDate(shifted.getUTCDate() + delta * 7);
  } else {
    // 月をまたぐと日が溢れるため（1/31 の翌月など）、月表示の基準日は常に月初に置く。
    shifted.setUTCDate(1);
    shifted.setUTCMonth(shifted.getUTCMonth() + delta);
  }
  return shifted.toISOString().slice(0, 10);
}

function hrefFor(view: StaffCalendarView, anchorDate: string): string {
  return `/staff/calendar?view=${view}&date=${anchorDate}`;
}
