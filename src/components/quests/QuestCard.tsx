import type { ReactElement } from "react";

import { QuestApplyButton, type QuestApplyAction } from "@/components/quests/QuestApplyButton";
import type { QuestBoardItem } from "@/lib/quests/board";

type QuestCardProps = {
  item: QuestBoardItem;
  /**
   * 街人登録モーダルを開く（WBS 12-1 ／ v13 §5.10.6「施錠カードをタップすると Step 1 を起動」）。
   * 施錠カードでないとき・登録導線が不要な相手（会員・運営）には渡らない。
   */
  onOpenRegistration?: () => void;
  /**
   * 受注申請（WBS 5-2）。渡されないときはボタンを非活性のまま描く
   * （一覧を静的に描くだけの文脈では申請の受け皿が無い）。
   */
  apply?: QuestApplyAction;
};

/** 起案元の表示名。内部識別子（`morning_meeting_auto`）をそのまま画面へ出さない。 */
const ORIGIN_LABELS: Record<QuestBoardItem["originType"], string> = {
  manual: "運営が起案",
  morning_meeting_auto: "朝会から自動抽出",
  shopping_list: "買い物リストから",
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
export function QuestCard({ item, onOpenRegistration, apply }: QuestCardProps): ReactElement {
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

      {apply === undefined ? (
        <button
          type="button"
          disabled
          className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:bg-neutral-300"
        >
          受注を申請する
        </button>
      ) : (
        <QuestApplyButton questId={item.questId} canApply={item.canApply} apply={apply} />
      )}

      {item.opensRegistrationModal &&
        (onOpenRegistration === undefined ? (
          // 導線の受け皿が無い文脈（一覧を静的に描くだけの場合）では、案内文だけを残す。
          <p className="text-xs text-neutral-600">街人登録をすると、このクエストを受注できます。</p>
        ) : (
          // ★ 施錠カードだけがモーダルを起動する（§5.10.6）。
          //    どのカードから開いても内容は同じなので、状態は一覧側が1つだけ持つ。
          <button
            type="button"
            onClick={onOpenRegistration}
            className="self-start text-xs font-medium text-amber-900 underline underline-offset-4"
          >
            街人登録をすると、このクエストを受注できます（登録の案内を見る）
          </button>
        ))}
    </li>
  );
}
