"use server";

import { recordMorningMeetingMinutes } from "@/lib/morning-meetings/record";
import { isStaff, readViewer } from "@/lib/auth/session";

export type MinutesFormState = { status: "idle" | "saved" | "error"; message?: string };

/** 保存できなかった理由の利用者向け文言。内部の識別子をそのまま見せない。 */
const MESSAGE: Record<string, string> = {
  invalid_held_on: "実施日を選んでください。",
  blank_transcript: "文字起こしテキストを貼り付けてください。",
  denied: "この操作を行う権限がありません。",
  failed: "保存に失敗しました。時間をおいて再試行してください。",
};

/**
 * 朝会の文字起こしテキストを投入する Server Action（v13 §9 #63）。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * Server Action は URL を持つエンドポイントとして公開されるため、
 * 「投入画面を出さない」だけでは防御にならない。判定をここにも置くのはそのため。
 * 判定の根拠は `members.role` のみで、`member_type`（立場）は見ない（CLAUDE.md §4.1）。
 */
export async function saveMorningMeetingMinutesAction(
  _prev: MinutesFormState,
  formData: FormData,
): Promise<MinutesFormState> {
  const viewer = await readViewer();

  // ★ ここがサーバサイド認可。DOM の非表示とは独立して効く。
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return { status: "error", message: MESSAGE.denied };
  }

  const result = await recordMorningMeetingMinutes({
    heldOn: String(formData.get("heldOn") ?? ""),
    transcriptText: String(formData.get("transcriptText") ?? ""),
    createdByMemberId: viewer.memberId,
  });

  if (result.ok) {
    return { status: "saved", message: "議事録として保存しました。" };
  }
  return { status: "error", message: MESSAGE[result.reason] ?? MESSAGE.failed };
}
