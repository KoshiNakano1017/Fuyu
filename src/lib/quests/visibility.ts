// クエストボードの表示種別（通常 / 🔒 施錠 / 🚧 資格ゲート）を決める純関数。WBS 5-1。
//
// 根拠: v13 §5.10.6（ゲスト開放は `guest_allowed` のみで判定。`false` は**隠さず施錠して見せる**）、
//       v13 §2 L171-172・§5.9.3（認可の根拠は `role` のみ。画面と API は同じ定義を参照する）、
//       DB物理設計.md §3-1（`quests` の列）。
//
// ここに DB も HTTP も持ち込まない。表示（`board.ts`）と API 認可（`application-gate.ts`）の
// **両方がこの1枚を参照する**ことで、「画面では押せないが API は通る」状態を作らない。

import type { Role } from "@/lib/auth/session";

/**
 * 起案元区分（v13 §7「クエスト情報」）。手動起案・朝会自動抽出・買い物リスト起点を
 * 1つの一覧に混ぜたうえで、出どころだけを示す（§5.3-1・§5.12.3）。
 *
 * DB 側の列名は `quests.origin_type`（`source_type` ではない）。
 */
export type QuestOriginType = "manual" | "morning_meeting_auto" | "shopping_list";

/** 募集状態。受注申請を受け付けるのは `open` だけ。 */
export type QuestStatus = "open" | "closed" | "archived";

/** クエスト1件。**ゲストへ返してよい列とそうでない列が混ざっている**（絞るのは `board.ts`）。 */
export type Quest = {
  questId: string;
  title: string;
  categoryId?: string | null;
  originType: QuestOriginType;
  status: QuestStatus;
  /** ゲスト開放。カテゴリや `execution_mode` から導出しない（v13 §5.10.6 冒頭） */
  guestAllowed: boolean;
  /** 資格ゲート。街人登録では解放されない別の軸（v13 §5.10.6 表3行目） */
  requiredCertification: readonly string[];
  /**
   * コアメンバー・管理者限定フラグ（v13 §5.10.6 2026-09-20改訂）。
   * true の施錠クエストは、報酬額・指示内容を**一般会員にも**返さない
   * （既定の施錠クエストはゲストにのみ返さない。§areDetailsHiddenForViewer 参照）。
   */
  coreOnlyReward: boolean;
  /** 募集人数（`quests.recruit_count`）。ここまでしか受注できない（v13 §5.3 note L844） */
  recruitCount: number;
  /**
   * 募集枠を占有している受注申請の件数。取り下げ（`キャンセル`）だけを数えない
   * （数え方の正本は 0043 の `quest_occupied_application_count()`）。
   *
   * ⚠️ **DB から渡ってこない。** 件数は `v_quest_board` が返さない（返すと
   *    `GET /rest/v1/v_quest_board?select=...` で全クエストの申請件数を直接読めるため／0043 ③）。
   *    充足の有無だけが `recruitmentFull` として渡る。この列は、件数から可否を導く
   *    テスト・フィクスチャのための入力であり、省略された場合は `recruitCount`
   *    （＝満了）として扱う（`isRecruitmentFull()`）。
   */
  applicationCount?: number;
  /**
   * 募集枠が埋まっているか（`v_quest_board.is_recruitment_full`）。
   * DB 側が件数を明かさずに返す判定結果であり、`applicationCount` より優先する。
   */
  recruitmentFull?: boolean;
  /** 報酬額。返さない条件は `areDetailsHiddenForViewer()` を参照 */
  rewardUii?: number | null;
  /** 指示内容。同上 */
  description?: string | null;
  /** 担当者情報。同上 */
  assigneeName?: string | null;
};

/**
 * クエストボードの閲覧者。
 *
 * ⚠️ `member_type`（親方／街人／ゲスト）は**立場**であって権限ではないため、
 *    この型に持たせない（v13 §2・CLAUDE.md §4.1）。持たせると参照もできてしまう。
 */
export type QuestBoardViewer = {
  memberId: string;
  role: Role;
  /** 会員マスタの `certifications`。資格ゲートの照合に使う（v13 §5.3-2） */
  certifications: readonly string[];
};

/** カードに重ねるバッジ。文言は v13 §5.10.6 の表のとおりで、ここ以外に書かない。 */
export const LOCKED_BADGE = "🔒 街人登録で解放";
export const CERTIFICATION_BADGE = "🚧 受注できません";

export type QuestBadge = typeof LOCKED_BADGE | typeof CERTIFICATION_BADGE;

/**
 * ゲストに対して施錠されているか。
 *
 * 判定の根拠は `role` だけである。`member_type` を混ぜると、立場が「親方」で権限が `guest` の
 * 会員に施錠クエストが開いてしまう（本プロジェクトで実際に起きた事故の型）。
 */
export function isLockedForViewer(quest: Quest, viewer: QuestBoardViewer): boolean {
  return viewer.role === "guest" && !quest.guestAllowed;
}

/** `role` がコアメンバー・管理者か（v13 §2・CLAUDE.md §4.1：認可の根拠は `role` のみ）。 */
function isStaffRole(role: QuestBoardViewer["role"]): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * 報酬額・指示内容・担当者情報を伏せるべきか。
 *
 * `isLockedForViewer()`（🔒 バッジ・街人登録モーダルの起動判定）とは**別の関数**にしてある。
 * 街人登録の導線はゲストにしか出さない一方、詳細を伏せる範囲は
 * `core_only_reward`（v13 §5.10.6 2026-09-20改訂）によりゲストより広くなり得るため、
 * 「施錠バッジが出ているか」と「詳細を返すか」が一致しなくなった。1つの条件に
 * まとめると、どちらかの意味が暗黙に混じって次の変更で事故る（CLAUDE.md §4.2）。
 *
 * 条件は2つ、いずれかを満たせば伏せる:
 *   (a) ゲスト かつ 施錠中（従来どおり）
 *   (b) スタッフ以外 かつ `core_only_reward`（コア・管理者だけがフラグを立てられる）
 */
export function areDetailsHiddenForViewer(quest: Quest, viewer: QuestBoardViewer): boolean {
  const hiddenFromGuest = viewer.role === "guest" && !quest.guestAllowed;
  const hiddenFromNonStaff = quest.coreOnlyReward && !isStaffRole(viewer.role);
  return hiddenFromGuest || hiddenFromNonStaff;
}

/** 資格要件を満たしていないか（v13 §5.3-2 の安全ゲート）。 */
export function lacksRequiredCertification(quest: Quest, viewer: QuestBoardViewer): boolean {
  return quest.requiredCertification.some(
    (certification) => !viewer.certifications.includes(certification),
  );
}

/**
 * 募集人数が埋まっているか（v13 §5.3 note L844「募集人数の**範囲で**受注可」）。
 *
 * 判定の入口はこの関数1本のまま（v13 §5.9.3「二重管理しない」）。入力だけが2通りある:
 *   ① `recruitmentFull` — `v_quest_board` が返す判定結果。DB は件数を明かさない（0043 ③）
 *   ② `applicationCount` — 件数から導く。境界値をテストで固定するための入力
 *
 * `>=` で比べる。`===` だと、既に溢れているクエスト（運用ミス・`recruit_count` の
 * 引き下げで起こりうる）にだけ枠が開く。DB 側の上限ガード（0043 の
 * `quest_applications_guard_capacity()`）も同じ不等号で書いてある。
 *
 * どちらも無ければ「満了」に倒す。上限は厳しい側が既定でなければならない。
 */
export function isRecruitmentFull(quest: Quest): boolean {
  if (quest.recruitmentFull !== undefined) {
    return quest.recruitmentFull;
  }
  return (quest.applicationCount ?? quest.recruitCount) >= quest.recruitCount;
}

/**
 * カードに重ねるバッジ。重ならなければ null。
 *
 * 施錠が資格ゲートより先に立つ。ゲストには報酬額も指示内容も返さない以上、
 * 「資格が足りない」ことまで伝えると、返していない詳細を推測させる手がかりになる。
 */
export function badgeFor(quest: Quest, viewer: QuestBoardViewer): QuestBadge | null {
  if (isLockedForViewer(quest, viewer)) {
    return LOCKED_BADGE;
  }
  if (lacksRequiredCertification(quest, viewer)) {
    return CERTIFICATION_BADGE;
  }
  return null;
}

/**
 * タップで街人登録モーダル（§5.10.1 Step 1）を起動するか。
 *
 * 施錠カードだけが起動する。資格ゲートは**街人登録では解放されない**ため導線を出さない
 * （出すと「登録したのに受注できない」を生む／v13 §5.10.6 表3行目）。
 */
export function opensRegistrationModal(quest: Quest, viewer: QuestBoardViewer): boolean {
  return isLockedForViewer(quest, viewer);
}

/**
 * 街人登録で解放されるクエストの件数（解放件数バナーの N ／ v13 §5.10.6）。
 *
 * `status = 'open'` に限る。受付を終えた施錠クエストを数えると、
 * 「登録しても解放されない件数」を登録動機として提示することになる。
 *
 * `core_only_reward = true` も同じ理由で除外する（2026-09-20改訂）。街人登録は `role` を
 * `guest` → `member` に変えるだけであり、`core_only_reward` の非開示は `member` にも及ぶ
 * （`areDetailsHiddenForViewer()` 参照）。含めると「登録しても報酬額・指示内容は結局見えない件」を
 * 解放数として見せてしまう。
 */
export function countQuestsUnlockedByRegistration(quests: readonly Quest[]): number {
  return quests.filter(
    (quest) => !quest.guestAllowed && !quest.coreOnlyReward && quest.status === "open",
  ).length;
}
