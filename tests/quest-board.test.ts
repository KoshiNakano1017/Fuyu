// クエストボード（WBS 5-1 ／ Issue #53）の受入テスト。
//
// 根拠: v13 §5.3（L754 統合表示）・§7（L2360 起案元区分）・§5.10.6（L1784-1800 ゲスト開放）、
//       v13 §2（L171-172 認可は `role` のみ）、CLAUDE.md §4.4。
//
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。実装コードは読んでいない。
//    `@/lib/quests/board` の `buildQuestBoard(quests, viewer)` を入口として想定する。
//
// 施錠表示は §5.9 の「権限外は DOM ごと非表示」とは**逆**の扱いである（§5.10.6 L1796-1799）。
// 見せずに隠すと登録動機が伝わらず、見せすぎると詳細が漏れる。両側をここで固定する。

import { buildQuestBoard } from "@/lib/quests/board";

import {
  ADMIN_VIEWER,
  ALL_QUESTS,
  CERTIFICATION_REQUIRED_QUEST,
  CERTIFIED_MEMBER_VIEWER,
  CORE_MEMBER_VIEWER,
  CORE_ONLY_LOCKED_QUEST,
  GUEST_TYPED_MEMBER_VIEWER,
  GUEST_VIEWER,
  LOCKED_OPEN_QUEST_COUNT,
  LOCKED_ZERO_REWARD_QUEST,
  MANUAL_OPEN_QUEST,
  MEMBER_VIEWER,
  MORNING_MEETING_LOCKED_QUEST,
  OYAKATA_BUT_GUEST_VIEWER,
} from "./fixtures/quest-board";

/** 閲覧者の型は実装側の定義に従う（画面ガードと API 認可で同じ定義を参照するため／v13 §5.9.3）。 */
type Viewer = Parameters<typeof buildQuestBoard>[1];

/** 指定クエストの表示行を取り出す。一覧に無ければ undefined。 */
function itemOf(viewer: Viewer, questId: string) {
  return buildQuestBoard(ALL_QUESTS, viewer).items.find((item) => item.questId === questId);
}

/**
 * 一覧に出ていることを前提に表示行を取り出す。
 * 出ていなければ落とす。`expect(undefined).not.toHaveProperty(...)` は素通りするため、
 * 「行ごと消えている」状態を「詳細を返していない」と取り違えないようにする。
 */
function shownItemOf(viewer: Viewer, questId: string) {
  const item = itemOf(viewer, questId);
  if (item === undefined) {
    throw new Error(`クエスト ${questId} が一覧に表示されていない`);
  }
  return item;
}

describe("完了条件1: 手動起案と朝会自動抽出が単一の一覧に並ぶ（v13 §5.3 L754 ／ §7 L2360）", () => {
  test("`manual` と `morning_meeting_auto` の両方が1つの items に含まれる", () => {
    const originTypes = buildQuestBoard(ALL_QUESTS, MEMBER_VIEWER).items.map(
      (item) => item.originType,
    );
    expect(originTypes).toEqual(expect.arrayContaining(["manual", "morning_meeting_auto"]));
  });
});

describe("完了条件2: ゲストには施錠して見せる（v13 §5.10.6 L1789）", () => {
  test("ゲストにも `guest_allowed=false` のクエストが一覧に表示される", () => {
    expect(itemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId)).toBeDefined();
  });

  test("ゲストの `guest_allowed=false` のカードに `🔒 街人登録で解放` が重なる", () => {
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).badge).toBe(
      "🔒 街人登録で解放",
    );
  });

  test("ゲストは `guest_allowed=false` のクエストの申請ボタンが非活性である", () => {
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).canApply).toBe(false);
  });

  test("ゲストは `guest_allowed=true` のクエストの申請ボタンが活性である", () => {
    expect(shownItemOf(GUEST_VIEWER, MANUAL_OPEN_QUEST.questId).canApply).toBe(true);
  });

  test("街人には `guest_allowed=false` のクエストが施錠されない", () => {
    expect(shownItemOf(MEMBER_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).isLocked).toBe(false);
  });

  test("施錠カードはタップで街人登録モーダルを起動する（v13 §5.10.6 L1792）", () => {
    expect(
      shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).opensRegistrationModal,
    ).toBe(true);
  });
});

describe("完了条件3: 施錠クエストの詳細をゲストへ返さない（v13 §5.10.6 L1800）", () => {
  test("ゲスト向けの施錠クエストに報酬額が含まれない", () => {
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId)).not.toHaveProperty(
      "rewardUii",
    );
  });

  test("ゲスト向けの施錠クエストに指示内容が含まれない", () => {
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId)).not.toHaveProperty(
      "description",
    );
  });

  test("ゲスト向けの施錠クエストに担当者情報が含まれない", () => {
    // 担当者情報は「誰がその作業に入っているか」であり、ゲストへ開くと会員の動静が漏れる。
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId)).not.toHaveProperty(
      "assigneeName",
    );
  });

  test("報酬額が 0 の施錠クエストでも報酬額はキーごと返らない（境界値）", () => {
    // `0` を「値が無い」と扱う実装だと、ここだけすり抜ける。
    expect(shownItemOf(GUEST_VIEWER, LOCKED_ZERO_REWARD_QUEST.questId)).not.toHaveProperty(
      "rewardUii",
    );
  });

  test("ゲスト向けの施錠クエストにもタイトルは含まれる（カード上はタイトル・カテゴリまで）", () => {
    expect(shownItemOf(GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).title).toBe(
      MORNING_MEETING_LOCKED_QUEST.title,
    );
  });

  test("街人には報酬額が返る（返さないのはゲストの施錠クエストだけ）", () => {
    expect(shownItemOf(MEMBER_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).rewardUii).toBe(
      MORNING_MEETING_LOCKED_QUEST.rewardUii,
    );
  });
});

describe("完了条件4: 解放件数の常設バナー（v13 §5.10.6 L1793）", () => {
  test("ゲストの一覧上部にバナーが表示される", () => {
    expect(buildQuestBoard(ALL_QUESTS, GUEST_VIEWER).banner).not.toBeNull();
  });

  test("N が `guest_allowed=false` かつ `status='open'` の件数と一致する", () => {
    // 受付を終えた施錠クエストを数えると「登録しても解放されない件数」を提示することになる。
    expect(buildQuestBoard(ALL_QUESTS, GUEST_VIEWER).banner?.lockedOpenCount).toBe(
      LOCKED_OPEN_QUEST_COUNT,
    );
  });

  test("バナーの文言が「あと N 件のクエストが街人登録で解放されます」である", () => {
    expect(buildQuestBoard(ALL_QUESTS, GUEST_VIEWER).banner?.text).toContain(
      `あと${LOCKED_OPEN_QUEST_COUNT}件のクエストが街人登録で解放されます`,
    );
  });
});

describe("完了条件6: 表示の判定も `role` で行う（v13 §2 L171-172 ／ CLAUDE.md §4.1）", () => {
  test("`member_type` が親方でも `role` が guest なら施錠される", () => {
    expect(
      shownItemOf(OYAKATA_BUT_GUEST_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).isLocked,
    ).toBe(true);
  });

  test("`member_type` がゲストでも `role` が member なら施錠されない", () => {
    expect(
      shownItemOf(GUEST_TYPED_MEMBER_VIEWER, MORNING_MEETING_LOCKED_QUEST.questId).isLocked,
    ).toBe(false);
  });
});

describe("完了条件7: 資格ゲートの表示（v13 §5.10.6 L1790）", () => {
  test("`required_certification` 未保有のクエストが `🚧 受注できません` として表示される", () => {
    expect(shownItemOf(MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST.questId).badge).toBe(
      "🚧 受注できません",
    );
  });

  test("資格ゲートでは街人登録の導線を出さない（登録しても解放されないため）", () => {
    expect(
      shownItemOf(MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST.questId).opensRegistrationModal,
    ).toBe(false);
  });

  test("資格保有者には `🚧 受注できません` が出ない", () => {
    expect(
      shownItemOf(CERTIFIED_MEMBER_VIEWER, CERTIFICATION_REQUIRED_QUEST.questId).badge,
    ).toBeNull();
  });
});

describe("完了条件8: `core_only_reward` はゲストだけでなく一般会員にも詳細を伏せる（v13 §5.10.6 2026-09-20改訂）", () => {
  test("一般街人には `core_only_reward=true` の報酬額が含まれない（完了条件3の「街人には返る」の例外）", () => {
    expect(shownItemOf(MEMBER_VIEWER, CORE_ONLY_LOCKED_QUEST.questId)).not.toHaveProperty(
      "rewardUii",
    );
  });

  test("一般街人には `core_only_reward=true` の指示内容が含まれない", () => {
    expect(shownItemOf(MEMBER_VIEWER, CORE_ONLY_LOCKED_QUEST.questId)).not.toHaveProperty(
      "description",
    );
  });

  test("ゲストにも `core_only_reward=true` の報酬額は含まれない（従来どおり）", () => {
    expect(shownItemOf(GUEST_VIEWER, CORE_ONLY_LOCKED_QUEST.questId)).not.toHaveProperty(
      "rewardUii",
    );
  });

  test("コアメンバーには `core_only_reward=true` でも報酬額が返る", () => {
    expect(shownItemOf(CORE_MEMBER_VIEWER, CORE_ONLY_LOCKED_QUEST.questId).rewardUii).toBe(
      CORE_ONLY_LOCKED_QUEST.rewardUii,
    );
  });

  test("管理者には `core_only_reward=true` でも指示内容が返る", () => {
    expect(shownItemOf(ADMIN_VIEWER, CORE_ONLY_LOCKED_QUEST.questId).description).toBe(
      CORE_ONLY_LOCKED_QUEST.description,
    );
  });

  test("`core_only_reward=true` でも一般街人には施錠バッジは出ない（街人登録導線はゲスト専用のため）", () => {
    // isLockedForViewer はゲスト専用の判定であり続ける。core_only_reward は詳細列だけを絞る、
    // 別軸の制御である（visibility.ts の areDetailsHiddenForViewer コメント参照）。
    expect(shownItemOf(MEMBER_VIEWER, CORE_ONLY_LOCKED_QUEST.questId).isLocked).toBe(false);
  });
});
