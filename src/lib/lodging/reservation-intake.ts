/**
 * アプリ内からの宿泊予約の受付判定（WBS 3-7 ／ v13 §5.2.4 ／ §9 #36）。純関数だけを置く。
 *
 * 「一度アカウントを作成した利用者が、アプリから直接次回の宿泊を予約できる」ための層である。
 * 残枠の判定は `availability.ts`、料金は `rates.ts`、夜ごとの積み上げは `stay-changes.ts` が持ち、
 * ここは**受け付けてよいかの判断と、予約1件の見積り**に絞る。
 *
 * ## 3-7 の残りは「会員だから省けること・会員だから使えるもの」だった
 *
 * 日程・形態・残枠・人数の基本フローは 2026-09-21 に実装済みで（`/reservations`）、
 * WBS が残していたのは **①既知情報の再入力を求めない ②会員料金の表示 ③宿泊券の充当**の3点である
 * （v13 §5.2.4 の表）。いずれも「ログインしている」ことから導ける振る舞いであり、
 * 公開予約ページ（`/reserve` ／ WBS 3-5b）には無い。
 *
 * ## 既知情報を「自動補完」する範囲
 *
 * §5.2.4 は氏名・連絡先・住所・前泊地を会員マスタから補完すると定めるが、
 * **アプリ内の予約フォームはそれらを最初から尋ねていない**（会員行に既にあるため）。
 * したがってここでの自動補完は「**前回の滞在の形態・人数・交通手段を初期値にする**」であり、
 * PII（氏名・住所）をフォームへ書き戻すことはしない。
 * 宿泊法の申告項目はチェックイン時の名簿（`lodging_register_entries` ／ WBS 3-2）が扱う。
 */

import { countNights, datesOfStay } from "./availability";
import type { AccommodationRate } from "./rates";
import {
  nightlyLodgingCharge,
  type NightlyCharge,
  type NightlyStay,
} from "./stay-changes";

/** 交通手段（`0026` の `chk_check_ins_transport_method` と同じ4値）。 */
export const TRANSPORT_METHODS = ["car", "taxi", "shuttle", "other"] as const;

export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/** 利用者向けの表示名。内部識別子を画面へ出さない。 */
export const TRANSPORT_LABELS: Record<TransportMethod, string> = {
  car: "車",
  taxi: "タクシー",
  // ★ 送迎は課金項目である（v13 §5.4.2③ ／ 片道 1,900円）。金額は `menu_items` が持つ
  shuttle: "送迎（片道・当日のお会計に加算）",
  other: "その他",
};

/** 残枠ビューが持つ窓（`0015`：今日から180日先）。ここを超える日程は可否を判定できない。 */
export const RESERVABLE_DAYS_AHEAD = 180;

export type ReservationInput = {
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  /** `HH:MM`。空文字は「申告なし」 */
  arrivalTime: string;
  /** `TRANSPORT_METHODS` のいずれか。空文字は「選択しない」 */
  transportMethod: string;
  adultsCount: number;
  childrenCount: number;
  /** 宿泊券を何泊ぶん充てるか。**予約時点では消費しない**（v13 §5.2.4） */
  stayTicketNights: number;
  note: string;
};

export type ReservationRejection =
  | "not_signed_in"
  | "unknown_type"
  | "invalid_dates"
  | "past_date"
  | "outside_window"
  | "invalid_headcount"
  | "invalid_arrival_time"
  | "invalid_transport"
  | "too_many_tickets"
  | "full";

export type ReservationPlan = {
  nights: number;
  /** ★ 備考が**完全な空欄**なら自動確定（v13 §5.2.4 ／ §9 #30-③） */
  autoConfirmed: boolean;
  /** `check_ins.status` に入れる値 */
  status: "confirmed" | "pre_registered";
  /** 充当する宿泊券（泊）。残高と泊数で頭を押さえた値 */
  stayTicketNights: number;
};

export type ReservationDecision =
  | { allowed: true; plan: ReservationPlan }
  | { allowed: false; reason: ReservationRejection };

const ARRIVAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 受け付けてよいか。**残枠は含まない**（`full` は呼び出し側が数えた結果を渡す場面のための値で、
 * ここでは返さない）。残枠は DB を読む必要があり、純関数の外にある。
 *
 * 判定の順序は「利用者が直せる順」にしてある。日付の誤りを「満室です」と言い換えて返さない。
 */
export function decideReservation(params: {
  input: ReservationInput;
  knownRoomTypes: readonly string[];
  /** 保有宿泊券（泊）。`stay_ticket_balance()` の値 */
  stayTicketBalance: number;
  /** 判定基準日（日本時間の今日 ／ `src/lib/today.ts`） */
  today: string;
}): ReservationDecision {
  const { input } = params;

  if (!params.knownRoomTypes.includes(input.roomType)) {
    return { allowed: false, reason: "unknown_type" };
  }
  if (input.checkInDate === "" || input.checkOutDate === "" || input.checkOutDate <= input.checkInDate) {
    return { allowed: false, reason: "invalid_dates" };
  }
  if (input.checkInDate < params.today) {
    // 過去日の予約は残枠ビューの窓（今日起点）にも無く、可否を数えられない。
    return { allowed: false, reason: "past_date" };
  }
  if (input.checkInDate > addDays(params.today, RESERVABLE_DAYS_AHEAD)) {
    return { allowed: false, reason: "outside_window" };
  }
  if (
    !Number.isSafeInteger(input.adultsCount) ||
    !Number.isSafeInteger(input.childrenCount) ||
    input.adultsCount < 0 ||
    input.childrenCount < 0 ||
    input.adultsCount + input.childrenCount < 1
  ) {
    return { allowed: false, reason: "invalid_headcount" };
  }
  if (input.arrivalTime !== "" && !ARRIVAL_TIME.test(input.arrivalTime)) {
    return { allowed: false, reason: "invalid_arrival_time" };
  }
  if (
    input.transportMethod !== "" &&
    !(TRANSPORT_METHODS as readonly string[]).includes(input.transportMethod)
  ) {
    return { allowed: false, reason: "invalid_transport" };
  }

  const nights = countNights({
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    adultsCount: input.adultsCount,
    childrenCount: input.childrenCount,
  });

  // ★ 充当は「泊数」と「残高」の**両方**で頭を押さえる。超過は黙って切り詰めずに断る —
  //   切り詰めると、利用者が思った額と請求額が違う状態で予約が成立する。
  if (
    !Number.isSafeInteger(input.stayTicketNights) ||
    input.stayTicketNights < 0 ||
    input.stayTicketNights > maxApplicableTicketNights({ nights, balance: params.stayTicketBalance })
  ) {
    return { allowed: false, reason: "too_many_tickets" };
  }

  return {
    allowed: true,
    plan: {
      nights,
      autoConfirmed: autoConfirms(input.note),
      status: autoConfirms(input.note) ? "confirmed" : "pre_registered",
      stayTicketNights: input.stayTicketNights,
    },
  };
}

/**
 * 残枠を数えるために、要求された滞在を夜ごとに展開する。
 *
 * 滞在中の変更（WBS 3-10）の `nightsToJudge()` と同じ形（`NightlyStay`）を返すので、
 * 満室判定は `findFullNight()` を共用できる。**予約と変更で別の式を持たない**のが肝心である
 * （片方だけ棟貸型の数え方を直す、という取りこぼしが起きる）。
 */
export function requestedNights(input: {
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
}): NightlyStay[] {
  return datesOfStay({
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    adultsCount: input.adultsCount,
    childrenCount: input.childrenCount,
  }).map((date) => ({
    date,
    roomType: input.roomType,
    adultsCount: input.adultsCount,
    childrenCount: input.childrenCount,
  }));
}

/**
 * ★ 備考が空なら自動確定する（v13 §5.2.4「確定処理」／§9 #30-③「完全な空欄のみ」）。
 *
 * 現場の要望は「定型的な予約を人手で触らない」ことであり、**何か書かれている予約は読む前提**である。
 * 判定は `trim()` して空かどうか — **空白や改行だけの備考は「書かれていない」として扱う**。
 * 公開予約ページ（`public-reservation.ts`）が同じ式を使っており、
 * 経路によって確定の基準が違う状態を作らないためにここも揃えてある。
 */
export function autoConfirms(note: string): boolean {
  return note.trim() === "";
}

/** 充当できる上限（泊）。泊数と残高の小さいほう。 */
export function maxApplicableTicketNights(params: { nights: number; balance: number }): number {
  return Math.max(0, Math.min(params.nights, params.balance));
}

/**
 * 予約1件の見積り。**夜ごとにその日付で有効な単価を引く**（v13 §5.4.2②）。
 *
 * 料金改定をまたぐ滞在で「今の単価 × 泊数」を出すと、改定前の夜まで新価格になる。
 * 積み上げの実体は `stay-changes.ts` の `nightlyLodgingCharge()` であり、
 * 滞在中の形態変更（WBS 3-10）と**同じ関数で計算する**（画面ごとに式を持たない）。
 */
export function quoteReservation(params: {
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  rates: readonly AccommodationRate[];
  memberCategory: "member" | "non_member";
  /** 充当する宿泊券（泊）。差し引いた請求額は**単価が一律の場合だけ**出す（下記） */
  stayTicketNights?: number;
}): {
  lines: NightlyCharge[];
  totalYen: number;
  missingRateNights: number;
  coveredNights: number;
  /**
   * 宿泊券を充当したあとに現地で払う額（円）。
   *
   * ★ **夜ごとの単価が揃っていないときは `null` を返す。** 宿泊券は「1泊」の券であって
   * 金額が紐づいていないため、**どの夜に充てるか**で支払額が変わる。その順序は正本（v13 §5.2.4）に
   * 書かれておらず、ここで決めると**金額の仕様を実装が勝手に確定させる**ことになる
   * （CLAUDE.md §7.0「認可・金額・個人情報の仕様判断は必ず先に聞く」）。
   * 料金改定をまたぐ滞在でだけ起きる場面なので、その場合は額を出さずに運営が確定する
   * （`QUESTIONS.md` [2026-09-26] に推奨つきで起票済み）。
   */
  payableYen: number | null;
} {
  const nights = datesOfStay({
    checkInDate: params.checkInDate,
    checkOutDate: params.checkOutDate,
    adultsCount: 0,
    childrenCount: 0,
  }).map((date) => ({ date, roomType: params.roomType }));

  const charge = nightlyLodgingCharge({
    nights,
    rates: params.rates,
    memberCategory: params.memberCategory,
  });

  const coveredNights = Math.max(0, Math.min(params.stayTicketNights ?? 0, charge.lines.length));
  const prices = charge.lines.map((line) => line.pricePerNightYen);
  const uniform = prices.every((price) => price !== null && price === prices[0]);

  return {
    ...charge,
    coveredNights,
    payableYen:
      uniform && prices.length > 0
        ? Math.max(0, charge.totalYen - coveredNights * (prices[0] as number))
        : coveredNights === 0
          ? charge.totalYen
          : null,
  };
}

/**
 * 前回の滞在から初期値を作る（v13 §5.2.4「既知情報の再入力を求めない」）。
 *
 * ⚠️ **PII（氏名・住所・前泊地）は扱わない。** 会員行にある情報をフォームへ書き戻すのではなく、
 * **尋ねないこと**で再入力を無くしている。宿泊法の申告項目はチェックイン時の名簿が担当する
 * （v13 §5.2.7 ／ WBS 3-2）。ここで返すのは予約の形（形態・人数）だけである。
 */
export function prefillFromStays(
  stays: readonly {
    roomType: string;
    checkInDate: string;
    adultsCount: number;
    childrenCount: number;
  }[],
): { roomType: string; adultsCount: number; childrenCount: number } | null {
  if (stays.length === 0) {
    return null;
  }
  const latest = [...stays].sort((left, right) =>
    right.checkInDate.localeCompare(left.checkInDate),
  )[0];
  return {
    roomType: latest.roomType,
    adultsCount: latest.adultsCount,
    childrenCount: latest.childrenCount,
  };
}

/** 断られた理由を現場の言葉にする。 */
export function reservationDenialMessage(reason: ReservationRejection): string {
  switch (reason) {
    case "not_signed_in":
      return "ログインが必要です。";
    case "unknown_type":
      return "宿泊形態を選んでください。";
    case "invalid_dates":
      return "チェックイン日より後のチェックアウト日を選んでください。";
    case "past_date":
      return "過去の日付では予約できません。";
    case "outside_window":
      return `予約できるのは ${RESERVABLE_DAYS_AHEAD} 日先までです。それ以降は運営へご相談ください。`;
    case "invalid_headcount":
      return "人数を1名以上で入力してください。";
    case "invalid_arrival_time":
      return "到着予定時刻は 00:00〜23:59 の形式で入力してください。";
    case "invalid_transport":
      return "交通手段を選び直してください。";
    case "too_many_tickets":
      return "充当する宿泊券は、泊数と保有数のどちらも超えないようにしてください。";
    case "full":
      return "選んだ期間は満室です。日程か宿泊形態を変えてお試しください。";
  }
}

/** 予約が通ったときの案内。自動確定かどうかで言うことが変わる（v13 §5.2.4「確定処理」）。 */
export function describeReservationResult(plan: ReservationPlan): string {
  const parts = [
    plan.autoConfirmed
      ? `予約を確定しました（${plan.nights}泊）。`
      : `予約を受け付けました（${plan.nights}泊）。備考を運営が確認してから確定します。`,
  ];
  if (plan.stayTicketNights > 0) {
    parts.push(
      `宿泊券 ${plan.stayTicketNights}泊ぶんを充当します（消費はチェックアウト時です）。`,
    );
  }
  return parts.join(" ");
}

/** 日付に日数を足す（UTC で組み立ててローカルタイムゾーンの影響を受けないようにする）。 */
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}
