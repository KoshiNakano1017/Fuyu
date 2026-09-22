// トップページ（画面ID A2 ホーム）が「入口」として機能することの受入テスト。
//
// 2026-09-21 の詰まりの再発検査:
//   未ログインでトップを開くと `RoleNav` が null を返し（v13 §5.9.2 の DOM 非描画）、
//   トップ自体は仮置きの文言だけだったため、**ログイン経路が画面のどこにも無かった**。
//   「この文言の画面しか出てこない」として報告された状態である。
//
// なぜソースを文字列として読むのか:
//   「ログインリンクが書かれていること」「独自の領域一覧を書いていないこと」は
//   書かれている／いないことを固定する条件であり、`tests/staff-knowledge-page.test.ts` と
//   同じ手段で押さえる（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AREAS, visibleAreasFor } from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

import { SRC_DIR } from "./helpers/ai-sources";

const HOME_PAGE = join(SRC_DIR, "app", "page.tsx");
const source = readFileSync(HOME_PAGE, "utf8");

const ROLES: readonly Role[] = ["admin", "core_member", "member", "guest", "custom"];

describe("未ログインでも入口が見つかる", () => {
  test("トップページにログイン画面へのリンクがある", () => {
    expect(source).toContain('href="/login"');
  });

  test("ログイン状態を見て描き分けている（未ログインを素通りさせない）", () => {
    expect(source).toContain("readViewer");
  });
});

describe("ログイン後の一覧はナビと同じ表を根拠にする", () => {
  // WBS 2-6「ナビ定義と §5.9.1 表を同一ロール定義から生成」。
  // ここで独自の配列を書くと、ナビ・サーバサイド認可に続く3つ目の真実ができる。
  test("領域の一覧を `visibleAreasFor()` から取っている", () => {
    expect(source).toContain("visibleAreasFor");
  });

  test("画面内に経路の文字列を直書きしていない（ログイン画面を除く）", () => {
    const hardcodedPaths = AREAS.filter((area) => area.path !== "/").filter((area) =>
      source.includes(`"${area.path}"`),
    );
    expect(hardcodedPaths.map((area) => area.path)).toEqual([]);
  });
});

describe("表示マトリクスとの整合（v13 §5.9.1）", () => {
  test.each(ROLES)("%s のホームには自分に見える領域が1つ以上ある", (role) => {
    // ホーム自身を除いても空にならないこと。空だと入口として役に立たない。
    const areas = visibleAreasFor(role).filter((area) => area.key !== "home");
    expect(areas.length).toBeGreaterThan(0);
  });

  test("ホーム領域は全ロールに見える（入口が消えない）", () => {
    for (const role of ROLES) {
      expect(visibleAreasFor(role).map((area) => area.key)).toContain("home");
    }
  });
});
