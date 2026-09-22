import { AccessDenied } from "@/components/auth/AccessDenied";
import { NotYetAvailable } from "@/components/ui/NotYetAvailable";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";

/**
 * Eumo給付一覧（画面ID B10 ／ WBS 5-5 Uii支払・XP／貢献バッジ付与）。
 *
 * ⚠️ **まだ作れない。** `eumo_grants`（`0023_eumo_grants.sql`）自体は2026-09-21に
 * 作成済みだが、給付一覧・送付操作・受領確認を読み書きする画面ロジックが未着手。
 * さらに `5-7`（送付・受領追跡）は**EUMO過去発行分の突合基準（#59）が未決**のまま
 * ブロック中であり、二重付与を防ぐ判定ロジックを先に組めない。
 *
 * 読み先はあるが書き込みロジックが無いまま一覧を作ると、**常に空の一覧**になる。
 * 「給付対象が0件」なのか「まだ動いていない」のかが運営から区別できず、
 * 承認済みクエストの給付が漏れても気づけない。ここは待つほうが安全である。
 *
 * 認可だけは先に置く。経路が開いた時点で権限判定が抜けていると、
 * 実装を足すときに忘れる（v13 §5.9.3）。
 */
export default async function StaffEumoPage() {
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
    <NotYetAvailable
      title="Eumo給付一覧"
      blockedBy={[
        "WBS 5-7（Eumo給付の送付・受領追跡） — EUMO過去発行分の突合基準（#59）が未決のためブロック中です",
        "WBS 5-5（Uii支払・XP／貢献バッジ付与）の画面ロジック — eumo_grants テーブルは作成済みですが、一覧・送付・受領確認の実装が未着手です",
      ]}
    />
  );
}
