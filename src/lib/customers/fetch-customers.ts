/**
 * 顧客管理画面（WBS 8-1 ／ 画面ID C11）の材料を読む。
 *
 * ★ すべて **anon キー ＋ RLS**（`createServerSupabaseClient()`）で読む。
 *   行を絞るのは `0005` の `members_select_staff`・`0019` の `orders_select_staff` 等であり、
 *   **`service_role` をここで使ってはならない**（使うと RLS の拒否がすべて素通りする）。
 *
 * ⚠️ **実名（`member_profiles_private`）へ触れない。** 表示名は `v_member_public`（`0009`）の
 *   ニックネーム／会員番号だけを使う。v13 §5.6.1① は顧客サマリーに氏名を出すと定めるが、
 *   本画面は未会計と伝票の操作が目的であり、**氏名が無くても成立する**。
 *   宿泊法の申告項目（氏名・住所）は専用画面（WBS 2-4・3-2）が扱う。
 *   PII を運ぶ画面を増やすほど、漏れる経路が増える（`DB物理設計.md` §6-6b）。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { OrderLine } from "@/lib/orders/totals";

import type { CustomerRow } from "./sort";

/** 顧客詳細の伝票1件。一覧（`OrderSummary`）より多くの列を持つ。 */
export type CustomerOrder = {
  orderId: string;
  status: "未会計" | "精算済み" | "取消";
  servingStatus: string;
  orderChannel: "self" | "staff_proxy";
  totalAmountYen: number;
  totalAmountUii: number;
  createdAt: string;
  cancelReason: string | null;
  /** 生きている精算QRがあるか（発行済み・未使用・未失効・期限内） */
  hasActiveQr: boolean;
  lines: (OrderLine & { itemId: string })[];
};

export type PendingAdjustment = {
  adjustmentId: string;
  orderId: string;
  amountYen: number;
  amountUii: number;
  category: "追加請求" | "返金";
  reason: string;
  occurredAt: string;
};

export type CustomerDetail = {
  memberId: string;
  displayName: string;
  memberType: string;
  isStaying: boolean;
  checkInDate: string | null;
  roomType: string | null;
  orders: CustomerOrder[];
  pendingAdjustments: PendingAdjustment[];
};

/**
 * 一覧の行を組み立てる。
 *
 * 1本の SQL にまとめず、4本を並べて読んでから突き合わせる。
 * 集計（未会計合計・未処理差額の有無）を SQL へ押し込むと、
 * **並び順の仕様（§5.6.7）がクエリの中に溶けて読めなくなる**。
 * 並びは `sortCustomers()`（純関数・試験あり）が決める。
 */
export async function fetchCustomerRows(): Promise<CustomerRow[]> {
  const supabase = await createServerSupabaseClient();

  const [members, labels, checkIns, orders, adjustments] = await Promise.all([
    supabase.from("members").select("member_id, member_type, account_status"),
    supabase.from("v_member_public").select("member_id, display_name"),
    supabase.from("check_ins").select("member_id, status, check_in_date"),
    supabase.from("orders").select("purchaser_id, status, total_amount_yen, total_amount_uii"),
    supabase.from("settlement_adjustments").select("status, orders(purchaser_id)").eq("status", "未処理"),
  ]);

  const labelByMember = new Map(
    ((labels.data ?? []) as { member_id: string; display_name: string | null }[]).map((row) => [
      row.member_id,
      row.display_name ?? "（表示名なし）",
    ]),
  );

  const stayRows = (checkIns.data ?? []) as {
    member_id: string;
    status: string;
    check_in_date: string;
  }[];

  const orderRows = (orders.data ?? []) as {
    purchaser_id: string;
    status: string;
    total_amount_yen: number;
    total_amount_uii: number;
  }[];

  // PostgREST の埋め込みは、親を1件返す関係でも配列で来ることがある。
  // どちらの形でも拾えるように平らにしてから集める。
  const pendingMembers = new Set(
    ((adjustments.data ?? []) as unknown as { orders: unknown }[])
      .flatMap((row) => (Array.isArray(row.orders) ? row.orders : [row.orders]))
      .map((order) => (order as { purchaser_id?: unknown } | null)?.purchaser_id)
      .filter((memberId): memberId is string => typeof memberId === "string"),
  );

  return ((members.data ?? []) as { member_id: string; member_type: string }[]).map((member) => {
    const stays = stayRows.filter((stay) => stay.member_id === member.member_id);
    const staying = stays.find((stay) => stay.status === "staying");
    const unsettled = orderRows.filter(
      (order) => order.purchaser_id === member.member_id && order.status === "未会計",
    );

    return {
      memberId: member.member_id,
      displayName: labelByMember.get(member.member_id) ?? "（表示名なし）",
      memberType: member.member_type,
      isStaying: staying !== undefined,
      checkInDate: staying?.check_in_date ?? null,
      hasPendingAdjustment: pendingMembers.has(member.member_id),
      unsettledYen: unsettled.reduce((sum, order) => sum + order.total_amount_yen, 0),
      unsettledUii: unsettled.reduce((sum, order) => sum + order.total_amount_uii, 0),
      // 「来訪した」＝実際に滞在に入った記録。予約（pre_registered / confirmed）は来訪ではない
      lastVisitDate: latestVisitDate(stays),
    };
  });
}

function latestVisitDate(
  stays: readonly { status: string; check_in_date: string }[],
): string | null {
  const visited = stays
    .filter((stay) => stay.status === "staying" || stay.status === "checked_out")
    .map((stay) => stay.check_in_date)
    .sort();
  return visited.length === 0 ? null : visited[visited.length - 1];
}

const ORDER_DETAIL_COLUMNS =
  "order_id, status, serving_status, order_channel, total_amount_yen, total_amount_uii, created_at, cancel_reason, " +
  "settlement_qr_token_hash, settlement_qr_expires_at, settlement_qr_consumed_at, settlement_qr_revoked_at, " +
  "order_items(item_id, product_name, unit_price_yen, quantity, voided_at)";

/** 顧客1人分の詳細。伝票は取消も含めて全件返す（取消線で残すため／v13 §5.6.2）。 */
export async function fetchCustomerDetail(memberId: string): Promise<CustomerDetail | null> {
  const supabase = await createServerSupabaseClient();

  const [member, label, checkIn, orders, adjustments] = await Promise.all([
    supabase.from("members").select("member_id, member_type").eq("member_id", memberId).maybeSingle(),
    supabase.from("v_member_public").select("display_name").eq("member_id", memberId).maybeSingle(),
    supabase
      .from("check_ins")
      .select("check_in_date, room_type")
      .eq("member_id", memberId)
      .eq("status", "staying")
      .maybeSingle(),
    supabase
      .from("orders")
      .select(ORDER_DETAIL_COLUMNS)
      .eq("purchaser_id", memberId)
      .order("created_at", { ascending: false }),
    supabase
      .from("settlement_adjustments")
      .select("adjustment_id, order_id, amount_yen, amount_uii, category, reason, occurred_at, orders!inner(purchaser_id)")
      .eq("status", "未処理")
      .eq("orders.purchaser_id", memberId),
  ]);

  if (member.error || member.data === null) {
    return null;
  }

  return {
    memberId,
    displayName: (label.data?.display_name as string | null) ?? "（表示名なし）",
    memberType: String(member.data.member_type),
    isStaying: checkIn.data !== null,
    checkInDate: (checkIn.data?.check_in_date as string | undefined) ?? null,
    roomType: (checkIn.data?.room_type as string | undefined) ?? null,
    orders: ((orders.data ?? []) as unknown as Record<string, unknown>[]).map(toCustomerOrder),
    pendingAdjustments: ((adjustments.data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
      adjustmentId: String(row.adjustment_id),
      orderId: String(row.order_id),
      amountYen: Number(row.amount_yen),
      amountUii: Number(row.amount_uii),
      category: row.category as "追加請求" | "返金",
      reason: String(row.reason),
      occurredAt: String(row.occurred_at),
    })),
  };
}

function toCustomerOrder(row: Record<string, unknown>): CustomerOrder {
  const items = (row.order_items ?? []) as {
    item_id: string;
    product_name: string;
    unit_price_yen: number;
    quantity: number;
    voided_at: string | null;
  }[];

  return {
    orderId: String(row.order_id),
    status: row.status as CustomerOrder["status"],
    servingStatus: String(row.serving_status),
    orderChannel: row.order_channel as CustomerOrder["orderChannel"],
    totalAmountYen: Number(row.total_amount_yen),
    totalAmountUii: Number(row.total_amount_uii),
    createdAt: String(row.created_at),
    cancelReason: row.cancel_reason === null ? null : String(row.cancel_reason),
    hasActiveQr: isQrActive(row),
    // 取消済みの明細（`0031` の論理削除）は表示にも合計にも出さない。
    // 行は残っているので、履歴を追う必要が出たら DB 側から辿れる。
    lines: items
      .filter((item) => item.voided_at === null)
      .map((item) => ({
      itemId: item.item_id,
      productName: item.product_name,
      unitPriceYen: item.unit_price_yen,
      quantity: item.quantity,
      })),
  };
}

/**
 * 生きている精算QRか。
 *
 * 期限切れのQRを「生きている」と数えると、編集のたびに失効時刻だけが書かれ、
 * 画面には「失効させました」と出るのに実際には何も変わらない状態になる。
 */
function isQrActive(row: Record<string, unknown>): boolean {
  if (row.settlement_qr_token_hash === null || row.settlement_qr_token_hash === undefined) {
    return false;
  }
  if (row.settlement_qr_consumed_at !== null || row.settlement_qr_revoked_at !== null) {
    return false;
  }
  const expiresAt = row.settlement_qr_expires_at;
  return typeof expiresAt === "string" && new Date(expiresAt).getTime() > Date.now();
}
