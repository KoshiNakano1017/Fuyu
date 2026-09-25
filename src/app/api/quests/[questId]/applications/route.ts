import { NextResponse } from "next/server";

import { createQuestApplication } from "@/lib/quests/applications";
import { canApplyToQuest } from "@/lib/quests/application-gate";
import { fetchQuestById, readQuestBoardViewer } from "@/lib/quests/fetch-board";

type RouteContext = {
  params: Promise<{ questId: string }>;
};

/**
 * 受け付けられなかったときの文言。**理由で書き分けない**（v13 §5.10.6 末尾）。
 * 事前のゲート拒否と、DB 側の上限ガード（0041）に当たった場合の両方でこれを返す。
 */
const REJECTED_MESSAGE = "このクエストは受注できません";

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
 *
 * ## 登録（WBS 5-2）は 2026-09-21 に追加した
 *
 * `0017_quest_applications_and_work_logs.sql`（受注申請・完了報告の DDL ＋ 遷移ガード）が
 * 入り、ステータス遷移が DB 側で確定したため、暫定実装になる恐れが無くなった。
 * 登録するのは `申請中` の1行だけで、指示・承認は運営の審査画面（画面ID B5）が行う。
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
    return NextResponse.json({ error: REJECTED_MESSAGE }, { status: 403 });
  }

  const result = await createQuestApplication({ questId, memberId: viewer.memberId });

  if (!result.ok) {
    if (result.reason === "duplicate") {
      // 二重申請は「もう申請済み」であることを伝えてよい。本人の自分の状態であり、
      // 施錠クエストの内情を漏らすことにはならない。
      return NextResponse.json({ error: "すでに申請済みです" }, { status: 409 });
    }
    if (result.reason === "unavailable") {
      // 枠が無い場合。ゲート拒否と同じ文言・同じステータスで返す（理由を区別しない）。
      return NextResponse.json({ error: REJECTED_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "受注申請を登録できませんでした" }, { status: 500 });
  }

  return NextResponse.json({ applicationId: result.applicationId }, { status: 201 });
}
