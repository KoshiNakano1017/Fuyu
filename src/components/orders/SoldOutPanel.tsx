"use client";

import { useActionState } from "react";

import type { MenuItem } from "@/lib/orders/menu";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

/**
 * SOLDOUT トグル（画面ID B2 ／ WBS 6-3）。
 *
 * 独立した画面を作らず注文管理（B1）へ内包する。画面設計.md §2 が
 * 「B1 に内包」と定めており、売り切れは**捌いている最中に起きる**ため、
 * 板から離れずに切り替えられることが要件そのものである。
 *
 * 値段は出さない。`0018` の列単位 GRANT により、コアメンバーが触れるのは
 * `is_sold_out` だけである。触れない列を画面に並べると、押せないボタンが増えるだけになる。
 */
export function SoldOutPanel({
  items,
  toggleSoldOut,
}: {
  items: MenuItem[];
  toggleSoldOut: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <SoldOutToggle key={item.menuItemId} item={item} toggleSoldOut={toggleSoldOut} />
      ))}
    </ul>
  );
}

function SoldOutToggle({
  item,
  toggleSoldOut,
}: {
  item: MenuItem;
  toggleSoldOut: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
}) {
  const [, submit] = useActionState(toggleSoldOut, SUBMIT_IDLE);

  return (
    <li>
      <form action={submit}>
        <input type="hidden" name="menuItemId" value={item.menuItemId} />
        {/* 押したら反転する。現在値をそのまま送ると二度押しで元へ戻らない */}
        <input type="hidden" name="soldOut" value={item.isSoldOut ? "false" : "true"} />
        <button
          type="submit"
          className={
            item.isSoldOut
              ? "rounded bg-neutral-700 px-3 py-1 text-sm text-white"
              : "rounded border border-neutral-300 bg-white px-3 py-1 text-sm"
          }
        >
          {item.name}
          <span className="ml-2 text-xs">{item.isSoldOut ? "SOLDOUT" : "販売中"}</span>
        </button>
      </form>
    </li>
  );
}
