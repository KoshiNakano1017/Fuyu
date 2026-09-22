"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { registerShoppingItemAction, type RegisterFormState } from "./actions";

const INITIAL: RegisterFormState = { status: "idle" };

/**
 * 「ほしいもの」の登録（v13 §5.12.1）。**クイックアクション1つとモーダル1枚**で構成する。
 *
 * ## なぜインラインのフォームではなくモーダルなのか
 *
 * §5.12.1「入口」は「**専用画面へ遷移させず、モーダル1枚で登録が完結する**」と定めている
 * （画面設計 A13 も「A2 ホームからの登録モーダル ＋ 一覧」）。フォームを一覧の上に
 * 開いたまま置くと、**一覧を見に来ただけの人にも常時フォームが居座る**うえ、
 * 「登録は画面のどこかにある入力欄」になり、仕様が意図した「🛒 ほしいものを登録」という
 * 1つの入口が消える。ここをボタン＋`<dialog>` にしておけば、置き場所が
 * 一覧でもダッシュボード（A2／C1）でも**同じ1枚のモーダル**を使い回せる。
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
 *
 * ## 入力値はサーバから戻して復元する
 *
 * React はアクションの完了時にフォームを初期状態へ戻す。重複候補を出した拍子に入力が
 * 消えると、「それでも登録する」が品名の `required` で止まり、打ち直しになる
 * （§5.12.1 の「30秒で登録できる」が成立しない）。各欄の `defaultValue` を
 * 直前の入力値（`state.values`）から与えて復元する。
 */
export function ShoppingRegisterForm() {
  const [state, submit] = useActionState(registerShoppingItemAction, INITIAL);
  const duplicated = state.status === "duplicate";
  /** 直前の入力値。登録できたときだけ空に戻る（次の1件を空のフォームから書き始められる）。 */
  const values = state.values;
  /** 重複「候補」。自動でまとめず、相乗りか「それでも登録する」かを利用者に選ばせる。 */
  const duplicateCandidates = state.duplicates ?? [];

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  // `open` 属性を直接書くと背景が操作できてしまう（ブラウザの非モーダル表示になる）。
  // 「モーダル1枚で完結する」ためには `showModal()` で開く必要がある。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  // 登録できたときだけ閉じる。重複候補・エラーは**開いたまま**でないと、
  // 「それでも登録する」も入力の直しもモーダルの外からは行えない。
  // 閉じるのは `close()` だけにして、状態の更新は `onClose`（イベント）側へ寄せる。
  //
  // ⚠️ 依存は `state.status` ではなく **`state` そのもの**にする。
  // status だけを見ると "saved" → "saved" で値が変わらず、**2件目以降の登録で
  // この効果が再実行されない**。アクションは毎回新しいオブジェクトを返す
  // （`actions.ts` の各 return）ため、`state` なら登録のたびに必ず走る。
  // 閉じ損ねると保存できた旨がモーダルの裏に隠れ、利用者は失敗したと思って
  // 再送信する（＝重複登録）。
  useEffect(() => {
    if (state.status === "saved") {
      dialogRef.current?.close();
    }
  }, [state]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-white"
      >
        🛒 ほしいものを登録
      </button>

      {/* 登録できた旨はモーダルを閉じた後に残す。閉じた瞬間に消えると、保存できたか分からない。 */}
      {state.status === "saved" && state.message && <p className="text-sm text-green-700">{state.message}</p>}

      <dialog
        ref={dialogRef}
        aria-label="ほしいものを登録"
        onClose={() => setIsOpen(false)}
        className="w-full max-w-xl rounded border border-neutral-300 p-0 backdrop:bg-neutral-900/40"
      >
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          <h2 className="text-lg font-bold">ほしいものを登録</h2>
          <button type="button" onClick={() => setIsOpen(false)} className="rounded px-2 py-1 text-sm">
            閉じる
          </button>
        </div>

        <FormBody
          submit={submit}
          state={state}
          duplicated={duplicated}
          values={values}
          duplicateCandidates={duplicateCandidates}
        />
      </dialog>
    </div>
  );
}

/** モーダルの中身。入力欄の並びは §5.12.1「入力項目」の順に合わせてある。 */
function FormBody({
  submit,
  state,
  duplicated,
  values,
  duplicateCandidates,
}: {
  submit: (formData: FormData) => void;
  state: RegisterFormState;
  duplicated: boolean;
  values: RegisterFormState["values"];
  duplicateCandidates: NonNullable<RegisterFormState["duplicates"]>;
}) {
  return (
    <form action={submit} className="flex flex-col gap-3 p-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        ほしいもの（品名）
        <input
          type="text"
          name="itemName"
          defaultValue={values?.itemName ?? ""}
          required
          placeholder="例：食器用洗剤"
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          数量（任意）
          {/*
            DB は `quantity > 0` を CHECK している（0030）。`min` は下限を**含む**ため
            「0 より大きい」をそのまま書けない。0 を弾ける最小の下限をブラウザ側の目安として置き、
            実際の判定はサーバ側（`registerShoppingItemAction`）が行う（編集フォームと同じ）。
          */}
          <input
            type="number"
            name="quantity"
            defaultValue={values?.quantity ?? ""}
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
            defaultValue={values?.unit ?? ""}
            placeholder="本 / 袋"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          いつまでに（任意）
          <input
            type="date"
            name="wantedBy"
            defaultValue={values?.wantedBy ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          優先度
          <select
            name="priority"
            defaultValue={values?.priority || "通常"}
            className="rounded border border-neutral-300 px-3 py-2"
          >
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
            defaultValue={values?.referencePriceJpy ?? ""}
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
            defaultValue={values?.shopName ?? ""}
            placeholder="例：カインズ"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          商品ページのURL（任意）
          <input
            type="url"
            name="shopUrl"
            defaultValue={values?.shopUrl ?? ""}
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
          defaultValue={values?.purpose ?? ""}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>

      {duplicated && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p className="font-medium">同じものが既に登録されています</p>
          <ul className="mt-1 list-disc pl-5">
            {duplicateCandidates.map((item) => (
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

      {state.status === "error" && state.message ? <p className="text-sm text-red-700">{state.message}</p> : null}
    </form>
  );
}
