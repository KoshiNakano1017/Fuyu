"use server";

import { revalidatePath } from "next/cache";

import { readViewer } from "@/lib/auth/session";
import { decideConfirmReceipt } from "@/lib/eumo/grants";
import { fetchGrantStatus, markGrantReceived } from "@/lib/eumo/store";
import type { SubmitState } from "@/lib/forms/submit-state";

/**
 * 本人による Eumo 給付の受領報告（WBS 8-4 ／ v13 §5.3.1 の 2026-08-29 拡張）。
 *
 * ## 本人に許すのは1遷移だけ
 *
 * 「送付済 → 受領確認済」以外は通さない。金額・用途・送付の記録は触れない。
 * これは画面の作りではなく **`0032` のトリガー**が守っている。
 * ここで止めるのは利用者へ理由を返すためで、画面を経由しない呼び出しは DB が 42501 で拒否する。
 *
 * ## 「受け取っていないのに押してしまった」を救う手は用意しない
 *
 * 受領確認済からの巻き戻しは運営の操作である（本人が戻せると、
 * 受領の記録が本人の操作だけで往復してしまい、追跡の意味が無くなる）。
 * 押し間違えたときは運営へ申し出る運用とし、画面にもそう書く。
 */
export async function reportGrantReceiptAction(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return { status: "error", message: "ログインが必要です。" };
  }

  const grantId = String(formData.get("grantId") ?? "").trim();
  const status = await fetchGrantStatus(grantId);
  if (status === null) {
    // RLS（`eumo_select_self`）越しに読めない＝自分の給付ではない場合もここへ来る。
    // 「他人の給付です」とは返さない（他人の給付の存在が分かってしまう）。
    return { status: "error", message: "対象の給付が見つかりません。" };
  }

  const decision = decideConfirmReceipt({
    actorRole: viewer.role,
    status,
    isRecipientSelf: true,
  });
  if (!decision.allowed) {
    const message =
      decision.reason === "already_received"
        ? "この給付は既に受領済みです。"
        : "まだ運営から送付されていません。届いてから報告してください。";
    return { status: "error", message };
  }

  // ★ 確認者を自分にする。`0032` のトリガーが「受領報告の確認者は本人」を要求している。
  const saved = await markGrantReceived({ grantId, confirmedBy: viewer.memberId });
  if (!saved) {
    return { status: "error", message: "記録できませんでした。時間をおいて再試行してください。" };
  }

  revalidatePath("/me");
  revalidatePath("/staff/eumo");
  return { status: "done", message: "受領を報告しました。ありがとうございます。" };
}
