"use client";

import { useActionState, useState } from "react";

import { requestLoginCode, verifyLoginCode, type LoginState } from "./actions";

const INITIAL: LoginState = { status: "idle" };

/**
 * メールOTP の2段（アドレス送信 → コード入力）。
 *
 * ⚠️ **パスワード欄は無い。** `type="password"` の input をこのファイルに足さないこと
 * （v13 §5.2.6「パスワードは発行も保存もしない」）。
 *
 * 認可の判定はここではしない。クライアント側の状態で画面を出し分けるのは
 * **利便性のためだけ**であり、権限の防壁はサーバ側（`src/lib/auth/guard.ts`）にある。
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [sendState, send] = useActionState(requestLoginCode, INITIAL);
  const [verifyState, verify] = useActionState(verifyLoginCode, INITIAL);

  const codeSent = sendState.status === "code_sent";

  return (
    <div className="flex flex-col gap-6">
      <form action={send} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
          {codeSent ? "コードを再送する" : "確認コードを送る"}
        </button>
      </form>

      {codeSent ? (
        <form action={verify} className="flex flex-col gap-3">
          {/* 送信済みのアドレスを引き継ぐ。利用者に2度入力させない。 */}
          <input type="hidden" name="email" value={email} />
          <label className="flex flex-col gap-1 text-sm">
            確認コード（6桁）
            <input
              type="text"
              name="token"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="rounded border border-neutral-300 px-3 py-2 tracking-widest"
            />
          </label>
          <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
            ログイン
          </button>
        </form>
      ) : null}

      {codeSent ? (
        <p className="text-sm text-neutral-600">
          コードを送信しました。届かない場合は、登録されているアドレスかご確認ください。
        </p>
      ) : null}

      {verifyState.status === "error" && verifyState.message ? (
        <p className="text-sm text-red-700">{verifyState.message}</p>
      ) : null}
      {sendState.status === "error" && sendState.message ? (
        <p className="text-sm text-red-700">{sendState.message}</p>
      ) : null}
    </div>
  );
}
