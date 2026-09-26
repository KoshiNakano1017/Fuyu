// 受注申請の可否判定（WBS `5-2` 受注申請・運営審査・実行指示 ／ Issue #167）の受入テスト。
//
// 根拠:
//   v13 §5.3（項目2）L837「会員マスタの `certifications` と照合し、未保有者は受注申請できない
//     バリデーションを設ける（スキルLv要件とは独立）」
//   v13 §5.3 note L844「1クエスト＝運営が指定した**募集人数の範囲で**受注可」
//   v13 §5.10.6 L1883（表3行目）「資格ゲート。街人登録では解放されないため、登録導線は出さない」
//   v13 §5.10.6 L1887「サーバ側でも `guest_allowed = false` のクエストに対するゲストの
//     受注申請APIを拒否する（表示制御のみに依存しない）」
//   v13 §5.9.3 L1717「画面ガードとAPI認可は**同一のロール定義**を参照し、二重管理しない」
//   CLAUDE.md §4.4（認可は必ずテストを書く）
//
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。`src/` は読んでいない。
//    判定の入口は既存と同じ `canApplyToQuest(viewer, quest)` **1本のまま**とし、
//    募集人数の上限は引数を増やさずクエスト側の属性（`recruitCount` / `applicationCount`）で渡す。
//    ここで判定関数を増やすと v13 §5.9.3 の「二重管理しない」に反する。
//
// 🚫 フィクスチャは自作のみ。実在の会員データを参照していない（CLAUDE.md §3.2・§7.1）。

import { buildQuestBoard } from "@/lib/quests/board";
import { canApplyToQuest } from "@/lib/quests/application-gate";

import {
  ALL_QUESTS,
  CERTIFICATION_REQUIRED_QUEST,
  CERTIFIED_MEMBER_VIEWER,
  FULLY_RECRUITED_QUEST,
  GUEST_VIEWER,
  LOCKED_CLOSED_QUEST,
  MANUAL_OPEN_QUEST,
  MEMBER_VIEWER,
  MORNING_MEETING_LOCKED_QUEST,
  OVER_RECRUITED_QUEST,
  PARTIALLY_RECRUITED_QUEST,
} from "./fixtures/quest-board";

describe("完了条件1: ゲストは `guest_allowed=false` のクエストへ受注申請できない（v13 §5.10.6 L1887）", () => {
  test("ゲストは `guest_allowed=false` のクエストへ受注申請できない", () => {
    expect(canApplyToQuest(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST)).toBe(false);
  });

  test("ゲストでも `guest_allowed=true` のクエストへは受注申請できる（拒否の範囲を広げていない）", () => {
    expect(canApplyToQuest(GUEST_VIEWER, MANUAL_OPEN_QUEST)).toBe(true);
  });
});

describe("完了条件2: 資格未保有者は受注申請できない（v13 §5.3 項目2 L837）", () => {
  test("`required_certification` を保有しない街人は受注申請できない", () => {
    // ここが緩むと未資格者がチェーンソー・重機の作業を受注できる（v13 §5.10.6 L1877 の事故）。
    expect(canApplyToQuest(MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST)).toBe(false);
  });

  test("資格を保有する街人は受注申請できる", () => {
    expect(canApplyToQuest(CERTIFIED_MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST)).toBe(true);
  });
});

describe("完了条件3: 資格ゲートは `guest_allowed` から独立している（v13 §5.10.6 L1883）", () => {
  // `CERTIFICATION_REQUIRED_QUEST` は `guest_allowed = true`。つまり施錠されていない。
  // それでも資格が無ければ通らないことを、`role` の両側で対にして固定する。
  test("ゲストは資格未保有のクエストへ受注申請できない", () => {
    expect(canApplyToQuest(GUEST_VIEWER, CERTIFICATION_REQUIRED_QUEST)).toBe(false);
  });

  test("`role` が guest から member に変わっても、資格未保有なら受注申請できないままである", () => {
    // 街人登録（§5.10）で解放されるのは施錠だけであり、資格ゲートは解放されない。
    expect(canApplyToQuest(MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST)).toBe(false);
  });
});

describe("完了条件4: `status` が open でないクエストへは受注申請できない（v13 §5.10.6 ／ chk_quests_status）", () => {
  test("`status` が closed のクエストへは受注申請できない", () => {
    // 閲覧者は街人。`guest_allowed = false` では落ちない相手を選び、**status だけで落ちる**ことを見る。
    expect(canApplyToQuest(MEMBER_VIEWER, LOCKED_CLOSED_QUEST)).toBe(false);
  });
});

describe("完了条件8: 募集人数に達したクエストへは受注申請できない（v13 §5.3 note L844）", () => {
  test("募集人数に達していないクエストへは受注申請できる（境界値: 上限の直前）", () => {
    expect(canApplyToQuest(MEMBER_VIEWER, PARTIALLY_RECRUITED_QUEST)).toBe(true);
  });

  test("募集人数に達したクエストへは受注申請できない（境界値: 上限ちょうど）", () => {
    expect(canApplyToQuest(MEMBER_VIEWER, FULLY_RECRUITED_QUEST)).toBe(false);
  });

  test("募集人数を超えているクエストへは受注申請できない（境界値: 上限の超過）", () => {
    // `=== recruitCount` で書くとここだけ通る。既に溢れている枠をさらに開いてはいけない。
    expect(canApplyToQuest(MEMBER_VIEWER, OVER_RECRUITED_QUEST)).toBe(false);
  });

  test("募集が埋まっていても、まだ0件のクエストは受注申請できる（境界値: 0件）", () => {
    expect(canApplyToQuest(MEMBER_VIEWER, MANUAL_OPEN_QUEST)).toBe(true);
  });
});

describe("完了条件5: 画面・API・Server Action が同一の判定関数と一致する（v13 §5.9.3 L1717）", () => {
  test("★ 画面の申請ボタンの活性が、全クエスト × 全閲覧者でサーバ側の判定と一致する", () => {
    // 割れると「ボタンは押せないが API は通る」／「ボタンは押せるが API が落ちる」状態になる。
    // 5-1 の同種テストは資格ゲートを対象外にしていたが、5-2 ではサーバ側も範囲に入るため
    // 資格クエストと募集充足クエストも含めて全件を突き合わせる。
    const mismatches: string[] = [];
    for (const viewer of [GUEST_VIEWER, MEMBER_VIEWER, CERTIFIED_MEMBER_VIEWER]) {
      for (const item of buildQuestBoard(ALL_QUESTS, viewer).items) {
        const quest = ALL_QUESTS.find((candidate) => candidate.questId === item.questId)!;
        if (item.canApply !== canApplyToQuest(viewer, quest)) {
          mismatches.push(`${viewer.role} × ${quest.title}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
