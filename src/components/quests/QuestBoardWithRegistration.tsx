"use client";

import { useState } from "react";

import { RegistrationModal, type ApplyAction } from "@/components/membership/RegistrationModal";
import type { QuestApplyAction } from "@/components/quests/QuestApplyButton";
import { QuestCard } from "@/components/quests/QuestCard";
import type { QuestBoardItem } from "@/lib/quests/board";

export type RegistrationOffer = {
  annualFeeYen: number;
  benefits: readonly string[];
  confirmationLines: readonly string[];
  paymentNotice: string;
  submitLabel: string;
  activeStatus: string | null;
};

/**
 * クエストボードの一覧と街人登録モーダル（WBS 5-1 ＋ 12-1）。
 *
 * ## モーダルは一覧に1つだけ持つ
 *
 * v13 §5.10.6 は「施錠カードをタップすると Step 1 モーダルを起動する」と定めている。
 * カードごとにモーダルを持つと、開いている枚数ぶん状態が増える（閉じ忘れ・二重表示の温床）。
 * 起動元はどのカードでも同じ内容なので、**状態はここに1つ**置く。
 *
 * ## 判定は持ち込まない
 *
 * どのカードが施錠されているか（`isLocked` / `opensRegistrationModal`）はサーバ側の
 * `buildQuestBoard()` が決めており、報酬額・指示内容はそこでキーごと落ちている。
 * このコンポーネントは**受け取った通りに描くだけ**で、ロールを見ない（v13 §5.9.3）。
 *
 * `offer` が `null` のときはモーダルを出さない（会員・運営には登録導線が要らない）。
 */
export function QuestBoardWithRegistration({
  items,
  offer,
  apply,
  applyToQuest,
}: {
  items: readonly QuestBoardItem[];
  offer: RegistrationOffer | null;
  /** 街人登録の申請（WBS 12-1） */
  apply: ApplyAction;
  /** 受注申請（WBS 5-2） */
  applyToQuest: QuestApplyAction;
}) {
  const [isModalOpen, setModalOpen] = useState(false);

  return (
    <>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <QuestCard
            key={item.questId}
            item={item}
            onOpenRegistration={
              offer !== null && item.opensRegistrationModal ? () => setModalOpen(true) : undefined
            }
            apply={applyToQuest}
          />
        ))}
      </ul>

      {offer === null ? null : (
        <RegistrationModal
          open={isModalOpen}
          onClose={() => setModalOpen(false)}
          annualFeeYen={offer.annualFeeYen}
          benefits={offer.benefits}
          confirmationLines={offer.confirmationLines}
          paymentNotice={offer.paymentNotice}
          submitLabel={offer.submitLabel}
          activeStatus={offer.activeStatus}
          apply={apply}
        />
      )}
    </>
  );
}
