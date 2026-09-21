// 宿泊予定カレンダーの組み立て（WBS 3-6 ／ 画面ID C10）。純関数だけを置く。
//
// 根拠: v13 §5.2.5①（残枠は都度算出）、§9 #30-⑤（Googleカレンダー同等の操作感）、
//       `0015_room_availability_view.sql`（残枠の正本）。

import type { DailyAvailability, StayEntry } from "./fetch-lodging";

export type CalendarDay = {
  date: string;
  /** その日に滞在している予約。日付をまたぐ予約は該当する全日に現れる。 */
  stays: StayEntry[];
  /** 宿泊形態ごとの残枠。`v_room_availability` の行をそのまま束ねる。 */
  availability: DailyAvailability[];
};

/**
 * 月の日付を列挙する（`YYYY-MM` → `YYYY-MM-DD` の配列）。
 *
 * UTC で組み立てるのは、実行環境のタイムゾーンで月末が1日ずれるのを避けるため
 * （`availability.ts` の `datesOfStay()` と同じ理由）。
 */
export function datesOfMonth(month: string): string[] {
  const [year, monthIndex] = month.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(monthIndex)) {
    throw new RangeError(`月の指定が不正です: ${month}`);
  }

  const dates: string[] = [];
  const cursor = new Date(Date.UTC(year, monthIndex - 1, 1));
  while (cursor.getUTCMonth() === monthIndex - 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * その日を滞在が専有しているか。
 *
 * **退去日は専有しない**（`availability.ts` の `occupiesDate()` と同じ約束）。
 * ここだけ `<=` にすると、カレンダーの人数とビューの残枠が食い違う。
 */
function occupiesDate(stay: StayEntry, date: string): boolean {
  return stay.checkInDate <= date && date < stay.checkOutDate;
}

/** 日付 × 滞在 × 残枠を1日分ずつに束ねる。 */
export function buildCalendar(params: {
  dates: readonly string[];
  stays: readonly StayEntry[];
  availability: readonly DailyAvailability[];
}): CalendarDay[] {
  const availabilityByDate = new Map<string, DailyAvailability[]>();
  for (const row of params.availability) {
    const bucket = availabilityByDate.get(row.date);
    if (bucket === undefined) {
      availabilityByDate.set(row.date, [row]);
    } else {
      bucket.push(row);
    }
  }

  return params.dates.map((date) => ({
    date,
    stays: params.stays.filter((stay) => occupiesDate(stay, date)),
    availability: availabilityByDate.get(date) ?? [],
  }));
}

/**
 * その日の滞在人数（大人＋子ども）。
 *
 * 予約の件数ではなく人数を数える。食事の仕込みも寝具の用意も人数で決まるためで、
 * 「3件」とだけ出されても現場では使えない（v13 §5.2.5①）。
 */
export function headcountOn(day: CalendarDay): number {
  return day.stays.reduce((total, stay) => total + stay.adultsCount + stay.childrenCount, 0);
}

/**
 * 要確認の日か。**1形態でも満室なら印を付ける。**
 *
 * 満室そのものは異常ではないが、当日の追加受け入れができない日であり、
 * 運営が事前に気づけることに意味がある（§9 #30-⑤「要確認強調」）。
 */
export function needsAttention(day: CalendarDay): boolean {
  return day.availability.some((row) => row.total > 0 && row.available === 0);
}
