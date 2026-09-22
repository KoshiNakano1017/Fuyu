"use client";

import { useActionState } from "react";

import { sendInvitationAction, type InviteFormState } from "./actions";

const INITIAL: InviteFormState = { status: "idle" };

export function InvitationForm() {
  const [state, submit] = useActionState(sendInvitationAction, INITIAL);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        会員ID
        <input
          type="text"
          name="memberId"
          required
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        送信先メールアドレス
        <input
          type="email"
          name="email"
          required
          className="rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
        案内メールを送信する
      </button>
      {state.message ? (
        <p className={state.status === "error" ? "text-sm text-red-700" : "text-sm text-green-700"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
