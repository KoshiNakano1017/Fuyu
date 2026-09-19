"use client";

import { useActionState } from "react";

import { saveMorningMeetingMinutesAction, type MinutesFormState } from "./actions";

const INITIAL: MinutesFormState = { status: "idle" };

/**
 * 朝会テキストの投入フォーム（v13 §9 #63）。
 *
 * ⚠️ **ファイル入力を置かない。** 投入経路はテキストの貼り付け1本に限ると
 * 2026-09-05 のオーナー決定で確定している（API連携・ファイルアップロードは行わない）。
 * アプリは音声も扱わない。
 */
export function MorningMeetingForm({ defaultHeldOn }: { defaultHeldOn: string }) {
  const [state, submit] = useActionState(saveMorningMeetingMinutesAction, INITIAL);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        実施日
        <input
          type="date"
          name="heldOn"
          required
          defaultValue={defaultHeldOn}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        文字起こしテキスト（全文を貼り付けてください）
        <textarea
          name="transcriptText"
          required
          rows={16}
          className="rounded border border-neutral-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
        議事録として保存する
      </button>
      {state.message ? (
        <p className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
