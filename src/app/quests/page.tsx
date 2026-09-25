import Link from "next/link";

import { GuestUnlockBanner } from "@/components/quests/GuestUnlockBanner";
import {
  QuestBoardWithRegistration,
  type RegistrationOffer,
} from "@/components/quests/QuestBoardWithRegistration";
import { requireSignedIn } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/session";
import {
  buildMembershipBenefits,
  buildMembershipConfirmationLines,
  decideMembershipApplication,
  MEMBERSHIP_PAYMENT_NOTICE,
  MEMBERSHIP_SUBMIT_LABEL,
} from "@/lib/membership/registration";
import { fetchCurrentSignupPlan, fetchMyActiveApplication } from "@/lib/membership/store";
import { buildQuestBoard } from "@/lib/quests/board";
import { fetchQuestBoardRows, readQuestBoardViewer } from "@/lib/quests/fetch-board";

import { applyForMembershipAction } from "./actions";

/**
 * クエストボード（v13 §5.3-1 ／ WBS 5-1）。
 *
 * 手動起案と朝会からの自動抽出を**1つの一覧**として並べる。起案元はカード上の
 * ラベルに留め、一覧を分けない（分けると「今日やること」が2箇所に散る）。
 *
 * **判定は Server Component で行う。** 施錠クエストの詳細は `buildQuestBoard()` が
 * サーバ側で落としてから描画するため、ブラウザへ一度も届かない（v13 §5.9.3）。
 *
 * ## 街人登録モーダル（WBS 12-1 ／ v13 §5.10.6）
 *
 * 施錠カードからの起動先である。**特典の数値はここで作らず `membership_plans` から引く**
 * （§7「付与数はマスタから取得し、コードに直書きしない」）。
 * 登録導線そのものが要らない相手（会員・運営・申込中の人）には `offer` を渡さない。
 */
export default async function QuestsPage() {
  await requireSignedIn();

  const viewer = await readQuestBoardViewer();
  if (viewer === null) {
    // `requireSignedIn()` を通った直後にここへ来るのは、会員行へ結合されていない場合だけ。
    // 権限を与えず空の一覧を返す（安全側）。
    return <main className="mx-auto max-w-2xl p-6">クエストを表示できませんでした。</main>;
  }

  const { items, banner } = buildQuestBoard(await fetchQuestBoardRows(), viewer);
  const offer = await buildRegistrationOffer(viewer.role, viewer.memberId);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">クエスト</h1>

      {/* 受けた仕事の報告は別画面（画面ID A4 ／ WBS 5-3）。板を混ぜない */}
      <Link href="/reports" className="text-sm underline underline-offset-4">
        受注したクエストの作業報告へ
      </Link>

      {banner !== null && <GuestUnlockBanner banner={banner} />}

      <QuestBoardWithRegistration
        items={items}
        offer={offer}
        apply={applyForMembershipAction}
      />
    </main>
  );
}

/**
 * モーダルへ渡す内容を組む。渡さない（`null`）のは、登録導線が要らない相手である。
 *
 * ★ 申込中の申請があるときは**内容を出したうえで状態を見せる**（v13 §5.10.3
 * 「同一ユーザーの申込中レコードが既に存在する場合は新規作成せず既存を表示する」）。
 * ここで `null` にしてしまうと、申請した本人が自分の申請状態を確かめられなくなる。
 */
async function buildRegistrationOffer(
  role: Role,
  memberId: string,
): Promise<RegistrationOffer | null> {
  const [plan, active] = await Promise.all([
    fetchCurrentSignupPlan(),
    fetchMyActiveApplication(memberId),
  ]);

  const decision = decideMembershipApplication({
    actorRole: role,
    hasActiveApplication: active !== null,
    plan,
  });

  // 会員・運営（`already_member`）とプラン未取得には導線を出さない。
  // 申込中（`already_applied`）だけは、状態を見せるために出す。
  if (plan === null) {
    return null;
  }
  if (!decision.allowed && decision.reason !== "already_applied") {
    return null;
  }

  return {
    annualFeeYen: plan.annualFeeYen,
    benefits: buildMembershipBenefits(plan),
    confirmationLines: buildMembershipConfirmationLines(plan),
    paymentNotice: MEMBERSHIP_PAYMENT_NOTICE,
    submitLabel: MEMBERSHIP_SUBMIT_LABEL,
    activeStatus: active === null ? null : active.status,
  };
}
