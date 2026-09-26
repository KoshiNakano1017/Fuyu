"use client";

import { useActionState, useState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { RoomOption } from "@/lib/lodging/stay-change-store";
import type { NightlyCharge, StayChangeLogEntry, StayForChange } from "@/lib/lodging/stay-changes";

export type ChangeStayAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/** 1件の滞在と、それに紐づく表示材料（夜ごとの宿泊費・変更履歴）。 */
export type StayChangeView = {
  stay: StayForChange;
  /** 変更が効く日の既定値（滞在中は当日・予約段階は初日） */
  defaultEffectiveDate: string;
  /** ★ 夜ごとの内訳。**その夜に使った形態の単価**を積んだもの（v13 §5.6.9） */
  nights: readonly NightlyCharge[];
  totalYen: number;
  /** 料金マスタに該当行が無かった夜の数。0円として合計に混ぜない */
  missingRateNights: number;
  history: readonly StayChangeLogEntry[];
};

/**
 * 滞在中の宿泊形態・部屋・日程・人数の変更（画面ID C11 の「宿泊」タブ ／ WBS 3-10 ／ v13 §5.6.9）。
 *
 * ## 夜ごとの内訳を操作の真上に置く
 *
 * §5.6.9 の料金規則は「**その夜に実際に使った形態**の単価を積む」である。
 * 合計だけを出すと、変更が**滞在全体を塗り替えていないこと**を運営が確かめられない。
 * 3泊目から単価が切り替わっていることが見えれば、その場で誤りに気づける。
 *
 * ## 「適用する日」を必ず選ばせる
 *
 * 既定は滞在中なら当日、予約段階なら初日。ここを入力させずに常に当日で固定すると、
 * 「明日からコテージへ移る」の予定を先に入れられず、当日の朝まで操作を持ち越すことになる。
 *
 * ## 部屋の選択肢は選んだ形態の部屋だけに絞る
 *
 * 形態と部屋が食い違った割当（コテージの滞在にドミトリーのベッド）は、
 * 残枠の見え方と実際の寝場所がずれる。**選ばせない**のが最も確実である。
 */
export function StayChangeSection({
  memberId,
  views,
  roomOptions,
  roomTypeLabels,
  change,
}: {
  memberId: string;
  views: readonly StayChangeView[];
  roomOptions: readonly RoomOption[];
  /** 形態の表示名（`accommodation_types.display_name`）。内部識別子を画面へ出さない */
  roomTypeLabels: Record<string, string>;
  change: ChangeStayAction;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold">滞在の変更</h2>

      {views.length === 0 ? (
        <p className="text-sm text-neutral-600">
          変更できる滞在（予約済み・滞在中）はありません。退館済みの滞在は変更できません。
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {views.map((view) => (
            <li key={view.stay.checkinId}>
              <StayChangeCard
                memberId={memberId}
                view={view}
                roomOptions={roomOptions}
                roomTypeLabels={roomTypeLabels}
                change={change}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StayChangeCard({
  memberId,
  view,
  roomOptions,
  roomTypeLabels,
  change,
}: {
  memberId: string;
  view: StayChangeView;
  roomOptions: readonly RoomOption[];
  roomTypeLabels: Record<string, string>;
  change: ChangeStayAction;
}) {
  const [state, submit, isPending] = useActionState(change, SUBMIT_IDLE);
  // 選んだ形態に応じて部屋の選択肢を絞るため、フォーム内で状態を持つ。
  const [roomType, setRoomType] = useState(view.stay.roomType);

  const { stay } = view;
  const roomsForType = roomOptions.filter((room) => room.roomType === roomType);

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {stay.checkInDate} 〜 {stay.checkOutDate}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-neutral-200 px-2 py-0.5">
            {roomTypeLabels[stay.roomType] ?? stay.roomType}
          </span>
          <span className="text-neutral-600">
            {stay.roomName === null ? "部屋未割当" : stay.roomName}
          </span>
          <span className="text-neutral-600">
            大人{stay.adultsCount}名
            {stay.childrenCount === 0 ? "" : ` ／ 子ども${stay.childrenCount}名`}
          </span>
          {stay.status === "staying" ? (
            <span className="rounded bg-green-100 px-2 py-0.5 text-green-800">滞在中</span>
          ) : (
            <span className="rounded bg-neutral-100 px-2 py-0.5">予約済み</span>
          )}
        </span>
      </div>

      {/* 夜ごとの内訳（v13 §5.6.9「宿泊費は泊単位で、その夜に実際に使った形態の単価を積む」） */}
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-bold">
          宿泊費 ¥{view.totalYen.toLocaleString("ja-JP")}
          <span className="ml-1 text-xs font-normal text-neutral-600">（{view.nights.length}泊）</span>
        </h3>
        <ul className="flex flex-col gap-0.5 text-xs text-neutral-700">
          {view.nights.map((night) => (
            <li key={night.date} className="flex flex-wrap justify-between gap-2">
              <span>
                {night.date}：{roomTypeLabels[night.roomType] ?? night.roomType}
              </span>
              <span>
                {night.pricePerNightYen === null ? (
                  <span className="text-amber-700">単価未登録</span>
                ) : (
                  `¥${night.pricePerNightYen.toLocaleString("ja-JP")}`
                )}
              </span>
            </li>
          ))}
        </ul>
        {view.missingRateNights === 0 ? null : (
          <p className="text-xs text-amber-700">
            {view.missingRateNights}泊は宿泊料金マスタに該当行が無いため、合計に含めていません
            （マスタ管理の宿泊料金で登録してください）。
          </p>
        )}
      </div>

      <form action={submit} className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        <input type="hidden" name="checkinId" value={stay.checkinId} />
        <input type="hidden" name="memberId" value={memberId} />

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs">
            この日から適用
            <input
              type="date"
              name="effectiveDate"
              required
              defaultValue={view.defaultEffectiveDate}
              min={stay.checkInDate}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            宿泊形態
            <select
              name="roomType"
              value={roomType}
              onChange={(event) => setRoomType(event.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              {Object.entries(roomTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            部屋
            <select
              name="roomId"
              defaultValue={stay.roomId ?? ""}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              <option value="">（変更しない ／ 未割当）</option>
              {roomsForType.map((room) => (
                <option key={room.roomId} value={room.roomId}>
                  {room.roomName}（定員{room.capacity}）
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs">
            退去日
            <input
              type="date"
              name="checkOutDate"
              required
              defaultValue={stay.checkOutDate}
              min={stay.checkInDate}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            大人（名）
            <input
              type="number"
              name="adultsCount"
              required
              min={0}
              step={1}
              defaultValue={stay.adultsCount}
              className="w-20 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            子ども（名）
            <input
              type="number"
              name="childrenCount"
              required
              min={0}
              step={1}
              defaultValue={stay.childrenCount}
              className="w-20 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>
        </div>

        <label className="flex flex-col text-xs">
          変更理由（必須）
          <input
            type="text"
            name="reason"
            required
            placeholder="雨天でキャンプサイトからコテージへ移動 ／ 同伴者1名追加 ／ 延泊 など"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            この内容へ変更する
          </button>
          <span className="text-[0.7rem] text-neutral-500">
            変更後の残枠を再判定します。満室の夜があるときは変更できません（v13 §5.6.9）。
          </span>
        </div>
      </form>

      {state.status !== "idle" && state.message !== undefined ? (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"}>
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3">
        <h3 className="text-sm font-bold">変更履歴</h3>
        {view.history.length === 0 ? (
          <p className="text-xs text-neutral-600">この滞在の変更はまだありません。</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-neutral-700">
            {view.history.map((entry) => (
              <li key={entry.changeId}>
                {new Date(entry.createdAt).toLocaleString("ja-JP")}（{entry.effectiveDate} から適用）
                ／ {entry.changedByLabel} ／ {describeLogEntry(entry, roomTypeLabels)} ／ 理由：
                {entry.reason}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[0.7rem] text-neutral-500">
          履歴は追記専用です（取り消せません）。誤りは新しい変更を理由つきで積んで直します。
          部屋台帳（部屋そのものの形態）は変更しません — 変わるのは滞在側です（v13 §5.6.9）。
        </p>
      </div>
    </div>
  );
}

/** 履歴1件を「何が変わったか」の1行にする。変わっていない項目は書かない。 */
function describeLogEntry(
  entry: StayChangeLogEntry,
  roomTypeLabels: Record<string, string>,
): string {
  const label = (roomType: string) => roomTypeLabels[roomType] ?? roomType;
  const parts: string[] = [];
  if (entry.roomTypeBefore !== null && entry.roomTypeAfter !== null) {
    parts.push(`形態 ${label(entry.roomTypeBefore)} → ${label(entry.roomTypeAfter)}`);
  }
  if (entry.checkOutDateBefore !== null && entry.checkOutDateAfter !== null) {
    parts.push(`退去日 ${entry.checkOutDateBefore} → ${entry.checkOutDateAfter}`);
  }
  if (entry.adultsBefore !== null && entry.adultsAfter !== null) {
    parts.push(`大人 ${entry.adultsBefore}名 → ${entry.adultsAfter}名`);
  }
  if (entry.childrenBefore !== null && entry.childrenAfter !== null) {
    parts.push(`子ども ${entry.childrenBefore}名 → ${entry.childrenAfter}名`);
  }
  return parts.length === 0 ? "部屋の移動" : parts.join(" ／ ");
}
