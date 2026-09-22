import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { fetchLodgingRegisterPrefill } from "@/lib/lodging/register";

import { LodgingRegisterForm } from "./LodgingRegisterForm";

/**
 * チェックイン時の宿泊者名簿画面（画面ID A1 ／ v13 §5.2.7）。運営専用（店員用タブレット操作）。
 *
 * **判定は Server Component で行う。** 権限が無い場合、下のフォームは一度も組み立てられない
 * （v13 §5.9.2 のフラッシュ防止・`invitations/page.tsx` と同じ型）。
 */
export default async function LodgingRegisterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  const { id: checkinId } = await params;
  const prefill = await fetchLodgingRegisterPrefill(checkinId);

  if (prefill === null) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <h1 className="text-2xl font-bold">宿泊者名簿</h1>
        <p className="text-sm text-neutral-600">指定されたチェックインが見つかりません。</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">宿泊者名簿</h1>
        <p className="text-sm text-neutral-600">
          {prefill.checkInDate} 〜 {prefill.checkOutDate} ／ {prefill.roomTypeLabel}
        </p>
      </div>

      <p className="text-sm text-neutral-600">
        氏名・住所は<strong>紐づく予約・会員情報からの下書き</strong>です。
        本人に提示して内容を確認し、必要なら訂正のうえ確定してください。
      </p>

      <LodgingRegisterForm checkinId={checkinId} prefill={prefill} />
    </main>
  );
}
