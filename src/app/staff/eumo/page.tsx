import { AccessDenied } from "@/components/auth/AccessDenied";
import { GrantBoard } from "@/components/eumo/GrantBoard";
import { AccessDeniedError, requireStaff } from "@/lib/auth/guard";
import { fetchGrants } from "@/lib/eumo/store";

import { confirmReceiptAction, markFailedAction, markSentAction } from "./actions";

/**
 * Eumo給付一覧（画面ID B10 ／ WBS 5-5・5-7 ／ v13 §5.3.1・§5.10.8）。
 *
 * 「発行依頼（未送付）」「発行済み・未受領（送付済）」「受領済み」「送付失敗」を分けて出す。
 * 分けるのは並び順の問題ではなく、**運営の仕事が状態ごとに違う**ためである。
 * 発行依頼は eumo で送る仕事、発行済みは届いたか確かめる仕事で、混ぜると両方が滞る。
 *
 * ⚠️ 本画面には `sent_to`（送付先メール／LINE ID ＝ PII-A）が出る。
 * 閲覧は staff に限る（`0023` の `eumo_select_staff`）。
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

  const grants = await fetchGrants();
  const byStatus = {
    unsent: grants.filter((grant) => grant.status === "未送付"),
    sent: grants.filter((grant) => grant.status === "送付済"),
    failed: grants.filter((grant) => grant.status === "送付失敗"),
    received: grants.filter((grant) => grant.status === "受領確認済"),
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-2xl font-bold">Eumo給付一覧</h1>
        <p className="mt-1 text-sm text-neutral-600">
          クエストの最終承認で自動起票された報酬と、キャッシュバック・手動起票の給付が並びます。
          実際の送金は eumo 側（アプリ外）で行い、ここでは
          <strong>「依頼した・送った・受け取られた」の追跡だけ</strong>を行います（v13 §5.3.1）。
        </p>
      </div>

      <GrantSection title={`発行依頼（${byStatus.unsent.length}件）`} grants={byStatus.unsent} />
      <GrantSection title={`発行済み・未受領（${byStatus.sent.length}件）`} grants={byStatus.sent} />
      <GrantSection title={`送付失敗（${byStatus.failed.length}件）`} grants={byStatus.failed} />
      <GrantSection title={`受領済み（${byStatus.received.length}件）`} grants={byStatus.received} />
    </main>
  );
}

function GrantSection({
  title,
  grants,
}: {
  title: string;
  grants: Awaited<ReturnType<typeof fetchGrants>>;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">{title}</h2>
      <GrantBoard
        grants={grants}
        markSent={markSentAction}
        confirmReceipt={confirmReceiptAction}
        markFailed={markFailedAction}
      />
    </section>
  );
}
