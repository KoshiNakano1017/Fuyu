import { ReservationForm } from "@/components/lodging/ReservationForm";
import { requireSignedIn } from "@/lib/auth/guard";
import { CANCELLED_BY_OPERATOR_LABEL, formatCancelledAt } from "@/lib/lodging/checkin-ops";
import {
  fetchAccommodationTypes,
  fetchAvailability,
  fetchMyStays,
} from "@/lib/lodging/fetch-lodging";

import { createReservationAction } from "./actions";

/**
 * 状態の表示名。**生の `status` をそのまま出さない** —— `cancelled` と書かれても、
 * 本人には自分が取り消したのか運営が取り消したのかが分からない（v13 §5.2.2「本人への表示」）。
 */
const STATUS_LABELS: Record<string, string> = {
  pre_registered: "予約受付",
  confirmed: "予約確定",
  staying: "滞在中",
  checked_out: "退館済み",
  cancelled: CANCELLED_BY_OPERATOR_LABEL,
};

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
                <span
                  className={
                    stay.status === "cancelled"
                      ? "rounded bg-red-100 px-2 py-0.5 text-xs text-red-800"
                      : "rounded bg-neutral-100 px-2 py-0.5 text-xs"
                  }
                >
                  {STATUS_LABELS[stay.status] ?? stay.status}
                </span>

                {/*
                  取り消された予約は、日時と理由まで本人に見せる（v13 §5.2.2「本人への表示」）。
                  「いつ・なぜ取り消されたか」が読めないと、本人は運営へ問い合わせるしかない。
                */}
                {stay.status === "cancelled" ? (
                  <p className="w-full text-xs text-red-800">
                    {CANCELLED_BY_OPERATOR_LABEL}
                    {stay.cancelledAt === null || stay.cancelledAt === undefined
                      ? ""
                      : ` ／ ${formatCancelledAt(stay.cancelledAt)}`}
                    {stay.cancelReason === null ||
                    stay.cancelReason === undefined ||
                    stay.cancelReason === ""
                      ? ""
                      : ` ／ 理由：${stay.cancelReason}`}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
