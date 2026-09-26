// 管理系メニューの到達性（WBS 2-6 ／ Issue #92 ／ v13 §5.9.5）の受入テスト。
//
// 固定する完了条件（§5.9.5 の表の5項目をそのまま条件にした）:
//  1 平置きの上限 …… 常時表示のナビ項目は7つまで
//  2 グルーピング …… 運営専用画面は「⚙️ 管理」へ束ねる
//  3 横スクロールに依存しない …… ナビは折り返す。overflow-x / nowrap を使わない
//  4 入口の重複を許す …… 価格・料金を出す画面からマスタ管理へ直接飛べる（管理者のみ）
//  5 空振りの禁止 …… ナビ定義と §5.9.1 表が一致し、リンク先の画面が実在する
//
// ⚠️ ここは「隠す」ではなく「**権限内が確実に見つかる**」ことを守るテストである。
//    2026-08-25 のプロトタイプ確認では、12タブを横1列に並べたバーの ⑩⑪⑫ が画面外へ
//    押し出され、**実装済みのマスタ管理へ管理者が到達できなかった**（v13 §9 #54）。
//    「実装されているか」ではなく「到達できるか」を、壊れたときに気づける形にしてある。
//
// ## §5.9.1 の表を正本から読む理由
//
// 表をテスト側へ書き写すと、**正本・コード・テストの3つ目の真実**ができる。
// §5.9.5「空振りの禁止」は「ナビ定義と §5.9.1 の表は同一のロール定義から生成する」と
// 定めているので、突合の相手は写しではなく正本そのものにする。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  ADMIN_MENU_LABEL,
  AREAS,
  NAV_DAILY_LIMIT,
  adminMenuAreasFor,
  dailyAreasFor,
  visibilityFor,
  type AreaKey,
  type Visibility,
} from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

import { REPO_ROOT, SRC_DIR } from "./helpers/ai-sources";

const SPEC = join(REPO_ROOT, "docs", "spec", "浮遊街アプリ 総合要件定義・設計書_v13.md");
const NAV = join(SRC_DIR, "components", "nav", "RoleNav.tsx");

/** §5.9.1 の表の列順（ゲスト → 一般会員 → コアメンバー → 運営管理者）。 */
const COLUMN_ROLES: readonly Role[] = ["guest", "member", "core_member", "admin"];

/**
 * §5.9.1 の行見出し → `AreaKey` の対応。
 *
 * 行見出しは補足つき（「ホーム（ワンタップチェックイン）」等）なので、**先頭一致**で引く。
 * `custom` は表に列が無い（§9 #66 で `member` と同等と決めた）ため、この対応表には現れない。
 */
const ROW_TO_KEY: ReadonlyArray<readonly [string, AreaKey]> = [
  ["ホーム", "home"],
  ["クエスト（", "quests"],
  ["カフェ注文", "cafeOrder"],
  ["マイページ", "myPage"],
  ["アップロード", "upload"],
  ["宿泊予約", "stayReservation"],
  ["店員用タブレット", "staffTablet"],
  ["クエスト承認・査定", "questApproval"],
  ["ナレッジ登録フォーム", "knowledgeForm"],
  ["管理者PCダッシュボード", "adminDashboard"],
  ["Eumo給付一覧", "eumoGrants"],
  ["宿泊予定カレンダー", "stayCalendar"],
  ["マスタ管理", "masterData"],
  ["ロール切替プレビュー", "rolePreview"],
];

/**
 * §5.9.1 の表に**行が無いが `AREAS` にはある**領域と、その根拠。
 *
 * 表に無い行を黙って許すと「空振りの禁止」が空文になるため、**根拠つきで列挙する**。
 */
const NOT_IN_TABLE: ReadonlyArray<readonly [AreaKey, string]> = [
  // 買い物リストは §5.12.1（2026-09-22 オーナー確定）で追加された領域で、
  // 「タブを増やさない」方針のため §5.9.1 の表へは行が起こされていない。
  ["shoppingList", "v13 §5.12.1 ／ §9 #65②"],
];

/** 表のセル（◯ / △ / 非表示）を3値へ写す。 */
function toVisibility(cell: string): Visibility {
  if (cell.includes("非表示")) {
    return "hidden";
  }
  if (cell.startsWith("△")) {
    return "limited";
  }
  // 「◯（`active` のみ）」のような補足つきも ◯ として扱う（条件は画面側の責務）。
  if (cell.includes("◯")) {
    return "visible";
  }
  throw new Error(`§5.9.1 の表に読めないセルがあります: ${cell}`);
}

function readSpecTable(): Map<AreaKey, Record<Role, Visibility>> {
  const spec = readFileSync(SPEC, "utf8");
  const start = spec.indexOf("#### 5.9.1 タブ・メニューの表示マトリクス");
  const end = spec.indexOf("#### 5.9.2", start);
  if (start < 0 || end < 0) {
    throw new Error("正本から §5.9.1 の節を見つけられません（節見出しが変わった可能性）");
  }
  const section = spec.slice(start, end);

  const parsed = new Map<AreaKey, Record<Role, Visibility>>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.replace(/\*\*/g, "").trim());
    if (cells.length !== 5) {
      continue;
    }
    // 取り消し線の行（AIコンシェルジュ）は §9 #31 により無効。表から落ちた行として扱う。
    if (cells[0].startsWith("~~")) {
      continue;
    }
    const match = ROW_TO_KEY.find(([prefix]) => cells[0].startsWith(prefix));
    if (!match) {
      continue;
    }
    const visibility = {} as Record<Role, Visibility>;
    COLUMN_ROLES.forEach((role, index) => {
      visibility[role] = toVisibility(cells[index + 1]);
    });
    // `custom` は表に列が無い。§9 #66 により `member` と同等とする。
    visibility.custom = visibility.member;
    parsed.set(match[1], visibility);
  }
  return parsed;
}

const SPEC_TABLE = readSpecTable();

describe("★ 空振りの禁止：ナビ定義と v13 §5.9.1 の表が一致する（§5.9.5）", () => {
  test("表の行がすべて `AREAS` に存在する（権限があるのに出ない画面を作らない）", () => {
    const keys = AREAS.map((area) => area.key);
    for (const key of SPEC_TABLE.keys()) {
      expect(keys).toContain(key);
    }
  });

  test("表の行数と `AREAS` の件数が合う（表に無い行は根拠つきで列挙済み）", () => {
    expect(SPEC_TABLE.size + NOT_IN_TABLE.length).toBe(AREAS.length);
  });

  test.each([...SPEC_TABLE.keys()])("%s の表示可否が全ロールで表と一致する", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    const expected = SPEC_TABLE.get(key)!;
    const actual = Object.fromEntries(
      (Object.keys(expected) as Role[]).map((role) => [role, visibilityFor(area, role)]),
    );
    expect(actual).toEqual(expected);
  });

  test.each(NOT_IN_TABLE)("表に行が無い %s には根拠が書かれている", (key, basis) => {
    expect(AREAS.map((area) => area.key)).toContain(key);
    expect(basis).toMatch(/§/);
  });

  test("★ リンク先の画面が実在する（ナビに出るのに開けない経路を作らない）", () => {
    for (const area of AREAS) {
      const page = join(SRC_DIR, "app", area.path === "/" ? "" : area.path, "page.tsx");
      expect(existsSync(page)).toBe(true);
    }
  });
});

describe("★ 平置きの上限：常時表示は7項目まで（§5.9.5）", () => {
  const ROLES: readonly Role[] = ["admin", "core_member", "member", "guest", "custom"];

  test("上限が §5.9.5 の値である", () => {
    expect(NAV_DAILY_LIMIT).toBe(7);
  });

  test.each(ROLES)("%s の第1階層が上限を超えない", (role) => {
    expect(dailyAreasFor(role).length).toBeLessThanOrEqual(NAV_DAILY_LIMIT);
  });

  test("★ 管理者でも第1階層は増えない（12画面を平置きしない）", () => {
    // #54 の実態は「管理者の権限対象が12画面あるのにフラットな1列に並べた」ことだった。
    expect(dailyAreasFor("admin")).toEqual(dailyAreasFor("member"));
  });

  test("上限を超える定義は例外で気づける（黙って切り捨てない）", () => {
    // 切り捨てる実装だと、8つ目を足した人には「項目が1つ消えた」ようにしか見えない。
    const source = readFileSync(join(SRC_DIR, "lib", "auth", "navigation.ts"), "utf8");
    expect(source).toContain("throw new Error(");
  });
});

describe("★ グルーピング：運営専用は「⚙️ 管理」へ束ねる（§5.9.5）", () => {
  test("見出しに語を添える（歯車だけにしない）", () => {
    expect(ADMIN_MENU_LABEL).toContain("管理");
  });

  test("一般会員・ゲストには管理メニューが1項目も無い（＝見出しごと出ない）", () => {
    for (const role of ["member", "guest", "custom"] as const) {
      expect(adminMenuAreasFor(role)).toHaveLength(0);
    }
  });

  test("★ 運営専用の領域は第1階層に出ない", () => {
    const dailyKeys = AREAS.filter((area) => area.group === "daily").map((area) => area.key);
    for (const staffOnly of [
      "staffTablet",
      "questApproval",
      "knowledgeForm",
      "eumoGrants",
      "stayCalendar",
      "adminDashboard",
      "masterData",
      "rolePreview",
    ]) {
      expect(dailyKeys).not.toContain(staffOnly);
    }
  });

  test("管理者は8領域すべてへ管理メニューから到達できる", () => {
    expect(adminMenuAreasFor("admin")).toHaveLength(8);
  });

  test("コアメンバーの管理メニューには管理者専用が入らない", () => {
    const keys = adminMenuAreasFor("core_member").map((area) => area.key);
    expect(keys).not.toContain("masterData");
    expect(keys).toContain("staffTablet");
  });

  test("第1階層と管理メニューを足すと可視領域の全部になる（どちらにも属さない領域を作らない）", () => {
    for (const role of ["admin", "core_member", "member", "guest", "custom"] as const) {
      const grouped = dailyAreasFor(role).length + adminMenuAreasFor(role).length;
      const visible = AREAS.filter((area) => visibilityFor(area, role) !== "hidden").length;
      expect(grouped).toBe(visible);
    }
  });
});

describe("★ 横スクロールを到達手段にしない（§5.9.5）", () => {
  // **コメントを落としてから見る。** 「`overflow-x-auto` を使わない」という説明文自体が
  // 禁止語を含むため、生のソースを検査すると自分の説明で落ちる（実測で踏んだ）。
  const nav = readFileSync(NAV, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("折り返す（`flex-wrap`）", () => {
    expect(nav).toContain("flex-wrap");
  });

  test("★ 横スクロール・折り返し禁止のクラスを使わない", () => {
    // 「スクロールすれば出てくる」は、画面外に項目があること自体が見えないため到達手段にならない。
    for (const forbidden of ["overflow-x-auto", "overflow-x-scroll", "whitespace-nowrap"]) {
      expect(nav).not.toContain(forbidden);
    }
  });

  test("管理メニューは JavaScript 無しでも開く（`details`）", () => {
    // ここが開かないと管理者はマスタ管理へ到達できず、#54 の再発になる。
    expect(nav).toContain("<details");
  });
});

describe("★ 入口の重複を許す：価格を出す画面からマスタ管理へ飛べる（§5.9.5）", () => {
  const SHORTCUT = join(SRC_DIR, "components", "nav", "MasterDataShortcut.tsx");

  test("近道の可視性は `AREAS` から引く（二重管理しない）", () => {
    const source = readFileSync(SHORTCUT, "utf8");
    expect(source).toContain("visibilityFor(masterData, role)");
    // 近道側でロール名を直書きすると §5.9.1 の表と別の真実になる。
    expect(source).not.toContain('role === "admin"');
  });

  test("カフェ注文画面に近道がある", () => {
    expect(readFileSync(join(SRC_DIR, "app", "orders", "page.tsx"), "utf8")).toContain(
      "<MasterDataShortcut",
    );
  });

  test("宿泊予約画面に近道がある", () => {
    expect(readFileSync(join(SRC_DIR, "app", "reservations", "page.tsx"), "utf8")).toContain(
      "<MasterDataShortcut",
    );
  });
});
