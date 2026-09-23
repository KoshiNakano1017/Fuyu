// 買い物リストの画面まわりの受入テスト（Issue #147 ／ WBS `5-8` 買い物リスト（ほしいものリスト））。
//
// 固定する完了条件:
//  13 ゲストの登録が**サーバサイドで**拒否される（画面を経由しない直接リクエストでも通らない）
//  14 ゲストは買い物リストを閲覧できる
//  20 重複候補が登録の画面に提示される
//  22 一覧で、各品目のステータス・優先度・希望者数（相乗りを含む）が読める
//  23 登録が専用画面へ遷移せずモーダル1枚で完結する
//  24 ゲストの画面に登録導線が描画されない
//  25 買い物リストのためにタブを新設していない
//
// 根拠: v13 §5.12.1（入口はモーダル1枚・専用画面へ遷移させない・ゲストは閲覧のみ）／
//       §5.9.2（権限外は DOM から除外する）／ §5.9.3（DOM 非表示は認可ではない）／
//       §5.9.5（常時表示するナビ項目は7つまで）。
//
// なぜソースを文字列として読むのか:
//   「専用の登録画面が無いこと」「認可判定より後ろでしか登録導線を組み立てていないこと」は
//   **書かれていない／順序がこうである**ことを固定する条件であり、実行時の振る舞いでは捕まえにくい
//   （`tests/staff-knowledge-page.test.ts`・`tests/home-entry.test.ts` と同じ手段 ／ CLAUDE.md §4.4）。
//
// 完了条件25 の読み方:
//   §5.9.1 のタブ表に買い物リストの行は無く、§5.12.1 は「13枚目のタブを足すと §5.9.5 に抵触する」と
//   書いている。一方 §5.9.5 は「権限があるのにメニューへ出ていない画面を作らない（空振りの禁止）」も
//   同時に要求する。両立する唯一の読み方は「**到達経路は持たせてよいが、常時表示のナビ項目は
//   7つを超えてはならない**」であり、ここではその上限で固定する。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { canAccessPath, visibleAreasFor } from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

import { SRC_DIR } from "./helpers/ai-sources";

const SHOPPING_DIR = join(SRC_DIR, "app", "shopping");
const SHOPPING_PATH = "/shopping";

/** 画面のソースを読む。無ければその時点で完了条件を満たしていないので、例外のまま落とす。 */
function readShoppingSource(fileName: string): string {
  return readFileSync(join(SHOPPING_DIR, fileName), "utf8");
}

describe("一覧で品目の状態が読める（完了条件22 ／ v13 §5.12.2・§7）", () => {
  test("一覧がステータスを表示している", () => {
    expect(readShoppingSource("page.tsx")).toContain("ステータス");
  });

  test("一覧が優先度を表示している", () => {
    expect(readShoppingSource("page.tsx")).toContain("優先度");
  });

  test("一覧が希望者数を requesters から数えて表示している", () => {
    // 希望者数が運営の優先順位の根拠になる（§5.12.1 相乗り）。登録者1名＋相乗り者の数が読めること。
    expect(readShoppingSource("page.tsx")).toMatch(/requesters[\s\S]{0,40}length/);
  });
});

describe("登録はモーダル1枚で完結する（完了条件23 ／ v13 §5.12.1）", () => {
  test("登録専用のページ（/shopping/new）が存在しない", () => {
    // 「気づいた瞬間に30秒で登録できる」ことが要件であり、画面遷移を挟んだ時点で成立しない。
    expect(existsSync(join(SHOPPING_DIR, "new"))).toBe(false);
  });

  test("一覧の画面が登録フォームを同じ画面に描画している", () => {
    expect(readShoppingSource("page.tsx")).toContain("<ShoppingRegisterForm");
  });

  test("登録の Server Action が別画面へ遷移させない", () => {
    expect(readShoppingSource("actions.ts")).not.toMatch(/\bredirect\(/);
  });
});

describe("重複候補は登録の画面で提示される（完了条件20 ／ v13 §5.12.1）", () => {
  test("登録フォームが重複候補を描画している", () => {
    expect(readShoppingSource("ShoppingRegisterForm.tsx")).toMatch(/candidate/i);
  });
});

describe("ゲストの画面に登録導線が出ない（完了条件24 ／ v13 §5.9.2）", () => {
  test("一覧の画面が canRegister() で登録導線を出し分けている", () => {
    expect(readShoppingSource("page.tsx")).toContain("canRegister(");
  });

  test("認可判定より前に登録フォームを組み立てていない", () => {
    // §5.9.2 は「display:none による視覚的非表示ではなく、要素自体を描画しない」ことを要求する。
    const source = readShoppingSource("page.tsx");
    expect(source.indexOf("canRegister(")).toBeLessThan(source.indexOf("<ShoppingRegisterForm"));
  });
});

describe("サーバサイドでも登録を拒否する（完了条件13 ／ v13 §5.9.3）", () => {
  test("登録の Server Action がロールを判定している", () => {
    // 画面から導線を消すだけでは認可にならない。Server Action は直接 POST で到達し得る
    // （同梱の Next.js 16.3.4 ドキュメント `01-app/02-guides/data-security.md`）。
    expect(readShoppingSource("actions.ts")).toContain("canRegister(");
  });

  test("Server Action が member_type でロールを判定していない", () => {
    // 認可は `role` で決める（CLAUDE.md §4.1）。`member_type` で分岐すると親方の街人が通る。
    expect(readShoppingSource("actions.ts")).not.toContain("member_type");
  });
});

describe("ゲストも買い物リストを開ける（完了条件14 ／ v13 §6 買い物リストの閲覧）", () => {
  test("ゲストは /shopping へ到達できる", () => {
    expect(canAccessPath(SHOPPING_PATH, "guest")).toBe(true);
  });

  test("街人も /shopping へ到達できる", () => {
    expect(canAccessPath(SHOPPING_PATH, "member")).toBe(true);
  });
});

describe("タブを新設していない（完了条件25 ／ v13 §5.9.5 平置きの上限）", () => {
  const EVERYDAY_ROLES: readonly Role[] = ["member", "guest"];

  test.each(EVERYDAY_ROLES)("%s の常時表示ナビが7項目を超えない", (role) => {
    expect(visibleAreasFor(role).length).toBeLessThanOrEqual(7);
  });
});
