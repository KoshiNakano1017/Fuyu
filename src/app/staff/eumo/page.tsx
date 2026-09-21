import { AccessDenied } from "@/components/auth/AccessDenied";
import { NotYetAvailable } from "@/components/ui/NotYetAvailable";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";

/**
 * Eumo給付一覧（画面ID B10 ／ WBS 5-5 Uii支払・XP／貢献バッジ付与）。
 *
 * ⚠️ **まだ作れない。** 給付予定を積む `eumo_grants` テーブルが存在しない。
 * `0017_quest_applications_and_work_logs.sql` の冒頭が
 * 「Eumo給付（`eumo_grants`）と XP 付与 → 0019（WBS 5-5）」と予告しているが、
 * `0019_orders_and_settlement.sql` は注文・精算だけを入れて終わっている。
 *
 * 読み先が無いまま一覧を作ると、**常に空の一覧**になる。
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
        "WBS 5-5（Uii支払・XP／貢献バッジ付与）の DB 層 — 給付予定を積む eumo_grants テーブルが未作成です",
      ]}
    />
  );
}
