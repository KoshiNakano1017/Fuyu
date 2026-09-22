import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { AREAS, visibilityFor } from "@/lib/auth/navigation";
import { ROLE_DISPLAY_NAMES, ROLES_IN_DISPLAY_ORDER } from "@/lib/auth/role-labels";

// 表示名と並びの出所は `role-labels.ts` ただ1つ（WBS 2-5）。ここに2つ目の表を作らない

const VISIBILITY_MARK = { visible: "◯", limited: "△", hidden: "—" } as const;

/**
 * ロール切替プレビュー（画面ID C11 ／ WBS 2-3）。
 *
 * ## 「切り替える」のではなく「表を見せる」
 *
 * モック（`prototype_v15.html`）のロールスイッチは**デモ用**であり、
 * v13 §5.9.2 が「本番実装時は admin 限定へ絞る」と定めている。
 * さらに本番で実際にロールを切り替えると、**切り替えた状態で行った操作の
 * 責任者が誰か分からなくなる**（`app.operator_id` の申告義務と食い違う）。
 *
 * そこでここでは**表示マトリクスそのものを表として見せる**。
 * 運営が知りたいのは「このロールの人には何が見えるか」であって、
 * 自分がそのロールになることではない。
 *
 * 表の出所は `AREAS`（`src/lib/auth/navigation.ts`）ただ1つで、
 * ナビの描画とサーバサイド認可が同じ表を参照している（WBS 2-6）。
 * ここに別の表を書くと、3つ目の真実ができる。
 */
export default async function AdminPreviewPage() {
  try {
    await requireAdmin();
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
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">ロール切替プレビュー</h1>
      <p className="text-sm text-neutral-600">
        ロールごとにナビへ出る領域の一覧です（v13 §5.9.1）。
        ◯＝表示、△＝限定表示、—＝そもそも描画しません。
        実際にロールを切り替える機能は置いていません。切り替えた状態での操作は、
        誰が行ったのかを記録できなくなるためです。
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b p-2 text-left">領域</th>
              <th className="border-b p-2 text-left">経路</th>
              {ROLES_IN_DISPLAY_ORDER.map((role) => (
                <th key={role} className="border-b p-2 text-center">
                  {ROLE_DISPLAY_NAMES[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AREAS.map((area) => (
              <tr key={area.key}>
                <td className="border-b p-2">{area.label}</td>
                <td className="border-b p-2 font-mono text-xs text-neutral-600">{area.path}</td>
                {ROLES_IN_DISPLAY_ORDER.map((role) => (
                  <td key={`${area.key}-${role}`} className="border-b p-2 text-center">
                    {VISIBILITY_MARK[visibilityFor(area, role)]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
