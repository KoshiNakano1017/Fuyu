import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";

import { MorningMeetingForm } from "./MorningMeetingForm";

/**
 * 実施日の初期値（日本時間の今日）。
 *
 * サーバで決めてクライアントへ渡す。クライアント側で `new Date()` から組み立てると
 * 端末のタイムゾーンで値が変わり、ハイドレーションの結果も揺れる。
 * 朝会は日本時間の朝に行われるので、基準は運営の所在地に固定する。
 */
function todayInJapan(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/**
 * 朝会テキストの投入画面（WBS 4-1 ／ v13 §9 #63）。運営専用。
 *
 * **判定は Server Component で行う。** 権限が無い場合、下の `MorningMeetingForm` は
 * **一度も組み立てられない**ので、権限外の利用者にフォームが一瞬見えることがない
 * （v13 §5.9.2 のフラッシュ防止）。これは認可そのものではなく、
 * 認可は Server Action と RLS が二重に持つ（v13 §5.9.3）。
 */
export default async function MorningMeetingsPage() {
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

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">朝会議事録の投入</h1>
      <p className="text-sm text-neutral-600">
        外部ソフトで文字起こししたテキストを、そのまま貼り付けて保存します。
        <strong>保存した本文には参加者の実名が含まれることがあります。</strong>
        読めるのは管理者とコアメンバーだけです。
      </p>
      <MorningMeetingForm defaultHeldOn={todayInJapan()} />
    </main>
  );
}
