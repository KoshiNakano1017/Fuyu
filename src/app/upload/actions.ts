"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import type { SubmitState } from "@/lib/forms/submit-state";
import {
  decideModeration,
  moderationDenialMessage,
  type ModerationAction,
} from "@/lib/media/moderation";
import { fetchMediaState, setMediaVisibility, softDeleteMedia } from "@/lib/media/store";

/**
 * メディアの運営措置（WBS 14-3 ／ v13 §5.11.7 ③ とその警告）。
 *
 * ## ここで止めるのは理由を返すためである
 *
 * 認可の実体は `0027` の RLS（`media_assets_update_self` / `_update_staff`）にある。
 * 画面を経由しない PostgREST 直アクセスはそこで 0行になる。この Action が事前判定するのは、
 * **利用者へ「なぜできないか」を返す**ためと、**理由の入力を強制する**ためである。
 *
 * ## 「見つかりません」で統一する
 *
 * 他人の非公開投稿を指定された場合、RLS 越しに読めないため `null` が返る。
 * ここで「他の人の投稿です」と返すと、**存在そのものが分かってしまう**。
 * 読めなかったときの文言は一律「対象の投稿が見つかりません」にする。
 */
export async function moderateMediaAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: "ログインが必要です。" };
  }

  const mediaId = String(formData.get("mediaId") ?? "").trim();
  const action = String(formData.get("action") ?? "") as ModerationAction;
  const reason = String(formData.get("reason") ?? "");

  if (!isModerationAction(action)) {
    return { status: "error", message: "操作を特定できませんでした。" };
  }

  const current = await fetchMediaState(mediaId);
  if (current === null) {
    return { status: "error", message: "対象の投稿が見つかりません。" };
  }

  const decision = decideModeration({
    actorRole: viewer.role,
    isOwnPost: current.memberId === viewer.memberId,
    action,
    currentVisibility: current.visibility,
    isDeleted: current.isDeleted,
    reason,
  });

  if (!decision.allowed) {
    return { status: "error", message: moderationDenialMessage(decision.reason) };
  }

  const saved =
    action === "delete"
      ? await softDeleteMedia({
          mediaId,
          // ★ 措置した人を必ず残す（`0027` の CHECK が要求している）
          deletedBy: viewer.memberId,
          reason: reason.trim() === "" ? null : reason.trim(),
        })
      : await setMediaVisibility({
          mediaId,
          visibility: action === "hide" ? "運営のみ" : "公開",
        });

  if (!saved) {
    return { status: "error", message: "記録できませんでした。時間をおいて再試行してください。" };
  }

  revalidatePath("/upload");
  return { status: "done", message: MODERATION_DONE_MESSAGES[action] };
}

const MODERATION_DONE_MESSAGES: Record<ModerationAction, string> = {
  hide: "非表示にしました（運営からは引き続き見えます）。",
  unhide: "公開に戻しました。",
  delete: "削除しました。",
};

function isModerationAction(value: string): value is ModerationAction {
  return value === "hide" || value === "unhide" || value === "delete";
}
