// 受注申請のサーバ側ゲート（WBS 5-1 ／ Issue #53 ／ 2026-09-19 オーナー決定 B）の受入テスト。
//
// 根拠: v13 §5.10.6 L1794「サーバ側でも `guest_allowed = false` のクエストに対する
//       ゲストの受注申請APIを拒否する（表示制御のみに依存しない）」、
//       v13 §5.9.3 L1620-1624「DOM非表示は認可ではない」「画面ガードと API 認可は
//       同一のロール定義を参照し、二重管理しない」、v13 §2 L171-172、CLAUDE.md §4.4。
//
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。実装コードは読んでいない。
//    `@/lib/quests/application-gate` の `canApplyToQuest(viewer, quest)` を
//    「画面操作を経由しない経路」も含めた**唯一の判定点**として想定する。

import { buildQuestBoard } from "@/lib/quests/board";
import { canApplyToQuest } from "@/lib/quests/application-gate";

import {
  ALL_QUESTS,
  GUEST_TYPED_MEMBER_VIEWER,
  GUEST_VIEWER,
  MANUAL_OPEN_QUEST,
  MEMBER_VIEWER,
  MORNING_MEETING_LOCKED_QUEST,
  OYAKATA_BUT_GUEST_VIEWER,
} from "./fixtures/quest-board";

describe("完了条件5: ゲストの受注申請をサーバ側で拒否する（v13 §5.10.6 L1794）", () => {
  test("ゲストは `guest_allowed=false` のクエストへ受注申請できない", () => {
    expect(canApplyToQuest(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST)).toBe(false);
  });

  test("ゲストは `guest_allowed=true` のクエストへ受注申請できる", () => {
    expect(canApplyToQuest(GUEST_VIEWER, MANUAL_OPEN_QUEST)).toBe(true);
  });

  test("街人は `guest_allowed=false` のクエストへ受注申請できる", () => {
    expect(canApplyToQuest(MEMBER_VIEWER, MORNING_MEETING_LOCKED_QUEST)).toBe(true);
  });

  test("★ 画面の申請ボタンの活性と、サーバ側の受注可否が全件一致する（§5.9.3 二重管理しない）", () => {
    // ここが割れると「ボタンは押せないが API は通る」状態になり、
    // 画面を経由しない経路（curl・JS 改変）で施錠クエストを受注できてしまう。
    //
    // 資格ゲート（`required_certification`）は**サーバ側が 5-2 の範囲**のため対象から外す。
    // 5-1 では表示のみを固定しており、ここで一致を求めると範囲外の実装を強制してしまう。
    const gateableQuests = ALL_QUESTS.filter((quest) => quest.requiredCertification.length === 0);

    const mismatches: string[] = [];
    for (const viewer of [GUEST_VIEWER, MEMBER_VIEWER]) {
      for (const item of buildQuestBoard(gateableQuests, viewer).items) {
        const quest = gateableQuests.find((candidate) => candidate.questId === item.questId)!;
        if (item.canApply !== canApplyToQuest(viewer, quest)) {
          mismatches.push(`${viewer.role} × ${quest.title}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("完了条件6: 受注可否の判定を `role` で行う（v13 §2 L171-172 ／ CLAUDE.md §4.1）", () => {
  test("`member_type` が親方でも `role` が guest なら受注申請できない", () => {
    // 「立場が上だから受注もできるはず」を認可に混ぜない（v13 §2 L172）。
    expect(canApplyToQuest(OYAKATA_BUT_GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST)).toBe(false);
  });

  test("`member_type` がゲストでも `role` が member なら受注申請できる", () => {
    expect(canApplyToQuest(GUEST_TYPED_MEMBER_VIEWER, MORNING_MEETING_LOCKED_QUEST)).toBe(true);
  });
});
