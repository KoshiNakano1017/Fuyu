// 買い物リストの材料を Supabase から読み書きする。WBS 5-8 / 5-9。
//
// 根拠: v13 §5.12（買い物リスト ＆ 買い出しクエスト化）、0028 の RLS ／ ガードトリガー。
//
// 純関数（`status.ts` / `duplicate.ts` / `quest-draft.ts`）と分けてあるのは、
// 判定の試験に DB もセッションも要らない状態を保つためである（`fetch-board.ts` と同じ）。
// snake_case → camelCase の変換はこのファイルに閉じる。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { ShoppingQuestInsertRow } from "./quest-draft";
import type { ShoppingItemStatus } from "./status";

export type ShoppingItem = {
  itemId: string;
  itemName: string;
  quantity: number | null;
  unit: string | null;
  wantedBy: string | null;
  purpose: string | null;
  shopName: string | null;
  shopUrl: string | null;
  referencePriceJpy: number | null;
  priority: "至急" | "通常" | "いつでも";
  status: ShoppingItemStatus;
  registeredBy: string;
  requesters: string[];
  skipReason: string | null;
  questId: string | null;
  withdrawnAt: string | null;
  createdAt: string;
};

/**
 * 一覧に出す列。
 *
 * ★ 登録者の氏名・ニックネームを引かない。表示に必要なのは「自分が登録したか」だけで、
 *   それは `registered_by` と自分の `memberId` の比較で足りる。
 *   名前を載せると、ニックネーム未設定の会員で実名が露出する（v13 §9 #62）。
 */
const ITEM_COLUMNS =
  "item_id, item_name, quantity, unit, wanted_by, purpose, shop_name, shop_url, reference_price_jpy, priority, status, registered_by, requesters, skip_reason, quest_id, withdrawn_at, created_at";

type ShoppingItemRow = {
  item_id: string;
  item_name: string;
  quantity: number | null;
  unit: string | null;
  wanted_by: string | null;
  purpose: string | null;
  shop_name: string | null;
  shop_url: string | null;
  reference_price_jpy: number | null;
  priority: ShoppingItem["priority"];
  status: ShoppingItemStatus;
  registered_by: string;
  requesters: string[] | null;
  skip_reason: string | null;
  quest_id: string | null;
  withdrawn_at: string | null;
  created_at: string;
};

function toItem(row: ShoppingItemRow): ShoppingItem {
  return {
    itemId: row.item_id,
    itemName: row.item_name,
    quantity: row.quantity,
    unit: row.unit,
    wantedBy: row.wanted_by,
    purpose: row.purpose,
    shopName: row.shop_name,
    shopUrl: row.shop_url,
    referencePriceJpy: row.reference_price_jpy,
    priority: row.priority,
    status: row.status,
    registeredBy: row.registered_by,
    requesters: row.requesters ?? [],
    skipReason: row.skip_reason,
    questId: row.quest_id,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
  };
}

/**
 * 買い物リストを読む。
 *
 * 取下げ済みは RLS が運営にだけ見せる（0028）。ここで絞らないのは、
 * 「行を見せるかどうか」の判断を DB とアプリの2箇所に分散させないため。
 */
export async function fetchShoppingItems(): Promise<ShoppingItem[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("shopping_list_items")
    .select(ITEM_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    // 失敗の詳細をそのまま画面・ログへ流さない（CLAUDE.md §3.2）。
    throw new Error("買い物リストを取得できませんでした");
  }

  return (data as ShoppingItemRow[]).map(toItem);
}

export type NewShoppingItem = {
  itemName: string;
  quantity: number | null;
  unit: string | null;
  wantedBy: string | null;
  purpose: string | null;
  shopName: string | null;
  shopUrl: string | null;
  referencePriceJpy: number | null;
  priority: ShoppingItem["priority"];
  registeredBy: string;
};

/** 「ほしいもの」を1件登録する。ゲストはトリガーと RLS が弾く（0028）。 */
export async function insertShoppingItem(input: NewShoppingItem): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.from("shopping_list_items").insert({
    item_name: input.itemName,
    quantity: input.quantity,
    unit: input.unit,
    wanted_by: input.wantedBy,
    purpose: input.purpose,
    shop_name: input.shopName,
    shop_url: input.shopUrl,
    reference_price_jpy: input.referencePriceJpy,
    priority: input.priority,
    registered_by: input.registeredBy,
  });

  return error === null;
}

/** 編集で直せる項目（v13 §5.12.1「入力項目」）。状態・登録者・相乗りは含めない。 */
export type ShoppingItemEdit = {
  itemName: string;
  quantity: number | null;
  unit: string | null;
  wantedBy: string | null;
  purpose: string | null;
  shopName: string | null;
  shopUrl: string | null;
  referencePriceJpy: number | null;
  priority: ShoppingItem["priority"];
};

/**
 * 品目の内容を直す（v13 §5.12.1「編集・取下げは登録者本人と運営が行える」）。
 *
 * ★ **書き換える列をここで固定する。** フォームの値をそのまま展開すると、
 *   `status`・`registered_by`・`requesters` まで送れてしまう。DB 側は 0030 のトリガーが
 *   登録者の書き換えと本人による状態変更を止めるが、**止まるのは例外としてであり**、
 *   アプリから送らないのが先である（v13 §5.9.3 の二重防御と同じ向き）。
 *   相乗り（`requesters`）は `shopping_item_add_requester()` 以外から触らない（0030 ③）。
 *
 * 可否の判定は呼び出し側が `decideEdit()` で済ませてある前提。
 */
export async function updateShoppingItemFields(params: {
  itemId: string;
  edit: ShoppingItemEdit;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase
    .from("shopping_list_items")
    .update({
      item_name: params.edit.itemName,
      quantity: params.edit.quantity,
      unit: params.edit.unit,
      wanted_by: params.edit.wantedBy,
      purpose: params.edit.purpose,
      shop_name: params.edit.shopName,
      shop_url: params.edit.shopUrl,
      reference_price_jpy: params.edit.referencePriceJpy,
      priority: params.edit.priority,
    })
    .eq("item_id", params.itemId);

  return error === null;
}

/** 状態を1件更新する。遷移の可否は呼び出し側が `decideStatusChange()` で判定済みである前提。 */
export async function updateShoppingItemStatus(params: {
  itemId: string;
  next: ShoppingItemStatus;
  decidedBy?: string;
  skipReason?: string;
  purchasedBy?: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const patch: Record<string, unknown> = { status: params.next };

  if (params.next === "見送り") {
    patch.skip_reason = params.skipReason;
    patch.decided_by = params.decidedBy;
    patch.decided_at = new Date().toISOString();
  }
  if (params.next === "買う") {
    patch.decided_by = params.decidedBy;
    patch.decided_at = new Date().toISOString();
    // 部分購入で戻すとき、前回のクエストを引きずらない（v13 §5.12.3）。
    patch.quest_id = null;
  }
  if (params.next === "購入済") {
    patch.purchased_at = new Date().toISOString();
    patch.purchased_by = params.purchasedBy;
  }

  const { error } = await supabase.from("shopping_list_items").update(patch).eq("item_id", params.itemId);
  return error === null;
}

/** 取下げ（論理削除）。状態は動かさない（v13 §5.12.1）。 */
export async function withdrawShoppingItem(params: { itemId: string; reason: string }): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase
    .from("shopping_list_items")
    .update({ withdrawn_at: new Date().toISOString(), withdraw_reason: params.reason })
    .eq("item_id", params.itemId);

  return error === null;
}

/** 「自分も欲しい」。列単位の許可を出せないため RPC 経由でのみ触る（0028 ③）。 */
export async function addRequester(itemId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("shopping_item_add_requester", { p_item_id: itemId });
  return error === null;
}

/**
 * ID を指定して読む。
 *
 * 状態で絞らないのは、**その行に対して何をしてよいか**を決めるのが呼び出し側の純関数
 * （`decideStatusChange()` / `decideEdit()`）だからである。ここで先に落とすと、
 * 「対象が無い」と「その状態では操作できない」が区別できなくなる。
 */
export async function fetchShoppingItemsByIds(itemIds: readonly string[]): Promise<ShoppingItem[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("shopping_list_items").select(ITEM_COLUMNS).in("item_id", itemIds);

  if (error) {
    throw new Error("買い物リストを取得できませんでした");
  }
  return (data as ShoppingItemRow[]).map(toItem);
}

/** 買い出しクエストの起案対象を読む（`買う` かどうかの判定は `quest-draft.ts` が行う）。 */
export async function fetchApprovedItems(itemIds: readonly string[]): Promise<ShoppingItem[]> {
  return fetchShoppingItemsByIds(itemIds);
}

/**
 * 買い出しクエストを1件起案し、選択した品目を紐づける。
 *
 * ⚠️ **クエストの INSERT と品目の UPDATE はトランザクションになっていない。**
 * PostgREST 経由の2回の往復であるため、後段が落ちるとクエストだけが残る。
 * その場合でも品目は `買う` のまま残り、**もう一度クエスト化できる**（二重に作られた
 * クエストは運営が締める）。逆順にすると「クエストの無いクエスト化済」という
 * 復旧しにくい状態が生まれるため、この順序で倒している。
 */
export async function createShoppingQuest(params: {
  row: ShoppingQuestInsertRow;
  itemIds: readonly string[];
}): Promise<string | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase.from("quests").insert(params.row).select("quest_id").single();
  if (error || !data) {
    return null;
  }

  const questId = (data as { quest_id: string }).quest_id;

  const { error: linkError } = await supabase
    .from("shopping_list_items")
    .update({ status: "クエスト化済", quest_id: questId })
    .in("item_id", params.itemIds as string[]);

  return linkError === null ? questId : null;
}
