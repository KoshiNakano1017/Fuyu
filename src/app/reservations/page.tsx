import Link from "next/link";

import { ReservationForm } from "@/components/lodging/ReservationForm";
import { requireSignedIn } from "@/lib/auth/guard";
import { fetchAccommodationTypes, fetchAvailability } from "@/lib/lodging/fetch-lodging";

import { createReservationAction } from "./actions";

/**
 * 宿泊予約（画面ID A11 ／ WBS 3-7）。
 *
 * 本人の宿泊予定・履歴（画面ID A12）は **A6 マイログ（`/me`）内のタブ**にある
 * （v13 §5.2.5② ／ `画面設計.md` §4 A12）。ここからはそこへ送るだけにする。
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
  // 戻り値は使わないが、未ログインを弾くために必ず通す（v13 §5.9.3）。
  await requireSignedIn();

  const today = new Date().toISOString().slice(0, 10);
  const [types, todayAvailability] = await Promise.all([
    fetchAccommodationTypes(),
    fetchAvailability({ fromDate: today, toDate: today }),
  ]);

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
        {/*
          予定・履歴の一覧はここに持たない。正本は本人向けカレンダー（画面ID A12）を
          **A6 マイログ内のタブ**と定めており（v13 §5.2.5② ／ `画面設計.md` §4 A12）、
          同じ内容を2画面に置くと片方だけ直る。ここからは A6 へ送る。
        */}
        <h2 className="text-lg font-bold">予定・履歴</h2>
        <p className="text-sm text-neutral-600">
          宿泊の予定と履歴は、マイページの「宿泊予定・履歴」カレンダーでご確認いただけます。
        </p>
        <Link className="text-sm underline" href="/me">
          マイページの宿泊予定・履歴へ
        </Link>
      </section>
    </main>
  );
}
