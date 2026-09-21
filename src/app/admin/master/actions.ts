"use server";

import { revalidatePath } from "next/cache";

import type { SubmitState } from "@/lib/forms/submit-state";
import { readViewer } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const MESSAGE = {
  denied: "この操作を行う権限がありません。",
  invalid: "商品名と価格（0以上の整数）を入力してください。",
  failed: "保存できませんでした。時間をおいて再試行してください。",
} as const;

/**
 * カフェメニューの登録（画面ID C13 ／ WBS 6-4）。
 *
 * ## Uii 価格を入力させない
 *
 * v13 §5.5 が `floor(単価×0.8)` と定めており、`menu_items` は Uii 列を持たない。
 * 入力欄を置くと、円と Uii が食い違ったマスタができる。画面には `Money` で
 * 換算結果を出すだけにする。
 *
 * ## `admin` 限定
 *
 * `menu_items_insert_admin`（`0018`）が行レベルで admin に限っている。
 * コアメンバーが触れるのは `is_sold_out` だけ（列単位 GRANT）。
 */
export async function createMenuItemAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isAdmin(viewer.role)) {
    return { status: "error", message: MESSAGE.denied };
  }

  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const unitPriceYen = Number.parseInt(String(formData.get("unitPriceYen") ?? ""), 10);
  const description = String(formData.get("description") ?? "").trim();

  if (
    name === "" ||
    category === "" ||
    !Number.isSafeInteger(unitPriceYen) ||
    unitPriceYen < 0
  ) {
    return { status: "error", message: MESSAGE.invalid };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("menu_items").insert({
    name,
    category,
    unit_price_yen: unitPriceYen,
    description: description === "" ? null : description,
    created_by: viewer.memberId,
    updated_by: viewer.memberId,
  });

  if (error) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath("/admin/master");
  revalidatePath("/orders");
  revalidatePath("/staff/orders");
  return { status: "done", message: "メニューを追加しました。" };
}

/**
 * 宿泊料金の登録（画面ID C13 ／ WBS 3-9）。
 *
 * ## 改定は上書きではなく行の追加
 *
 * v13 §5.4.2② が「料金改定は既存行を上書きせず、**適用期間を区切って新しい行を追加**する」と
 * 定めている。上書きにすると、過去の予約を開いたときに現在価格で再計算される（§5.6.5）。
 * したがってこの Action は **INSERT しか行わない**。
 *
 * 期間の重なりは DB の `ex_rate_no_overlap`（`0021`）が弾く。ここで先回りして
 * 判定しないのは、判定と保存の間に他の管理者が入れた行を見落とすためである。
 */
export async function createAccommodationRateAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isAdmin(viewer.role)) {
    return { status: "error", message: MESSAGE.denied };
  }

  const roomType = String(formData.get("roomType") ?? "").trim();
  const memberCategory = String(formData.get("memberCategory") ?? "").trim();
  const pricePerNightYen = Number.parseInt(String(formData.get("pricePerNightYen") ?? ""), 10);
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "").trim();
  const effectiveUntil = String(formData.get("effectiveUntil") ?? "").trim();

  if (
    roomType === "" ||
    (memberCategory !== "member" && memberCategory !== "non_member") ||
    !Number.isSafeInteger(pricePerNightYen) ||
    pricePerNightYen < 0 ||
    effectiveFrom === ""
  ) {
    return { status: "error", message: "宿泊形態・会員区分・単価・適用開始日を入力してください。" };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("accommodation_rates").insert({
    room_type: roomType,
    member_category: memberCategory,
    price_per_night_yen: pricePerNightYen,
    effective_from: effectiveFrom,
    effective_until: effectiveUntil === "" ? null : effectiveUntil,
    created_by: viewer.memberId,
  });

  if (error) {
    // 期間の重なり（23P01）もここへ来る。DB のメッセージは出さず、原因を日本語で伝える
    return {
      status: "error",
      message:
        "保存できませんでした。同じ宿泊形態・会員区分で適用期間が重なっていないか確認してください。",
    };
  }

  revalidatePath("/admin/master");
  return { status: "done", message: "宿泊料金を追加しました。" };
}
