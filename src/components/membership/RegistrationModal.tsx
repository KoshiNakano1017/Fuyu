"use client";

import { useActionState, useState } from "react";

import { SUBMIT_IDLE, type SubmitState } from "@/lib/forms/submit-state";

export type ApplyAction = (prev: SubmitState, formData: FormData) => Promise<SubmitState>;

export type RegistrationModalProps = {
  open: boolean;
  onClose: () => void;
  /** 料金（円）。`membership_plans` から来た値をそのまま出す */
  annualFeeYen: number;
  /** 特典の箇条書き（`buildMembershipBenefits()` の戻り値） */
  benefits: readonly string[];
  /** 確認画面の確認事項（`buildMembershipConfirmationLines()` の戻り値） */
  confirmationLines: readonly string[];
  paymentNotice: string;
  submitLabel: string;
  /** 既に申込中のとき出す状態（v13 §5.10.3「既存を表示する」） */
  activeStatus: string | null;
  apply: ApplyAction;
};

/**
 * 街人登録モーダル（v13 §5.10.1 Step 1〜2 ／ WBS 12-1）。
 *
 * ## 2段にする理由は誤タップの防止である（§5.10.3）
 *
 * Step 1（インフォメーション ＆ 入力）→ Step 2（確認 ＆ 申請確定）。
 * 1枚で確定できると、施錠カードを触っただけで申請が飛ぶ。
 *
 * ## 入力欄は持つが送らない（2026-09-25 オーナー決定 A ／ Issue #87）
 *
 * §5.10.2 は Step 1 を「インフォメーション **＆ 入力**」と定めているため入力欄は置く。
 * ただし**この導線では永続化しない**。ニックネームは本登録時に必須化済み（WBS `2-7`）、
 * 連絡先は `member_identifiers`（`0025`）が持ち、いずれも名寄せ（`10-2`）の領域である。
 * 別経路から書き込むと同じ情報の出どころが2つになる。
 *
 * その扱いを**画面にも書く**（黙って捨てると、入力した本人は「登録された」と思う）。
 *
 * ## 「決済」ではなく「申請」と書く（§5.10.2 末尾）
 *
 * この時点で課金は発生しない。支払い手段は運営から案内する（§5.10.7 の3経路）。
 */
export function RegistrationModal({
  open,
  onClose,
  annualFeeYen,
  benefits,
  confirmationLines,
  paymentNotice,
  submitLabel,
  activeStatus,
  apply,
}: RegistrationModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [state, submit, isPending] = useActionState(apply, SUBMIT_IDLE);

  if (!open) {
    return null;
  }

  const applied = state.status === "done";

  return (
    // `fixed` の親を持たないよう、呼び出し側は body 直下相当の位置へ置く。
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="membership-modal-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id="membership-modal-title" className="text-lg font-bold">
            🌿 街人（メンバー）に登録して浮遊街をもっと楽しもう
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded px-2 py-1 text-sm text-neutral-600"
          >
            ✕
          </button>
        </div>

        {activeStatus !== null ? (
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            すでに申請を受け付けています（状態：{activeStatus}）。運営からのご案内をお待ちください。
          </p>
        ) : applied ? (
          <p className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">
            {state.message}
          </p>
        ) : step === 1 ? (
          <Step1
            annualFeeYen={annualFeeYen}
            benefits={benefits}
            onNext={() => setStep(2)}
          />
        ) : (
          <Step2
            confirmationLines={confirmationLines}
            paymentNotice={paymentNotice}
            submitLabel={submitLabel}
            isPending={isPending}
            errorMessage={state.status === "error" ? state.message : undefined}
            onBack={() => setStep(1)}
            submit={submit}
          />
        )}
      </div>
    </div>
  );
}

function Step1({
  annualFeeYen,
  benefits,
  onNext,
}: {
  annualFeeYen: number;
  benefits: readonly string[];
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        料金 <span className="text-xl font-bold">¥{annualFeeYen.toLocaleString("ja-JP")}</span>
      </p>

      <ul className="flex flex-col gap-1 text-sm">
        {benefits.map((benefit) => (
          <li key={benefit} className="flex gap-1">
            <span aria-hidden>・</span>
            <span>{benefit}</span>
          </li>
        ))}
      </ul>

      {/*
        §5.10.2 の入力欄。**送信しない**（決定 A ／ Issue #87）。
        置くのは、本登録・名寄せで同じ情報を聞かれることを先に知らせる意味があるため。
      */}
      <fieldset className="flex flex-col gap-2 rounded border border-neutral-200 p-3">
        <legend className="px-1 text-xs text-neutral-600">
          登録後に必要になる情報（この画面では保存しません）
        </legend>
        <label className="flex flex-col text-xs">
          ニックネーム（アプリ内表示名）
          <input
            type="text"
            name="nickname"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs">
          メールアドレス・電話番号
          <input
            type="text"
            name="contact"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs">
          誕生年月（概算）
          <input
            type="text"
            name="birthMonth"
            placeholder="1990-04"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <p className="text-[0.7rem] text-neutral-500">
          運営が承認したあと、本登録の画面で改めて入力していただきます。
        </p>
      </fieldset>

      <button
        type="button"
        onClick={onNext}
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
      >
        登録内容を確認する
      </button>
    </div>
  );
}

function Step2({
  confirmationLines,
  paymentNotice,
  submitLabel,
  isPending,
  errorMessage,
  onBack,
  submit,
}: {
  confirmationLines: readonly string[];
  paymentNotice: string;
  submitLabel: string;
  isPending: boolean;
  errorMessage?: string;
  onBack: () => void;
  submit: (formData: FormData) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">以下の内容で街人登録を申請します。よろしいですか？</p>

      <ul className="flex flex-col gap-1 rounded bg-neutral-50 p-3 text-sm">
        {confirmationLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <p className="text-xs text-neutral-600">{paymentNotice}</p>

      {errorMessage === undefined ? null : <p className="text-xs text-red-700">{errorMessage}</p>}

      <form action={submit} className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
        >
          戻る
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </form>
    </div>
  );
}
