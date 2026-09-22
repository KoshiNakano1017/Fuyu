import type { ShoppingItem } from "@/lib/shopping/fetch-items";

import { editShoppingItemAction } from "./actions";

/**
 * 登録済みの品目を直す（v13 §5.12.1「編集・取下げは登録者本人と運営が行える」）。
 *
 * ## なぜ一覧の中に畳んで置くのか
 *
 * 編集は「一覧で見ていて違いに気づいたとき」に始まる操作であり、対象の行から離れない方がよい。
 * 一方で常時開いていると、閲覧しに来ただけの人にも入力欄が並ぶ（§5.12.1 が登録をモーダルに
 * 寄せたのと同じ理由）。`<details>` で畳めば、クライアント JS を足さずに両方を満たせる。
 *
 * 入力欄の並びは登録モーダル（`ShoppingRegisterForm`）と同じ §5.12.1「入力項目」の順にする。
 * 同じ値を同じ順で出さないと、登録したときと違う画面を読み直すことになる。
 */
export function ShoppingItemEditForm({ item }: { item: ShoppingItem }) {
  return (
    <details className="rounded border border-neutral-200 p-2">
      <summary className="cursor-pointer text-sm">内容を直す</summary>

      <form action={editShoppingItemAction} className="mt-3 flex flex-col gap-3">
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
            <input
              type="number"
              name="quantity"
              defaultValue={item.quantity ?? ""}
              min="0"
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

        <button type="submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white">
          この内容で直す
        </button>
      </form>
    </details>
  );
}
