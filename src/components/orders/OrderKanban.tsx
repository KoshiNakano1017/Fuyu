"use client";

import { useActionState } from "react";

import { Money } from "@/components/ui/Money";
import type { OrderSummary } from "@/lib/orders/fetch-orders";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

/**
 * 注文管理カンバン（画面ID B1 ／ WBS 6-1・6-5）。
 *
 * ## 2軸である理由
 *
 * 列は**提供ステータス**（未提供／提供済み）で分ける。会計ステータス（未会計／精算済み）は
 * カード上のバッジに留める。v13 §5.4.1／§9 #39 が
 * 「提供と会計は独立した2軸」と定めており、片方の軸でしか並べられない板にすると
 * 「出したが未会計」の伝票が**どちらの列にも居場所を失う**。
 *
 * ## 表示語をここで作らない
 *
 * `未提供` は客向けには「調理中」と出す（v13 §5.4.1）。変換は
 * `toServingStatusDisplayLabel()` に一本化してあるので、ここで文字列を書かない。
 */
export function OrderKanban({
  orders,
  markServed,
}: {
  orders: OrderSummary[];
  markServed: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  const columns: { key: string; label: string; items: OrderSummary[] }[] = [
    {
      key: "未提供",
      label: toServingStatusDisplayLabel("未提供"),
      items: orders.filter((order) => order.servingStatus === "未提供"),
    },
    {
      key: "提供済み",
      label: toServingStatusDisplayLabel("提供済み"),
      items: orders.filter((order) => order.servingStatus === "提供済み"),
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {columns.map((column) => (
        <section key={column.key} className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">
            {column.label}
            <span className="ml-2 text-sm font-normal text-neutral-600">
              {column.items.length}件
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {column.items.map((order) => (
              <OrderCard
                key={order.orderId}
                order={order}
                markServed={markServed}
                showServeButton={column.key === "未提供"}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OrderCard({
  order,
  markServed,
  showServeButton,
}: {
  order: OrderSummary;
  markServed: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
  showServeButton: boolean;
}) {
  const [state, submit] = useActionState(markServed, SUBMIT_IDLE);

  return (
    <li className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{order.purchaserLabel}</span>
        <span className="flex gap-1">
          {/* 会計の軸。提供の軸（列）とは独立して出す */}
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">{order.status}</span>
          {order.orderChannel === "staff_proxy" && (
            <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-900">代理</span>
          )}
        </span>
      </div>

      <ul className="text-sm text-neutral-700">
        {order.lines.map((line, index) => (
          <li key={`${order.orderId}-${index}`}>
            {line.productName} × {line.quantity}
          </li>
        ))}
      </ul>

      <span className="text-sm font-medium">
        <Money priceYen={order.totalAmountYen} />
      </span>

      {showServeButton && (
        <form action={submit}>
          <input type="hidden" name="orderId" value={order.orderId} />
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1 text-sm text-white">
            提供済みにする
          </button>
        </form>
      )}
      {state.status === "error" && state.message && (
        <p className="text-sm text-red-700">{state.message}</p>
      )}
    </li>
  );
}
