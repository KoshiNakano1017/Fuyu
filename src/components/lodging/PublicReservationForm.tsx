"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Money } from "@/components/ui/Money";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { AccommodationType, DailyAvailability } from "@/lib/lodging/fetch-lodging";
import type { AccommodationRate } from "@/lib/lodging/rates";

type Action = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 公開予約ページ（画面ID `/reserve` ／ WBS 3-5b）。
 *
 * ## 2段階にする理由
 *
 * v13 §5.2.3 TO-BE② が「**送信前に**メールOTPで本人確認を行う」と定めている。
 * 先に予約内容を送らせてから確認すると、確認を通らなかった入力が
 * サーバ側に溜まる（＝本人確認していない連絡先が残る）。
 *
 * ## 料金を表示するが、送らない
 *
 * 表示は利用者が選ぶための情報であり、請求はサーバが `accommodation_rates` から引く。
 * 未ログインの予約は**常に非会員料金**である（§5.2.3 の warning：自己申告を料金に使わない）。
 */
export function PublicReservationForm({
  types,
  todayAvailability,
  rates,
  requestCode,
  createReservation,
}: {
  types: AccommodationType[];
  todayAvailability: DailyAvailability[];
  rates: AccommodationRate[];
  requestCode: Action;
  createReservation: Action;
}) {
  const [codeState, sendCode] = useActionState(requestCode, SUBMIT_IDLE);
  const [reserveState, reserve] = useActionState(createReservation, SUBMIT_IDLE);

  const remainingOf = new Map(todayAvailability.map((row) => [row.roomType, row.available]));
  const nonMemberRate = new Map(
    rates
      .filter((rate) => rate.memberCategory === "non_member" && rate.effectiveUntil === null)
      .map((rate) => [rate.roomType, rate.pricePerNightYen]),
  );
  const codeSent = codeState.status === "done";

  return (
    <div className="flex flex-col gap-8">
      <p className="rounded border border-neutral-200 bg-white p-3 text-sm">
        会員の方は <Link href="/login" className="underline">ログイン</Link> してからのご予約で、
        登録済みの情報が引き継がれ、会員料金が適用されます。
      </p>

      <form action={sendCode} className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">1. メールアドレスの確認</h2>
        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-white">
          確認コードを送る
        </button>
        {codeState.message && (
          <p className={codeState.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
            {codeState.message}
          </p>
        )}
      </form>

      {codeSent && (
        <form action={reserve} className="flex flex-col gap-4">
          <h2 className="text-lg font-bold">2. ご予約の内容</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              メールアドレス（確認用）
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className="rounded border border-neutral-300 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              確認コード（6桁）
              <input
                type="text"
                name="code"
                required
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                className="rounded border border-neutral-300 px-3 py-2 tracking-widest"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              お名前
              <input type="text" name="fullName" required className="rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              電話番号（当日連絡用）
              <input type="tel" name="phone" className="rounded border border-neutral-300 px-3 py-2" />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            宿泊形態
            <select name="roomType" required className="rounded border border-neutral-300 px-3 py-2">
              {types.map((type) => {
                const remaining = remainingOf.get(type.roomType);
                const priceYen = nonMemberRate.get(type.roomType);
                return (
                  <option key={type.roomType} value={type.roomType} disabled={remaining === 0}>
                    {type.displayName}
                    {priceYen !== undefined && `（1泊 ${priceYen.toLocaleString("ja-JP")}円）`}
                    {remaining === 0 ? "（本日満室）" : ""}
                  </option>
                );
              })}
            </select>
            {nonMemberRate.size === 0 && (
              <span className="text-xs text-neutral-600">
                料金は運営がご案内します（料金マスタが未登録のため表示できません）。
              </span>
            )}
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              チェックイン
              <input type="date" name="checkInDate" required className="rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              チェックアウト
              <input type="date" name="checkOutDate" required className="rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              到着予定時刻
              <input type="time" name="arrivalTime" className="rounded border border-neutral-300 px-3 py-2" />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              大人（高校生以上・代表者含む）
              <input type="number" name="adultsCount" min={0} max={20} defaultValue={1} className="rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              子ども（中学生以下）
              <input type="number" name="childrenCount" min={0} max={20} defaultValue={0} className="rounded border border-neutral-300 px-3 py-2" />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            当日の交通手段
            <select name="transportMethod" className="rounded border border-neutral-300 px-3 py-2" defaultValue="">
              <option value="">選択しない</option>
              <option value="car">車</option>
              <option value="taxi">タクシー</option>
              <option value="shuttle">送迎（片道 1,900円）</option>
              <option value="other">その他</option>
            </select>
            {/* 送迎は課金項目。金額はメニューマスタが持ち、チェックイン時に伝票へ計上する（v13 §5.4.2③） */}
            <span className="text-xs text-neutral-600">
              送迎は片道 <Money priceYen={1900} /> です。当日のお会計に加算します。
            </span>
          </label>

          {/*
            「街人ですか？」は**参考フラグ**である（v13 §5.2.3 の warning ／ 2026-08-29 再導入）。
            料金にも権限にも影響させない。チェックイン時の街人照合（§5.10.8）の事前情報として使う。
          */}
          <fieldset className="flex flex-col gap-1 rounded border border-neutral-200 p-3 text-sm">
            <legend className="px-1">街人（会員）ですか？</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="selfDeclaredMachibito" value="yes" /> はい
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="selfDeclaredMachibito" value="no" defaultChecked /> いいえ
            </label>
            <span className="text-xs text-neutral-600">
              料金の判定には使いません。当日の照合のためにうかがっています。
            </span>
          </fieldset>

          <label className="flex flex-col gap-1 text-sm">
            ご質問・ご要望・ご不安な点（任意）
            <textarea name="note" rows={3} className="rounded border border-neutral-300 px-3 py-2" />
            <span className="text-xs text-neutral-600">
              ご記入がある場合は運営が内容を確認してからの確定になります。
            </span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="consented" required />
            「浮遊街に宿泊される方へ」に同意します
          </label>

          <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-white">
            予約する
          </button>

          {reserveState.status === "done" && reserveState.message && (
            <p className="text-sm text-green-700">{reserveState.message}</p>
          )}
          {reserveState.status === "error" && reserveState.message && (
            <p className="text-sm text-red-700">{reserveState.message}</p>
          )}
        </form>
      )}
    </div>
  );
}
