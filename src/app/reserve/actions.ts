"use server";

import type { SubmitState } from "@/lib/forms/submit-state";
import { sendReservationOtpMail } from "@/lib/mail/resend";
import { issueReservationOtp, OTP_EXPIRY_MINUTES } from "@/lib/reservations/otp";
import { createPublicReservation } from "@/lib/reservations/public-reservation";

/**
 * 確認コードを送る（v13 §5.2.3 TO-BE②）。
 *
 * ⚠️ **結果でアドレスの存在を漏らさない。** 送信できてもできなくても同じ文面を返す。
 * `src/app/login/actions.ts` の `requestLoginCode` が同じ理由で文面を統一している。
 * 例外は「送信基盤が未設定」で、これは利用者の問題ではなく運営の問題なので区別して伝える
 * （黙って「送った」と言うと、届かないコードを待ち続けさせることになる）。
 */
export async function requestReservationCodeAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const email = String(formData.get("email") ?? "").trim();
  if (email === "") {
    return { status: "error", message: "メールアドレスを入力してください。" };
  }

  const issued = await issueReservationOtp(email);
  if (!issued.ok) {
    if (issued.reason === "too_frequent") {
      return { status: "error", message: "少し時間をおいてから再送してください。" };
    }
    return { status: "error", message: "確認コードを送れませんでした。" };
  }

  const sent = await sendReservationOtpMail({
    to: email,
    code: issued.code,
    expiryMinutes: OTP_EXPIRY_MINUTES,
  });

  if (!sent.ok && sent.reason === "not_configured") {
    return {
      status: "error",
      message: "ただいまメールを送信できません。お手数ですが運営へお問い合わせください。",
    };
  }

  return {
    status: "done",
    message: `確認コードを送信しました（${OTP_EXPIRY_MINUTES}分間有効）。`,
  };
}

/** 失敗理由の利用者向け文言。内部の識別子をそのまま見せない。 */
const MESSAGE: Record<string, string> = {
  invalid_code: "確認コードが正しくないか、有効期限が切れています。",
  not_consented: "「浮遊街に宿泊される方へ」への同意が必要です。",
  invalid_input: "入力内容をご確認ください（日程・人数・お名前）。",
  failed: "予約できませんでした。時間をおいて再試行してください。",
};

/**
 * 予約を確定する（画面ID `/reserve` ／ WBS 3-5b）。
 *
 * ★ **料金を受け取らない。** 画面に出している料金は表示のためだけで、
 * 請求は `accommodation_rates` からサーバ側が引く（`rates.ts`）。
 * 受け取ると、フォームの値を書き換えるだけで安い料金の予約を作れてしまう。
 *
 * ★ **会員判定を自己申告で行わない**（v13 §5.2.3 の warning）。
 * 「街人ですか？」は参考フラグ（`self_declared_machibito`）としてのみ保存し、
 * 料金・権限には一切影響させない。このページは未ログインなので常に非会員扱いである。
 */
export async function createPublicReservationAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const result = await createPublicReservation({
    email: String(formData.get("email") ?? ""),
    code: String(formData.get("code") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    roomType: String(formData.get("roomType") ?? ""),
    checkInDate: String(formData.get("checkInDate") ?? ""),
    checkOutDate: String(formData.get("checkOutDate") ?? ""),
    arrivalTime: String(formData.get("arrivalTime") ?? ""),
    adultsCount: Number.parseInt(String(formData.get("adultsCount") ?? "0"), 10) || 0,
    childrenCount: Number.parseInt(String(formData.get("childrenCount") ?? "0"), 10) || 0,
    transportMethod: String(formData.get("transportMethod") ?? ""),
    selfDeclaredMachibito: String(formData.get("selfDeclaredMachibito") ?? "") === "yes",
    note: String(formData.get("note") ?? ""),
    consented: String(formData.get("consented") ?? "") === "on",
  });

  if (result.ok) {
    return {
      status: "done",
      message: result.autoConfirmed
        ? "ご予約を確定しました。確認のご連絡をお待ちください。"
        : "ご予約を受け付けました。ご記入の内容を確認のうえ、運営からご連絡します。",
    };
  }
  return { status: "error", message: MESSAGE[result.reason] ?? MESSAGE.failed };
}
