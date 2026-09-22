"use client";

import { useActionState } from "react";

import { registerShoppingItemAction, type RegisterFormState } from "./actions";

const INITIAL: RegisterFormState = { status: "idle" };

/**
 * 「ほしいもの」の登録フォーム（v13 §5.12.1）。
 *
 * ## 必須は品名だけ
 *
 * 「気づいた瞬間に30秒で登録できる」ことを最優先する。入力必須を増やすと、
 * 結局 LINE に書かれて終わる。残りの項目は後から運営が補える。
 *
 * ## 重複は提示するだけ
 *
 * 既に同じものが登録されていれば候補を出し、**相乗り**か「それでも登録する」かを
 * 利用者に選ばせる。自動でまとめない（「同じ洗剤」でも容量違いが別物であることが多い）。
 */
export function ShoppingRegisterForm() {
  const [state, submit] = useActionState(registerShoppingItemAction, INITIAL);
  const duplicated = state.status === "duplicate";

  return (
    <form action={submit} className="flex flex-col gap-3 rounded border border-neutral-300 p-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        ほしいもの（品名）
        <input
          type="text"
          name="itemName"
          required
          placeholder="例：食器用洗剤"
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          数量（任意）
          <input type="number" name="quantity" min="0" step="any" className="rounded border border-neutral-300 px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          単位（任意）
          <input type="text" name="unit" placeholder="本 / 袋" className="rounded border border-neutral-300 px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          いつまでに（任意）
          <input type="date" name="wantedBy" className="rounded border border-neutral-300 px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          優先度
          <select name="priority" defaultValue="通常" className="rounded border border-neutral-300 px-3 py-2">
            <option value="至急">至急</option>
            <option value="通常">通常</option>
            <option value="いつでも">いつでも</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          参考価格（円・任意）
          <input
            type="number"
            name="referencePriceJpy"
            min="0"
            step="1"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          どこで買えるか（任意）
          <input type="text" name="sourceHint" placeholder="店名・URL" className="rounded border border-neutral-300 px-3 py-2" />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        何に使うか（任意）
        <input type="text" name="purpose" className="rounded border border-neutral-300 px-3 py-2" />
      </label>

      {duplicated && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p className="font-medium">同じものが既に登録されています</p>
          <ul className="mt-1 list-disc pl-5">
            {state.duplicates?.map((item) => (
              <li key={item.itemId}>{item.itemName}</li>
            ))}
          </ul>
          <p className="mt-2 text-neutral-700">
            一覧から「自分も欲しい」を押すと相乗りできます。容量違いなど別物であれば、そのまま登録してください。
          </p>
          {/* 2回目の送信でだけ重複確認を飛ばす。既定で握りつぶさない。 */}
          <input type="hidden" name="confirmDuplicate" value="1" />
        </div>
      )}

      <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
        {duplicated ? "それでも登録する" : "ほしいものを登録する"}
      </button>

      {state.message && state.status !== "duplicate" ? (
        <p className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>{state.message}</p>
      ) : null}
    </form>
  );
}
