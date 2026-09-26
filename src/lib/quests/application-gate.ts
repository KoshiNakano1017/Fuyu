// 受注申請の可否を決める唯一の判定点。WBS 5-1（2026-09-19 オーナー決定 B）。
//
// 根拠: v13 §5.10.6 L1794「サーバ側でも `guest_allowed = false` のクエストに対する
//       ゲストの受注申請APIを拒否する（表示制御のみに依存しない）」、
//       v13 §5.9.3「DOM 非表示は認可ではない」「画面ガードと API 認可は同一のロール定義を参照する」。
//
// ⚠️ この関数は**画面を経由しない経路（curl・JS 改変）でも通る**ことを前提に書く。
//    `board.ts` の申請ボタン活性もここを根拠にするため、両者が割れることがない。

import {
  isLockedForViewer,
  isRecruitmentFull,
  lacksRequiredCertification,
  type Quest,
  type QuestBoardViewer,
} from "./visibility";

/**
 * その閲覧者がそのクエストへ受注申請してよいか。
 *
 * ## 資格要件の安全ゲート（WBS 5-2 で追加・2026-09-20）
 *
 * v13 §5.3-2 が「ユンボ・重機、チェーンソー（間伐）、食品衛生等の業務は、会員マスタの
 * `certifications` と照合し、**未保有者は受注申請できない**バリデーションを設ける」と定めている。
 * 5-1 の時点では「5-2 でこの関数へ条件を1つ加える形で行う（判定点を増やさない）」と
 * 書き残されており、そのとおりに条件を1つ足した。
 *
 * **判定点を増やさないことが重要である。** 画面の申請ボタンの活性（`board.ts`）と
 * API の拒否（`/api/quests/{id}/applications`）が同じ関数を根拠にしているため、
 * 別の場所に資格判定を書くと、片方だけ緩い状態が生まれる（v13 §5.9.3）。
 *
 * ## 施錠とは独立に判定する
 *
 * `guest_allowed`（ゲスト開放）と `required_certification`（資格）は**別の軸**である
 * （v13 §5.10.6 冒頭）。街人登録しても資格は解放されないため、
 * 「登録で解放される件数」の集計に資格ゲートを混ぜてはならない。
 */
export function canApplyToQuest(viewer: QuestBoardViewer, quest: Quest): boolean {
  // 募集を終えたクエストへは誰も申請できない。認可以前の受付状態の話。
  if (quest.status !== "open") {
    return false;
  }
  if (isLockedForViewer(quest, viewer)) {
    return false;
  }
  // 募集人数の範囲でしか受注できない（v13 §5.3 note L844）。DB 側にも同じ上限がある
  // （0043 の `quest_applications_guard_capacity()`）が、一般会員のセッションは他人の
  // 申請行を読めないため、充足の有無は `v_quest_board.is_recruitment_full` 経由で受け取る
  // （件数そのものはビューも返さない／0043 ③）。
  if (isRecruitmentFull(quest)) {
    return false;
  }
  // 資格の要る作業を未保有者が受注すると、事故は取り返しがつかない（重機・チェーンソー）。
  return !lacksRequiredCertification(quest, viewer);
}
