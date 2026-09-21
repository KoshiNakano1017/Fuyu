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
