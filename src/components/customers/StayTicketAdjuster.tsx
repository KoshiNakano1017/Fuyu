"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import type { StayTicketEntry, StayTicketTxType } from "@/lib/lodging/stay-tickets";

export type AdjustAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 宿泊券の手動増減と調整ログ（画面ID C8 ／ WBS 10-4 ／ v13 §5.8.5）。
 *
 * ## 増減と履歴を同じ場所に置く
 *
 * v13 §5.8.5 は「調整ログを顧客詳細から閲覧可能とする」ことを要件にしている。
 * 操作の直下に履歴があれば、**二重に調整したかどうかをその場で確かめられる**。
 * 別画面へ分けると、同じ訂正を2回積む事故が起きる（残高は取引の積み上げなので戻せない）。
 *
 * ## 「いくつからいくつへ」はサーバで組む
 *
 * 保存しているのは差分（`nights`）だけであり、前後の残高は取引の積み上げから導く
 * （`fetchStayTicketHistory()`）。ここで再計算しないのは、表示のために2通りの
 * 計算式を持たないためである。
 *
 * ## 種別は選ばせない
 *
 * この画面から積めるのは `staff_adjust` だけである（`plan_grant` を名乗った手動付与が
 * 混ざると、付与の出どころが追えなくなる）。
 */
export function StayTicketAdjuster({
  memberId,
  balance,
  history,
  txLabels,
  maxNights,
  adjust,
}: {
  memberId: string;
  balance: number;
  history: readonly StayTicketEntry[];
  /** 種別の表示名。サーバ専用モジュールを client から import しないため props で受け取る */
  txLabels: Record<StayTicketTxType, string>;
  /**
   * 1回で動かせる幅（泊）。
   *
   * ★ 定数を client から import しない。出どころ（`stay-ticket-adjust.ts`）は
   * 認可判定のため `@/lib/auth/session` を読み、それが `next/headers` へ連なる
   * （client バンドルへ入るとビルドが落ちる）。**判定も定数もサーバ側に置いたまま値だけを渡す。**
   */
  maxNights: number;
  adjust: AdjustAction;
}) {
  const [state, submit, isPending] = useActionState(adjust, SUBMIT_IDLE);

  return (
    <section className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">宿泊券</h2>
        <span className="text-sm">
          残り <span className="text-xl font-bold">{balance}</span> 泊
        </span>
      </div>

      <form action={submit} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="memberId" value={memberId} />
        <label className="flex flex-col text-xs">
          増減（泊）
          <input
            type="number"
            name="nights"
            required
            step={1}
            min={-maxNights}
            max={maxNights}
            placeholder="+4 / -1"
            className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col text-xs">
          理由（必須）
          <input
            type="text"
            name="reason"
            required
            placeholder="出資追加 ／ 特例付与 ／ 誤登録の訂正 ／ イベント招待枠 など"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          調整する
        </button>
      </form>

      {state.status !== "idle" && state.message !== undefined ? (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"}>
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-bold">調整ログ</h3>
        {history.length === 0 ? (
          <p className="text-xs text-neutral-600">宿泊券の増減はまだありません。</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-neutral-700">
            {history.map((entry) => (
              <li key={entry.txId} className="flex flex-wrap justify-between gap-2">
                <span>
                  {new Date(entry.occurredAt).toLocaleString("ja-JP")}{" "}
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5">
                    {txLabels[entry.txType]}
                  </span>{" "}
                  {entry.operatorLabel === null ? "（自動）" : entry.operatorLabel}
                  {entry.reason === null ? "" : `：${entry.reason}`}
                </span>
                <span className="font-medium">
                  {entry.nights > 0 ? `+${entry.nights}` : entry.nights} 泊（
                  {entry.balanceBefore} → {entry.balanceBefore + entry.nights}）
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[0.7rem] text-neutral-500">
          残高は取引の積み上げで算出しています（v13 §5.8.5）。過去の行は取り消せません。
          間違えたときは反対向きの調整を理由つきで積んでください。
        </p>
      </div>
    </section>
  );
}
