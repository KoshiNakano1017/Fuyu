import { roleDisplayName } from "@/lib/auth/role-labels";
import type { Role } from "@/lib/auth/session";

/**
 * アクセス制限画面（v13 §5.9.4）。
 *
 * 仕様が要求している3点をそのまま出す。
 *   - 「運営業務専用です」という趣旨の説明
 *   - **現在のロール**
 *   - **必要な権限**
 *
 * ⚠️ **RLS の内部事情を書かない。** §5.9.4 は「RLS 注記は本番非表示」と定めている。
 * 「ポリシーに拒否されました」のような文面は、攻撃者に構造を教えるだけで
 * 利用者には何の助けにもならない。
 *
 * ⚠️ この画面が出ている時点で、**保護対象のコンテンツはレンダリングされていない**。
 * 呼び出し元が Server Component で判定しており、本体は組み立てられていない
 * （v13 §5.9.2 のフラッシュ防止）。
 */
export function AccessDenied({
  currentRole,
  requiredRoleLabel,
}: {
  currentRole: Role | null;
  requiredRoleLabel: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-bold">この画面は運営業務専用です。</h1>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-neutral-600">現在の権限</dt>
          {/* 表示名の出所は `role-labels.ts` ただ1つ（WBS 2-5）。画面ごとに表を持たない */}
          <dd className="font-medium">{roleDisplayName(currentRole)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-neutral-600">必要な権限</dt>
          <dd className="font-medium">{requiredRoleLabel}</dd>
        </div>
      </dl>
      <p className="text-sm text-neutral-600">
        権限が必要な場合は運営へお問い合わせください。
      </p>
    </main>
  );
}
