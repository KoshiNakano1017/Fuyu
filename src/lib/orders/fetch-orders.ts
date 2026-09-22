// カフェ注文の材料を Supabase から読む。WBS 6-1（セルフ注文）・6-2（代理注文）・6-5（提供ステータス）。
//
// 純関数（`menu.ts` / `totals.ts` / `serving-status.ts`）と分けてあるのは、
// 判定の試験に DB もセッションも要らない状態を保つためである（`fetch-board.ts` と同じ作法）。
//
// ★ すべて **anon キー＋RLS** の経路で読む（`createServerSupabaseClient()`）。
//   `orders_select_self` / `orders_select_staff`（`0019`）が行を絞るため、
//   アプリ側で `purchaser_id` による絞り込みを重ねなくても他人の伝票は返らない。
//   逆に言えば **RLS を迂回する service_role をここで使ってはならない**（CLAUDE.md §3.2）。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { MenuItem } from "./menu";
import type { OrderLine } from "./totals";

/** 会計ステータス（`orders.status` の CHECK と同じ3値）。 */
export type OrderStatus = "未会計" | "精算済み" | "取消";

/** 注文の経路（`orders.order_channel`）。代理注文をカードに出し分けるのに使う。 */
export type OrderChannel = "self" | "staff_proxy";

export type OrderSummary = {
  orderId: string;
  purchaserId: string;
  /** 伝票の持ち主の表示名。`v_member_public` 由来で、実名は含まない。 */
  purchaserLabel: string;
  status: OrderStatus;
  /** `serving_status` の生値。表示は `toServingStatusDisplayLabel()` を通す。 */
  servingStatus: string;
  orderChannel: OrderChannel;
  totalAmountYen: number;
  totalAmountUii: number;
  createdAt: string;
  lines: OrderLine[];
};

/** 滞在中のチェックイン。セルフ注文の可否と、代理注文の相手選択に使う。 */
export type StayingCheckIn = {
  checkinId: string;
  memberId: string;
  memberLabel: string;
  roomType: string;
};

const MENU_COLUMNS =
  "menu_item_id, name, category, subcategory, unit_price_yen, description, is_sold_out, is_published, available_from, available_until, display_order";

type MenuRow = {
  menu_item_id: string;
  name: string;
  category: string;
  subcategory: string | null;
  unit_price_yen: number;
  description: string | null;
  is_sold_out: boolean;
  is_published: boolean;
  available_from: string | null;
  available_until: string | null;
  display_order: number;
};

function toMenuItem(row: MenuRow): MenuItem {
  return {
    menuItemId: row.menu_item_id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    unitPriceYen: row.unit_price_yen,
    description: row.description,
    isSoldOut: row.is_sold_out,
    isPublished: row.is_published,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    displayOrder: row.display_order,
  };
}

/**
 * 品書きの全行を読む。**未公開・期間外の除外はここで行わない。**
 *
 * 絞り込みを `menu.ts` の純関数へ寄せているのは、マスタ管理画面（WBS 6-4）が
 * 「未公開のものも含めた全件」を必要とするためである。同じ読み出しを2本持たない。
 */
export async function fetchMenuItems(): Promise<MenuItem[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("menu_items")
    .select(MENU_COLUMNS)
    .order("display_order", { ascending: true });

  if (error) {
    // 失敗の詳細をそのまま画面・ログへ流さない（CLAUDE.md §3.2）。
    throw new Error("メニューを取得できませんでした");
  }
  return (data as MenuRow[]).map(toMenuItem);
}

/**
 * 自分の「滞在中」チェックインを1件返す。無ければ null。
 *
 * セルフ注文は**チェックイン中に限る**（v13 §5.4.1「🔒 要チェックイン」）。
 * これは画面の出し分けのためだけの判定であり、防壁ではない。
 * 実際に注文を止めているのは `orders_insert_self`（`0019`）の WITH CHECK である。
 */
export async function fetchMyStayingCheckIn(memberId: string): Promise<StayingCheckIn | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select("checkin_id, member_id, room_type")
    .eq("member_id", memberId)
    .eq("status", "staying")
    .order("check_in_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return {
    checkinId: data.checkin_id as string,
    memberId: data.member_id as string,
    memberLabel: "自分",
    roomType: data.room_type as string,
  };
}

/**
 * 滞在中のチェックインを全件返す（代理注文の相手選択 ／ WBS 6-2）。
 *
 * ⚠️ **氏名を持ってこない。** 表示名は `v_member_public`（`0009`）の
 * ニックネーム／会員番号であり、`member_profiles_private` には触れない
 * （v13 §5.9・CLAUDE.md §7.1）。店員タブレットは客の目に入る位置に置かれるため、
 * ここで実名を引くと画面越しに実名が漏れる。
 */
export async function fetchStayingCheckIns(): Promise<StayingCheckIn[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select("checkin_id, member_id, room_type")
    .eq("status", "staying")
    .order("check_in_date", { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as { checkin_id: string; member_id: string; room_type: string }[];
  const labels = await fetchMemberLabels(rows.map((row) => row.member_id));

  return rows.map((row) => ({
    checkinId: row.checkin_id,
    memberId: row.member_id,
    memberLabel: labels.get(row.member_id) ?? "（表示名なし）",
    roomType: row.room_type,
  }));
}

/**
 * 会員の表示名をまとめて引く。
 *
 * ★ 読み先は `members` ではなく **`v_member_public`**（`0009`）である。
 * 他者向けの表示は**ニックネーム／未設定時は会員番号**であり、
 * `full_name` へのフォールバックは禁止されている（v13 §5.9.5 ／ WBS 2-3）。
 * ビュー越しに読むことで、その規則を画面側で再実装しなくて済む。
 */
async function fetchMemberLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name")
    .in("member_id", unique);

  const labels = new Map<string, string>();
  for (const row of (data ?? []) as { member_id: string; display_name: string | null }[]) {
    if (row.display_name !== null) {
      labels.set(row.member_id, row.display_name);
    }
  }
  return labels;
}

const ORDER_COLUMNS =
  "order_id, purchaser_id, status, serving_status, order_channel, total_amount_yen, total_amount_uii, created_at, order_items(product_name, unit_price_yen, quantity)";

type OrderRow = {
  order_id: string;
  purchaser_id: string;
  status: OrderStatus;
  serving_status: string;
  order_channel: OrderChannel;
  total_amount_yen: number;
  total_amount_uii: number;
  created_at: string;
  order_items: { product_name: string; unit_price_yen: number; quantity: number }[] | null;
};

function toOrderSummary(row: OrderRow, labels: Map<string, string>): OrderSummary {
  return {
    orderId: row.order_id,
    purchaserId: row.purchaser_id,
    purchaserLabel: labels.get(row.purchaser_id) ?? "（表示名なし）",
    status: row.status,
    servingStatus: row.serving_status,
    orderChannel: row.order_channel,
    totalAmountYen: row.total_amount_yen,
    totalAmountUii: row.total_amount_uii,
    createdAt: row.created_at,
    lines: (row.order_items ?? []).map((item) => ({
      productName: item.product_name,
      unitPriceYen: item.unit_price_yen,
      quantity: item.quantity,
    })),
  };
}

async function toSummaries(rows: OrderRow[]): Promise<OrderSummary[]> {
  const labels = await fetchMemberLabels(rows.map((row) => row.purchaser_id));
  return rows.map((row) => toOrderSummary(row, labels));
}

/**
 * 店員タブレットのカンバンに並べる伝票（WBS 6-1・6-5）。
 *
 * 取消（`status = '取消'`）は載せない。カンバンは「これから捌く仕事」を映す板であり、
 * 取り消された伝票が残ると未提供の列が実態より多く見える。
 * 取消の履歴は顧客管理画面（WBS 8-1）の担当である。
 */
export async function fetchOpenOrders(): Promise<OrderSummary[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .in("status", ["未会計", "精算済み"])
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error("注文を取得できませんでした");
  }
  return toSummaries((data ?? []) as OrderRow[]);
}

/** 本人の注文履歴（マイログ ／ WBS 8-4）。RLS の `orders_select_self` が行を絞る。 */
export async function fetchMyOrders(memberId: string): Promise<OrderSummary[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("purchaser_id", memberId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error("注文を取得できませんでした");
  }
  return toSummaries((data ?? []) as OrderRow[]);
}
