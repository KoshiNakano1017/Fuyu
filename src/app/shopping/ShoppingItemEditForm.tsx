"use client";

import { useActionState } from "react";

import type { ShoppingItem } from "@/lib/shopping/fetch-items";

import { editShoppingItemAction, type EditFormState } from "./actions";

const INITIAL: EditFormState = { status: "idle" };

/**
 * 登録済みの品目を直す（v13 §5.12.1「編集・取下げは登録者本人と運営が行える」）。
 *
 * ## なぜ一覧の中に畳んで置くのか
 *
 * 編集は「一覧で見ていて違いに気づいたとき」に始まる操作であり、対象の行から離れない方がよい。
 * 一方で常時開いていると、閲覧しに来ただけの人にも入力欄が並ぶ（§5.12.1 が登録をモーダルに
 * 寄せたのと同じ理由）。`<details>` で畳めば、置き場所を変えずに両方を満たせる。
 *
 * 入力欄の並びは登録モーダル（`ShoppingRegisterForm`）と同じ §5.12.1「入力項目」の順にする。
 * 同じ値を同じ順で出さないと、登録したときと違う画面を読み直すことになる。
 *
 * ## なぜクライアントコンポーネントなのか
 *
 * 編集は**失敗し得る**（権限・URL 形式・数量の範囲）。`<form action={...}>` に
 * `void` を返すアクションを繋ぐと、拒否されても画面に何も出ず、利用者は
 * 「直したはずの値が戻っている」ことにしか気づけない。結果を出すために
 * `useActionState` を使う（登録モーダルと同じ作り）。
 */
export function ShoppingItemEditForm({ item }: { item: ShoppingItem }) {
  const [state, submit] = useActionState(editShoppingItemAction, INITIAL);

  return (
    <details className="rounded border border-neutral-200 p-2">
      <summary className="cursor-pointer text-sm">内容を直す</summary>

      <form action={submit} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="itemId" value={item.itemId} />

        <label className="flex flex-col gap-1 text-sm font-medium">
          ほしいもの（品名）
          <input
            type="text"
            name="itemName"
            defaultValue={item.itemName}
            required
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            数量（任意）
            {/*
              DB は `quantity > 0` を CHECK している（0030）。`min` は下限を**含む**ため
              「0 より大きい」をそのまま書けない。0 を弾ける最小の下限をブラウザ側の目安として置き、
              実際の判定はサーバ側（`editShoppingItemAction`）が行う。
            */}
            <input
              type="number"
              name="quantity"
              defaultValue={item.quantity ?? ""}
              min="0.01"
              step="any"
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            単位（任意）
            <input
              type="text"
              name="unit"
              defaultValue={item.unit ?? ""}
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            いつまでに（任意）
            <input
              type="date"
              name="wantedBy"
              defaultValue={item.wantedBy ?? ""}
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            優先度
            <select name="priority" defaultValue={item.priority} className="rounded border border-neutral-300 px-3 py-2">
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
              defaultValue={item.referencePriceJpy ?? ""}
              min="0"
              step="1"
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            どこで買えるか・店名（任意）
            <input
              type="text"
              name="shopName"
              defaultValue={item.shopName ?? ""}
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            商品ページのURL（任意）
            <input
              type="url"
              name="shopUrl"
              defaultValue={item.shopUrl ?? ""}
              placeholder="https://"
              className="rounded border border-neutral-300 px-3 py-2"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          何に使うか（任意）
          <input
            type="text"
            name="purpose"
            defaultValue={item.purpose ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        {state.status !== "idle" && state.message !== undefined && (
          <p
            role="status"
            className={
              state.status === "error"
                ? "text-sm text-red-700"
                : "text-sm text-green-700"
            }
          >
            {state.message}
          </p>
        )}

        <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white">
          この内容で直す
        </button>
      </form>
    </details>
  );
}
