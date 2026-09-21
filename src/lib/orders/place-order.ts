// 注文の確定（WBS 6-1 セルフ注文 ／ 6-2 代理注文）。
//
// 画面（Server Action）と DB の間に挟む層。`totals.ts` の純関数で金額を組み立て、
// `orders` と `order_items` へ書く。**認可はここではなく呼び出し元と RLS で行う**
// （Server Action 側の `readViewer()` ＋ `0019` の WITH CHECK ／ v13 §5.9.3 の二重防御）。

import { createServerSupabaseClient } from "@/lib/supabase/server";

import { calculateOrderTotals, toOrderItemRows, type OrderLine } from "./totals";

/** 失敗の理由。利用者向け文言への変換は呼び出し元（Server Action）が行う。 */
export type PlaceOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: "empty_cart" | "not_staying" | "sold_out" | "failed" };

/**
 * 伝票を1件作る。
 *
 * ## なぜ単価をマスタから引き直すのか
 *
 * 引数で受け取るのは**メニューIDと数量だけ**で、単価は画面から受け取らない。
 * 単価を画面から渡すと、フォームの hidden 値を書き換えるだけで
 * 「1円のコーヒー」を注文できてしまう。金額は必ずサーバ側でマスタから引く。
 *
 * ## なぜ売り切れをここでも見るのか
 *
 * 品書きを開いてからカートを確定するまでの間に売り切れることがある。
 * 画面の SOLDOUT 表示は開いた時点の写しでしかないので、確定の直前に取り直す。
 */
export async function placeOrder(params: {
  checkinId: string;
  purchaserId: string;
  /** 代理注文なら操作した店員の `member_id`。セルフ注文なら null。 */
  createdByMemberId: string | null;
  quantities: ReadonlyMap<string, number>;
}): Promise<PlaceOrderResult> {
  const wanted = [...params.quantities.entries()].filter(([, quantity]) => quantity > 0);
  if (wanted.length === 0) {
    return { ok: false, reason: "empty_cart" };
  }

  const supabase = await createServerSupabaseClient();

  const { data: menuRows, error: menuError } = await supabase
    .from("menu_items")
    .select("menu_item_id, name, unit_price_yen, is_sold_out, is_published")
    .in(
      "menu_item_id",
      wanted.map(([menuItemId]) => menuItemId),
    );

  if (menuError || !menuRows || menuRows.length !== wanted.length) {
    return { ok: false, reason: "failed" };
  }

  const master = new Map(
    (menuRows as { menu_item_id: string; name: string; unit_price_yen: number; is_sold_out: boolean; is_published: boolean }[]).map(
      (row) => [row.menu_item_id, row],
    ),
  );

  const lines: OrderLine[] = [];
  for (const [menuItemId, quantity] of wanted) {
    const item = master.get(menuItemId);
    if (item === undefined || !item.is_published) {
      return { ok: false, reason: "failed" };
    }
    if (item.is_sold_out) {
      return { ok: false, reason: "sold_out" };
    }
    lines.push({ productName: item.name, unitPriceYen: item.unit_price_yen, quantity });
  }

  const totals = calculateOrderTotals(lines);

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      checkin_id: params.checkinId,
      purchaser_id: params.purchaserId,
      order_channel: params.createdByMemberId === null ? "self" : "staff_proxy",
      created_by: params.createdByMemberId,
      total_amount_yen: totals.totalAmountYen,
      total_amount_uii: totals.totalAmountUii,
    })
    .select("order_id")
    .maybeSingle();

  if (orderError || !order) {
    // チェックイン中でない場合は `orders_insert_self` の WITH CHECK がここで弾く。
    // 理由の切り分けはできないが、**弾かれたこと自体が仕様どおり**である。
    return { ok: false, reason: "not_staying" };
  }

  const orderId = order.order_id as string;
  const { error: itemsError } = await supabase
    .from("order_items")
    .insert(toOrderItemRows(lines).map((row) => ({ ...row, order_id: orderId, source_menu_item_id: null })));

  if (itemsError) {
    // ⚠️ **ここで取り消せない。** `orders` の DELETE は全拒否、UPDATE は staff のみ
    //    （`0019` の `orders_update_staff`）であり、セルフ注文の本人には畳む権限が無い。
    //    したがって明細の無い伝票が残りうる。合計だけがある行は顧客管理画面（WBS 8-1）で
    //    運営が取り消す。
    //    根治には「伝票と明細を1トランザクションで作る RPC」が要る（DB層の仕事）。
    //    権限を緩めて本人に UPDATE を許すのは、**伝票の改竄経路を開ける**ことになるので採らない。
    return { ok: false, reason: "failed" };
  }

  return { ok: true, orderId };
}
