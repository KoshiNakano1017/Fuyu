// 運営向け 宿泊予定カレンダー C10 の受入テスト（WBS 3-8 ／ Issue #169）。
//
// 根拠: v13 §5.2.5②（L682「全予約を日付軸で表示。月/週切替。「要確認」予約は強調表示」）／
//       v13 §5.2.3「管理者画面：宿泊予定カレンダー」の**表示内容**と**「要確認」予約の見え方**（L582・L584）／
//       v13 §5.2.3 TO-BE④・§9 #30-④（「要確認」の判定基準＝備考が完全な空欄のときだけ自動確定）／
//       v13 §6・画面設計.md §5（L483：管理者・コアメンバーのみ）／ CLAUDE.md §7.1（実名を出さない）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { areaForPath, canAccessPath } from "@/lib/auth/navigation";
import {
  buildStaffCalendar,
  isNeedsAttentionStay,
  summarizeStayForStaff,
  type StaffCalendarDay,
} from "@/lib/lodging/calendar";
import type { DailyAvailability, StayEntry } from "@/lib/lodging/fetch-lodging";

import { SRC_DIR } from "./helpers/ai-sources";

const CALENDAR_PATH = "/staff/calendar";
const C10_PAGE = join(SRC_DIR, "app", "staff", "calendar", "page.tsx");
const ANCHOR = "2026-09-15";

function stay(overrides: Partial<StayEntry> = {}): StayEntry {
  return {
    checkinId: "stay-1",
    memberId: "00000000-0000-0000-0000-00000000bb01",
    memberLabel: "街人#10001",
    roomType: "cottage",
    checkInDate: "2026-09-10",
    checkOutDate: "2026-09-12",
    adultsCount: 2,
    childrenCount: 1,
    status: "confirmed",
    note: "",
    assignedRoomName: null,
    memberCategory: "会員",
    ...overrides,
  };
}

function availability(overrides: Partial<DailyAvailability> = {}): DailyAvailability {
  return { date: "2026-09-10", roomType: "cottage", total: 3, occupied: 1, available: 2, ...overrides };
}

function buildMonth(stays: StayEntry[], daily: DailyAvailability[] = []): StaffCalendarDay[] {
  return buildStaffCalendar({ view: "month", anchorDate: ANCHOR, stays, availability: daily });
}

function dayOf(days: StaffCalendarDay[], date: string): StaffCalendarDay {
  const found = days.find((day) => day.date === date);
  if (found === undefined) throw new Error(`${date} の日セルが無い`);
  return found;
}

/** コメントを落としたソース。説明として名前を挙げたコメントで誤検知しないため。 */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("全予約を日付軸で表示する（完了条件18 ／ v13 §5.2.5② 運営向け）", () => {
  test("予約は滞在期間の各日に現れる（退去日は含まない）", () => {
    const days = buildMonth([stay({ checkInDate: "2026-09-10", checkOutDate: "2026-09-12" })]);
    const shown = days.filter((day) => day.entries.length > 0).map((day) => day.date);
    expect(shown).toEqual(["2026-09-10", "2026-09-11"]);
  });

  test("会員をまたいで全件が同じ日セルに並ぶ（本人分だけに絞らない）", () => {
    const days = buildMonth([
      stay({ checkinId: "a", memberId: "00000000-0000-0000-0000-00000000bb01" }),
      stay({ checkinId: "b", memberId: "00000000-0000-0000-0000-00000000bb02" }),
    ]);
    expect(dayOf(days, "2026-09-10").entries).toHaveLength(2);
  });
});

describe("月表示と週表示を切り替えられる（完了条件19 ／ v13 §9 #30-⑤）", () => {
  test("月表示は基準日の属する月の日数ぶんの日セルを返す", () => {
    expect(buildMonth([])).toHaveLength(30);
  });

  test("週表示は7日分の日セルを返す", () => {
    const days = buildStaffCalendar({ view: "week", anchorDate: ANCHOR, stays: [], availability: [] });
    expect(days).toHaveLength(7);
  });

  test("週表示は基準日を含む週を返す", () => {
    const days = buildStaffCalendar({ view: "week", anchorDate: ANCHOR, stays: [], availability: [] });
    expect(days.map((day) => day.date)).toContain(ANCHOR);
  });
});

describe("「要確認」予約を強調する（完了条件20 ／ v13 §5.2.3 TO-BE④・§9 #30-④）", () => {
  test("備考に記載があり自動確定されなかった予約は要確認になる", () => {
    expect(isNeedsAttentionStay(stay({ status: "pre_registered", note: "到着が22時になります" }))).toBe(true);
  });

  test("備考が空欄で自動確定された予約は要確認にしない", () => {
    expect(isNeedsAttentionStay(stay({ status: "confirmed", note: "" }))).toBe(false);
  });

  test("「特になし」のような定型文言も要確認として扱う（判定基準は完全な空欄のみ）", () => {
    // §9 #30-④「完全な空欄のみを『空』とする」。定型文言を空と見なすと、
    // 担当者が読むべき申し送りが自動確定に紛れて埋もれる。
    expect(isNeedsAttentionStay(stay({ status: "pre_registered", note: "特になし" }))).toBe(true);
  });

  test("要確認の予約は日セルの中で強調対象として印が付く", () => {
    const days = buildMonth([stay({ status: "pre_registered", note: "食事制限あり" })]);
    expect(dayOf(days, "2026-09-10").entries[0].needsAttention).toBe(true);
  });

  test("満室の日でも備考の無い予約は強調しない（満室表示と取り違えない）", () => {
    // 既存の `needsAttention(day)`（＝その日に満室の形態がある）は**残枠の話**であり、
    // §5.2.5② が強調せよと言っている「要確認**予約**」とは別物である。
    const days = buildMonth([stay({ status: "confirmed", note: "" })], [availability({ available: 0 })]);
    expect(dayOf(days, "2026-09-10").entries[0].needsAttention).toBe(false);
  });
});

describe("1予約から読めること（完了条件21 ／ v13 §5.2.3「表示内容」）", () => {
  test("チェックイン日・チェックアウト日・部屋タイプ・割当部屋・大人子供人数・会員区分が読める", () => {
    const summary = summarizeStayForStaff(
      stay({
        checkInDate: "2026-09-10",
        checkOutDate: "2026-09-12",
        roomType: "cottage",
        assignedRoomName: "コテージA",
        adultsCount: 2,
        childrenCount: 1,
        memberCategory: "会員",
      }),
    );
    expect(summary).toMatchObject({
      checkInDate: "2026-09-10",
      checkOutDate: "2026-09-12",
      roomType: "cottage",
      assignedRoomName: "コテージA",
      adultsCount: 2,
      childrenCount: 1,
      memberCategory: "会員",
    });
  });

  test("割当部屋が確定していなければ空で返す（別の値で埋めない）", () => {
    // v13 §5.2.5 の note のとおり、部屋番号の確定は予約成立の前提ではない。
    expect(summarizeStayForStaff(stay({ assignedRoomName: null })).assignedRoomName).toBeNull();
  });
});

describe("C10 は管理者・コアメンバーのみ（完了条件22 ／ v13 §6 ／ 画面設計.md §5 L483）", () => {
  test("経路がナビの表に登録されている（表に無い経路は誰でも素通りするため）", () => {
    expect(areaForPath(CALENDAR_PATH)?.key).toBe("stayCalendar");
  });

  test("許可側: 管理者は宿泊予定カレンダーへ入れる", () => {
    expect(canAccessPath(CALENDAR_PATH, "admin")).toBe(true);
  });

  test("許可側: コアメンバーは宿泊予定カレンダーへ入れる", () => {
    expect(canAccessPath(CALENDAR_PATH, "core_member")).toBe(true);
  });

  test("拒否側: 一般会員は宿泊予定カレンダーへ入れない", () => {
    expect(canAccessPath(CALENDAR_PATH, "member")).toBe(false);
  });

  test("拒否側: ゲストは宿泊予定カレンダーへ入れない", () => {
    expect(canAccessPath(CALENDAR_PATH, "guest")).toBe(false);
  });

  test("拒否はサーバサイドで行う（ページが requireStaff() を通る ／ v13 §5.9.3）", () => {
    // 「DOM 非表示は認可ではない」。ナビから消えていても URL は叩ける。
    expect(readCode(C10_PAGE)).toContain("requireStaff(");
  });

  test("認可判定より前にカレンダーを組み立てない（v13 §5.9.4）", () => {
    const source = readCode(C10_PAGE);
    expect(source.indexOf("requireStaff(")).toBeLessThan(source.indexOf("buildStaffCalendar"));
  });
});

describe("C10 に会員の実名を出さない（完了条件23 ／ CLAUDE.md §7.1）", () => {
  // ★ 走査するのは **C10 が実際に読む経路**だけである（2026-09-26 に範囲を絞った）。
  //   `src/lib/lodging/` 一式を対象にすると `register.ts`（宿泊者名簿 ／ WBS 3-2）が引っかかる。
  //   あれは**旅館業法の法定記録として氏名・住所を扱うのが役目**（v13 §5.2.7 ／ PII-A）であり、
  //   C10 とは別の画面・別のテーブルである。無関係なモジュールを混ぜると、
  //   「C10 に実名を出さない」という本来の性質が**別の理由で落ちる試験**になってしまう。
  const sources = [
    C10_PAGE,
    join(SRC_DIR, "lib", "lodging", "fetch-lodging.ts"),
    join(SRC_DIR, "lib", "lodging", "calendar.ts"),
    join(SRC_DIR, "lib", "lodging", "meal-reservations.ts"),
    join(SRC_DIR, "lib", "lodging", "meal-reservation-store.ts"),
  ];

  test("走査対象のソースが存在する（0件で素通りさせない）", () => {
    expect(sources.length).toBeGreaterThan(1);
  });

  test("氏名を持つテーブル（member_profiles_private）を参照しない", () => {
    const offenders = sources.filter((path) => readCode(path).includes("member_profiles_private"));
    expect(offenders).toEqual([]);
  });

  test("氏名の列（full_name）を参照しない", () => {
    const offenders = sources.filter((path) => readCode(path).includes("full_name"));
    expect(offenders).toEqual([]);
  });

  test("表示名は公開ビュー（v_member_public）から取る", () => {
    const usesPublicView = sources.some((path) => readCode(path).includes("v_member_public"));
    expect(usesPublicView).toBe(true);
  });
});
