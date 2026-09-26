/**
 * 滞在中の宿泊形態・部屋・日程・人数の変更（WBS 3-10 ／ v13 §5.6.9 ／ §9 #50）。
 *
 * 2026-08-25 のプロトタイプ確認で出た「顧客管理画面で宿泊形態をいじれない」への対応。
 * 現地で「やっぱりキャンプサイトからコテージへ移りたい」が起きたときの導線である。
 *
 * ## 守るべき性質は3つで、どれも黙って破られうる
 *
 * | 性質 | 破れ方 |
 * | --- | --- |
 * | **滞在全体を新しい単価で塗り替えない**（§5.6.9「料金の再計算」） | `check_ins.room_type` を上書きするだけの実装だと、3泊目から移った滞在が「3泊すべてコテージ」になる |
 * | **満室なら変更を拒否する**（同節「残枠の再判定」） | 変更後の形態だけを見て初日で判定すると、2泊目が満室の変更を通す |
 * | **部屋台帳を動かさない**（同節の [!important]） | `rooms.room_type` を書き換えて形態を変えると、他の予約の残枠・料金まで巻き添えになる |
 *
 * 1つ目は `nightlyRoomTypes()`、2つ目は `findFullNight()`、3つ目は DB 側のトリガー
 * （`0041` の `trg_rooms_room_type_immutable`）が受け持つ。
 *
 * ## 変更の境界は「日」である
 *
 * 宿泊費は泊単位に積むため、変更は**いつの夜から効くか**（`effectiveDate`）を必ず伴う。
 * 時刻で切らないのは、単価が1泊いくらであり、夜の途中で切り替える意味が無いためである。
 */

import { countOccupancy, datesOfStay, type AccommodationCapacity } from "./availability";
import type { CheckInStatus } from "./checkin-ops";
import { rateOn, type AccommodationRate } from "./rates";

/** 変更の対象になる滞在（`check_ins` の1行 ＋ 現在の部屋割当）。 */
export type StayForChange = {
  checkinId: string;
  status: CheckInStatus;
  /** **現在の**宿泊形態。過去の夜の形態は変更履歴からしか復元できない */
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
  /** 現在の割当部屋（`room_assignments` の `ended_at IS NULL` の行）。未割当なら null */
  roomId: string | null;
  roomName: string | null;
};

/** 画面から届く変更後の内容。 */
export type StayChangeInput = {
  roomType: string;
  /** 移動先の部屋。未割当のままにする場合は null */
  roomId: string | null;
  checkOutDate: string;
  adultsCount: number;
  childrenCount: number;
  /** この日の夜から変更後の内容が効く */
  effectiveDate: string;
  reason: string;
};

/** 何が変わったか。**変わらなかった項目は null**（`0041` の「変えていない項目は NULL」と同じ規約）。 */
export type StayChangeDiff = {
  roomType: { before: string; after: string } | null;
  checkOutDate: { before: string; after: string } | null;
  adults: { before: number; after: number } | null;
  children: { before: number; after: number } | null;
  /** 部屋の移動。`before` は履歴（`room_assignments`）側にあるため、記録するのは移動先だけ */
  room: { before: string | null; after: string } | null;
};

export type StayChangeRejection =
  | "not_staff"
  | "not_changeable"
  | "blank_reason"
  | "no_change"
  | "unknown_room_type"
  | "effective_date_outside_stay"
  | "invalid_check_out_date"
  | "invalid_counts"
  | "full";

export type StayChangeDecision =
  | { allowed: true; diff: StayChangeDiff; nights: readonly NightlyStay[] }
  | {
      allowed: false;
      reason: StayChangeRejection;
      /** `full` のときだけ入る。どの夜のどの形態で詰まったかを画面へ返すため */
      fullNight?: { date: string; roomType: string };
    };

/** ある1泊の占有（残枠の判定に使う最小単位）。 */
export type NightlyStay = {
  date: string;
  roomType: string;
  adultsCount: number;
  childrenCount: number;
};

/** 変更履歴の1件（`check_in_changes` ／ 読み出し用）。 */
export type StayChangeLogEntry = {
  changeId: string;
  effectiveDate: string;
  roomTypeBefore: string | null;
  roomTypeAfter: string | null;
  checkOutDateBefore: string | null;
  checkOutDateAfter: string | null;
  adultsBefore: number | null;
  adultsAfter: number | null;
  childrenBefore: number | null;
  childrenAfter: number | null;
  reason: string;
  changedByLabel: string;
  createdAt: string;
};

/** 変更を受け付ける滞在の状態（v13 §5.6.9「対象：予約済み・チェックイン中」）。 */
const CHANGEABLE_STATUSES: readonly CheckInStatus[] = ["pre_registered", "confirmed", "staying"];

function isStaffRole(role: string): boolean {
  return role === "admin" || role === "core_member";
}

/**
 * 変更してよいか。判定の順序は**利用者に返す言葉が最も具体的になる順**にしてある。
 *
 * 満室判定を最後に置くのは、理由の書き忘れや人数の打ち間違いを「満室です」と言い換えて
 * 返さないためである（現場では、返された言葉のとおりに原因を探す）。
 *
 * ## `others` から自分自身を除いておくこと
 *
 * 残枠は「自分以外の占有」と比べる。自分を含めたまま渡すと、
 * **人数を減らす変更さえ満室で弾かれる**（自分の旧占有と新占有を二重に数えるため）。
 */
export function decideStayChange(params: {
  actorRole: string;
  stay: StayForChange;
  input: StayChangeInput;
  knownRoomTypes: readonly string[];
  /** 自分以外の滞在の占有（夜ごとに展開したもの） */
  others: readonly NightlyStay[];
  /** 宿泊形態ごとの収容枠（`rooms` の `status = '利用可'` の行から作る） */
  capacities: ReadonlyMap<string, AccommodationCapacity>;
}): StayChangeDecision {
  const { actorRole, stay, input } = params;

  if (!isStaffRole(actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (!CHANGEABLE_STATUSES.includes(stay.status)) {
    return { allowed: false, reason: "not_changeable" };
  }
  if (input.reason.trim() === "") {
    return { allowed: false, reason: "blank_reason" };
  }
  if (!params.knownRoomTypes.includes(input.roomType)) {
    return { allowed: false, reason: "unknown_room_type" };
  }
  if (
    !Number.isInteger(input.adultsCount) ||
    !Number.isInteger(input.childrenCount) ||
    input.adultsCount < 0 ||
    input.childrenCount < 0 ||
    input.adultsCount + input.childrenCount < 1
  ) {
    // 「大人0名・子供0名」は `0014` の `chk_check_ins_has_guest` が弾く幽霊予約である
    return { allowed: false, reason: "invalid_counts" };
  }
  if (input.checkOutDate <= stay.checkInDate) {
    return { allowed: false, reason: "invalid_check_out_date" };
  }
  // 退去日は専有しないため、退去日を境界に選ぶと1泊も効かない変更になる（`0041` の effective_date）。
  if (input.effectiveDate < stay.checkInDate || input.effectiveDate >= input.checkOutDate) {
    return { allowed: false, reason: "effective_date_outside_stay" };
  }

  const diff = diffStayChange(stay, input);
  if (isEmptyDiff(diff)) {
    return { allowed: false, reason: "no_change" };
  }

  const nights = nightsToJudge(stay, input);
  const fullNight = findFullNight({
    requested: nights,
    others: params.others,
    capacities: params.capacities,
  });
  if (fullNight !== null) {
    return { allowed: false, reason: "full", fullNight };
  }

  return { allowed: true, diff, nights };
}

/** 変更前後の差分を取る。 */
export function diffStayChange(stay: StayForChange, input: StayChangeInput): StayChangeDiff {
  return {
    roomType:
      stay.roomType === input.roomType ? null : { before: stay.roomType, after: input.roomType },
    checkOutDate:
      stay.checkOutDate === input.checkOutDate
        ? null
        : { before: stay.checkOutDate, after: input.checkOutDate },
    adults:
      stay.adultsCount === input.adultsCount
        ? null
        : { before: stay.adultsCount, after: input.adultsCount },
    children:
      stay.childrenCount === input.childrenCount
        ? null
        : { before: stay.childrenCount, after: input.childrenCount },
    room:
      input.roomId === null || stay.roomId === input.roomId
        ? null
        : { before: stay.roomId, after: input.roomId },
  };
}

function isEmptyDiff(diff: StayChangeDiff): boolean {
  return (
    diff.roomType === null &&
    diff.checkOutDate === null &&
    diff.adults === null &&
    diff.children === null &&
    diff.room === null
  );
}

/**
 * 再判定すべき夜を並べる。**変更が効く日から新しい退去日まで**である。
 *
 * それより前の夜は旧い内容のまま残る（§5.6.9「変更日を境に単価が切り替わる」）ため、
 * 残枠を数え直す必要が無い。逆にここを滞在全体にすると、
 * **すでに泊まった夜が満室扱いで変更を拒否する**（今夜の分は当人が占有しているため）。
 */
export function nightsToJudge(stay: StayForChange, input: StayChangeInput): NightlyStay[] {
  const from = input.effectiveDate > stay.checkInDate ? input.effectiveDate : stay.checkInDate;
  return datesOfStay({
    checkInDate: from,
    checkOutDate: input.checkOutDate,
    adultsCount: input.adultsCount,
    childrenCount: input.childrenCount,
  }).map((date) => ({
    date,
    roomType: input.roomType,
    adultsCount: input.adultsCount,
    childrenCount: input.childrenCount,
  }));
}

/**
 * 1泊でも満室なら、その夜を返す（空いていれば null）。
 *
 * 数え方は形態ごとに2通りある（人数枠型／棟貸型 ／ v13 §9 #47）。その規則は
 * `countOccupancy()` が唯一の出所であり、ここでは持たない。
 *
 * 収容枠が1つも無い形態（`rooms` に `status = '利用可'` の行が無い）は**満室として扱う**。
 * 「マスタに形態はあるが部屋が無い」状態で予約を通すと、当日に泊まる場所が無い。
 */
export function findFullNight(params: {
  requested: readonly NightlyStay[];
  others: readonly NightlyStay[];
  capacities: ReadonlyMap<string, AccommodationCapacity>;
}): { date: string; roomType: string } | null {
  for (const night of params.requested) {
    const capacity = params.capacities.get(night.roomType);
    if (capacity === undefined) {
      return { date: night.date, roomType: night.roomType };
    }

    const total = capacity.allocationMode === "per_person" ? capacity.totalCapacity : capacity.totalUnits;
    const occupiedByOthers = countOccupancy(
      params.others
        .filter((other) => other.date === night.date && other.roomType === night.roomType)
        .map(asOccupying),
      capacity,
    );
    const required = countOccupancy([asOccupying(night)], capacity);

    if (total - occupiedByOthers < required) {
      return { date: night.date, roomType: night.roomType };
    }
  }
  return null;
}

/**
 * 1泊を `countOccupancy()` が受け取る形へ写す。
 *
 * `countOccupancy()` は日付で絞らない（絞りは呼び出し側の責務）ため、
 * 日付欄には同じ日を入れてよい。ここで人数の数え方を再実装しないことが肝心である。
 */
function asOccupying(night: NightlyStay) {
  return {
    checkInDate: night.date,
    checkOutDate: night.date,
    adultsCount: night.adultsCount,
    childrenCount: night.childrenCount,
  };
}

/**
 * ★ 夜ごとの宿泊形態を復元する（`0041` の `check_in_state_on()` の TypeScript 版）。
 *
 * 優先順は3段で、SQL 側と揃えてある：
 *
 * 1. その夜までに効いた変更のうち、**最後の** `roomTypeAfter`
 * 2. 1件も無ければ、**最初の**変更の `roomTypeBefore`（＝滞在開始時の形態）
 * 3. 変更履歴が無ければ、`stay.roomType`（現在の形態）
 *
 * 2段目が要るのは、`check_ins.room_type` が**現在の**形態でしかないためである。
 * 3泊目からコテージへ移った滞在で、1・2泊目を現在の形態で埋めると
 * 滞在全体がコテージの単価で塗り替わる（§5.6.9 が禁じている振る舞い）。
 */
export function nightlyRoomTypes(params: {
  stay: { checkInDate: string; checkOutDate: string; roomType: string };
  changes: readonly Pick<
    StayChangeLogEntry,
    "effectiveDate" | "roomTypeBefore" | "roomTypeAfter" | "createdAt"
  >[];
}): { date: string; roomType: string }[] {
  const ordered = [...params.changes]
    .filter((change) => change.roomTypeAfter !== null || change.roomTypeBefore !== null)
    .sort(
      (left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate) ||
        left.createdAt.localeCompare(right.createdAt),
    );
  const originalRoomType =
    ordered.find((change) => change.roomTypeBefore !== null)?.roomTypeBefore ??
    params.stay.roomType;

  return datesOfStay({
    checkInDate: params.stay.checkInDate,
    checkOutDate: params.stay.checkOutDate,
    adultsCount: 0,
    childrenCount: 0,
  }).map((date) => {
    const effective = ordered
      .filter((change) => change.roomTypeAfter !== null && change.effectiveDate <= date)
      .at(-1);
    return { date, roomType: effective?.roomTypeAfter ?? originalRoomType };
  });
}

/** 1泊ぶんの宿泊費。単価が引けなかった夜は `pricePerNightYen` が null になる。 */
export type NightlyCharge = {
  date: string;
  roomType: string;
  pricePerNightYen: number | null;
};

/**
 * ★ 宿泊費を**泊単位**で積む（v13 §5.6.9「料金の再計算」）。
 *
 * 単価は**その夜の日付で有効な行**から引く（§5.4.2②）。マスタを改定しても
 * 過去の夜の単価が動かないのは、`rateOn()` に夜の日付を渡しているからである。
 *
 * ## 単価が無い夜を 0 円にしない
 *
 * 料金マスタは初期行を持たない（`0021`：管理者が C13 から入力する）。
 * 引けなかった夜を 0 円で足すと、**入力漏れが「無料の夜」として請求額に混ざる**。
 * `missingRateNights` として数えて画面に出し、合計からは外す。
 */
export function nightlyLodgingCharge(params: {
  nights: readonly { date: string; roomType: string }[];
  rates: readonly AccommodationRate[];
  memberCategory: "member" | "non_member";
}): { lines: NightlyCharge[]; totalYen: number; missingRateNights: number } {
  const lines = params.nights.map((night) => ({
    date: night.date,
    roomType: night.roomType,
    pricePerNightYen:
      rateOn(params.rates, {
        roomType: night.roomType,
        memberCategory: params.memberCategory,
        date: night.date,
      })?.pricePerNightYen ?? null,
  }));

  return {
    lines,
    totalYen: lines.reduce((total, line) => total + (line.pricePerNightYen ?? 0), 0),
    missingRateNights: lines.filter((line) => line.pricePerNightYen === null).length,
  };
}

/** 変更が効く日の既定値。滞在中は当日、予約段階（まだ来ていない）は初日。 */
export function defaultEffectiveDate(stay: StayForChange, today: string): string {
  if (stay.status !== "staying") {
    return stay.checkInDate;
  }
  // 早着・延泊で予定日とずれていても、滞在中の変更は「今夜から」が既定である。
  // 滞在の外へ出た日付は `decideStayChange()` が弾くため、窓の内側へ寄せておく。
  if (today < stay.checkInDate) {
    return stay.checkInDate;
  }
  return today < stay.checkOutDate ? today : stay.checkInDate;
}

/** 断られた理由を現場の言葉にする。 */
export function stayChangeDenialMessage(
  reason: StayChangeRejection,
  fullNight?: { date: string; roomType: string },
): string {
  switch (reason) {
    case "not_staff":
      return "滞在の変更は管理者・コアメンバーだけが行えます。";
    case "not_changeable":
      return "退館済み・取消済みの滞在は変更できません（新しい予約として起こしてください）。";
    case "blank_reason":
      return "変更理由の入力が必要です（v13 §5.6.9）。";
    case "no_change":
      return "変更された項目がありません。";
    case "unknown_room_type":
      return "宿泊形態を選んでください。";
    case "effective_date_outside_stay":
      return "変更を適用する日は、宿泊初日以降かつ退去日より前にしてください（退去日の夜は専有しません）。";
    case "invalid_check_out_date":
      return "退去日は宿泊初日より後の日付にしてください。";
    case "invalid_counts":
      return "人数は0以上の整数で、合計1名以上にしてください。";
    case "full":
      return fullNight === undefined
        ? "変更後の日程・形態に空きがありません。"
        : `${fullNight.date} の${fullNight.roomType}が満室のため変更できません。`;
  }
}

/** 変更内容の要約（操作後の報告文・履歴の1行に使う）。 */
export function describeStayChange(diff: StayChangeDiff): string {
  const parts: string[] = [];
  if (diff.roomType !== null) {
    parts.push(`宿泊形態 ${diff.roomType.before} → ${diff.roomType.after}`);
  }
  if (diff.checkOutDate !== null) {
    parts.push(`退去日 ${diff.checkOutDate.before} → ${diff.checkOutDate.after}`);
  }
  if (diff.adults !== null) {
    parts.push(`大人 ${diff.adults.before}名 → ${diff.adults.after}名`);
  }
  if (diff.children !== null) {
    parts.push(`子ども ${diff.children.before}名 → ${diff.children.after}名`);
  }
  if (diff.room !== null) {
    parts.push("部屋の移動");
  }
  return parts.join(" ／ ");
}
