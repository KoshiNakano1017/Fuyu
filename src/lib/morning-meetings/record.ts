import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * 保存に失敗した理由。利用者向けの文言は呼び出し元（Server Action）が決める。
 * ここは「何が起きたか」だけを返し、表示の都合を持ち込まない。
 */
export type RecordMinutesResult =
  | { ok: true; meetingId: string }
  | { ok: false; reason: "blank_transcript" | "invalid_held_on" | "denied" | "failed" };

/** 実施日の受け入れ形式（`<input type="date">` が送ってくる形）。 */
const HELD_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 貼り付けられた朝会の文字起こしテキストを、その場で議事録として保存する（v13 §9 #63）。
 *
 * ## 呼び出し側の責務
 *
 * **この関数は認可をしない。** 呼び出し元（Server Action）が `readViewer()` ＋ `isStaff()` で
 * 判定してから呼ぶこと（`src/lib/auth/invitations.ts` と同じ分担）。
 * ただしここで使うのは RLS が効く通常のサーバクライアントであり、
 * 仮に判定漏れがあっても DB 側のポリシー（`mm_insert_staff`）が最後に拒否する
 * ＝ 二重防御になっている（v13 §5.9.3）。
 *
 * ## 本文を加工しない理由
 *
 * §9 #63 は「貼り付け時点で議事録として格納する」と定めている。
 * 整形・要約は WBS 4-2 の責務であり、ここで手を入れると
 * **原文がどこにも残らない**（後から構造化をやり直せない）。
 * 前後の空白の除去も行わず、検証（空白のみでないこと）にだけ `trim()` を使う。
 */
export async function recordMorningMeetingMinutes(params: {
  heldOn: string;
  transcriptText: string;
  createdByMemberId: string;
}): Promise<RecordMinutesResult> {
  const { heldOn, transcriptText, createdByMemberId } = params;

  if (!HELD_ON_PATTERN.test(heldOn)) {
    return { ok: false, reason: "invalid_held_on" };
  }
  if (transcriptText.trim() === "") {
    return { ok: false, reason: "blank_transcript" };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("morning_meetings")
    .insert({
      held_on: heldOn,
      transcript_text: transcriptText,
      created_by: createdByMemberId,
    })
    .select("meeting_id")
    .maybeSingle();

  if (error) {
    // 42501 = insufficient_privilege。RLS に拒否された場合で、
    // 呼び出し元の判定をすり抜けた操作がここで止まったことを意味する。
    return { ok: false, reason: error.code === "42501" ? "denied" : "failed" };
  }
  if (!data) {
    return { ok: false, reason: "failed" };
  }

  return { ok: true, meetingId: data.meeting_id as string };
}
