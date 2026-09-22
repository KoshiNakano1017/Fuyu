/**
 * 伝票編集・精算QRの DB 往復（WBS 7-2・7-3）。判定は純関数側にある
 * （`slip-edit.ts` ／ `src/lib/billing/settlement-qr.ts`）。
 *
 * ★ anon キー ＋ RLS で書く。行を絞るのは `0019` の `orders_update_staff` /
 *   `order_items_update_staff` であり、**`service_role` は使わない**。
 *   画面側の判定をすり抜けた操作は、最後に DB が 42501 で拒否する（v13 §5.9.3）。
 */

import {
  issueSettlementToken,
  type IssuedSettlementToken,
} from "@/lib/billing/settlement-qr";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { toUii } from "@/lib/uii";

import type { SettlementDifference, SlipEditPlan } from "./slip-edit";
import type { OrderLine } from "./totals";

/** 編集対象の伝票。判定に要る分だけを持つ。 */
export type EditableOrder = {
  orderId: string;
  purchaserId: string;
  status: "未会計" | "精算済み" | "取消";
  totalAmountYen: number;
  hasActiveQr: boolean;
  lines: (OrderLine & { itemId: string })[];
};

export async function fetchOrderForEdit(orderId: string): Promise<EditableOrder | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("orders")
    .select(
      "order_id, purchaser_id, status, total_amount_yen, settlement_qr_token_hash, settlement_qr_expires_at, settlement_qr_consumed_at, settlement_qr_revoked_at, order_items(item_id, product_name, unit_price_yen, quantity, voided_at)",
    )
    .eq("order_id", orderId)
    .maybeSingle();

  if (error || data === null) {
    return null;
  }

  const items = (data.order_items ?? []) as {
    item_id: string;
    product_name: string;
    unit_price_yen: number;
    quantity: number;
    voided_at: string | null;
  }[];

  return {
    orderId: String(data.order_id),
    purchaserId: String(data.purchaser_id),
    status: data.status as EditableOrder["status"],
    totalAmountYen: Number(data.total_amount_yen),
    hasActiveQr:
      data.settlement_qr_token_hash !== null &&
      data.settlement_qr_consumed_at === null &&
      data.settlement_qr_revoked_at === null &&
      typeof data.settlement_qr_expires_at === "string" &&
      new Date(data.settlement_qr_expires_at).getTime() > Date.now(),
    // 取消済みの明細は編集の対象にも合計にも入れない（`0031` の論理削除）
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

export type SlipEditWrite = {
  orderId: string;
  editorId: string;
  reason: string;
  /** 数量・単価の変更（`itemId` で引く既存行） */
  updates: readonly { itemId: string; quantity: number; unitPriceYen: number }[];
  /** 取消する明細行（論理削除 ／ `0031`） */
  voidedItemIds: readonly string[];
  plan: SlipEditPlan;
};

/**
 * 編集を書き込む。
 *
 * ## 書き込みの順番
 *
 * 明細 → 伝票合計 → 差額 の順で書く。合計を先に書くと、明細の更新が失敗したときに
 * **明細と合計が食い違った伝票**が残る。この順なら、途中で失敗しても
 * 「明細は直ったが合計が古い」＝画面で再計算すれば気づける形に留まる。
 *
 * ⚠️ トランザクションではない。PostgREST 経由の複数文はまとめて巻き戻せないため、
 * 影響の小さい順に並べることで最悪の失敗を軽くしている。
 * （単一トランザクションが要るなら RPC 化が必要だが、それは `QUESTIONS.md`
 * 「伝票の編集履歴ログ…」の決着後にまとめて設計する。）
 */
export async function applySlipEdit(write: SlipEditWrite): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const editedAt = new Date().toISOString();

  for (const update of write.updates) {
    const { error } = await supabase
      .from("order_items")
      .update({
        quantity: update.quantity,
        unit_price_yen: update.unitPriceYen,
        // ★ 明細の Uii は「当時の単価から導いた値」である。単価を直したらここも直す。
        //   放置すると円だけが変わり、Uii 表示と合計が食い違う（v13 §5.5）。
        unit_price_uii: toUii(update.unitPriceYen),
        edited_by: write.editorId,
        edit_reason: write.reason,
      })
      .eq("item_id", update.itemId)
      .eq("order_id", write.orderId);
    if (error) {
      return false;
    }
  }

  for (const itemId of write.voidedItemIds) {
    const { error } = await supabase
      .from("order_items")
      .update({ voided_at: editedAt, voided_by: write.editorId, void_reason: write.reason })
      .eq("item_id", itemId)
      .eq("order_id", write.orderId);
    if (error) {
      return false;
    }
  }

  const orderPatch: Record<string, unknown> = {
    total_amount_yen: write.plan.totals.totalAmountYen,
    total_amount_uii: write.plan.totals.totalAmountUii,
    updated_at: editedAt,
  };
  // 旧QRの自動失効（v13 §5.6.3-5）。編集後の金額と旧QRの金額が食い違うため。
  if (write.plan.revokeQr) {
    orderPatch.settlement_qr_revoked_at = editedAt;
  }

  const { error: orderError } = await supabase
    .from("orders")
    .update(orderPatch)
    .eq("order_id", write.orderId);
  if (orderError) {
    return false;
  }

  if (write.plan.difference !== null) {
    return insertAdjustment({
      orderId: write.orderId,
      difference: write.plan.difference,
      reason: write.reason,
    });
  }
  return true;
}

/** 差額を「未処理」として残す（v13 §5.6.5-3・§5.6.6）。 */
export async function insertAdjustment(params: {
  orderId: string;
  difference: SettlementDifference;
  reason: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("settlement_adjustments").insert({
    order_id: params.orderId,
    amount_yen: params.difference.amountYen,
    amount_uii: params.difference.amountUii,
    category: params.difference.category,
    reason: params.reason,
    // `status` は DB の既定（未処理）に委ねる。既定を2箇所に書かない
  });
  return error === null;
}

/**
 * 注文者の付け替え（v13 §5.6.2）。
 *
 * `checkin_id` も一緒に移す。伝票の持ち主だけを変えると、
 * **他人の滞在にぶら下がった伝票**が残り、滞在単位の集計（§5.6.8）が狂う。
 */
export async function reassignPurchaser(params: {
  orderId: string;
  nextPurchaserId: string;
  nextCheckinId: string;
  editorId: string;
  reason: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("orders")
    .update({
      purchaser_id: params.nextPurchaserId,
      checkin_id: params.nextCheckinId,
      // 付替も編集であり、旧QRは失効させる（受け取る相手が変わるため）
      settlement_qr_revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", params.orderId);

  if (error) {
    return false;
  }
  // 付替の理由は明細ではなく伝票の事実なので、生きている明細すべてへ残す。
  // （専用の編集履歴ログが無いための暫定。`QUESTIONS.md` の該当論点で決着させる）
  await supabase
    .from("order_items")
    .update({ edited_by: params.editorId, edit_reason: params.reason })
    .eq("order_id", params.orderId)
    .is("voided_at", null);
  return true;
}

/** 伝票の取消（論理削除 ／ v13 §5.6.2・§5.6.5-5）。 */
export async function cancelOrder(params: {
  orderId: string;
  editorId: string;
  reason: string;
  difference: SettlementDifference | null;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("orders")
    .update({
      status: "取消",
      cancelled_at: now,
      cancelled_by: params.editorId,
      cancel_reason: params.reason,
      // 取り消した伝票のQRで精算できてはならない
      settlement_qr_revoked_at: now,
      updated_at: now,
    })
    .eq("order_id", params.orderId);

  if (error) {
    return false;
  }
  if (params.difference !== null) {
    return insertAdjustment({
      orderId: params.orderId,
      difference: params.difference,
      reason: params.reason,
    });
  }
  return true;
}

/**
 * 精算QRを発行する（WBS 7-3）。
 *
 * ★ 平文のトークンは**戻り値でだけ**返す。DB にはハッシュしか入らないため、
 * 画面を閉じた後に同じトークンを再表示する手段は無い（再発行すると旧QRは失効する）。
 */
export async function issueSettlementQr(params: {
  orderId: string;
  staffId: string;
}): Promise<IssuedSettlementToken | null> {
  const supabase = await createServerSupabaseClient();
  const issuedAt = new Date();
  const issued = issueSettlementToken(issuedAt);

  const { error } = await supabase
    .from("orders")
    .update({
      settlement_qr_token_hash: issued.tokenHash,
      settlement_qr_issued_by: params.staffId,
      settlement_qr_issued_at: issuedAt.toISOString(),
      settlement_qr_expires_at: issued.expiresAt.toISOString(),
      // 再発行なので、前のQRの失効・使用済みの記録は引き継がない
      settlement_qr_consumed_at: null,
      settlement_qr_revoked_at: null,
      updated_at: issuedAt.toISOString(),
    })
    .eq("order_id", params.orderId)
    // 未会計でなくなっていたら書かない（別の端末が先に精算した場合）
    .eq("status", "未会計");

  return error === null ? issued : null;
}

/**
 * 精算済みにする（v13 §5.6.1④「精算済みマーク処理」）。
 *
 * 発行済みのQRがあれば同時に使用済みにする（単回使用 ／ 2026-09-10 A案）。
 * 消し込みを別操作にすると、精算後もQRが生きたまま残る。
 */
export async function markOrderSettled(params: {
  orderId: string;
  staffId: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("orders")
    .update({
      status: "精算済み",
      settled_at: now,
      settlement_qr_consumed_at: now,
      updated_at: now,
    })
    .eq("order_id", params.orderId)
    .eq("status", "未会計");

  return error === null;
}

/** 未会計へ戻す（v13 §5.6.2「決済ステータス変更：未会計 ⇄ 会計済み の手動切替」）。 */
export async function markOrderUnsettled(params: {
  orderId: string;
  staffId: string;
  reason: string;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("orders")
    .update({
      status: "未会計",
      settled_at: null,
      // 使用済みのQRは復活させない。戻した後の請求は新しいQRで行う
      settlement_qr_revoked_at: now,
      updated_at: now,
    })
    .eq("order_id", params.orderId)
    .eq("status", "精算済み");

  if (error) {
    return false;
  }
  // 理由の記録先は明細の `edit_reason` しか無い（専用の編集履歴ログが未設計 ／
  // `QUESTIONS.md`「[2026-09-20] 伝票の編集履歴ログ…」）。付替と同じ暫定で、
  // 生きている明細すべてに操作者と理由を残す。
  await supabase
    .from("order_items")
    .update({ edited_by: params.staffId, edit_reason: params.reason })
    .eq("order_id", params.orderId)
    .is("voided_at", null);
  return true;
}
