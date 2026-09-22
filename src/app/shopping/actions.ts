"use server";

import { revalidatePath } from "next/cache";

import { isStaff, readViewer } from "@/lib/auth/session";
import { findDuplicateCandidates } from "@/lib/shopping/duplicate";
import {
  addRequester,
  createShoppingQuest,
  fetchApprovedItems,
  fetchShoppingItems,
  fetchShoppingItemsByIds,
  insertShoppingItem,
  updateShoppingItemFields,
  updateShoppingItemStatus,
  withdrawShoppingItem,
} from "@/lib/shopping/fetch-items";
import { buildShoppingQuestDraft } from "@/lib/shopping/quest-draft";
import { readShopUrlInput } from "@/lib/shopping/shop-url";
import { canRegister, decideEdit, decideStatusChange, type ShoppingAction } from "@/lib/shopping/status";

/**
 * 買い物リストの Server Action（v13 §5.12 ／ WBS 5-8・5-9）。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * Server Action は URL を持つエンドポイントとして公開されるため、
 * 「ゲストに登録ボタンを描かない」だけでは防御にならない。
 * 判定の根拠は `members.role`（権限ロール）だけである。会員種別（立場）は認可に使わない
 * （CLAUDE.md §4.1）。立場で分岐すると、親方の肩書きを持つ街人が運営の操作まで通ってしまう。
 */

/** 入力欄へ書き戻すための値。名前はフォームの `name` 属性と一致させる。 */
export type RegisterFormValues = {
  itemName: string;
  quantity: string;
  unit: string;
  wantedBy: string;
  priority: string;
  referencePriceJpy: string;
  shopName: string;
  shopUrl: string;
  purpose: string;
};

export type RegisterFormState = {
  status: "idle" | "saved" | "error" | "duplicate";
  message?: string;
  /** 重複候補。利用者に相乗りか「それでも登録」かを選ばせる（自動マージしない）。 */
  duplicates?: { itemId: string; itemName: string }[];
  /**
   * 直前の入力値。**再表示のために必ず返す。**
   *
   * React はアクションの完了時にフォームを初期状態へ戻すため、これを返さないと
   * 重複候補を出した瞬間に全入力欄が空になり、「それでも登録する」が品名の
   * `required` で止まる。利用者は打ち直しを強いられ、§5.12.1 の「30秒で登録」が壊れる。
   */
  values?: RegisterFormValues;
};

const MESSAGE: Record<string, string> = {
  denied: "この操作を行う権限がありません。",
  guest_denied: "ゲストは買い物リストへ登録できません。",
  blank_name: "品名を入力してください。",
  bad_shop_url: "入手先URLは http:// または https:// で始まるものを入力してください。",
  blank_reason: "理由を入力してください。",
  not_staff: "買う・見送りの判断は運営のみが行えます。",
  not_owner: "自分が登録した品目のみ取り下げられます。",
  invalid_transition: "その操作はいまの状態では行えません。",
  already_withdrawn: "取り下げ済みの品目です。",
  no_items: "クエスト化する品目を選んでください。",
  not_approved: "「買う」と判断された品目だけをクエストにできます。",
  failed: "保存に失敗しました。時間をおいて再試行してください。",
};

const PATH = "/shopping";

function toNumberOrNull(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  if (text === "") {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTextOrNull(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

/** 優先度は3値のみ（v13 §5.12.1）。それ以外が送られてきたら `通常` に倒す。 */
function toPriority(value: FormDataEntryValue | null): "至急" | "通常" | "いつでも" {
  const text = String(value ?? "");
  return text === "至急" || text === "いつでも" ? text : "通常";
}

/** 入力値をそのまま拾う（検証せず、画面へ書き戻すためだけに使う）。 */
function readFormValues(formData: FormData): RegisterFormValues {
  const text = (key: string) => String(formData.get(key) ?? "");
  return {
    itemName: text("itemName"),
    quantity: text("quantity"),
    unit: text("unit"),
    wantedBy: text("wantedBy"),
    priority: text("priority"),
    referencePriceJpy: text("referencePriceJpy"),
    shopName: text("shopName"),
    shopUrl: text("shopUrl"),
    purpose: text("purpose"),
  };
}

/** 「ほしいもの」を登録する（v13 §5.12.1）。必須は品名のみ。 */
export async function registerShoppingItemAction(
  _prev: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  // 入力値は**どの経路で返っても書き戻す**。打ち直しを強いた時点で登録されなくなる。
  const values = readFormValues(formData);

  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.denied, values };
  }
  // ★ ゲストは登録できない（v13 §5.12.1 ／ 2026-09-22 オーナー確定）。
  if (!canRegister(viewer.role)) {
    return { status: "error", message: MESSAGE.guest_denied, values };
  }

  const itemName = String(formData.get("itemName") ?? "").trim();
  if (itemName === "") {
    return { status: "error", message: MESSAGE.blank_name, values };
  }

  // 開けないURLは保存せず、入力し直してもらう（`shop-url.ts`）。
  // 重複検知より前に弾く。重複候補を出したあとで形式エラーを返すと、選び直しが無駄になる。
  const shopUrl = readShopUrlInput(toTextOrNull(formData.get("shopUrl")));
  if (shopUrl === undefined) {
    return { status: "error", message: MESSAGE.bad_shop_url, values };
  }

  // 重複は「候補を出して相乗りへ誘導する」だけ。自動でまとめない（v13 §5.12.1）。
  const confirmed = String(formData.get("confirmDuplicate") ?? "") === "1";
  if (!confirmed) {
    const duplicates = findDuplicateCandidates(
      itemName,
      (await fetchShoppingItems()).map((item) => ({
        itemId: item.itemId,
        itemName: item.itemName,
        status: item.status,
        withdrawnAt: item.withdrawnAt,
      })),
    );
    if (duplicates.length > 0) {
      return {
        status: "duplicate",
        message: "同じものが既に登録されています。相乗りするか、そのまま登録するかを選んでください。",
        duplicates: duplicates.map((d) => ({ itemId: d.itemId, itemName: d.itemName })),
        values,
      };
    }
  }

  const saved = await insertShoppingItem({
    itemName,
    quantity: toNumberOrNull(formData.get("quantity")),
    unit: toTextOrNull(formData.get("unit")),
    wantedBy: toTextOrNull(formData.get("wantedBy")),
    purpose: toTextOrNull(formData.get("purpose")),
    shopName: toTextOrNull(formData.get("shopName")),
    shopUrl,
    referencePriceJpy: toNumberOrNull(formData.get("referencePriceJpy")),
    priority: toPriority(formData.get("priority")),
    registeredBy: viewer.memberId,
  });

  if (!saved) {
    return { status: "error", message: MESSAGE.failed, values };
  }

  revalidatePath(PATH);
  // 登録できたときだけ入力値を返さない。次の1件を空のフォームから書き始められる。
  return { status: "saved", message: "ほしいものとして登録しました。" };
}

/**
 * 登録した品目の内容を直す（v13 §5.12.1「編集・取下げは登録者本人と運営が行える」）。
 *
 * 通してよい相手は **登録者本人と運営**で、取下げ（`changeShoppingItemStatusAction` の
 * `withdraw`）と同じである。一方で**動かせるのは内容だけ**であり、状態は動かさない。
 * 判定は純関数 `decideEdit()` が持ち、ここは入出力の詰め替えに徹する。
 */
export async function editShoppingItemAction(formData: FormData): Promise<void> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return;
  }

  const itemId = String(formData.get("itemId") ?? "");
  const itemName = String(formData.get("itemName") ?? "").trim();

  const items = await fetchShoppingItemsByIds([itemId]);
  const item = items[0];
  if (item === undefined) {
    return;
  }

  const decision = decideEdit({
    actorRole: viewer.role,
    current: item.status,
    withdrawn: item.withdrawnAt !== null,
    isOwner: item.registeredBy === viewer.memberId,
    itemName,
  });

  if (!decision.allowed) {
    return;
  }

  // 登録と同じ検証を編集にも通す（`shop-url.ts`）。ここが抜けていると、
  // 一度登録した品目を編集するだけで検証を迂回できる。
  const shopUrl = readShopUrlInput(toTextOrNull(formData.get("shopUrl")));
  if (shopUrl === undefined) {
    return;
  }

  await updateShoppingItemFields({
    itemId,
    edit: {
      itemName,
      quantity: toNumberOrNull(formData.get("quantity")),
      unit: toTextOrNull(formData.get("unit")),
      wantedBy: toTextOrNull(formData.get("wantedBy")),
      purpose: toTextOrNull(formData.get("purpose")),
      shopName: toTextOrNull(formData.get("shopName")),
      shopUrl,
      referencePriceJpy: toNumberOrNull(formData.get("referencePriceJpy")),
      priority: toPriority(formData.get("priority")),
    },
  });

  revalidatePath(PATH);
}

/** 「自分も欲しい」（相乗り）。 */
export async function joinShoppingItemAction(formData: FormData): Promise<void> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !canRegister(viewer.role)) {
    return;
  }
  await addRequester(String(formData.get("itemId") ?? ""));
  revalidatePath(PATH);
}

/**
 * 状態を動かす（`買う` / `見送り` / `購入済` / 部分購入の戻し / 取下げ）。
 *
 * 遷移の可否は純関数 `decideStatusChange()` が決める。ここは入出力の詰め替えだけを行う。
 */
export async function changeShoppingItemStatusAction(formData: FormData): Promise<void> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return;
  }

  const itemId = String(formData.get("itemId") ?? "");
  const action = String(formData.get("action") ?? "") as ShoppingAction;
  const reason = String(formData.get("reason") ?? "");

  const items = await fetchApprovedItems([itemId]);
  const item = items[0];
  if (item === undefined) {
    return;
  }

  const decision = decideStatusChange({
    action,
    actorRole: viewer.role,
    current: item.status,
    withdrawn: item.withdrawnAt !== null,
    isOwner: item.registeredBy === viewer.memberId,
    reason,
  });

  if (!decision.allowed) {
    return;
  }

  if (action === "withdraw") {
    await withdrawShoppingItem({ itemId, reason });
  } else {
    await updateShoppingItemStatus({
      itemId,
      next: decision.next,
      decidedBy: viewer.memberId,
      skipReason: reason,
      purchasedBy: viewer.memberId,
    });
  }

  revalidatePath(PATH);
}

/**
 * 選択した品目から買い出しクエストを1件起案する（v13 §5.12.3）。
 *
 * **品目1つにつき1クエストを作らない。** まとめて1件にする。
 */
export async function convertToQuestAction(formData: FormData): Promise<void> {
  const viewer = await readViewer();
  if (!viewer.signedIn || !isStaff(viewer.role)) {
    return;
  }

  const itemIds = formData.getAll("itemIds").map(String).filter((id) => id !== "");
  const items = await fetchApprovedItems(itemIds);

  const draft = buildShoppingQuestDraft({
    items: items.map((item) => ({
      itemId: item.itemId,
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit,
      referencePriceJpy: item.referencePriceJpy,
      status: item.status,
      withdrawnAt: item.withdrawnAt,
    })),
    createdByMemberId: viewer.memberId,
    rewardUii: toNumberOrNull(formData.get("rewardUii")),
    titleOverride: String(formData.get("title") ?? ""),
  });

  if (!draft.ok) {
    return;
  }

  await createShoppingQuest({ row: draft.row, itemIds });
  revalidatePath(PATH);
  revalidatePath("/quests");
}
