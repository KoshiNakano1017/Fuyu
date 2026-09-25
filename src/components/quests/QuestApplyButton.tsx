"use client";

import { useActionState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type QuestApplyAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

/**
 * 受注申請ボタン（WBS 5-2 ／ v13 §5.3-2）。
 *
 * ## 非活性の理由を書かない
 *
 * 押せない理由（施錠・締切・資格不足）はボタンに出さない。バッジ（`🔒 街人登録で解放` /
 * `🚧 受注できません`）が伝える範囲に留めるのが §5.10.6 末尾の要求であり、
 * **詳細を伏せている施錠クエストの状態を推測させない**ためである。
 *
 * ## 活性の根拠はサーバが決めた `canApply` である
 *
 * ここでロールや資格を見ない。`buildQuestBoard()` が `canApplyToQuest()` で決めた結果だけを
 * 受け取る。押した後も Server Action が**同じ関数**で再判定するので、
 * クライアントで活性を書き換えても通らない（v13 §5.9.3）。
 */
export function QuestApplyButton({
  questId,
  canApply,
  apply,
}: {
  questId: string;
  canApply: boolean;
  apply: QuestApplyAction;
}) {
  const [state, submit, isPending] = useActionState(apply, SUBMIT_IDLE);
  const applied = state.status === "done";

  return (
    <div className="flex flex-col gap-1">
      <form action={submit}>
        <input type="hidden" name="questId" value={questId} />
        <button
          type="submit"
          disabled={!canApply || isPending || applied}
          className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:bg-neutral-300"
        >
          {applied ? "申請済み" : "受注を申請する"}
        </button>
      </form>

      {state.status === "idle" || state.message === undefined ? null : (
        <p className={state.status === "error" ? "text-xs text-red-700" : "text-xs text-neutral-700"}>
          {state.message}
        </p>
      )}
    </div>
  );
}
