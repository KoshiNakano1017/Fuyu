"use client";

import { useActionState, useState } from "react";

import { Money } from "@/components/ui/Money";
import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

/**
 * カフェメニューの登録フォーム（画面ID C13 ／ WBS 6-4）。
 *
 * ★ **Uii の入力欄を置かない。** v13 §5.5 は `floor(単価×0.8)` と定めており、
 * マスタは円単価だけを持つ（`0018` に Uii 列は無い）。
 * 入力させると、円と Uii が食い違ったマスタが作れてしまう。
 * 入力中の円価格から換算結果を**その場で見せる**のは、
 * 「いくらの Uii になるか」を登録前に確認したいという運用上の要求に応えるためである。
 */
export function MenuMasterForm({
  action,
  categories,
}: {
  action: (prev: SubmitState, formData: FormData) => Promise<SubmitState>;
  categories: string[];
}) {
  const [state, submit] = useActionState(action, SUBMIT_IDLE);
  const [priceYen, setPriceYen] = useState(0);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        商品名
        <input type="text" name="name" required className="rounded border border-neutral-300 px-3 py-2" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        カテゴリ
        <input
          type="text"
          name="category"
          required
          list="menu-categories"
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <datalist id="menu-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        価格（円）
        <input
          type="number"
          name="unitPriceYen"
          min={0}
          required
          value={priceYen}
          onChange={(event) => setPriceYen(Number.parseInt(event.target.value, 10) || 0)}
          className="rounded border border-neutral-300 px-3 py-2"
        />
        <span className="text-xs text-neutral-600">
          表示価格: <Money priceYen={priceYen} />
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        説明（任意）
        <textarea name="description" rows={2} className="rounded border border-neutral-300 px-3 py-2" />
      </label>

      <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-white">
        追加する
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
