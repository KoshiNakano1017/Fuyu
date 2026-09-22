import { describeRevisitAlert, type RevisitAlert } from "@/lib/customers/revisit";

/**
 * 再訪アラート（WBS 10-3 ／ v13 §5.6.6・§5.8.4）。
 *
 * 店員タブレットと管理ダッシュボードの両方に出す。差額は「次回来訪時に現地で精算する」
 * 前提で繰り越されており、**回収・返金の機会は本人が滞在しているあいだしかない**。
 *
 * ⚠️ 実名を出さない（表示名は `v_member_public` 由来）。この板は客から見える位置に置かれうる。
 * ⚠️ 金額は出すが、**何の差額かまでは出さない**。伝票の中身は顧客管理画面で開く。
 */
export function RevisitAlerts({ alerts }: { alerts: readonly RevisitAlert[] }) {
  if (alerts.length === 0) {
    return null;
  }

  return (
    <section className="rounded border border-amber-400 bg-amber-50 p-4">
      <h2 className="text-lg font-bold text-amber-900">
        未処理の差額がある方が滞在中です（{alerts.length}名）
      </h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm text-amber-900">
        {alerts.map((alert) => (
          <li key={alert.memberId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {alert.memberLabel}
              <span className="ml-2 text-xs">{alert.memberType}</span>
              <span className="ml-2 text-xs">宿泊券 {alert.stayTickets}枚</span>
            </span>
            <span className="font-medium">{describeRevisitAlert(alert)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-amber-800">
        滞在中に現金・Eumo で精算するか、返金してください（v13 §5.6.6）。
      </p>
    </section>
  );
}
