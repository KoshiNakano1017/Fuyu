import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { CashbackPanel } from "@/components/customers/CashbackPanel";
import { SlipEditor } from "@/components/customers/SlipEditor";
import { StayHistorySection } from "@/components/customers/StayHistorySection";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { sumUnsettled } from "@/lib/billing/unsettled";
import { fetchCustomerDetail } from "@/lib/customers/fetch-customers";
import { fetchStayHistory } from "@/lib/customers/fetch-stay-history";
import { judgeFirstVisitCashback } from "@/lib/eumo/grants";
import {
  countVisits,
  fetchCashbackStatus,
  fetchCurrentSignupCashbackUii,
  fetchMemberOrigin,
} from "@/lib/eumo/store";
import { fetchStayingCheckIns } from "@/lib/orders/fetch-orders";

import {
  cancelOrderAction,
  editSlipAction,
  issueFirstVisitCashbackAction,
  issueSettlementQrAction,
  reassignPurchaserAction,
  toggleSettlementStatusAction,
} from "./actions";

/**
 * 顧客サマリー ＋ 注文履歴（画面ID C11 ／ WBS 8-1・7-2・7-3 ／ v13 §5.6.1〜§5.6.6）。
 *
 * ## この画面が出さないもの
 *
 * - **氏名・住所・電話番号**（PII-A）。表示名は `v_member_public` のニックネーム／会員番号。
 *   宿泊法の申告項目は専用画面（WBS 2-4・3-2）が扱う
 * - **宿泊形態の変更（§5.6.9）**。WBS `3-10` の担当であり、要件のみ確定・詳細設計が未整備の段階にある
 *   （宿泊履歴の表示＝§5.6.8 ／ WBS `8-6` は実装済み）
 * - **手動調整行（まかない補助・割引 ／ §5.6.2）**。物理設計が存在せず、
 *   `QUESTIONS.md`「[2026-09-20] 伝票の編集履歴ログ・精算グループ・手動調整行の
 *   物理設計が存在しない」でオーナー判断待ち
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
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

  const { memberId } = await params;
  const [
    customer,
    stayingCheckIns,
    origin,
    visitCount,
    cashbackStatus,
    planCashbackUii,
    stayHistory,
  ] = await Promise.all([
      fetchCustomerDetail(memberId),
      fetchStayingCheckIns(),
      // 初回来訪キャッシュバックの材料（v13 §5.10.8 ①：**保存カラムを持たず都度算出**）
      fetchMemberOrigin(memberId),
      countVisits(memberId),
      fetchCashbackStatus(memberId),
      fetchCurrentSignupCashbackUii(),
      // 宿泊履歴（泊まった部屋 ／ v13 §5.6.8）
      fetchStayHistory(memberId),
    ]);
  if (customer === null) {
    notFound();
  }

  const cashbackJudgement = judgeFirstVisitCashback({
    memberType: origin?.memberType ?? customer.memberType,
    visitCount,
    existingCashbackStatus: cashbackStatus,
    // 会員行を読めなかった場合は「移行由来かどうか」を判定できない。
    // 分からないときは自動起票へ倒さず「要確認」へ倒す（二重付与は取り消せない）。
    isImportedMember: origin?.isImportedMember ?? true,
    planCashbackUii,
  });

  const unsettled = sumUnsettled(customer.orders);
  // 付け替え先は「滞在中のユーザー」を既定とする（v13 §5.6.2）。本人は候補から外す。
  const stayOptions = stayingCheckIns
    .filter((stay) => stay.memberId !== customer.memberId)
    .map((stay) => ({
      checkinId: stay.checkinId,
      memberId: stay.memberId,
      memberLabel: `${stay.memberLabel}（${stay.roomType}）`,
    }));

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <Link href="/admin/customers" className="text-sm underline">
        ← 顧客一覧へ戻る
      </Link>

      <header className="flex flex-col gap-2 rounded border border-neutral-300 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{customer.displayName}</h1>
          <span className="text-sm text-neutral-600">{customer.memberType}</span>
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              customer.isStaying ? "bg-green-100 text-green-800" : "bg-neutral-200 text-neutral-700"
            }`}
          >
            {customer.isStaying ? "滞在中" : "滞在外"}
          </span>
          {customer.roomType === null ? null : (
            <span className="text-xs text-neutral-600">{customer.roomType}</span>
          )}
        </div>

        {/*
          未会計額は**最も大きく強調**する（v13 §5.6.1①）。
          Uii が主・円が副（§5.5 ／ §9 #41）。伝票に保存済みの Uii を足した値であり、
          円から換算し直していない（`sumUnsettled()`）。
        */}
        <p className="text-3xl font-bold">
          {unsettled.totalAmountUii.toLocaleString("ja-JP")} Uii
          <span className="ml-2 text-base font-normal text-neutral-600">
            （¥{unsettled.totalAmountYen.toLocaleString("ja-JP")} ／ 未会計 {unsettled.orderCount} 件）
          </span>
        </p>

        {customer.pendingAdjustments.length === 0 ? null : (
          <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-semibold">未処理の差額が {customer.pendingAdjustments.length} 件あります</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs">
              {customer.pendingAdjustments.map((adjustment) => (
                <li key={adjustment.adjustmentId}>
                  {adjustment.category}: ¥{Math.abs(adjustment.amountYen).toLocaleString("ja-JP")}
                  （{adjustment.reason}）
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">
              次回来訪時に現地で精算します（v13 §5.6.6）。繰越しても未処理のまま残ります。
            </p>
          </div>
        )}
      </header>

      <CashbackPanel
        memberId={customer.memberId}
        memberType={customer.memberType}
        visitCount={visitCount}
        judgement={cashbackJudgement}
        issue={issueFirstVisitCashbackAction}
      />

      <StayHistorySection history={stayHistory} />

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">注文履歴</h2>
        {customer.orders.length === 0 ? (
          <p className="text-sm text-neutral-600">伝票はまだありません。</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {customer.orders.map((order) => (
              <SlipEditor
                key={order.orderId}
                order={order}
                stayOptions={stayOptions}
                editSlip={editSlipAction}
                reassign={reassignPurchaserAction}
                cancelOrder={cancelOrderAction}
                issueQr={issueSettlementQrAction}
                toggleSettlement={toggleSettlementStatusAction}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
