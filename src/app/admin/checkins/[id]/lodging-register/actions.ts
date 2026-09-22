"use server";

import { isStaff, readViewer } from "@/lib/auth/session";
import { submitLodgingRegisterEntry } from "@/lib/lodging/register";

export type LodgingRegisterFormState = {
  status: "idle" | "saved" | "error";
  message?: string;
};

const ERROR_MESSAGE: Record<string, string> = {
  full_name_not_confirmed: "氏名（・カナ）を本人へ提示し確認したことにチェックしてください。",
  full_name_blank: "氏名を入力してください。",
  address_blank: "住所を入力してください。",
  previous_location_blank: "前泊地を入力してください。",
  checkin_not_found: "指定されたチェックインが見つかりません。",
  denied: "この操作を行う権限がありません。",
  failed: "登録に失敗しました。時間をおいて再試行してください。",
};

/**
 * 宿泊者名簿の確定 Server Action（v13 §5.2.7）。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * `checkinId` は hidden input 経由で受け取る（`page.tsx` が Server Component で
 * 検証済みの値を埋め込むため、利用者側で書き換えても RLS と本関数の検証が最終防波堤になる）。
 */
export async function submitLodgingRegisterAction(
  _prev: LodgingRegisterFormState,
  formData: FormData,
): Promise<LodgingRegisterFormState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return { status: "error", message: "この操作を行う権限がありません。" };
  }

  const checkinId = String(formData.get("checkinId") ?? "").trim();
  if (checkinId === "") {
    return { status: "error", message: "チェックインが指定されていません。" };
  }

  const result = await submitLodgingRegisterEntry({
    checkinId,
    recordedByMemberId: viewer.memberId,
    fullNameConfirmed: formData.get("fullNameConfirmed") === "on",
    fullNameSnapshot: String(formData.get("fullNameSnapshot") ?? ""),
    fullNameKanaSnapshot: String(formData.get("fullNameKanaSnapshot") ?? "") || null,
    address: String(formData.get("address") ?? ""),
    previousLocation: String(formData.get("previousLocation") ?? ""),
    nextDestination: String(formData.get("nextDestination") ?? "") || null,
  });

  if (result.ok) {
    return {
      status: "saved",
      message: result.created ? "宿泊者名簿を登録しました。" : "宿泊者名簿を更新しました。",
    };
  }

  return { status: "error", message: ERROR_MESSAGE[result.reason] ?? ERROR_MESSAGE.failed };
}
