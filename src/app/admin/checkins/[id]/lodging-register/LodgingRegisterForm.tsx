"use client";

import { useActionState, useState } from "react";

import type { LodgingRegisterPrefill } from "@/lib/lodging/register";

import { submitLodgingRegisterAction, type LodgingRegisterFormState } from "./actions";

const INITIAL: LodgingRegisterFormState = { status: "idle" };

/**
 * 宿泊者名簿フォーム（v13 §5.2.7）。
 *
 * ## プレフィルは下書き、確定するのは店員
 *
 * 値は `prefill`（紐づく予約 ＋ 既存会員プロフィール ／ `fetchLodgingRegisterPrefill()`）から
 * 初期表示するが、**すべて編集可能**にしてある。加えて「氏名・カナを本人へ提示し確認した」
 * チェックを入れるまで送信ボタンを非活性にする。プレフィルされた値をそのまま送れてしまうと、
 * 「店員が確認した」という事実そのものが形骸化するため（v13 §5.2.7「本人の自己申告のみでは
 * 確定させない」の運用上の担保）。**このチェックはクライアント側の親切であり、防壁ではない。**
 * サーバ側（`actions.ts` → `validateLodgingRegisterInput()`）が同じ条件を必ず再検証する。
 */
export function LodgingRegisterForm({
  checkinId,
  prefill,
}: {
  checkinId: string;
  prefill: LodgingRegisterPrefill;
}) {
  const [state, submit] = useActionState(submitLodgingRegisterAction, INITIAL);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="checkinId" value={checkinId} />

      <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
        <legend className="px-1 text-sm font-medium text-neutral-700">氏名</legend>
        <label className="flex flex-col gap-1 text-sm">
          氏名
          <input
            type="text"
            name="fullNameSnapshot"
            required
            defaultValue={prefill.fullNameSnapshot ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          フリガナ
          <input
            type="text"
            name="fullNameKanaSnapshot"
            defaultValue={prefill.fullNameKanaSnapshot ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="fullNameConfirmed"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1"
          />
          <span>
            氏名・カナを本人へ提示し、確認した
            <span className="text-red-700">（必須）</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
        <legend className="px-1 text-sm font-medium text-neutral-700">
          旅館業法必須項目
        </legend>
        <label className="flex flex-col gap-1 text-sm">
          住所
          <textarea
            name="address"
            required
            rows={2}
            defaultValue={prefill.address ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          前泊地
          <input
            type="text"
            name="previousLocation"
            required
            defaultValue={prefill.previousLocation ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          後泊地／行先（任意）
          <input
            type="text"
            name="nextDestination"
            defaultValue={prefill.nextDestination ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={!confirmed}
        className="rounded bg-neutral-900 px-4 py-2 text-white disabled:bg-neutral-300"
      >
        {prefill.hasExistingEntry ? "宿泊者名簿を更新する" : "宿泊者名簿を確定する"}
      </button>

      {state.message ? (
        <p className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
