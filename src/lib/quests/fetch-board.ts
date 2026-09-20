// クエストボードの材料を Supabase から読む。WBS 5-1。
//
// 根拠: v13 §5.10.6（施錠クエストの詳細はゲストへ返さない）、v13 §5.9.3（サーバサイド認可）、
//       0008 の `v_quest_board`（列マスクの DB 側の関門）。
//
// ★ 読み先は `quests` ではなく **`v_quest_board`** である。
//   ビューが施錠クエストの報酬額・指示内容を NULL で返し、`board.ts` がキーごと落とす。
//   直接 `quests` を読むと DB 側の関門を1つ外すことになる（v13 §5.9.3 の二重防御）。
//
// 純関数（`board.ts` / `visibility.ts` / `application-gate.ts`）と分けてあるのは、
// 判定の試験に DB もセッションも要らない状態を保つためである。

import { readViewer } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { Quest, QuestBoardViewer, QuestOriginType, QuestStatus } from "./visibility";

/** `v_quest_board` の列（snake_case）。camelCase への変換はこのファイルで閉じる。 */
type QuestBoardRow = {
  quest_id: string;
  title: string;
  category_id: string | null;
  origin_type: QuestOriginType;
  status: QuestStatus;
  guest_allowed: boolean;
  core_only_reward: boolean;
  required_certification: string[] | null;
  reward_uii: number | null;
  description: string | null;
};

const QUEST_BOARD_COLUMNS =
  "quest_id, title, category_id, origin_type, status, guest_allowed, core_only_reward, required_certification, reward_uii, description";

function toQuest(row: QuestBoardRow): Quest {
  return {
    questId: row.quest_id,
    title: row.title,
    categoryId: row.category_id,
    originType: row.origin_type,
    status: row.status,
    guestAllowed: row.guest_allowed,
    coreOnlyReward: row.core_only_reward,
    requiredCertification: row.required_certification ?? [],
    rewardUii: row.reward_uii,
    description: row.description,
  };
}

/**
 * 一覧に並べるクエストを読む。
 *
 * **施錠クエスト（`guest_allowed = false`）を除外しない。** 除外すると施錠カードと
 * 解放件数バナーが同時に壊れる（v13 §5.10.6）。絞るのは行ではなく列である。
 */
export async function fetchQuestBoardRows(): Promise<Quest[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("v_quest_board")
    .select(QUEST_BOARD_COLUMNS)
    // `archived` は退役済み（DB物理設計 §1-3 の論理削除）。締切済み（`closed`）は
    // 「何が行われているか」が伝わるため残す
    .in("status", ["open", "closed"])
    .order("created_at", { ascending: false });

  if (error) {
    // 失敗の詳細をそのまま画面・ログへ流さない（CLAUDE.md §3.2）。
    throw new Error("クエスト一覧を取得できませんでした");
  }

  return (data as QuestBoardRow[]).map(toQuest);
}

/**
 * 判定に使う閲覧者を組み立てる。未ログインなら null。
 *
 * `role` は毎回 `members` から読む（`session.ts` の `readViewer()`）。
 * 資格は会員マスタの `certifications` を使う（v13 §5.3-2 の安全ゲート）。
 */
export async function readQuestBoardViewer(): Promise<QuestBoardViewer | null> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return null;
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("members")
    .select("certifications")
    .eq("member_id", viewer.memberId)
    .maybeSingle();

  return {
    memberId: viewer.memberId,
    role: viewer.role,
    // 読めなかった場合は「資格なし」に倒す。安全ゲートは厳しい側が既定でなければならない。
    certifications: (data?.certifications as string[] | null) ?? [],
  };
}

/** 受注申請の可否を判定するために1件だけ読む。見つからなければ null。 */
export async function fetchQuestById(questId: string): Promise<Quest | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("v_quest_board")
    .select(QUEST_BOARD_COLUMNS)
    .eq("quest_id", questId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return toQuest(data as QuestBoardRow);
}
