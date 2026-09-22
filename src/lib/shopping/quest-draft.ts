import type { ShoppingItemStatus } from "./status";

/**
 * 買い出しクエストの起案（v13 §5.12.3）。
 *
 * ## 買い出し1回＝1クエスト
 *
 * 品目1つにつき1クエストを作らない。「街へ出るついでにまとめて買う」のが実態であり、
 * 品目ごとにクエストを立てると、**1回の買い出しに対して承認・報酬・完了報告が
 * 品目数だけ発生する**。選択した品目はクエスト本文の明細として持ち、
 * 紐づけは `shopping_list_items.quest_id`（多対1）で行う。
 *
 * ## 新しい承認フローを作らない
 *
 * 起案後は既存の `quest_applications` / `work_logs` に乗る。
 * 完了報告の Before / After 写真を「レシート写真」「購入した品の写真」として
 * 運用するだけで足り、買い出し専用の申請表も報告様式も要らない。
 */

export type QuestableItem = {
  itemId: string;
  itemName: string;
  quantity: number | null;
  unit: string | null;
  referencePriceJpy: number | null;
  status: ShoppingItemStatus;
  withdrawnAt: string | null;
};

/** `quests` へ INSERT する行の形（`quest-candidates.ts` の同名型に合わせる）。 */
export type ShoppingQuestInsertRow = {
  title: string;
  description: string;
  recruit_count: number;
  reward_uii: number | null;
  origin_type: "shopping_list";
  /** 現地作業ではないため `remote`（v13 §5.12.3）。 */
  execution_mode: "remote";
  /**
   * ゲスト開放は既定 `false`。買い出しは立替が発生し得るため、
   * 開放するなら運営が個別に判断する（v13 §5.10.6 の仕組みをそのまま使う）。
   */
  guest_allowed: false;
  status: "open";
  created_by: string;
};

export type DraftDenialReason = "no_items" | "not_approved";

export type DraftResult =
  | { ok: true; row: ShoppingQuestInsertRow }
  | { ok: false; reason: DraftDenialReason };

/** 明細1行。数量・単位が無ければ品名だけを出す（必須は品名のみであるため）。 */
function toLine(item: QuestableItem): string {
  const amount = item.quantity === null ? "" : `${item.quantity}${item.unit ?? ""}`;
  const price = item.referencePriceJpy === null ? "" : `目安 ${item.referencePriceJpy.toLocaleString("ja-JP")}円`;
  const note = [amount, price].filter((part) => part !== "").join(" / ");
  return note === "" ? `・${item.itemName}` : `・${item.itemName}（${note}）`;
}

/**
 * 選択した品目から買い出しクエストを1件組み立てる。
 *
 * 通すのは `買う`（運営が承認済み）だけ。`希望` のまま載せられると、
 * 運営が一度フィルタを通すという §5.12.2 の設計が迂回される。
 */
export function buildShoppingQuestDraft(params: {
  items: readonly QuestableItem[];
  createdByMemberId: string;
  rewardUii?: number | null;
  recruitCount?: number;
  titleOverride?: string;
}): DraftResult {
  const { items, createdByMemberId, rewardUii = null, recruitCount = 1, titleOverride } = params;

  if (items.length === 0) {
    return { ok: false, reason: "no_items" };
  }

  const allApproved = items.every((item) => item.status === "買う" && item.withdrawnAt === null);
  if (!allApproved) {
    return { ok: false, reason: "not_approved" };
  }

  const title = titleOverride?.trim() || `買い出し（${items.length}件）`;

  const description = [
    "買い物リストからの買い出しクエストです。以下をまとめて購入してください。",
    "",
    ...items.map(toLine),
    "",
    "完了報告では、Before にレシート写真、After に購入した品の写真を添付してください（v13 §5.12.3）。",
    "品切れ等で買えなかったものがあれば、その旨を報告に書いてください。買えた分だけ購入済みとして扱います。",
  ].join("\n");

  return {
    ok: true,
    row: {
      title,
      description,
      recruit_count: Math.max(1, Math.round(recruitCount)),
      reward_uii: rewardUii,
      origin_type: "shopping_list",
      execution_mode: "remote",
      guest_allowed: false,
      status: "open",
      created_by: createdByMemberId,
    },
  };
}
