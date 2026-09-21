/**
 * 宿泊枠の残数算出（WBS 3-8 ／ v13 §5.2.5① ／ §9 #47）。
 *
 * ## DB のビューと同じ式をなぜ TypeScript にも置くのか
 *
 * 正本は `v_room_availability`（`supabase/migrations/0015_room_availability_view.sql`）である。
 * 一覧表示はビューを読む。ここに同じ式を置くのは**画面が予約を組み立てている最中**のためで、
 * まだ DB に無い予約を含めて「この内容で取れるか」を判定する必要がある
 * （v13 §5.2.3 ③「入力中に残枠を判定し、満室の宿泊形態は選択不可にする」）。
 *
 * 二重実装に見えるが、`countOccupancy()` の値域は
 * `tests/room-availability.test.ts` がビューと同じケースで固定している。
 */

/** 占有量の数え方（`accommodation_types.allocation_mode`）。 */
export type AllocationMode = "per_person" | "per_unit";

/** 残枠の算出対象になる予約。`check_ins` の1行に対応する。 */
export type OccupyingStay = {
  /** 宿泊初日（この日から専有する） */
  checkInDate: string;
  /** 退去日。**この日は専有しない** */
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
};

/** 宿泊形態ごとの収容枠。`rooms` の `status = '利用可'` の行だけから作る。 */
export type AccommodationCapacity = {
  allocationMode: AllocationMode;
  /** 人数枠型の分母＝`SUM(rooms.capacity)` */
  totalCapacity: number;
  /** 棟貸型の分母＝`COUNT(rooms.*)` */
  totalUnits: number;
  /** 棟貸型の1棟あたり定員＝`MAX(rooms.capacity)` */
  unitCapacity: number;
};

export type Availability = {
  total: number;
  occupied: number;
  available: number;
};

/** 1予約あたりの宿泊人数。 */
function headcountOf(stay: OccupyingStay): number {
  return stay.adultsCount + stay.childrenCount;
}

/**
 * ある日付を予約が専有しているか。
 *
 * **退去日は専有しない**（`date < checkOutDate`）。ここを `<=` にすると、
 * 退去日と次の到着日が重なる予約が入らなくなり稼働率が落ちる
 * （`DB物理設計.md` §3-12 が名指しで警告している）。
 */
function occupiesDate(stay: OccupyingStay, date: string): boolean {
  return stay.checkInDate <= date && date < stay.checkOutDate;
}

/**
 * ★ 占有量を数える。**形態によって数え方が2通りある**（v13 §9 #47）。
 *
 * - `per_person`（ドミトリー・キャンプサイト・車中泊）: 予約人数の合計
 * - `per_unit`（コテージ・アースバッグ・サロン）: 占有棟数。
 *   1予約が最低1棟を占め、定員を超える人数は複数棟を消費する
 *
 * 一律の式にすると、コテージで**1名の予約が3件入った時点で実際は3棟すべて埋まっているのに
 * 「残り3名」と表示される**（ダブルブッキング）。逆にドミトリーを件数で数えると、
 * 16床あるのに数件で満室扱いになり枠を使い切れない。
 */
export function countOccupancy(
  stays: readonly OccupyingStay[],
  capacity: AccommodationCapacity,
): number {
  if (capacity.allocationMode === "per_person") {
    return stays.reduce((total, stay) => total + headcountOf(stay), 0);
  }

  // 棟貸型。`unitCapacity` が 0 だと 0 除算になるため、その場合は1予約=1棟として数える。
  // （`rooms` に1行も無い形態では分母も 0 になるので、結果は「満室」に落ち着く）
  return stays.reduce((totalUnits, stay) => {
    const unitsForStay =
      capacity.unitCapacity > 0 ? Math.ceil(headcountOf(stay) / capacity.unitCapacity) : 1;
    return totalUnits + unitsForStay;
  }, 0);
}

/**
 * ある日付・ある宿泊形態の残枠を返す。
 *
 * `stays` には**有効な予約だけ**を渡すこと（キャンセル済み・チェックアウト済みを除く）。
 * 絞り込みを呼び出し側に委ねているのは、DB から引く場合は
 * `ix_check_ins_active_dates` の部分索引で絞るほうが速いためである。
 */
export function calculateAvailability(params: {
  date: string;
  stays: readonly OccupyingStay[];
  capacity: AccommodationCapacity;
}): Availability {
  const { date, stays, capacity } = params;

  const total =
    capacity.allocationMode === "per_person" ? capacity.totalCapacity : capacity.totalUnits;

  const occupyingStays = stays.filter((stay) => occupiesDate(stay, date));
  const occupied = countOccupancy(occupyingStays, capacity);

  // 負値を潰す。運営が定員超過を手で入れた場合に「残り -2」を画面へ出さない（満室は満室）。
  return { total, occupied, available: Math.max(total - occupied, 0) };
}

/**
 * 滞在の全日程で空きがあるか。**1日でも満室なら受け付けない。**
 *
 * 初日だけを見て判定すると、2泊目が満室の予約を通してしまう。
 * v13 §5.2.3 ③「満室の宿泊形態は選択不可にする」は滞在期間全体に対する要求である。
 */
export function canAccommodateStay(params: {
  requested: OccupyingStay;
  existingStays: readonly OccupyingStay[];
  capacity: AccommodationCapacity;
}): boolean {
  const { requested, existingStays, capacity } = params;

  return datesOfStay(requested).every((date) => {
    const { available } = calculateAvailability({ date, stays: existingStays, capacity });
    const requiredUnits = countOccupancy([requested], capacity);
    return available >= requiredUnits;
  });
}

/**
 * 予約が専有する日付の一覧（退去日を含まない）。
 *
 * 日付の加算に `Date` を使うのは、月末・うるう年の繰り上がりを自前で書かないため。
 * UTC で組み立てているのは、ローカルタイムゾーンによって日付が1日ずれるのを避けるため
 * （JST で実行しても UTC で実行しても同じ日付列を返す必要がある）。
 */
export function datesOfStay(stay: OccupyingStay): string[] {
  const dates: string[] = [];
  const checkOut = new Date(`${stay.checkOutDate}T00:00:00Z`);

  for (
    let cursor = new Date(`${stay.checkInDate}T00:00:00Z`);
    cursor < checkOut;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return dates;
}

/** 泊数。残枠ではなく宿泊券の消費数（WBS 3-4）の算出に使う。 */
export function countNights(stay: OccupyingStay): number {
  return datesOfStay(stay).length;
}
