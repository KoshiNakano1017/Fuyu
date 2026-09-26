import { ReservationForm } from "@/components/lodging/ReservationForm";
import { MasterDataShortcut } from "@/components/nav/MasterDataShortcut";
import { requireSignedIn } from "@/lib/auth/guard";
import {
  fetchAccommodationRates,
  fetchAccommodationTypes,
  fetchAvailability,
  fetchMyStays,
} from "@/lib/lodging/fetch-lodging";
import { prefillFromStays } from "@/lib/lodging/reservation-intake";
import { fetchStayTicketBalance } from "@/lib/lodging/stay-tickets";
import { todayInJapan } from "@/lib/today";

import { createReservationAction } from "./actions";

/**
 * 宿泊予約（画面ID A11 ／ WBS 3-7）＋ 本人の宿泊予定・履歴（画面ID A12 ／ WBS 3-8）。
 *
 * ## 未ログインの入口はここではない（`/reserve`）
 *
 * ⚠️ **Googleフォームは廃止済みである**（v13 §5.2.3・§5.2.4 ／ §9 #36 → **#46 で撤回**
 * ／ 2026-08-23 オーナー判断）。~~初回来訪者はフォーム経由~~ という旧方針は正本上で
 * 取り消し線が引かれており、**初回来訪者の入口はログイン不要の公開予約ページ `/reserve`** である。
 *
 * 正本は `/reserve` とこの画面を「**同一画面・同一ロジックとし、ログイン状態で振る舞いだけを
 * 変える**」と定めている（§5.2.4「入口」行）。`/reserve`（WBS 3-5b）は
 * 2026-09-21 に実装済みだが、**正本が求める「同一画面・同一ロジック」の統合は未達**であり、
 * `src/app/reserve/page.tsx` ＋ `PublicReservationForm` として本画面とは別に実装されている
 * （フォームの重複を解消する統合作業は未着手）。
 *
 * **ここに未ログイン向けの入力欄を持ち込まない。** 統合するなら `/reserve` 側の
 * OTP 検証・`service_role` 読み出しの経路ごと引き取る必要があり、本画面へ
 * 未ログイン向けの入力欄だけを足し増すと二重実装が3つ目に増える。
 *
 * ## 会員だから出せるもの（2026-09-26 ／ WBS 3-7 の残り）
 *
 * **会員料金**（`accommodation_rates` ／ Uii 主・円 副）と**保有宿泊券の充当**を画面に出す。
 * どちらも `/reserve`（未ログイン）には無い振る舞いで、v13 §5.2.4 が会員向けに定めている差分である。
 *
 * ## 残枠は都度算出
 *
 * 本日分の残枠を `v_room_availability`（`0015`）から読んで選択肢へ添える。
 * ただしこれは目安であり、**選んだ日程の可否は確定時にサーバが数え直す**
 * （`createReservationAction`）。画面に在庫を持たせない。
 */
export default async function ReservationsPage() {
  const viewer = await requireSignedIn();

  // 基準日は日本時間で決める（`src/lib/today.ts`）。UTC で切ると深夜帯に前日の残枠が出る。
  const today = todayInJapan();
  const [types, todayAvailability, myStays, rates, stayTicketBalance] = await Promise.all([
    fetchAccommodationTypes(),
    fetchAvailability({ fromDate: today, toDate: today }),
    fetchMyStays(viewer.memberId),
    // 会員料金の表示（v13 §5.2.4「各形態の料金は料金マスタから取得して表示」）
    fetchAccommodationRates(),
    // 宿泊券の充当（同節。**予約時点では消費しない**）
    fetchStayTicketBalance(viewer.memberId),
  ]);

  const displayNameOf = new Map(types.map((type) => [type.roomType, type.displayName]));

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">宿泊予約</h1>
          {/* 料金を出している画面からマスタへ直接飛ぶ（§5.9.5「入口の重複を許す」）。管理者にだけ出る。 */}
          <MasterDataShortcut role={viewer.role} label="料金マスタ" />
        </div>
        {/*
          `prefill` は前回の滞在から作る（v13 §5.2.4「既知情報の再入力を求めない」）。
          ★ PII（氏名・住所）はフォームへ書き戻さない — **尋ねないこと**で再入力を無くしている。
        */}
        <ReservationForm
          types={types}
          todayAvailability={todayAvailability}
          rates={rates}
          stayTicketBalance={stayTicketBalance}
          prefill={prefillFromStays(myStays)}
          today={today}
          action={createReservationAction}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">予定・履歴</h2>
        {myStays.length === 0 ? (
          <p className="text-sm text-neutral-600">予約はありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {myStays.map((stay) => (
              <li
                key={stay.checkinId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 bg-white p-3"
              >
                <span className="font-medium">
                  {stay.checkInDate} 〜 {stay.checkOutDate}
                </span>
                <span className="text-sm text-neutral-600">
                  {displayNameOf.get(stay.roomType) ?? stay.roomType} ／{" "}
                  {stay.adultsCount + stay.childrenCount}名
                </span>
                <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">{stay.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
