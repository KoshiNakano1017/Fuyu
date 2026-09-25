// 宿泊予定カレンダーの組み立て（WBS 3-6・3-8 ／ 画面ID A12・C10）。純関数だけを置く。
//
// 根拠: v13 §5.2.5①（残枠は都度算出）、§5.2.5②（本人向け A12 は月表示・日付タップで詳細へ／
//       運営向け C10 は月/週切替・「要確認」予約を強調）、§5.2.3 TO-BE④・§9 #30-④（「要確認」の
//       判定基準＝備考が完全な空欄のときだけ自動確定）、§9 #30-⑤（Googleカレンダー同等の操作感）、
//       `0015_room_availability_view.sql`（残枠の正本）。

import { formatJapanDateTime } from "@/lib/japan-time";

import type { DailyAvailability, MemberCategoryLabel, StayEntry } from "./fetch-lodging";

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


// ─────────────────────────────────────────────────────────────────────────────
// 本人向けカレンダー（画面ID A12 ／ v13 §5.2.5② 本人向け ／ 画面設計.md §4 A12）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 日セルの区別。**色そのものは画面の関心**なので、ここでは区別が付く語だけを決める
 * （画面設計.md §4 A12「予定と履歴、および『要確認』ステータスの予約を色で区別する」）。
 */
export type MyStayTone = "upcoming" | "history" | "attention";

/** 本人向けカレンダーの1日。 */
export type MyStayDay = {
  date: string;
  /** その日に滞在している**自分の**予約。 */
  stays: StayEntry[];
  /** 日付タップの遷移先。滞在が無い日は `null`（空振りのリンクを作らない）。 */
  href: string | null;
  /** 予定／履歴／要確認の区別。滞在が無い日は `null`。 */
  tone: MyStayTone | null;
};

/** キャンセル済みの予約か（`cancelled_at` が入っていれば論理削除済み）。 */
export function isCancelledStay(stay: StayEntry): boolean {
  return (stay.cancelledAt ?? null) !== null;
}

/**
 * 本人向けのキャンセル表示（v13 §5.2.2「本人への表示」）。
 *
 * 正本は「マイログの宿泊履歴に**『運営によりキャンセル（日時・理由）』**と表示し、
 * 相互確認できる状態にする」と定める。日時と理由を欠くと「相互確認」が成立しないため、
 * 文言と一緒に必ず両方を組み立てる。
 */
export function cancellationNoticeOf(stay: StayEntry): string | null {
  if (!isCancelledStay(stay)) {
    return null;
  }
  // 日時は**日本時間**で出す。サーバコンポーネントで描画されるため、タイムゾーンを明示しないと
  // 実行環境（Vercel / Node は UTC）の時刻が出て9時間ずれ、「相互確認」が成立しない。
  const cancelledOn = formatJapanDateTime(stay.cancelledAt as string);
  const reason = [stay.cancelReasonType, stay.cancelReason].filter(
    (part) => (part ?? "") !== "",
  ) as string[];
  // 理由は入力必須（`0014` の chk_check_ins_cancel_reason）だが、
  // 取れなかったときに日時だけでも出す（無言で消えるより本人が問い合わせられる）。
  const reasonText = reason.length === 0 ? "理由の記録なし" : reason.join("・");
  return `運営によりキャンセル（${cancelledOn} ／ ${reasonText}）`;
}

/**
 * 本人の宿泊予定（未来）と宿泊履歴（過去）を月表示のカレンダーへ組む。
 *
 * ⚠️ **`memberId` の一致だけで絞る。** `role` も `member_type` も見ない
 * （v13 §6 の「自身の宿泊予定・履歴カレンダー」は全ロール〇 ／ CLAUDE.md §4.1）。
 * DB 側では RLS が同じ境界を引いているが、ここでも絞るのは
 * 運営向けの取得関数（`fetchStaysOverlapping()`）の結果を誤って渡したときに
 * 他人の滞在が画面へ出るのを防ぐためである。
 *
 * **キャンセル済みは日セルに描かない。** このカレンダーが表す「予定」「履歴」は
 * 実際に泊まる（泊まった）日であり、取り消された予約を同じ色で塗ると本人が
 * 有効な予約と取り違える。取り消された事実は日セルではなく、
 * 「キャンセルされた予約」の一覧として日時・理由つきで出す（v13 §5.2.2「本人への表示」／
 * `cancellationNoticeOf()`）。**除外であって非表示ではない。**
 */
export function buildMyStayCalendar(params: {
  month: string;
  /** 予定と履歴を分ける基準日（`YYYY-MM-DD`）。呼び出し側が今日を渡す。 */
  today: string;
  memberId: string;
  stays: readonly StayEntry[];
}): MyStayDay[] {
  const mine = params.stays.filter(
    (stay) => stay.memberId === params.memberId && !isCancelledStay(stay),
  );

  return datesOfMonth(params.month).map((date) => {
    const staysOnDate = mine.filter((stay) => occupiesDate(stay, date));
    return {
      date,
      stays: staysOnDate,
      href: hrefForMyStays(staysOnDate),
      tone: toneForMyStays(staysOnDate, date, params.today),
    };
  });
}

/** 日付タップの遷移先。複数の滞在が重なる日は先頭（＝開始が早い予約）へ送る。 */
function hrefForMyStays(staysOnDate: readonly StayEntry[]): string | null {
  const first = staysOnDate[0];
  return first === undefined ? null : `/me/stays/${first.checkinId}`;
}

/**
 * 日セルの区別を決める。
 *
 * 「要確認」を最優先にする。予定か履歴かは日付を見れば分かるが、
 * **運営の対応を待っている予約は本人が気づけないと止まったまま**になる（v13 §5.2.3 TO-BE③④）。
 */
function toneForMyStays(
  staysOnDate: readonly StayEntry[],
  date: string,
  today: string,
): MyStayTone | null {
  if (staysOnDate.length === 0) {
    return null;
  }
  if (staysOnDate.some(isNeedsAttentionStay)) {
    return "attention";
  }
  return date < today ? "history" : "upcoming";
}


// ─────────────────────────────────────────────────────────────────────────────
// 運営向けカレンダー（画面ID C10 ／ v13 §5.2.5② 運営向け ／ §5.2.3「表示内容」）
// ─────────────────────────────────────────────────────────────────────────────

/** 表示の粒度。Googleカレンダー同等の操作感＝月/週切替（v13 §9 #30-⑤）。 */
export type StaffCalendarView = "month" | "week";

/** 1予約から運営が読む内容（v13 §5.2.3「表示内容」）。 */
export type StaffStaySummary = {
  checkInDate: string;
  checkOutDate: string;
  roomType: string;
  /** 割当部屋。**確定していなければ `null`**（部屋の確定は予約成立の前提ではない）。 */
  assignedRoomName: string | null;
  adultsCount: number;
  childrenCount: number;
  memberCategory: MemberCategoryLabel | null;
};

/** 日セルに並ぶ1予約。要確認の印を持つ。 */
export type StaffStayEntry = StaffStaySummary & {
  checkinId: string;
  memberLabel: string;
  status: string;
  /** 「要確認」予約か（＝強調表示の対象 ／ v13 §5.2.3「『要確認』予約の見え方」）。 */
  needsAttention: boolean;
};

/** 運営向けカレンダーの1日。 */
export type StaffCalendarDay = {
  date: string;
  /** その日に滞在している**全会員の**予約。 */
  entries: StaffStayEntry[];
  /** 宿泊形態ごとの残枠（`v_room_availability` の行）。 */
  availability: DailyAvailability[];
};

/**
 * 「要確認」予約か。
 *
 * 判定は **備考（`note`）が完全な空欄でない** かつ **まだ自動確定されていない**（`pre_registered`）。
 * 「特になし」のような定型文言を空と見なしてはならない（v13 §9 #30-④）。
 * 空と見なすと、担当者が読むべき申し送りが自動確定に紛れて埋もれる。
 *
 * ⚠️ その日に満室の形態があること（`needsAttention(day)`）とは**別物**である。
 * あちらは残枠の話で、こちらは1予約ごとの対応状況である。
 */
export function isNeedsAttentionStay(stay: StayEntry): boolean {
  const hasNote = (stay.note ?? "") !== "";
  return hasNote && stay.status === "pre_registered";
}

/** 1予約から運営が読む内容を取り出す。**引けない値を別の値で埋めない。** */
export function summarizeStayForStaff(stay: StayEntry): StaffStaySummary {
  return {
    checkInDate: stay.checkInDate,
    checkOutDate: stay.checkOutDate,
    roomType: stay.roomType,
    assignedRoomName: stay.assignedRoomName ?? null,
    adultsCount: stay.adultsCount,
    childrenCount: stay.childrenCount,
    memberCategory: stay.memberCategory ?? null,
  };
}

/** 全予約を日付軸へ並べる。`view` で月表示と週表示を切り替える。 */
export function buildStaffCalendar(params: {
  view: StaffCalendarView;
  /** 表示の基準日（`YYYY-MM-DD`）。月表示ではこの日の属する月、週表示ではこの日を含む週。 */
  anchorDate: string;
  stays: readonly StayEntry[];
  availability: readonly DailyAvailability[];
}): StaffCalendarDay[] {
  const dates =
    params.view === "week"
      ? datesOfWeek(params.anchorDate)
      : datesOfMonth(params.anchorDate.slice(0, 7));

  return buildCalendar({ dates, stays: params.stays, availability: params.availability }).map(
    (day) => ({
      date: day.date,
      entries: day.stays.map((stay) => ({
        ...summarizeStayForStaff(stay),
        checkinId: stay.checkinId,
        memberLabel: stay.memberLabel,
        status: stay.status,
        needsAttention: isNeedsAttentionStay(stay),
      })),
      availability: day.availability,
    }),
  );
}

/**
 * 基準日を含む週の7日（日曜始まり）。
 *
 * 日曜始まりにするのは Googleカレンダーの既定と揃えるためである（v13 §9 #30-⑤）。
 * UTC で組むのは `datesOfMonth()` と同じ理由（実行環境のタイムゾーンで日付がずれるのを避ける）。
 */
export function datesOfWeek(anchorDate: string): string[] {
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) {
    throw new RangeError(`基準日の指定が不正です: ${anchorDate}`);
  }

  const sunday = new Date(anchor);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());

  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(sunday);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}
