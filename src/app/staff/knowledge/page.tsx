import { AccessDenied } from "@/components/auth/AccessDenied";
import { ConciergeAdminLink } from "@/components/concierge/ConciergeAdminLink";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";

/**
 * ナレッジ登録の導線（B9 店員タブレット ／ WBS `9-2` line-rag-bot管理画面への導線（外部リンクのみ））。
 *
 * **中身は外部リンク1つだけ。** 登録フォームもエスカレーション一覧も API 連携も
 * アプリ本体には作らず、浮遊街コンシェルジュ（line-rag-bot）の Streamlit 管理画面で完結する
 * （v13 §5.7.5 の 2026-08-16 再確定注記 ／ §9 #31）。
 *
 * 対象ロールは `admin` / `core_member`（v13 §5.9.1「ナレッジ登録フォーム（§5.7）」行）。
 * ナビから消えていても URL は叩けるので、**ナビの非描画とは別に**ここで判定する
 * （v13 §5.9.3「DOM非表示は認可ではない」）。判定が済むまで本体を組み立てないため、
 * 権限外の利用者に導線が一瞬見えることもない（§5.9.4）。
 */
export default async function StaffKnowledgePage() {
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
      <h1 className="text-2xl font-bold">ナレッジ登録</h1>
      <p className="text-sm text-neutral-600">
        ナレッジの登録・編集は浮遊街コンシェルジュの管理画面で行います。
        別タブで開き、コンシェルジュ側のアカウントでログインしてください。
      </p>
      <ConciergeAdminLink />
    </main>
  );
}
