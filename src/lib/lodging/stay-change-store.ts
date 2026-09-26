/**
 * 滞在の変更（WBS 3-10 ／ v13 §5.6.9）の読み書き。判定は `stay-changes.ts`（純関数）にある。
 *
 * ## 書き込みは3か所へ届く
 *
 * | 先 | 何のため |
 * | --- | --- |
 * | `check_in_changes`（`0041`） | 誰が・いつ・何を・なぜ変えたか。**過去の夜の形態はここからしか復元できない** |
 * | `check_ins` | 現在の形態・日程・人数。残枠ビューと画面が「今の姿」として読む |
 * | `room_assignments`（`0006`） | 部屋の移動。旧割当を `ended_at` で閉じ、新しい行を積む（上書きしない） |
 *
 * ## トランザクションが張れないことを前提に、履歴を先に積む
 *
 * supabase-js には複数文をまとめる手段が無い（RPC を作れば張れるが、`0041` に
 * 手続きを増やすより順序で担保するほうが読める）。順序は **履歴 → 本体 → 部屋**である。
 * 途中で落ちた場合に残るのは「履歴はあるが本体が古い」状態で、これは画面上に
 * 変更前の内容と変更履歴の両方が並ぶため**運営が気づいて直せる**。
 * 逆順にすると「本体だけ変わって理由が無い」＝ §5.6.9 の理由必須が事後に破れた状態になり、
 * 誰にも気づかれない。
 */

import { createServerSupabaseClient } from "@/lib/supabase/server";

import type { AccommodationCapacity, AllocationMode } from "./availability";
import type {
  NightlyStay,
  StayChangeDiff,
  StayChangeInput,
  StayChangeLogEntry,
  StayForChange,
} from "./stay-changes";
import { nightlyRoomTypes } from "./stay-changes";

/** 変更を受け付ける状態（`stay-changes.ts` の `CHANGEABLE_STATUSES` と揃える）。 */
const CHANGEABLE_STATUSES = ["pre_registered", "confirmed", "staying"] as const;

type CheckInRow = {
  checkin_id: string;
  member_id: string;
  room_type: string;
  check_in_date: string;
  check_out_date: string;
  adults_count: number;
  children_count: number;
  status: StayForChange["status"];
};

/** 選択肢に出す部屋（`rooms` の `status = '利用可'` のみ）。 */
export type RoomOption = {
  roomId: string;
  roomName: string;
  roomType: string;
  capacity: number;
};

/**
 * ある会員の「変更できる滞在」を読む（予約済み・滞在中）。
 *
 * 現在の割当部屋（`ended_at IS NULL`）も一緒に返す。部屋を選び直す画面で
 * 「今どこにいるか」を出さないと、移動先を選ぶ判断ができない。
 */
export async function fetchChangeableStays(memberId: string): Promise<StayForChange[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    .eq("member_id", memberId)
    .is("cancelled_at", null)
    .in("status", CHANGEABLE_STATUSES)
    .order("check_in_date", { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as CheckInRow[];
  const assignments = await fetchCurrentAssignments(rows.map((row) => row.checkin_id));

  return rows.map((row) => {
    const assignment = assignments.get(row.checkin_id);
    return {
      checkinId: row.checkin_id,
      status: row.status,
      roomType: row.room_type,
      checkInDate: row.check_in_date,
      checkOutDate: row.check_out_date,
      adultsCount: row.adults_count,
      childrenCount: row.children_count,
      roomId: assignment?.roomId ?? null,
      roomName: assignment?.roomName ?? null,
    };
  });
}

/** 1件の滞在を読む。Server Action は**画面が渡した値を信じない**ため、必ずここで引き直す。 */
export async function fetchStayForChange(checkinId: string): Promise<StayForChange | null> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    .eq("checkin_id", checkinId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const row = data as CheckInRow;
  const assignment = (await fetchCurrentAssignments([row.checkin_id])).get(row.checkin_id);

  return {
    checkinId: row.checkin_id,
    status: row.status,
    roomType: row.room_type,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    adultsCount: row.adults_count,
    childrenCount: row.children_count,
    roomId: assignment?.roomId ?? null,
    roomName: assignment?.roomName ?? null,
  };
}

/** 滞在の持ち主（変更後に顧客ページを再検証するために要る）。 */
export async function fetchStayOwner(checkinId: string): Promise<string | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("check_ins")
    .select("member_id")
    .eq("checkin_id", checkinId)
    .maybeSingle();

  return (data as { member_id: string } | null)?.member_id ?? null;
}

async function fetchCurrentAssignments(
  checkinIds: readonly string[],
): Promise<Map<string, { roomId: string; roomName: string }>> {
  const current = new Map<string, { roomId: string; roomName: string }>();
  if (checkinIds.length === 0) {
    return current;
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("room_assignments")
    .select("check_in_id, room_id, room_name_snapshot, started_at")
    .in("check_in_id", checkinIds)
    .is("ended_at", null)
    .order("started_at", { ascending: true });

  for (const row of (data ?? []) as {
    check_in_id: string;
    room_id: string;
    room_name_snapshot: string;
  }[]) {
    // 同時に2部屋へ割り当てられている状態は想定外だが、**最後の行を採る**（時系列の最新）。
    current.set(row.check_in_id, { roomId: row.room_id, roomName: row.room_name_snapshot });
  }
  return current;
}

/** 選択肢に出す部屋。`利用可` 以外を出すと、メンテナンス中の部屋へ人を入れてしまう（v13 §5.2.1）。 */
export async function fetchRoomOptions(): Promise<RoomOption[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("rooms")
    .select("room_id, room_name, room_type, capacity")
    .eq("status", "利用可")
    .order("room_type", { ascending: true })
    .order("room_name", { ascending: true });

  return ((data ?? []) as {
    room_id: string;
    room_name: string;
    room_type: string;
    capacity: number;
  }[]).map((row) => ({
    roomId: row.room_id,
    roomName: row.room_name,
    roomType: row.room_type,
    capacity: row.capacity,
  }));
}

/**
 * 宿泊形態ごとの収容枠。`v_room_availability`（`0015`・`0041`）の `cap` CTE と同じ式である。
 *
 * ビューをそのまま読めない理由は `availability.ts` の冒頭と同じで、
 * ここでは**自分の滞在を除いた残枠**を数える必要があるためである
 * （ビューは自分の占有を含んだ集計値しか返さない）。
 */
export async function fetchCapacities(): Promise<Map<string, AccommodationCapacity>> {
  const supabase = await createServerSupabaseClient();
  const [{ data: typeRows }, { data: roomRows }] = await Promise.all([
    supabase.from("accommodation_types").select("room_type, allocation_mode"),
    supabase.from("rooms").select("room_type, capacity").eq("status", "利用可"),
  ]);

  const modes = new Map<string, AllocationMode>(
    ((typeRows ?? []) as { room_type: string; allocation_mode: AllocationMode }[]).map((row) => [
      row.room_type,
      row.allocation_mode,
    ]),
  );

  const capacities = new Map<string, AccommodationCapacity>();
  for (const row of (roomRows ?? []) as { room_type: string; capacity: number }[]) {
    const mode = modes.get(row.room_type);
    if (mode === undefined) {
      continue;
    }
    const current = capacities.get(row.room_type) ?? {
      allocationMode: mode,
      totalCapacity: 0,
      totalUnits: 0,
      unitCapacity: 0,
    };
    capacities.set(row.room_type, {
      allocationMode: mode,
      totalCapacity: current.totalCapacity + row.capacity,
      totalUnits: current.totalUnits + 1,
      unitCapacity: Math.max(current.unitCapacity, row.capacity),
    });
  }
  return capacities;
}

/**
 * ★ **自分以外**の滞在が、期間内の各夜に占めている枠を展開する。
 *
 * 夜ごとの形態は変更履歴から復元する（`nightlyRoomTypes()`）。現在の形態で全泊を数えると、
 * 「明日からコテージへ移る」他人の予約が**今夜のコテージまで埋めてしまい**、
 * 本来入れる変更を満室として弾く（`0041` の残枠ビューと同じ理屈）。
 */
export async function fetchOtherStayNights(params: {
  /** 除外する滞在（自分自身）。**新規予約の判定では null**（除外するものが無い） */
  excludeCheckinId: string | null;
  fromDate: string;
  toDate: string;
}): Promise<NightlyStay[]> {
  const supabase = await createServerSupabaseClient();

  const query = supabase
    .from("check_ins")
    .select(
      "checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count, children_count, status",
    )
    .gt("check_out_date", params.fromDate)
    .lte("check_in_date", params.toDate)
    .is("cancelled_at", null)
    .in("status", CHANGEABLE_STATUSES);

  const { data, error } =
    params.excludeCheckinId === null
      ? await query
      : await query.neq("checkin_id", params.excludeCheckinId);

  if (error || !data) {
    // 読めないときに「空いている」として返すと、満室の枠へ変更を通してしまう。
    // 判定側が扱える形にするため、ここでは throw して操作そのものを止める。
    throw new Error("他の滞在を取得できませんでした");
  }

  const rows = data as CheckInRow[];
  const logs = await fetchStayChangeLogs(rows.map((row) => row.checkin_id));

  return rows.flatMap((row) =>
    nightlyRoomTypes({
      stay: {
        checkInDate: row.check_in_date,
        checkOutDate: row.check_out_date,
        roomType: row.room_type,
      },
      changes: logs.get(row.checkin_id) ?? [],
    }).map((night) => ({
      date: night.date,
      roomType: night.roomType,
      // ⚠️ 人数は現在値で数える。夜ごとの人数まで遡ると、残枠の判定が
      //    `v_check_in_nights`（DB 側）と一致していることを試験で固定しにくくなるため、
      //    ここは**安全側（増えた人数で数える）**に倒す。
      adultsCount: row.adults_count,
      childrenCount: row.children_count,
    })),
  );
}

/** 変更履歴（画面表示用 ／ 新しい順）。操作者は `v_member_public` の表示名で出す（実名は出さない）。 */
export async function fetchStayChangeHistory(
  checkinIds: readonly string[],
): Promise<Map<string, StayChangeLogEntry[]>> {
  const history = new Map<string, StayChangeLogEntry[]>();
  if (checkinIds.length === 0) {
    return history;
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("check_in_changes")
    .select(
      "change_id, checkin_id, effective_date, room_type_before, room_type_after, check_out_date_before, check_out_date_after, adults_before, adults_after, children_before, children_after, reason, changed_by, created_at",
    )
    .in("checkin_id", checkinIds)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    change_id: string;
    checkin_id: string;
    effective_date: string;
    room_type_before: string | null;
    room_type_after: string | null;
    check_out_date_before: string | null;
    check_out_date_after: string | null;
    adults_before: number | null;
    adults_after: number | null;
    children_before: number | null;
    children_after: number | null;
    reason: string;
    changed_by: string;
    created_at: string;
  }[];

  const labels = await fetchMemberLabels(rows.map((row) => row.changed_by));

  for (const row of rows) {
    const entries = history.get(row.checkin_id) ?? [];
    entries.push({
      changeId: row.change_id,
      effectiveDate: row.effective_date,
      roomTypeBefore: row.room_type_before,
      roomTypeAfter: row.room_type_after,
      checkOutDateBefore: row.check_out_date_before,
      checkOutDateAfter: row.check_out_date_after,
      adultsBefore: row.adults_before,
      adultsAfter: row.adults_after,
      childrenBefore: row.children_before,
      childrenAfter: row.children_after,
      reason: row.reason,
      changedByLabel: labels.get(row.changed_by) ?? "（表示名なし）",
      createdAt: row.created_at,
    });
    history.set(row.checkin_id, entries);
  }
  return history;
}

/** 夜ごとの形態を復元するために要る最小限の履歴（表示用の `fetchStayChangeHistory` より軽い）。 */
async function fetchStayChangeLogs(
  checkinIds: readonly string[],
): Promise<Map<string, { effectiveDate: string; roomTypeBefore: string | null; roomTypeAfter: string | null; createdAt: string }[]>> {
  const logs = new Map<
    string,
    { effectiveDate: string; roomTypeBefore: string | null; roomTypeAfter: string | null; createdAt: string }[]
  >();
  if (checkinIds.length === 0) {
    return logs;
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("check_in_changes")
    .select("checkin_id, effective_date, room_type_before, room_type_after, created_at")
    .in("checkin_id", checkinIds)
    .order("effective_date", { ascending: true });

  for (const row of (data ?? []) as {
    checkin_id: string;
    effective_date: string;
    room_type_before: string | null;
    room_type_after: string | null;
    created_at: string;
  }[]) {
    const entries = logs.get(row.checkin_id) ?? [];
    entries.push({
      effectiveDate: row.effective_date,
      roomTypeBefore: row.room_type_before,
      roomTypeAfter: row.room_type_after,
      createdAt: row.created_at,
    });
    logs.set(row.checkin_id, entries);
  }
  return logs;
}

async function fetchMemberLabels(memberIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) {
    return new Map();
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("v_member_public")
    .select("member_id, display_name")
    .in("member_id", unique);

  const labels = new Map<string, string>();
  for (const row of (data ?? []) as { member_id: string; display_name: string | null }[]) {
    if (row.display_name !== null) {
      labels.set(row.member_id, row.display_name);
    }
  }
  return labels;
}

/**
 * 変更を書き込む。履歴 → 本体 → 部屋の順（冒頭の理由）。
 *
 * 戻り値は「どこまで進んだか」である。部屋の移動だけが落ちた場合に
 * 「変更は通ったが部屋が古い」ことを画面へ伝えるため、真偽値1つに潰さない。
 */
export async function applyStayChange(params: {
  stay: StayForChange;
  input: StayChangeInput;
  diff: StayChangeDiff;
  operatorId: string;
}): Promise<{ logged: boolean; updated: boolean; roomMoved: boolean }> {
  const { stay, input, diff, operatorId } = params;
  const supabase = await createServerSupabaseClient();

  const { error: logError } = await supabase.from("check_in_changes").insert({
    checkin_id: stay.checkinId,
    effective_date: input.effectiveDate,
    room_type_before: diff.roomType?.before ?? null,
    room_type_after: diff.roomType?.after ?? null,
    check_out_date_before: diff.checkOutDate?.before ?? null,
    check_out_date_after: diff.checkOutDate?.after ?? null,
    adults_before: diff.adults?.before ?? null,
    adults_after: diff.adults?.after ?? null,
    children_before: diff.children?.before ?? null,
    children_after: diff.children?.after ?? null,
    room_id_after: diff.room?.after ?? null,
    reason: input.reason.trim(),
    changed_by: operatorId,
  });
  if (logError !== null) {
    return { logged: false, updated: false, roomMoved: false };
  }

  const { error: updateError } = await supabase
    .from("check_ins")
    .update({
      room_type: input.roomType,
      check_out_date: input.checkOutDate,
      adults_count: input.adultsCount,
      children_count: input.childrenCount,
      updated_at: new Date().toISOString(),
    })
    .eq("checkin_id", stay.checkinId);
  if (updateError !== null) {
    return { logged: true, updated: false, roomMoved: false };
  }

  if (diff.room === null) {
    return { logged: true, updated: true, roomMoved: false };
  }

  const roomMoved = await moveRoomAssignment({
    checkinId: stay.checkinId,
    nextRoomId: diff.room.after,
    // 割当が1件も無かった滞在への割当は「初回」である（`0006` の `chk_assignments_reason` は2値）。
    // 何でも「部屋移動」にすると、履歴から「移動したのか、最初から入ったのか」が読めなくなる。
    isFirstAssignment: diff.room.before === null,
  });
  return { logged: true, updated: true, roomMoved };
}

/**
 * 部屋割当を移す。**旧い行を書き換えない**（`ended_at` を入れて閉じ、新しい行を積む ／ v13 §5.2.1・§5.6.8）。
 *
 * 部屋名は**割当時点の名前**をコピーする（`room_name_snapshot`）。`rooms` を参照に置き換えると、
 * 改名した瞬間に過去の履歴まで新しい名前で表示される（§5.6.8 の [!warning]）。
 */
async function moveRoomAssignment(params: {
  checkinId: string;
  nextRoomId: string;
  isFirstAssignment: boolean;
}): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("room_name")
    .eq("room_id", params.nextRoomId)
    .maybeSingle();

  const roomName = (room as { room_name: string } | null)?.room_name;
  if (roomName === undefined) {
    return false;
  }

  const closedAt = new Date().toISOString();
  const { error: closeError } = await supabase
    .from("room_assignments")
    .update({ ended_at: closedAt })
    .eq("check_in_id", params.checkinId)
    .is("ended_at", null);
  if (closeError !== null) {
    return false;
  }

  const { error: insertError } = await supabase.from("room_assignments").insert({
    check_in_id: params.checkinId,
    room_id: params.nextRoomId,
    room_name_snapshot: roomName,
    started_at: closedAt,
    assignment_reason: params.isFirstAssignment ? "初回" : "部屋移動",
  });

  return insertError === null;
}
