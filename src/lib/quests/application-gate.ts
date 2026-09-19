// 受注申請の可否を決める唯一の判定点。WBS 5-1（2026-09-19 オーナー決定 B）。
//
// 根拠: v13 §5.10.6 L1794「サーバ側でも `guest_allowed = false` のクエストに対する
//       ゲストの受注申請APIを拒否する（表示制御のみに依存しない）」、
//       v13 §5.9.3「DOM 非表示は認可ではない」「画面ガードと API 認可は同一のロール定義を参照する」。
//
// ⚠️ この関数は**画面を経由しない経路（curl・JS 改変）でも通る**ことを前提に書く。
//    `board.ts` の申請ボタン活性もここを根拠にするため、両者が割れることがない。

import { isLockedForViewer, type Quest, type QuestBoardViewer } from "./visibility";

/**
 * その閲覧者がそのクエストへ受注申請してよいか。
 *
 * ## 資格要件をここで見ない理由
 *
 * `required_certification` のサーバ側拒否は WBS 5-2 の範囲である（本 Issue のスコープ外）。
 * 5-1 は表示のみを固定しており、ここで拒否すると承認されていない範囲の認可を先に入れてしまう。
 * **資格ゲートを足すのは 5-2 で、この関数へ条件を1つ加える形で行う**（判定点を増やさない）。
 */
export function canApplyToQuest(viewer: QuestBoardViewer, quest: Quest): boolean {
  // 募集を終えたクエストへは誰も申請できない。認可以前の受付状態の話。
  if (quest.status !== "open") {
    return false;
  }
  return !isLockedForViewer(quest, viewer);
}
