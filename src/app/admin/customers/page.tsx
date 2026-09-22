import Link from "next/link";

import { AccessDenied } from "@/components/auth/AccessDenied";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { fetchCustomerRows } from "@/lib/customers/fetch-customers";
import { filterCustomers, groupByStay, type CustomerRow } from "@/lib/customers/sort";

/**
 * 顧客管理（画面ID C11 ／ WBS 8-1・8-5 ／ v13 §5.6.1・§5.6.7）。
 *
 * ## 既定は「滞在中が上」
 *
 * この画面を開く動機のほとんどは「**いま目の前にいる人**の未会計を見る／伝票を直す」である
 * （v13 §5.6.7 note）。五十音順や登録順にすると毎回検索から始めることになる。
 * 並びの規則そのものは `sortCustomers()`（純関数・試験あり）が持つ。
 *
 * ## 検索は全件が対象
 *
 * 退去済みの顧客を探す動線（遡及修正・差額精算）が必要なため、
 * 検索だけは滞在状態に関わらず全件を見る（§5.6.7）。
 *
 * ⚠️ **実名を出さない。** 表示名は `v_member_public` のニックネーム／会員番号である
 * （`fetch-customers.ts` 冒頭の注記）。
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
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

  const { q } = await searchParams;
  const query = q ?? "";
  const rows = filterCustomers(await fetchCustomerRows(), query);
  const { staying, away } = groupByStay(rows);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">顧客管理</h1>

      <form className="flex gap-2" action="/admin/customers">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="ニックネーム・会員番号で検索"
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded border border-neutral-400 px-4 py-2 text-sm">
          検索
        </button>
      </form>

      <CustomerSection title={`🟢 滞在中（${staying.length}名）`} rows={staying} highlighted />
      <CustomerSection title={`滞在外（${away.length}名）`} rows={away} highlighted={false} />
    </main>
  );
}

function CustomerSection({
  title,
  rows,
  highlighted,
}: {
  title: string;
  rows: readonly CustomerRow[];
  highlighted: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">該当する顧客はいません。</p>
      ) : (
        <ul className={`flex flex-col gap-1 rounded ${highlighted ? "bg-green-50 p-2" : ""}`}>
          {rows.map((row) => (
            <li key={row.memberId}>
              <Link
                href={`/admin/customers/${row.memberId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-200 bg-white px-3 py-2 text-sm hover:border-neutral-400"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{row.displayName}</span>
                  <span className="text-xs text-neutral-600">{row.memberType}</span>
                  {row.hasPendingAdjustment ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                      未処理の差額あり
                    </span>
                  ) : null}
                </span>
                {/*
                  ★ `Money` を使わない。あれは円から Uii を計算し直すため、
                  伝票に保存済みの Uii（単品ごとに切り捨てた当時の値）と
                  合計がずれる（v13 §5.5 ／ `src/lib/billing/unsettled.ts`）。
                  集計の表示は保存値をそのまま並べる。
                */}
                <span className="text-xs text-neutral-700">
                  未会計 {row.unsettledUii.toLocaleString("ja-JP")} Uii（¥
                  {row.unsettledYen.toLocaleString("ja-JP")}）
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
