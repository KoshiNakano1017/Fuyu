import { NextResponse } from "next/server";

import { canApplyToQuest } from "@/lib/quests/application-gate";
import { fetchQuestById, readQuestBoardViewer } from "@/lib/quests/fetch-board";

type RouteContext = {
  params: Promise<{ questId: string }>;
};

/**
 * `POST /api/quests/{questId}/applications` — 受注申請（API設計 §138）。
 *
 * ## 本ファイルの範囲は**認可ゲートだけ**である（2026-09-19 オーナー決定 B）
 *
 * v13 §5.10.6 最終行が「サーバ側でも `guest_allowed = false` のクエストに対する
 * ゲストの受注申請APIを拒否する（表示制御のみに依存しない）」と定めているため、
 * 申請の登録（WBS 5-2）より先にこの関門だけを置く。画面の申請ボタンを非活性にするだけでは、
 * `curl` や JS を書き換えた経路で施錠クエストを受注できる窓が開いたままになる。
 *
 * 判定は `canApplyToQuest()` ただ1箇所で行う。画面の申請ボタンの活性も同じ関数を根拠に
 * しており、二重管理しない（v13 §5.9.3）。
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const viewer = await readQuestBoardViewer();
  if (viewer === null) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { questId } = await context.params;
  const quest = await fetchQuestById(questId);
  if (quest === null) {
    return NextResponse.json({ error: "クエストが見つかりません" }, { status: 404 });
  }

  if (!canApplyToQuest(viewer, quest)) {
    // 拒否の理由（施錠なのか締切済みなのか）は返さない。返すと、詳細を伏せている
    // 施錠クエストの状態を推測する手がかりになる（v13 §5.10.6 末尾）。
    return NextResponse.json({ error: "このクエストは受注できません" }, { status: 403 });
  }

  // 受注申請の登録・運営審査・実行指示は WBS 5-2 の範囲。
  // ここで暫定の登録を入れると、ステータス遷移の設計が 5-2 の承認を経ずに決まってしまう。
  return NextResponse.json(
    { error: "受注申請の受付は準備中です" },
    { status: 501 },
  );
}
