"use server";

import { revalidatePath } from "next/cache";

import { createGeminiTextClient } from "@/lib/ai/gemini";
import { isStaff, readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import {
  markCandidate,
  parseCandidateCorrection,
  toQuestInsertRow,
  toStoredCandidates,
} from "@/lib/morning-meetings/quest-candidates";
import {
  fetchMeetingSummary,
  fetchMeetingWithTranscript,
  insertQuestFromCandidate,
  saveCandidates,
  saveStructuring,
} from "@/lib/morning-meetings/store";
import {
  formatKnowledgeCandidatesText,
  formatMinutesText,
  structureMorningMeeting,
} from "@/lib/morning-meetings/structure";

/**
 * 議事録の構造化（WBS 4-2）とクエスト候補の起案（WBS 4-3）の Server Action。
 *
 * 投入（4-1）の `actions.ts` と分けているのは、こちらが **Gemini を呼ぶ**＝
 * 失敗の仕方も待ち時間も別物だからである（CLAUDE.md §4.2「1関数1責務」と同じ理由をファイル単位で当てた）。
 *
 * ⚠️ **3つとも冒頭で staff 判定を行う。** Server Action は URL を持つ公開エンドポイントであり、
 * 画面にボタンを出さないことは防御にならない（v13 §5.9.3）。
 * 最後の防壁は `0011`／`0020` の RLS（`mm_*_staff`）と `0008` の `quests_write_staff` である。
 */

const MESSAGE: Record<string, string> = {
  denied: "この操作を行う権限がありません。",
  not_found: "対象の議事録が見つかりません。",
  blank_transcript: "本文が空のため構造化できません。",
  ai_failed: "AI による構造化に失敗しました。時間をおいて再試行してください。",
  save_failed: "保存に失敗しました。時間をおいて再試行してください。",
  quest_failed: "クエストの作成に失敗しました。時間をおいて再試行してください。",
  already_handled: "この候補は既に処理されています。",
  blank_title: "クエスト名を入力してください。",
  invalid_headcount: "募集人数は1以上の整数で入力してください。",
  invalid_minutes: "想定時間（分）は1以上の整数で入力してください。",
  invalid_reward: "報酬額は0以上の整数（Uii）で入力してください。",
};

function error(reason: string): SubmitState {
  return { status: "error", message: MESSAGE[reason] ?? MESSAGE.save_failed };
}

/**
 * 投入済みの議事録から、構造化議事録・クエスト候補・ナレッジ候補を**1回の呼び出しで**生成する。
 *
 * 生成結果は `summary_text` と `extracted_quest_candidates` へ保存する。
 * 保存するのは、画面を開き直すたびにモデルを呼び直さないためである
 * （`0020` のコメント：それでは非機能 P3〈テキスト投入から60秒以内〉の意味が無くなる）。
 *
 * ⚠️ **再実行は候補の状態を捨てる。** 既に公開・却下した候補も `pending` の新しい候補列へ
 * 置き換わる（同じ議事録から2回起案すると重複クエストが作れてしまう）ため、
 * 画面側は構造化済みの議事録に対して再実行の確認を求める。
 */
export async function structureMinutesAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return error("denied");
  }

  const meetingId = String(formData.get("meetingId") ?? "").trim();
  const meeting = await fetchMeetingWithTranscript(meetingId);
  if (meeting === null) {
    return error("not_found");
  }
  if (meeting.transcriptText.trim() === "") {
    return error("blank_transcript");
  }

  let structuring;
  try {
    structuring = await structureMorningMeeting({
      aiClient: createGeminiTextClient(),
      minutesBody: meeting.transcriptText,
    });
  } catch {
    // ⚠️ 例外の本文を画面へ出さない。プロンプト（＝朝会の全文）が混ざりうるため
    //    （`gemini.ts` はキーを伏せるが、本文までは伏せない）。
    return error("ai_failed");
  }

  const knowledgeText = formatKnowledgeCandidatesText(structuring.knowledgeCandidates);
  const minutesText = formatMinutesText({
    heldOn: meeting.heldOn,
    minutes: structuring.minutes,
  });

  const saved = await saveStructuring({
    meetingId,
    summaryText: knowledgeText === "" ? minutesText : `${minutesText}\n${knowledgeText}`,
    candidates: toStoredCandidates(structuring.questCandidates),
  });
  if (!saved) {
    return error("save_failed");
  }

  revalidatePath("/admin/morning-meetings");
  return {
    status: "done",
    message: `議事録を構造化しました（クエスト候補 ${structuring.questCandidates.length} 件）。`,
  };
}

/**
 * 候補を補正したうえでクエストボードへ公開する（WBS 4-3 のワンタップ起案）。
 *
 * ## 書き込みの順番
 *
 * `quests` への INSERT が先、候補の `published` 化が後である。逆にすると、
 * クエストの作成に失敗したときに「公開済みと記録されているのにボードに無い候補」が残る。
 * 順番がこの向きなら、最悪の失敗は「クエストはできたが候補が pending のまま」＝
 * 運営が気づいて対処できる形になる。
 */
export async function publishQuestCandidateAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return error("denied");
  }

  const meetingId = String(formData.get("meetingId") ?? "").trim();
  const candidateId = String(formData.get("candidateId") ?? "").trim();

  const parsed = parseCandidateCorrection({
    title: String(formData.get("title") ?? ""),
    headcount: String(formData.get("headcount") ?? ""),
    estimatedMinutes: String(formData.get("estimatedMinutes") ?? ""),
    rewardUii: String(formData.get("rewardUii") ?? ""),
  });
  if (!parsed.ok) {
    return error(parsed.reason);
  }

  const meeting = await fetchMeetingSummary(meetingId);
  if (meeting === null) {
    return error("not_found");
  }
  const candidate = meeting.candidates.find((item) => item.candidateId === candidateId);
  if (candidate === undefined) {
    return error("not_found");
  }
  if (candidate.status !== "pending") {
    // 二重起案の防止。同じ候補から2件のクエストが立つと、受注も報酬も二重になる。
    return error("already_handled");
  }

  const questId = await insertQuestFromCandidate(
    toQuestInsertRow({
      candidate,
      correction: parsed.correction,
      createdByMemberId: viewer.memberId,
    }),
  );
  if (questId === null) {
    return error("quest_failed");
  }

  const saved = await saveCandidates({
    meetingId,
    candidates: markCandidate(meeting.candidates, {
      candidateId,
      status: "published",
      publishedQuestId: questId,
    }),
  });
  if (!saved) {
    // クエストは既に立っている。これを隠すと運営は「失敗した」と読んでもう一度押す。
    return {
      status: "error",
      message: "クエストは作成しましたが、候補の状態を更新できませんでした。画面を再読み込みしてください。",
    };
  }

  revalidatePath("/admin/morning-meetings");
  revalidatePath("/quests");
  return { status: "done", message: "クエストボードへ公開しました。" };
}

/** 候補を却下する。クエストは作らず、候補だけを `dismissed` にする。 */
export async function dismissQuestCandidateAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return error("denied");
  }

  const meetingId = String(formData.get("meetingId") ?? "").trim();
  const candidateId = String(formData.get("candidateId") ?? "").trim();

  const meeting = await fetchMeetingSummary(meetingId);
  if (meeting === null) {
    return error("not_found");
  }
  const candidate = meeting.candidates.find((item) => item.candidateId === candidateId);
  if (candidate === undefined) {
    return error("not_found");
  }
  if (candidate.status !== "pending") {
    return error("already_handled");
  }

  const saved = await saveCandidates({
    meetingId,
    candidates: markCandidate(meeting.candidates, { candidateId, status: "dismissed" }),
  });
  if (!saved) {
    return error("save_failed");
  }

  revalidatePath("/admin/morning-meetings");
  return { status: "done", message: "候補を却下しました。" };
}
