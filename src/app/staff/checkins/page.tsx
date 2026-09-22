import { AccessDenied } from "@/components/auth/AccessDenied";
import { CheckInBoard } from "@/components/lodging/CheckInBoard";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { fetchCheckInBoard } from "@/lib/lodging/fetch-checkin-board";

import { checkInAction, checkOutAction } from "./actions";

/**
 * チェックイン／チェックアウト（画面ID A1 ／ WBS 3-2 ／ v13 §5.2.2）。運営専用。
 *
 * ## 基準日は日本時間で決める
 *
 * サーバのタイムゾーンで `toISOString()` を切ると、深夜帯に**前日の板**が出る。
 * 朝会も入退館も日本時間で回っているので、基準は運営の所在地に固定する
 * （`src/app/admin/morning-meetings/page.tsx` と同じ作法）。
 *
 * ## QR は未実装
 *
 * WBS `3-2` のタイトルは「チェックイン／チェックアウト操作（QR）」だが、
 * QR での本人特定は**発行・読み取り・失効の基盤**（精算QR と同じ作りが要る）であり、
 * 本画面は一覧からの操作で先に成立させている。QR 導線は残作業である。
 */
function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

export default async function StaffCheckInsPage() {
  try {
    await requireStaff();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  const today = todayInJapan();
  const rows = await fetchCheckInBoard(today);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">チェックイン／チェックアウト</h1>
      <p className="text-sm text-neutral-600">
        {today} の到着・滞在中・本日退館の方を表示しています。
        チェックインを確定すると、<strong>初回来訪の街人にはキャッシュバックの発行依頼が自動で起票</strong>
        されます（v13 §5.10.8）。
      </p>
      <CheckInBoard rows={rows} checkIn={checkInAction} checkOut={checkOutAction} />
    </main>
  );
}
