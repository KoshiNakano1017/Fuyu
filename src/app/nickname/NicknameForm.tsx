"use client";

import { useActionState } from "react";

import { NICKNAME_MAX_LENGTH } from "@/lib/members/nickname";

import { saveNicknameAction, type NicknameFormState } from "./actions";

const INITIAL: NicknameFormState = { status: "idle" };

/**
 * ニックネームの設定フォーム（WBS `2-7`）。
 *
 * `maxLength` はブラウザ側の親切であって検査ではない。**検査はサーバ側**
 * （`validateNickname()`）にあり、DevTools から属性を外しても通らない。
 */
export function NicknameForm({ currentNickname }: { currentNickname: string | null }) {
  const [state, submit] = useActionState(saveNicknameAction, INITIAL);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        ニックネーム
        <input
          type="text"
          name="nickname"
          required
          defaultValue={currentNickname ?? ""}
          maxLength={NICKNAME_MAX_LENGTH}
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
        保存する
      </button>
      {state.status === "error" && state.message ? (
        <p className="text-sm text-red-700">{state.message}</p>
      ) : null}
    </form>
  );
}
