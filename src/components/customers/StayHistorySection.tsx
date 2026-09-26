import type { StayHistory, StayHistoryRow } from "@/lib/customers/stay-history";
import { formatCancelledAt, isCancellableStayStatus } from "@/lib/lodging/checkin-ops";

import { StayCancelForm, type StayCancelAction } from "./StayCancelForm";

/**
 * 取り消しフォームを出す行か。
 *
 * 判定は `isCancellableStayStatus()`（Server Action の `decideStayCancellation()` と同じ述語）へ
 * 委ねる。ここに条件を書き写すと、**フォームは出るのに押すと拒否される**食い違いが生まれる。
 */
function canCancel(row: StayHistoryRow): boolean {
  return isCancellableStayStatus(row.status);
}

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
 *
 * ## 取り消した予約は消さず、取消線で残す
 *
 * v13 §7 L2541「キャンセル済みの予約は一覧で取消線表示とし、履歴として残す」。
 * 行ごと消すと「予約したが来なかった」という顧客の履歴が読めなくなり、
 * ノーショーの繰り返しに気づけない。
 */
export function StayHistorySection({
  history,
  cancelStay,
}: {
  history: StayHistory;
  /** 予約の取り消し（WBS 3-3 ／ v13 §5.2.2）。認可は Action 側が持つ */
  cancelStay: StayCancelAction;
}) {
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
                <span className={row.isCancelled ? "font-medium text-neutral-500 line-through" : "font-medium"}>
                  {row.checkInDate} 〜 {row.checkOutDate}（{row.nights}泊）
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {row.isCancelled ? (
                    <span className="rounded bg-red-100 px-2 py-0.5 text-red-800">キャンセル済み</span>
                  ) : null}
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

              {row.isCancelled ? (
                <p className="mt-1 text-xs text-red-800">
                  キャンセル
                  {row.cancelReasonType === null || row.cancelReasonType === undefined
                    ? ""
                    : `（${row.cancelReasonType}）`}
                  {row.cancelledAt === null || row.cancelledAt === undefined
                    ? ""
                    : ` ／ ${formatCancelledAt(row.cancelledAt)}`}
                  {row.cancelReason === null || row.cancelReason === undefined || row.cancelReason === ""
                    ? ""
                    : ` ／ 理由：${row.cancelReason}`}
                </p>
              ) : null}

              {canCancel(row) ? (
                <StayCancelForm checkinId={row.checkinId} cancelStay={cancelStay} />
              ) : null}

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
