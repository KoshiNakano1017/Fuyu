// クエストボードの表示行を組み立てる。WBS 5-1。
//
// 根拠: v13 §5.3-1（手動起案と朝会自動抽出を統合表示）、
//       v13 §5.10.6（施錠表示・解放件数バナー・詳細の非開示。2026-09-20改訂で
//       `core_only_reward` を追加＝コア・管理者以外への非開示はゲスト限定ではなくなった）。
//
// ⚠️ ここは「画面に何を出すか」だけでなく「**API が何を返すか**」でもある。
//    報酬額・指示内容・担当者情報は、クライアントへ渡す前にこの関数で落とす
//    （`areDetailsHiddenForViewer()` が対象を判定する。DOM で隠すのは認可ではない／v13 §5.9.3）。

import { canApplyToQuest } from "./application-gate";
import {
  areDetailsHiddenForViewer,
  badgeFor,
  countQuestsUnlockedByRegistration,
  isLockedForViewer,
  opensRegistrationModal,
  type Quest,
  type QuestBadge,
  type QuestBoardViewer,
  type QuestOriginType,
} from "./visibility";

/**
 * 一覧に並ぶ1枚のカード。
 *
 * 報酬額・指示内容・担当者情報は**任意プロパティ**である。施錠時は値を伏せるのではなく
 * **キーごと落とす**。`null` を入れると JSON にキーが残り、「返していない」ことが
 * 受け手から見て「値が無い」と区別できない（v13 §5.10.6 末尾）。
 */
export type QuestBoardItem = {
  questId: string;
  title: string;
  categoryId?: string | null;
  originType: QuestOriginType;
  isLocked: boolean;
  badge: QuestBadge | null;
  canApply: boolean;
  opensRegistrationModal: boolean;
  rewardUii?: number | null;
  description?: string | null;
  assigneeName?: string | null;
};

/** 一覧上部の常設バナー（v13 §5.10.6）。解放されるものが無いときは出さない。 */
export type GuestUnlockBanner = {
  lockedOpenCount: number;
  text: string;
};

export type QuestBoard = {
  items: QuestBoardItem[];
  banner: GuestUnlockBanner | null;
};

/**
 * 施錠の有無にかかわらずカードに載せてよい情報。
 * **タイトル・カテゴリ・施錠状態まで**（v13 §5.10.6 末尾）。
 */
function toCardBase(quest: Quest, viewer: QuestBoardViewer): QuestBoardItem {
  return {
    questId: quest.questId,
    title: quest.title,
    categoryId: quest.categoryId,
    originType: quest.originType,
    isLocked: isLockedForViewer(quest, viewer),
    badge: badgeFor(quest, viewer),
    canApply: canApplyToQuest(viewer, quest),
    opensRegistrationModal: opensRegistrationModal(quest, viewer),
  };
}

/** 詳細を伏せない閲覧者向け（`areDetailsHiddenForViewer()` が false）。詳細3項目をここで初めて足す。 */
function toUnlockedItem(quest: Quest, viewer: QuestBoardViewer): QuestBoardItem {
  return {
    ...toCardBase(quest, viewer),
    rewardUii: quest.rewardUii,
    description: quest.description,
    assigneeName: quest.assigneeName,
  };
}

function buildBanner(quests: readonly Quest[], viewer: QuestBoardViewer): GuestUnlockBanner | null {
  if (viewer.role !== "guest") {
    return null;
  }
  const lockedOpenCount = countQuestsUnlockedByRegistration(quests);
  if (lockedOpenCount === 0) {
    // 解放される件数が 0 のときに「あと0件」と出すと、登録動機の提示が逆効果になる。
    return null;
  }
  return {
    lockedOpenCount,
    text: `🔒 あと${lockedOpenCount}件のクエストが街人登録で解放されます`,
  };
}

/**
 * クエストボードを組み立てる。
 *
 * **行は1件も落とさない。** 施錠クエストを一覧から消すと、施錠カードも解放件数バナーも
 * 成立しない（v13 §5.10.6 は §5.9 の「DOM ごと非表示」とは逆の扱いを定めている）。
 * 絞るのは行ではなく列である。
 */
export function buildQuestBoard(
  quests: readonly Quest[],
  viewer: QuestBoardViewer,
): QuestBoard {
  const items = quests.map((quest) =>
    areDetailsHiddenForViewer(quest, viewer)
      ? toCardBase(quest, viewer)
      : toUnlockedItem(quest, viewer),
  );

  return { items, banner: buildBanner(quests, viewer) };
}
