/**
 * 完了報告の入力判定（WBS 5-3 ／ v13 §5.3-4）。DB へ触らない純関数だけを置く。
 *
 * ## 写真の必須は「アプリ層で担保する」と決まっている
 *
 * `0017` の `work_logs` は `before_photo_media_id` / `after_photo_media_id` を
 * **NOT NULL にしていない**。理由もコメントに残っている——縛ると、メディア基盤（`1-4`）が
 * 完成するまで完了報告そのものが出せなくなるためである。
 * そのメディア基盤は 2026-09-22 に通った（署名付きURL ＋ アップロード画面）ので、
 * **必須の判定はここが持つ**。DDL を後から NOT NULL へ締めると、既に入っている
 * 写真なしの報告（移行期のもの）が更新できなくなるため、DB 側は緩いままにする。
 *
 * ## 作業時間は「自己申告」である
 *
 * `work_hours` は受注者が入力する値であり、システムが計測したものではない。
 * 報酬は `quests.reward_uii`（運営が決めた額）から決まるため、ここが多少ずれても
 * 金額には効かない。したがって**上限で弾かず、常識外れの値だけを止める**。
 */

export type WorkLogRejection =
  | "not_applicant"
  | "not_instructed"
  | "missing_before_photo"
  | "missing_after_photo"
  | "invalid_work_hours"
  | "blank_issue_note";

export type WorkLogDecision = { allowed: true } | { allowed: false; reason: WorkLogRejection };

/** 1件の報告で受け付ける作業時間の上限（時間）。1日の労働として現実的な範囲に収める。 */
export const MAX_WORK_HOURS = 24;

/**
 * 完了報告を受け付けてよいか。
 *
 * `指示済み` または `承認`（実行してよいと運営が認めた状態）からのみ出せる。
 * 申請中のまま報告できると、**運営が指示を出す前に作業が終わっている**という、
 * 実行指示（v13 §5.3-3）の意味が無い状態が普通に起きる。
 */
export function decideWorkLogSubmission(params: {
  applicationStatus: string;
  beforePhotoMediaId: string | null;
  afterPhotoMediaId: string | null;
  workHours: number | null;
  issueFlag: boolean;
  issueNote: string;
}): WorkLogDecision {
  if (params.applicationStatus !== "指示済み" && params.applicationStatus !== "承認") {
    return { allowed: false, reason: "not_instructed" };
  }
  if (params.beforePhotoMediaId === null) {
    return { allowed: false, reason: "missing_before_photo" };
  }
  if (params.afterPhotoMediaId === null) {
    return { allowed: false, reason: "missing_after_photo" };
  }
  if (
    params.workHours !== null &&
    (!Number.isFinite(params.workHours) ||
      params.workHours <= 0 ||
      params.workHours > MAX_WORK_HOURS)
  ) {
    return { allowed: false, reason: "invalid_work_hours" };
  }
  if (params.issueFlag && params.issueNote.trim() === "") {
    // 「問題あり」にチェックだけ入れて中身が無いと、運営は何を見ればよいか分からない
    return { allowed: false, reason: "blank_issue_note" };
  }
  return { allowed: true };
}

/** 入力された作業時間（文字列）を数値へ。空欄は「未入力」＝ `null`。 */
export function parseWorkHours(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_WORK_HOURS) {
    return "invalid";
  }
  // 小数第2位まで（`quests.base_hours` と同じ粒度。1.5時間・0.25時間を表せる）
  return Math.round(value * 100) / 100;
}
