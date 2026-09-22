"use server";

import { revalidatePath } from "next/cache";

import { isStaff, readViewer } from "@/lib/auth/session";
import { findDuplicateCandidates } from "@/lib/shopping/duplicate";
import {
  addRequester,
  createShoppingQuest,
  fetchApprovedItems,
  fetchShoppingItems,
  insertShoppingItem,
  updateShoppingItemStatus,
  withdrawShoppingItem,
} from "@/lib/shopping/fetch-items";
import { buildShoppingQuestDraft } from "@/lib/shopping/quest-draft";
import { canRegister, decideStatusChange, type ShoppingAction } from "@/lib/shopping/status";

/**
 * 買い物リストの Server Action（v13 §5.12 ／ WBS 5-8・5-9）。
 *
 * ⚠️ **画面を経由せず直接呼ばれても拒否する**（v13 §5.9.3 の二重防御）。
 * Server Action は URL を持つエンドポイントとして公開されるため、
 * 「ゲストに登録ボタンを描かない」だけでは防御にならない。
 * 判定の根拠は `members.role` のみで、`member_type`（立場）は見ない（CLAUDE.md §4.1）。
 */

export type RegisterFormState = {
  status: "idle" | "saved" | "error" | "duplicate";
  message?: string;
  /** 重複候補。利用者に相乗りか「それでも登録」かを選ばせる（自動マージしない）。 */
  duplicates?: { itemId: string; itemName: string }[];
};

const MESSAGE: Record<string, string> = {
  denied: "この操作を行う権限がありません。",
  guest_denied: "ゲストは買い物リストへ登録できません。",
  blank_name: "品名を入力してください。",
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

/** 「ほしいもの」を登録する（v13 §5.12.1）。必須は品名のみ。 */
export async function registerShoppingItemAction(
  _prev: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: MESSAGE.denied };
  }
  // ★ ゲストは登録できない（v13 §5.12.1 ／ 2026-09-22 オーナー確定）。
  if (!canRegister(viewer.role)) {
    return { status: "error", message: MESSAGE.guest_denied };
  }

  const itemName = String(formData.get("itemName") ?? "").trim();
  if (itemName === "") {
    return { status: "error", message: MESSAGE.blank_name };
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
      };
    }
  }

  const priority = String(formData.get("priority") ?? "通常");
  const saved = await insertShoppingItem({
    itemName,
    quantity: toNumberOrNull(formData.get("quantity")),
    unit: toTextOrNull(formData.get("unit")),
    wantedBy: toTextOrNull(formData.get("wantedBy")),
    purpose: toTextOrNull(formData.get("purpose")),
    sourceHint: toTextOrNull(formData.get("sourceHint")),
    referencePriceJpy: toNumberOrNull(formData.get("referencePriceJpy")),
    priority: priority === "至急" || priority === "いつでも" ? priority : "通常",
    registeredBy: viewer.memberId,
  });

  if (!saved) {
    return { status: "error", message: MESSAGE.failed };
  }

  revalidatePath(PATH);
  return { status: "saved", message: "ほしいものとして登録しました。" };
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
