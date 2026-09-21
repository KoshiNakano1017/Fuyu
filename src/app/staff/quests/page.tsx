import { AccessDenied } from "@/components/auth/AccessDenied";
import { ReviewBoard } from "@/components/quests/ReviewBoard";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { isAdmin } from "@/lib/auth/session";
import { fetchPendingApplications, fetchPendingWorkLogs } from "@/lib/quests/applications";

import { instructApplicationAction, reviewWorkLogAction } from "./actions";

/**
 * クエスト承認・査定（画面ID B5 ／ WBS 5-2・5-4・5-6）。
 *
 * 受注申請への実行指示と、完了報告の二段階承認を1枚に置く。
 * 画面設計.md §2 が B5 を「報告済み → コアメンバー確認済 → 承認完了」の板と
 * 定めており、指示と承認を別画面にすると運営が2箇所を見に行くことになる。
 *
 * ⚠️ **最終承認ボタンの出し分けは防壁ではない**（v13 §5.9.3）。
 * 実際に止めているのは `0017` のトリガー `work_logs_guard_approval()` である。
 */
export default async function StaffQuestsPage() {
  let viewer;
  try {
    viewer = await requireStaff();
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

  const [applications, workLogs] = await Promise.all([
    fetchPendingApplications(),
    fetchPendingWorkLogs(),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">クエスト承認・査定</h1>
      <ReviewBoard
        applications={applications}
        workLogs={workLogs}
        isAdmin={isAdmin(viewer.role)}
        instruct={instructApplicationAction}
        review={reviewWorkLogAction}
      />
    </main>
  );
}
