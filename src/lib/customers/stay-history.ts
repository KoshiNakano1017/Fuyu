/**
 * 宿泊履歴（泊まった部屋）の組み立て（WBS 8-6 ／ v13 §5.6.8）。
 *
 * 2026-08-25 レビューの「顧客管理画面で顧客がこれまでどの部屋に泊まったかわかるように」への対応。
 * 記録自体は `room_assignments`（`0006`）にあるが、**過去の滞在で使った部屋を遡る導線が無かった**。
 *
 * ## 部屋移動のあった滞在を1行に潰さない
 *
 * §5.6.8 は「1行に潰さず、その滞在の下に割当履歴を時系列で展開する」と定める。
 * 用途のうち**忘れ物・クレームの追跡**（「先週アースバッグにあった充電器」から人を辿る）は、
 * 日付と部屋の対応が正確でなければ成立しないためである。
 *
 * ## 部屋名は「当時の名前」で出す
 *
 * `room_assignments.room_name_snapshot`（`0006`）を使い、`rooms` の現在名を引かない。
 * 引くと、部屋を改名した瞬間に**去年の履歴まで新しい名前で表示される**（§5.6.8 の [!warning]）。
 */

/** 滞在中の部屋割当1件。 */
export type RoomAssignmentEntry = {
  checkinId: string;
  /** 割当時点の部屋名（改名の影響を受けない） */
  roomName: string;
  startedAt: string;
  endedAt: string | null;
};

/** `check_ins` 1行ぶんの滞在。 */
export type StayRecord = {
  checkinId: string;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
  status: string;
  /** 取り消した日時。`null`／未指定なら取り消されていない（v13 §5.2.2「削除方式」） */
  cancelledAt?: string | null;
  /** 取り消しの種別（`会員都合` / `ノーショー` / `運営都合`） */
  cancelReasonType?: string | null;
  /** 取り消しの自由記述理由（v13 §5.2.2「理由入力」＝必須） */
  cancelReason?: string | null;
};

export type StayHistoryRow = StayRecord & {
  nights: number;
  isStaying: boolean;
  /** 取り消された滞在。**行は消さず取消線で出す**（v13 §7 L2541 ／ §5.6.8） */
  isCancelled: boolean;
  /** その滞在で使った部屋。**空なら「部屋未割当」**（空欄にしない／§5.6.8） */
  rooms: RoomAssignmentEntry[];
};

export type StayHistory = {
  rows: StayHistoryRow[];
  /** 通算の泊数（来訪した滞在のみ） */
  totalNights: number;
  /** よく使う部屋。同率なら名前順で1つに決める（表示がぶれないように） */
  favoriteRoom: { roomName: string; times: number } | null;
};

/**
 * 泊数。チェックアウト日 − チェックイン日。
 *
 * **日付の差**であって滞在した時間ではない。同日中に入って出た場合（日帰り）は 0 になるが、
 * それを 1 に切り上げない——「0泊」は宿泊していない事実であり、通算泊数へ足してはいけない。
 */
export function nightsBetween(checkInDate: string, checkOutDate: string): number {
  const from = new Date(`${checkInDate}T00:00:00Z`).getTime();
  const to = new Date(`${checkOutDate}T00:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
    return 0;
  }
  return Math.round((to - from) / 86_400_000);
}

/**
 * 滞在と部屋割当を突き合わせて履歴を作る。
 *
 * 並びは**チェックイン日の新しい順**（§5.6.8）。
 * 予約段階（`pre_registered` / `confirmed`）とキャンセルは**通算泊数に数えない**
 * （まだ泊まっていない、あるいは泊まらなかったため）。行としては出す——
 * 「予約したが来なかった」ことも顧客の履歴だからである。
 */
export function buildStayHistory(params: {
  stays: readonly StayRecord[];
  assignments: readonly RoomAssignmentEntry[];
}): StayHistory {
  const rows = [...params.stays]
    .sort((left, right) => right.checkInDate.localeCompare(left.checkInDate))
    .map((stay) => ({
      ...stay,
      nights: nightsBetween(stay.checkInDate, stay.checkOutDate),
      isStaying: stay.status === "staying",
      // 取り消しは `status` で判定する。`cancelled_at` は `0014` で後から入った列であり、
      // それ以前にキャンセルされた行では空のことがある（列が空でも取消の事実は消えない）。
      isCancelled: stay.status === "cancelled",
      rooms: params.assignments
        .filter((assignment) => assignment.checkinId === stay.checkinId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    }));

  const visited = rows.filter((row) => row.status === "staying" || row.status === "checked_out");

  return {
    rows,
    totalNights: visited.reduce((total, row) => total + row.nights, 0),
    favoriteRoom: pickFavoriteRoom(visited.flatMap((row) => row.rooms)),
  };
}

function pickFavoriteRoom(
  assignments: readonly RoomAssignmentEntry[],
): { roomName: string; times: number } | null {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    counts.set(assignment.roomName, (counts.get(assignment.roomName) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return null;
  }

  // 同率のときは名前順で決める。決め手を置かないと、読み出すたびに「よく使う部屋」が入れ替わる。
  const [roomName, times] = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  return { roomName, times };
}
