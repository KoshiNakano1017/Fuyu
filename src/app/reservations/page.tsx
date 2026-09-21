import { ReservationForm } from "@/components/lodging/ReservationForm";
import { requireSignedIn } from "@/lib/auth/guard";
import {
  fetchAccommodationTypes,
  fetchAvailability,
  fetchMyStays,
} from "@/lib/lodging/fetch-lodging";

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
 * 変える**」と定めている（§5.2.4「入口」行）。現状はログイン必須のこちらだけが実装済みで、
 * `/reserve` は **WBS 3-5b（★ 公開予約ページ `/reserve`）が未着手**のため存在しない。
 *
 * `3-5b` が着手できない理由（いずれも保存先が無い）:
 *   - 料金表示に要る `accommodation_rates` が未作成（**WBS 3-9 宿泊料金マスタ**）
 *   - 送信前のメールOTP（§5.2.3 TO-BE②）の基盤が未整備。会員ログインの OTP とは
 *     設定箇所が別である（`3-5b` は自前実装 ／ WBS `1-1e` の注記）
 *   - 同意チェックと同意版数の記録先（§5.2.3）が未作成
 *
 * **ここに未ログイン向けの入力欄を先に生やさない。** 本人確認も料金も無いまま予約を
 * 受け付けると、名寄せ（§5.8.3）が成立しない予約が積み上がる。
 *
 * ## 残枠は都度算出
 *
 * 本日分の残枠を `v_room_availability`（`0015`）から読んで選択肢へ添える。
 * ただしこれは目安であり、**選んだ日程の可否は確定時にサーバが数え直す**
 * （`createReservationAction`）。画面に在庫を持たせない。
 */
export default async function ReservationsPage() {
  const viewer = await requireSignedIn();

  const today = new Date().toISOString().slice(0, 10);
  const [types, todayAvailability, myStays] = await Promise.all([
    fetchAccommodationTypes(),
    fetchAvailability({ fromDate: today, toDate: today }),
    fetchMyStays(viewer.memberId),
  ]);

  const displayNameOf = new Map(types.map((type) => [type.roomType, type.displayName]));

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">宿泊予約</h1>
        <ReservationForm
          types={types}
          todayAvailability={todayAvailability}
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
