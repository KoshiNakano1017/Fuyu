"use client";

import { useActionState, useState } from "react";

import { Money } from "@/components/ui/Money";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { AccommodationType, DailyAvailability } from "@/lib/lodging/fetch-lodging";
import type { AccommodationRate } from "@/lib/lodging/rates";
import {
  maxApplicableTicketNights,
  quoteReservation,
  TRANSPORT_LABELS,
  TRANSPORT_METHODS,
} from "@/lib/lodging/reservation-intake";

/**
 * 宿泊予約フォーム（画面ID A11 ／ WBS 3-7 ／ v13 §5.2.4）。
 *
 * ## 満室の形態は選ばせない
 *
 * v13 §5.2.3 ③ が「満室の宿泊形態は選択不可にする」と定めている。
 * ただしここで見ているのは**今日の残枠**でしかなく、選んだ日程の残枠ではない。
 * 日程を含めた本当の判定は確定時にサーバが行う（`createReservationAction`）。
 * 画面側は「明らかに取れないもの」を先に落として往復を減らすだけである。
 *
 * ## 既定はドミトリー、または前回の滞在
 *
 * v13 §5.2.4 の既定値はドミトリーだが、**前回の滞在がある会員にはその形態・人数を初期値にする**
 * （同節「既知情報の再入力を求めない」）。毎回同じ内容を選び直させるのが現行フォームの摩擦の中心にある。
 *
 * ## 金額は入力しながら見える（Uii 主・円 副）
 *
 * 料金は**夜ごとにその日付で有効な単価**を引いて積む（§5.4.2② ／ `quoteReservation()`）。
 * サーバと同じ純関数をそのまま使っているので、画面の見積りと確定後の金額が食い違わない。
 * 単価が未登録の夜は 0 円として足さず、「単価未登録」として出す。
 *
 * ## 宿泊券は「充当の意思」だけを受け取る
 *
 * **予約時点では消費しない**（v13 §5.2.4）。消費はチェックアウト時である（WBS 3-4）。
 * 入力の上限は「泊数」と「保有数」の小さいほうで、サーバ側でも残高を引き直して検査する。
 */
export function ReservationForm({
  types,
  todayAvailability,
  rates,
  stayTicketBalance,
  prefill,
  today,
  action,
}: {
  types: AccommodationType[];
  todayAvailability: DailyAvailability[];
  /** 宿泊料金マスタ（`accommodation_rates`）。金額だけのデータで個人情報を含まない */
  rates: AccommodationRate[];
  stayTicketBalance: number;
  /** 前回の滞在から作った初期値（無ければ null ／ v13 §5.2.4） */
  prefill: { roomType: string; adultsCount: number; childrenCount: number } | null;
  /** 日本時間の今日。`min` 属性とサーバ側の判定基準日を揃える */
  today: string;
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  const [state, submit] = useActionState(action, SUBMIT_IDLE);

  const remainingOf = new Map(todayAvailability.map((row) => [row.roomType, row.available]));
  const fallbackRoomType =
    types.find((type) => type.roomType === "dormitory")?.roomType ?? types[0]?.roomType ?? "";

  const [roomType, setRoomType] = useState(prefill?.roomType ?? fallbackRoomType);
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [stayTicketNights, setStayTicketNights] = useState(0);

  const quote =
    checkInDate !== "" && checkOutDate > checkInDate
      ? quoteReservation({
          roomType,
          checkInDate,
          checkOutDate,
          rates,
          // ログインしている＝会員料金（`rates.ts` の `memberCategoryOf()` の規則）
          memberCategory: "member",
          stayTicketNights,
        })
      : null;

  const maxTickets = maxApplicableTicketNights({
    nights: quote?.lines.length ?? 0,
    balance: stayTicketBalance,
  });

  return (
    <form action={submit} className="flex flex-col gap-4">
      <p className="rounded bg-neutral-100 px-3 py-2 text-xs text-neutral-700">
        氏名・連絡先は登録済みの情報を使うため、入力は要りません（v13 §5.2.4）。
        宿泊者名簿（宿泊法の申告項目）は当日の受付でお伺いします。
      </p>

      <label className="flex flex-col gap-1 text-sm">
        宿泊形態
        <select
          name="roomType"
          required
          value={roomType}
          onChange={(event) => setRoomType(event.target.value)}
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
            min={today}
            value={checkInDate}
            onChange={(event) => setCheckInDate(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          チェックアウト
          <input
            type="date"
            name="checkOutDate"
            required
            min={checkInDate === "" ? today : checkInDate}
            value={checkOutDate}
            onChange={(event) => setCheckOutDate(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          到着予定時刻
          <input
            type="time"
            name="arrivalTime"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          交通手段
          <select
            name="transportMethod"
            defaultValue=""
            className="rounded border border-neutral-300 px-3 py-2"
          >
            <option value="">選択しない</option>
            {TRANSPORT_METHODS.map((method) => (
              <option key={method} value={method}>
                {TRANSPORT_LABELS[method]}
              </option>
            ))}
          </select>
          {/* 送迎は課金項目。金額はメニューマスタが持ち、チェックイン時に伝票へ計上する（v13 §5.4.2③） */}
          <span className="text-xs text-neutral-600">
            送迎は片道 <Money priceYen={1900} /> です。当日のお会計に加算します。
          </span>
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
            defaultValue={prefill?.adultsCount ?? 1}
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
            defaultValue={prefill?.childrenCount ?? 0}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </div>

      {/* 宿泊費（Uii 主・円 副 ／ v13 §5.5）。夜ごとにその日付の単価を積む（§5.4.2②） */}
      {quote === null ? (
        <p className="text-xs text-neutral-600">日程を選ぶと宿泊費の見積りが出ます。</p>
      ) : (
        <div className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-bold">宿泊費（{quote.lines.length}泊）</span>
            <Money priceYen={quote.totalYen} />
          </div>
          <ul className="flex flex-col gap-0.5 text-xs text-neutral-700">
            {quote.lines.map((line) => (
              <li key={line.date} className="flex flex-wrap justify-between gap-2">
                <span>{line.date}</span>
                <span>
                  {line.pricePerNightYen === null ? (
                    <span className="text-amber-700">単価未登録</span>
                  ) : (
                    <Money priceYen={line.pricePerNightYen} />
                  )}
                </span>
              </li>
            ))}
          </ul>
          {quote.missingRateNights === 0 ? null : (
            <p className="text-xs text-amber-700">
              {quote.missingRateNights}泊は料金が未登録のため、合計に含めていません。金額は運営が確定します。
            </p>
          )}
          {stayTicketNights === 0 ? null : quote.payableYen === null ? (
            <p className="text-xs text-amber-700">
              料金改定をまたぐ日程のため、宿泊券を充当したあとの金額は運営が確定します。
            </p>
          ) : (
            <p className="flex flex-wrap items-baseline gap-1 text-sm">
              <span>宿泊券 {quote.coveredNights}泊を充当した場合のお支払い</span>
              <Money priceYen={quote.payableYen} />
            </p>
          )}
        </div>
      )}

      <label className="flex flex-col gap-1 text-sm">
        宿泊券の充当（保有 {stayTicketBalance} 泊）
        <input
          type="number"
          name="stayTicketNights"
          min={0}
          max={maxTickets}
          value={stayTicketNights}
          onChange={(event) => setStayTicketNights(Number(event.target.value))}
          className="w-24 rounded border border-neutral-300 px-3 py-2"
        />
        <span className="text-xs text-neutral-600">
          充当できるのは最大 {maxTickets} 泊です。
          <strong>予約の時点では消費しません</strong>（チェックアウト時に消費します）。
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        備考
        <textarea name="note" rows={3} className="rounded border border-neutral-300 px-3 py-2" />
        {/* 自動確定の基準は「完全な空欄のみ」（v13 §5.2.4 ／ §9 #30-③） */}
        <span className="text-xs text-neutral-600">
          空欄のままならそのまま確定します。何か書かれている場合は、運営が確認してから確定します。
        </span>
      </label>

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
