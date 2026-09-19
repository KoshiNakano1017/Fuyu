import type { ReactElement } from "react";

import type { QuestBoardItem } from "@/lib/quests/board";

type QuestCardProps = {
  item: QuestBoardItem;
};

/** 起案元の表示名。内部識別子（`morning_meeting_auto`）をそのまま画面へ出さない。 */
const ORIGIN_LABELS: Record<QuestBoardItem["originType"], string> = {
  manual: "運営が起案",
  morning_meeting_auto: "朝会から自動抽出",
};

/**
 * クエストボードの1枚。
 *
 * ## 施錠カードは「隠す」のではなく「見せて止める」
 *
 * v13 §5.10.6 は §5.9 の「権限外は DOM ごと非表示」とは**逆**の扱いを定めている。
 * ゲストにも行を見せ、`🔒 街人登録で解放` を重ねて申請ボタンを非活性にする。
 * 見せずに隠すと、登録すると何ができるようになるかが伝わらない。
 *
 * ## ただし詳細は最初から**届いていない**
 *
 * 報酬額・指示内容・担当者情報は `buildQuestBoard()` がサーバ側でキーごと落としている。
 * ここで `hidden` にしているのではないため、開発者ツールから読むこともできない
 * （DOM 非表示は認可ではない／v13 §5.9.3）。
 */
export function QuestCard({ item }: QuestCardProps): ReactElement {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-bold">{item.title}</h2>
        {item.badge !== null && (
          <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700">
            {item.badge}
          </span>
        )}
      </div>

      <p className="text-xs text-neutral-500">{ORIGIN_LABELS[item.originType]}</p>

      {item.description !== undefined && item.description !== null && (
        <p className="text-sm text-neutral-700">{item.description}</p>
      )}

      {item.rewardUii !== undefined && item.rewardUii !== null && (
        <p className="text-sm">報酬 {item.rewardUii.toLocaleString("ja-JP")} Uii</p>
      )}

      <button
        type="button"
        disabled={!item.canApply}
        className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:bg-neutral-300"
      >
        受注を申請する
      </button>

      {item.opensRegistrationModal && (
        // 街人登録モーダル（§5.10.1 Step 1）本体は WBS 12-1 の成果物であり、ここでは導線だけを置く。
        <p className="text-xs text-neutral-600">街人登録をすると、このクエストを受注できます。</p>
      )}
    </li>
  );
}
