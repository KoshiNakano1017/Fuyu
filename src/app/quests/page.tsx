import { GuestUnlockBanner } from "@/components/quests/GuestUnlockBanner";
import { QuestCard } from "@/components/quests/QuestCard";
import { requireSignedIn } from "@/lib/auth/guard";
import { buildQuestBoard } from "@/lib/quests/board";
import { fetchQuestBoardRows, readQuestBoardViewer } from "@/lib/quests/fetch-board";

/**
 * クエストボード（v13 §5.3-1 ／ WBS 5-1）。
 *
 * 手動起案と朝会からの自動抽出を**1つの一覧**として並べる。起案元はカード上の
 * ラベルに留め、一覧を分けない（分けると「今日やること」が2箇所に散る）。
 *
 * **判定は Server Component で行う。** 施錠クエストの詳細は `buildQuestBoard()` が
 * サーバ側で落としてから描画するため、ブラウザへ一度も届かない（v13 §5.9.3）。
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

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">クエスト</h1>

      {banner !== null && <GuestUnlockBanner banner={banner} />}

      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <QuestCard key={item.questId} item={item} />
        ))}
      </ul>
    </main>
  );
}
