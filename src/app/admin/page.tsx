import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { ConciergeAdminLink } from "@/components/concierge/ConciergeAdminLink";
import { RevisitAlerts } from "@/components/customers/RevisitAlerts";
import { Money } from "@/components/ui/Money";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { sumUnsettled } from "@/lib/billing/unsettled";
import { fetchRevisitAlerts } from "@/lib/customers/fetch-revisit";
import { fetchAvailability, fetchStaysOverlapping } from "@/lib/lodging/fetch-lodging";
import { fetchOpenOrders } from "@/lib/orders/fetch-orders";
import { fetchPendingApplications, fetchPendingWorkLogs } from "@/lib/quests/applications";

import { ShoppingRegisterForm } from "../shopping/ShoppingRegisterForm";

/**
 * 今日の浮遊街サマリー（画面ID C1 ／ WBS 13-1）。
 *
 * ## 数えるだけで、判断はしない
 *
 * ここに出すのは**今日の実数**だけである。「対応が必要か」の判断は各画面が持っており、
 * ダッシュボードが独自の閾値で警告を出すと、判断の出所が2つになる。
 * 各カードからその画面へ行けることのほうが重要なので、リンクを必ず添える。
 *
 * ## 集計を DB へ寄せない
 *
 * 件数はそれぞれの一覧取得を数えて出す。専用の集計ビューを足すと、
 * 一覧と件数が食い違ったときにどちらが正しいか分からなくなる
 * （残枠だけは `v_room_availability` が正本なのでビューを読む）。
 *
 * ## クイックアクション「🛒 ほしいものを登録」
 *
 * v13 §5.12.1「入口」が **A2 ホームと C1 統合ダッシュボードに置く**と名指しで定めている
 * （同 note：タブを増やさず、登録はダッシュボードのクイックアクションから行う）。
 * **「買い物リストを開く」リンクではなく、モーダル1枚で登録が完結する入口である。**
 *
 * サマリーカードの並びには混ぜない。カードは「今日の実数」を数える器であり、
 * 登録の入口を同じ並びに置くと、上記「数えるだけで、判断はしない」の切り分けが崩れる。
 *
 * A2 ホームと違い `canRegister()` で囲わない。この画面は `requireAdmin()` を通過した
 * 訪問者しか到達せず、**登録不可なのはゲストだけ**（§5.12.1「登録できるロール」／§9 #65②）
 * なので、ここで再判定しても常に真になる。画面から消すことは認可ではなく、
 * 実際の関門は Server Action 側の判定である（§5.9.3）。
 */
export default async function AdminDashboardPage() {
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

  const today = new Date().toISOString().slice(0, 10);
  const [orders, stays, availability, applications, workLogs, revisitAlerts] = await Promise.all([
    fetchOpenOrders(),
    fetchStaysOverlapping({ fromDate: today, toDate: today }),
    fetchAvailability({ fromDate: today, toDate: today }),
    fetchPendingApplications(),
    fetchPendingWorkLogs(),
    // 未処理の差額を持つ方が滞在中なら、サマリーより先に出す（v13 §5.6.6 ／ WBS 10-3）
    fetchRevisitAlerts(),
  ]);

  const unsettled = sumUnsettled(orders);
  const unserved = orders.filter((order) => order.servingStatus === "未提供").length;
  const headcount = stays.reduce(
    (total, stay) => total + stay.adultsCount + stay.childrenCount,
    0,
  );

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">今日の浮遊街サマリー</h1>
      <p className="text-sm text-neutral-600">{today}</p>

      <RevisitAlerts alerts={revisitAlerts} />

      <section className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-medium text-neutral-700">クイックアクション</h2>
        <ShoppingRegisterForm />
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard
          title="本日の滞在"
          value={`${headcount}名 / ${stays.length}件`}
          href="/staff/checkins"
          linkLabel="チェックイン／チェックアウトへ"
        />
        <SummaryCard
          title="未提供の注文"
          value={`${unserved}件`}
          href="/staff/orders"
          linkLabel="店員用タブレットへ"
        />
        <SummaryCard
          title="未会計"
          value={
            unsettled.orderCount === 0 ? (
              "なし"
            ) : (
              <>
                <Money priceYen={unsettled.totalAmountYen} />
                <span className="ml-2 text-sm font-normal">{unsettled.orderCount}件</span>
              </>
            )
          }
          href="/admin/customers"
          linkLabel="顧客管理へ（伝票編集・精算QR）"
        />
        <SummaryCard
          title="審査待ち"
          value={`申請 ${applications.length}件 / 報告 ${workLogs.length}件`}
          href="/staff/quests"
          linkLabel="クエスト承認・査定へ"
        />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">本日の残枠</h2>
        {availability.length === 0 ? (
          <p className="text-sm text-neutral-600">残枠を算出できませんでした。</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {availability.map((row) => (
              <li
                key={row.roomType}
                className={
                  row.available === 0
                    ? "rounded bg-neutral-700 px-3 py-1 text-white"
                    : "rounded bg-neutral-100 px-3 py-1"
                }
              >
                {row.roomType} 残 {row.available}/{row.total}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">浮遊街コンシェルジュ</h2>
        <ConciergeAdminLink />
      </section>
    </main>
  );
}

function SummaryCard({
  title,
  value,
  href,
  linkLabel,
}: {
  title: string;
  value: React.ReactNode;
  href: string;
  linkLabel: string;
}) {
  return (
    <section className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-4">
      <h2 className="text-sm text-neutral-600">{title}</h2>
      <p className="text-xl font-bold">{value}</p>
      <Link href={href} className="text-sm underline underline-offset-4">
        {linkLabel}
      </Link>
    </section>
  );
}
