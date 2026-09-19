import { NextResponse } from "next/server";

import { buildQuestBoard } from "@/lib/quests/board";
import { fetchQuestBoardRows, readQuestBoardViewer } from "@/lib/quests/fetch-board";

/**
 * `GET /api/quests` — クエストボード（API設計 §136）。
 *
 * **JWT 必須**。`/api/public/*` ではないため未ログインには何も返さない（API設計 §50）。
 *
 * 返す内容は画面と同じ `buildQuestBoard()` の結果である。ゲストの施錠クエストには
 * 報酬額・指示内容・担当者情報が**キーごと含まれない**（v13 §5.10.6 末尾）。
 * 画面用と API 用で組み立てを分けると、片方だけ詳細が漏れる。
 */
export async function GET(): Promise<NextResponse> {
  const viewer = await readQuestBoardViewer();
  if (viewer === null) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const board = buildQuestBoard(await fetchQuestBoardRows(), viewer);
  return NextResponse.json(board);
}
