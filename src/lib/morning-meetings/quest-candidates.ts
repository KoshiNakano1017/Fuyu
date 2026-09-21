/**
 * クエスト候補のプレビュー・補正・ワンタップ起案（WBS 4-3）。
 *
 * 根拠: v13 §5.1 ③（クエスト作成提案としてプレビュー表示）、
 *       v13 §5.3-1（手動登録と朝会自動抽出を**統合表示**する）、
 *       v13 §7（起案元区分＝朝会自動抽出／手動起案）、
 *       v13 §5.10.6（**ゲスト開放は運営が明示制御する唯一の根拠**であり導出してはならない）。
 */

import type { QuestCandidate } from "./structure";

/** 候補の処理状態。承認されるまで `quests` には1行も作らない。 */
export type QuestCandidateStatus = "pending" | "published" | "dismissed";

/** 保存される候補（`morning_meetings.extracted_quest_candidates` の要素）。 */
export type StoredQuestCandidate = QuestCandidate & {
  /** 候補の識別子。同じ議事録内で一意であればよい */
  candidateId: string;
  status: QuestCandidateStatus;
  /** 公開した場合に、できたクエストへ辿れるようにする */
  publishedQuestId?: string;
};

/** 運営が補正できる項目（v13 §5.1 ③「抽出候補の補正・承認」）。 */
export type QuestCandidateCorrection = {
  title?: string;
  headcount?: number;
  estimatedMinutes?: number;
  rewardUii?: number;
};

/** `quests` へ INSERT する行の形。列名は DB に合わせる（snake_case）。 */
export type QuestInsertRow = {
  title: string;
  description: string | null;
  recruit_count: number;
  base_hours: number;
  reward_uii: number | null;
  origin_type: "morning_meeting_auto";
  guest_allowed: boolean;
  status: "open";
  created_by: string;
};

/** 抽出直後の候補に、保存と画面操作のための状態を付ける。 */
export function toStoredCandidates(candidates: readonly QuestCandidate[]): StoredQuestCandidate[] {
  return candidates.map((candidate, index) => ({
    ...candidate,
    // 議事録ごとの通し番号で足りる。UUID を振ると、まだ実体の無いものに
    // クエストと同じ重みの識別子を与えることになり、取り違えのもとになる。
    candidateId: `c${index + 1}`,
    status: "pending",
  }));
}

/** 補正を当てる。未指定の項目は元の値を残す（部分更新）。 */
export function applyCorrection(
  candidate: StoredQuestCandidate,
  correction: QuestCandidateCorrection,
): StoredQuestCandidate {
  return {
    ...candidate,
    title: correction.title ?? candidate.title,
    headcount: correction.headcount ?? candidate.headcount,
    estimatedMinutes: correction.estimatedMinutes ?? candidate.estimatedMinutes,
  };
}

/** まだ運営が処理していない候補だけを返す（画面の件数バッジに使う）。 */
export function pendingCandidates(
  candidates: readonly StoredQuestCandidate[],
): StoredQuestCandidate[] {
  return candidates.filter((candidate) => candidate.status === "pending");
}

/**
 * 候補を `quests` の1行へ写す。
 *
 * ## `guest_allowed` を候補から導出しない
 *
 * v13 §5.10.6 冒頭が「ゲスト開放は `guest_allowed` のみで制御し、カテゴリや
 * `execution_mode` から導出してはならない」と定めている。AI が抽出した内容から
 * 「これはゲストでもできそう」と推定して開放すると、**資格の要る作業を
 * ゲストへ開放する事故**になる。したがって既定は `false` 固定とし、
 * 開放は運営がクエスト編集画面で明示的に行う。
 *
 * ## `reward_uii` を AI に決めさせない
 *
 * 報酬額は金額である。運営が補正フォームで入力した値だけを採り、
 * 未入力なら `null`（未設定）のままボードへ出す。
 * AI の推定額をそのまま入れると、誰も確認していない金額で受注申請が始まる。
 *
 * ## `base_hours` の単位変換
 *
 * 候補は**分**、`quests.base_hours` は**時間**（numeric）である。
 * 小数第2位で丸めるのは、`90分 → 1.5` のような値を素直に表し、
 * かつ `100分 → 1.6666…` が無限小数として保存されるのを避けるため。
 */
export function toQuestInsertRow(params: {
  candidate: StoredQuestCandidate;
  correction?: QuestCandidateCorrection;
  createdByMemberId: string;
}): QuestInsertRow {
  const corrected = applyCorrection(params.candidate, params.correction ?? {});
  const rewardUii = params.correction?.rewardUii;

  return {
    title: corrected.title,
    description: buildDescription(corrected),
    recruit_count: Math.max(1, Math.round(corrected.headcount)),
    base_hours: Math.round((corrected.estimatedMinutes / 60) * 100) / 100,
    reward_uii: rewardUii ?? null,
    // ★ 起案元区分。手動起案と同じボードに並べたうえで出どころを示す（v13 §5.3-1・§7）。
    origin_type: "morning_meeting_auto",
    guest_allowed: false,
    status: "open",
    created_by: params.createdByMemberId,
  };
}

/**
 * 指示内容。**発言根拠を本文に残す**。
 *
 * 受注者が「なぜこの作業が要るのか」を辿れるようにするためで、
 * AI が作った説明文だけだと、朝会に出ていない人には背景が分からない。
 */
function buildDescription(candidate: StoredQuestCandidate): string | null {
  const lines: string[] = [];

  if (candidate.assigneeCandidates.length > 0) {
    lines.push(`担当候補: ${candidate.assigneeCandidates.join("・")}`);
  }
  if (candidate.sourceQuote.trim() !== "") {
    lines.push(`発言根拠:「${candidate.sourceQuote}」`);
  }
  lines.push("朝会の発言からAIが自動起案した候補を、運営が確認して公開したものである。");

  return lines.length === 0 ? null : lines.join("\n");
}

/** 公開・却下の結果を候補一覧へ反映する（元の配列は変更しない）。 */
export function markCandidate(
  candidates: readonly StoredQuestCandidate[],
  params: { candidateId: string; status: QuestCandidateStatus; publishedQuestId?: string },
): StoredQuestCandidate[] {
  return candidates.map((candidate) =>
    candidate.candidateId === params.candidateId
      ? { ...candidate, status: params.status, publishedQuestId: params.publishedQuestId }
      : candidate,
  );
}
