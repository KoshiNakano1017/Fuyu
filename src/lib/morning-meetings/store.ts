/**
 * 朝会議事録の読み書き（WBS 4-2・4-3 の DB 往復だけを担当する）。
 *
 * 判定・整形は `structure.ts` ／ `quest-candidates.ts`（いずれも純関数）が持つ。
 * ここに業務判断を書かないのは、`src/lib/quests/applications.ts` と同じ分担である。
 *
 * ★ anon キー ＋ RLS で読み書きする。行を絞るのは `0011` の `mm_select_staff` ／
 *   `mm_insert_staff` と `0020` の `mm_update_staff` であり、**書ける列は
 *   `0020` の列単位 GRANT（`summary_text` / `extracted_quest_candidates` / `updated_at`）に
 *   限られている**。`transcript_text` は GRANT が無いので、ここから書き換えようとしても
 *   DB が 42501 で拒否する（文字起こし全文は「貼り付けられた事実の記録」であるため）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import { parseStoredCandidates, type StoredQuestCandidate } from "./quest-candidates";
import type { QuestInsertRow } from "./quest-candidates";

/** 一覧に並べる議事録。**全文は含めない**（PII-A を必要のない画面へ運ばないため）。 */
export type MeetingSummary = {
  meetingId: string;
  heldOn: string;
  summaryText: string | null;
  candidates: StoredQuestCandidate[];
  createdAt: string;
};

/**
 * 候補の操作（公開・却下）のために1件だけ読む。**全文は読まない。**
 *
 * `fetchMeetingWithTranscript()` で代用しないのは、候補の状態を1つ変えるだけの操作に
 * 朝会の全文（PII-A）をサーバのメモリへ載せる理由が無いためである。
 */
export async function fetchMeetingSummary(meetingId: string): Promise<MeetingSummary | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("morning_meetings")
    .select("meeting_id, held_on, summary_text, extracted_quest_candidates, created_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return toMeetingSummary(data);
}

/** 構造化の対象。こちらは全文を持つ（モデルへ渡すため）。 */
export type MeetingWithTranscript = MeetingSummary & { transcriptText: string };

/**
 * 直近の議事録を新しい順に読む。
 *
 * 全文（`transcript_text`）を選ばないのは、一覧が1画面に数十件を運ぶためである。
 * 朝会の全文には参加者の実名が含まれうる（`0011` の PII-A）ので、
 * **表示に使わない画面へは載せない**（CLAUDE.md §3.2 の「必要な分だけ」）。
 */
export async function fetchRecentMeetings(limit = 20): Promise<MeetingSummary[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("morning_meetings")
    .select("meeting_id, held_on, summary_text, extracted_quest_candidates, created_at")
    .order("held_on", { ascending: false })
    .limit(limit);

  if (error || data === null) {
    return [];
  }
  return data.map(toMeetingSummary);
}

/** 構造化・起案の対象1件を、全文つきで読む。 */
export async function fetchMeetingWithTranscript(
  meetingId: string,
): Promise<MeetingWithTranscript | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("morning_meetings")
    .select(
      "meeting_id, held_on, summary_text, extracted_quest_candidates, created_at, transcript_text",
    )
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return { ...toMeetingSummary(data), transcriptText: String(data.transcript_text ?? "") };
}

/**
 * 構造化の結果（議事録サマリー ＋ クエスト候補）を書き戻す。
 *
 * 2列を**1回の UPDATE で**書く。別々に書くと、片方だけ成功した議事録
 * （サマリーはあるのに候補が空）が生まれ、運営が「AI が候補を出さなかったのか、
 * 保存に失敗したのか」を区別できなくなる。
 */
export async function saveStructuring(params: {
  meetingId: string;
  summaryText: string;
  candidates: readonly StoredQuestCandidate[];
}): Promise<boolean> {
  return updateMeeting(params.meetingId, {
    summary_text: params.summaryText,
    extracted_quest_candidates: params.candidates,
  });
}

/** 候補の状態（公開済み・却下）だけを書き戻す。 */
export async function saveCandidates(params: {
  meetingId: string;
  candidates: readonly StoredQuestCandidate[];
}): Promise<boolean> {
  return updateMeeting(params.meetingId, { extracted_quest_candidates: params.candidates });
}

async function updateMeeting(meetingId: string, patch: Record<string, unknown>): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("morning_meetings")
    // `updated_at` は列単位 GRANT に含まれている唯一の「時刻」であり、
    // DB 側にトリガーが無いのでここで明示的に進める。
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("meeting_id", meetingId);

  return error === null;
}

/**
 * 候補を `quests` へ1行として起こす（WBS 4-3 のワンタップ起案）。
 *
 * 行の中身は `toQuestInsertRow()` が決める。ここでは書き込みだけを行い、
 * **`guest_allowed` や `reward_uii` をここで足さない**（v13 §5.10.6 ／
 * 報酬額を AI にも DB 往復にも決めさせないため、判断は純関数側に一本化する）。
 */
export async function insertQuestFromCandidate(row: QuestInsertRow): Promise<string | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("quests")
    .insert(row)
    .select("quest_id")
    .maybeSingle();

  if (error || data === null) {
    return null;
  }
  return String(data.quest_id);
}

function toMeetingSummary(row: Record<string, unknown>): MeetingSummary {
  return {
    meetingId: String(row.meeting_id),
    heldOn: String(row.held_on),
    summaryText: row.summary_text === null ? null : String(row.summary_text),
    candidates: parseStoredCandidates(row.extracted_quest_candidates),
    createdAt: String(row.created_at),
  };
}
