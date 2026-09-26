import Link from "next/link";

import type { MyStayDay, MyStayTone } from "@/lib/lodging/calendar";

/**
 * 本人の宿泊予定・履歴カレンダー（画面ID A12 ／ WBS 3-8）。
 *
 * 根拠: v13 §5.2.5②（本人向け＝「月表示のカレンダー」「日付タップで当該滞在の詳細へ遷移」）／
 *       `画面設計.md` §4 A12（表示・遷移・区別）。
 *
 * ## 表示だけを持つ
 *
 * どの滞在を載せるかは `buildMyStayCalendar()` が決める（`member_id` の一致のみ）。
 * ここで絞り込みを書き足さない。**置き場所を変えられるようにこの形にしてある**
 * （正本は A6 マイログ内のタブと定めており、`/reservations` からはここへ送る）。
 *
 * ## 3種の区別は色で出す
 *
 * `画面設計.md` §4 A12「予定と履歴、および『要確認』ステータスの予約を色で区別する」。
 * 色だけに頼らず語（予定／履歴／要確認）も添える。色覚の差で区別が消えないようにするため。
 */
export function StayCalendar({ month, days }: { month: string; days: readonly MyStayDay[] }) {
  return (
    <div className="flex flex-col gap-2">
      <ol className="grid grid-cols-7 gap-1">
        {/* 月初の曜日までを空セルで埋める。週の列と曜日を合わせるため。 */}
        {Array.from({ length: leadingBlankCount(month) }, (_, index) => (
          <li key={`blank-${index}`} aria-hidden="true" />
        ))}

        {days.map((day) => (
          <li key={day.date} className="min-h-14">
            <DayCell day={day} />
          </li>
        ))}
      </ol>

      <ul className="flex flex-wrap gap-2 text-xs text-neutral-600">
        {(["upcoming", "history", "attention"] as const).map((tone) => (
          <li key={tone} className={`rounded px-2 py-0.5 ${TONE_CLASS[tone]}`}>
            {TONE_LABEL[tone]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DayCell({ day }: { day: MyStayDay }) {
  const dayOfMonth = Number.parseInt(day.date.slice(8, 10), 10);

  if (day.tone === null || day.href === null) {
    return (
      <span className="flex h-full flex-col rounded border border-neutral-200 p-1 text-xs text-neutral-500">
        {dayOfMonth}
      </span>
    );
  }

  return (
    <Link
      href={day.href}
      className={`flex h-full flex-col rounded border p-1 text-xs ${TONE_CLASS[day.tone]}`}
    >
      <span className="font-medium">{dayOfMonth}</span>
      <span>{TONE_LABEL[day.tone]}</span>
    </Link>
  );
}

const TONE_CLASS: Record<MyStayTone, string> = {
  upcoming: "border-sky-400 bg-sky-50 text-sky-900",
  history: "border-neutral-300 bg-neutral-100 text-neutral-700",
  attention: "border-rose-400 bg-rose-50 text-rose-900",
};

const TONE_LABEL: Record<MyStayTone, string> = {
  upcoming: "予定",
  history: "履歴",
  attention: "要確認",
};

/**
 * 月初の曜日（日曜=0）。UTC で読むのは日付の組み立て側（`datesOfMonth()`）と揃えるためで、
 * ここをローカル時刻にすると月初が1日ずれて曜日の列が全部動く。
 */
function leadingBlankCount(month: string): number {
  return new Date(`${month}-01T00:00:00Z`).getUTCDay();
}
