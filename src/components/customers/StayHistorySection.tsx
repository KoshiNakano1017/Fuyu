import type { StayHistory } from "@/lib/customers/stay-history";

/**
 * 宿泊履歴（泊まった部屋）（画面ID C11 の「宿泊」タブ ／ WBS 8-6 ／ v13 §5.6.8）。
 *
 * ## 部屋が未割当の滞在は「部屋未割当」と明示する
 *
 * 空欄にしない。空欄だと、**記録漏れなのか、割り当てずに運用したのか**が区別できない
 * （§5.6.8）。現場で「あの日どの部屋だったか」を遡るときに、この差は決定的である。
 *
 * ## 部屋移動を1行に潰さない
 *
 * 移動のあった滞在は、その滞在の下に割当履歴を時系列で展開する。
 * 忘れ物・クレームの追跡は、日付と部屋の対応が正確でなければ役に立たない。
 */
export function StayHistorySection({ history }: { history: StayHistory }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold">宿泊</h2>

      <p className="text-sm text-neutral-700">
        通算 {history.totalNights} 泊
        {history.favoriteRoom === null
          ? ""
          : ` ／ よく使う部屋：${history.favoriteRoom.roomName}（${history.favoriteRoom.times}回）`}
      </p>

      {history.rows.length === 0 ? (
        <p className="text-sm text-neutral-600">宿泊の記録はまだありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {history.rows.map((row) => (
            <li key={row.checkinId} className="rounded border border-neutral-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {row.checkInDate} 〜 {row.checkOutDate}（{row.nights}泊）
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {row.isStaying ? (
                    <span className="rounded bg-green-100 px-2 py-0.5 text-green-800">滞在中</span>
                  ) : null}
                  <span className="rounded bg-neutral-200 px-2 py-0.5">{row.roomType}</span>
                  <span className="text-neutral-600">
                    大人{row.adultsCount}名
                    {row.childrenCount === 0 ? "" : ` ／ 子ども${row.childrenCount}名`}
                  </span>
                </span>
              </div>

              {row.rooms.length === 0 ? (
                <p className="mt-1 text-xs text-neutral-600">部屋未割当</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-neutral-700">
                  {row.rooms.map((room) => (
                    <li key={`${room.checkinId}-${room.startedAt}`}>
                      {room.startedAt.slice(0, 10)} 〜{" "}
                      {room.endedAt === null ? "（継続中）" : room.endedAt.slice(0, 10)}：
                      {room.roomName}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-neutral-500">
        部屋名は<strong>割当時点の名前</strong>で表示します（改名しても過去の履歴は変わりません）。
      </p>
    </section>
  );
}
