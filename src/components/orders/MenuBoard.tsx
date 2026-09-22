"use client";

import { useActionState } from "react";

import { Money } from "@/components/ui/Money";
import type { MenuCategory } from "@/lib/orders/menu";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";
import { canOrderMenuItem } from "@/lib/orders/menu";

/**
 * 品書き＋数量入力（A5 セルフオーダー ／ B3 代理注文で共用）。
 *
 * ## 売り切れを消さずに出す
 *
 * `is_sold_out` の商品も**カードごと出したうえで数量入力を無効にする**
 * （v13 §5.4.1）。一覧から消すと「元々無い」のか「今日は売り切れた」のかが
 * 利用者に区別できず、店員への問い合わせが増える。
 *
 * ## 金額をここで計算しない
 *
 * 表示は `Money`（v13 §5.5 の Uii主・円副）に任せ、**合計はサーバが出す**。
 * 画面で足した合計を送ると、送られた値を信じるか捨てるかの判断が
 * サーバ側に増えるだけで、何の役にも立たない。
 */
export function MenuBoard({
  categories,
  action,
  submitLabel,
  disabledReason,
  extraFields,
}: {
  categories: MenuCategory[];
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
  submitLabel: string;
  /** 注文できない理由。null なら注文できる。 */
  disabledReason: string | null;
  /** 代理注文の相手選択など、品書きの前に差し込む入力。 */
  extraFields?: React.ReactNode;
}) {
  const [state, submit] = useActionState(action, SUBMIT_IDLE);
  const locked = disabledReason !== null;

  return (
    <form action={submit} className="flex flex-col gap-6">
      {locked && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          🔒 {disabledReason}
        </p>
      )}

      {extraFields}

      {categories.map((category) => (
        <section key={category.category} className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">{category.category}</h2>
          <ul className="flex flex-col gap-2">
            {category.items.map((item) => {
              const orderable = canOrderMenuItem(item) && !locked;
              return (
                <li
                  key={item.menuItemId}
                  className="flex items-center justify-between gap-3 rounded border border-neutral-200 bg-white p-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {item.name}
                      {item.isSoldOut && (
                        <span className="ml-2 rounded bg-neutral-700 px-2 py-0.5 text-xs text-white">
                          SOLDOUT
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-neutral-600">
                      <Money priceYen={item.unitPriceYen} />
                    </span>
                    {item.description !== null && (
                      <span className="text-xs text-neutral-500">{item.description}</span>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <span className="sr-only">{item.name} の数量</span>
                    <input
                      type="number"
                      name={`quantity:${item.menuItemId}`}
                      min={0}
                      max={99}
                      defaultValue={0}
                      disabled={!orderable}
                      className="w-16 rounded border border-neutral-300 px-2 py-1 text-right disabled:bg-neutral-100"
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <button
        type="submit"
        disabled={locked}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:bg-neutral-400"
      >
        {submitLabel}
      </button>

      {state.status === "done" && state.message && (
        <p className="text-sm text-green-700">{state.message}</p>
      )}
      {state.status === "error" && state.message && (
        <p className="text-sm text-red-700">{state.message}</p>
      )}
    </form>
  );
}
