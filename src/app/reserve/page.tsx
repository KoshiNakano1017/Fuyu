import { PublicReservationForm } from "@/components/lodging/PublicReservationForm";
import {
  fetchPublicAccommodationTypes,
  fetchPublicAvailability,
  fetchPublicRates,
} from "@/lib/reservations/public-catalog";

import { createPublicReservationAction, requestReservationCodeAction } from "./actions";

/**
 * 公開予約ページ（WBS 3-5b ／ v13 §5.2.3）。**ログイン不要**。
 *
 * ## ここが未ログインの入口である
 *
 * v13 §5.2.3 は 2026-08-23 に Googleフォームを廃止し（§9 #46）、初回来訪者の入口を
 * このページへ一本化した。フォームには残枠を反映する手段が無く §5.4.2 の
 * 「満室時は選択不可」が原理的に実装できないこと、本人確認手段が無く §5.8.3 の
 * 名寄せ要件を満たせないことが転換の理由である。
 *
 * ## ナビに載せない
 *
 * `AREAS`（`src/lib/auth/navigation.ts`）は**ログイン後**の領域の表である。
 * このページは未ログインの入口なので載せない（載せると、ログイン済みの利用者に
 * 非会員料金のページを案内することになる）。会員の入口は `/reservations` である。
 *
 * ## 認可
 *
 * ガードを置かない。**置かないことが仕様である。** 代わりに、書き込みは
 * `createPublicReservation()`（service_role）1箇所に閉じ、そこで OTP 検証を必須にしている。
 */
export default async function ReservePage() {
  const today = new Date().toISOString().slice(0, 10);

  // ★ 未ログインなので **service_role 経由**で読む。anon には GRANT が無く、
  //   そのまま anon で読むと 0件が返って全形態が満室に見える（`public-catalog.ts` の注記）
  const [types, todayAvailability, rates] = await Promise.all([
    fetchPublicAccommodationTypes(),
    fetchPublicAvailability(today),
    fetchPublicRates(),
  ]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">宿泊のご予約</h1>
      <p className="text-sm text-neutral-600">
        ログインなしでご予約いただけます。ご入力いただいたメールアドレスへ確認コードをお送りし、
        本人確認のうえで受け付けます。
      </p>

      <PublicReservationForm
        types={types}
        todayAvailability={todayAvailability}
        rates={rates}
        requestCode={requestReservationCodeAction}
        createReservation={createPublicReservationAction}
      />
    </main>
  );
}
