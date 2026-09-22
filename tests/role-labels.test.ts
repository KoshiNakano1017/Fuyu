// ロール表示名の変換表（WBS 2-5 ／ v13 §2・§5.9.4）の単体テスト。
//
// #58 は「改称しない」で決着したため、いまの表示名は内部識別子の日本語訳とほぼ一致する。
// それでも試験を置くのは、**表が1箇所であること**と**内部識別子が画面へ出ないこと**を
// 固定するためである（呼称を変える判断が出たときに、直す場所が1つであるように）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADMIN_REQUIRED_LABEL,
  ROLE_DISPLAY_NAMES,
  ROLES_IN_DISPLAY_ORDER,
  roleDisplayName,
  STAFF_REQUIRED_LABEL,
} from "@/lib/auth/role-labels";

describe("表示名の網羅（v13 §2 の5値）", () => {
  test("5つのロールすべてに表示名がある", () => {
    expect(Object.keys(ROLE_DISPLAY_NAMES).sort()).toEqual(
      ["admin", "core_member", "custom", "guest", "member"].sort(),
    );
  });

  test("表示順も5つすべてを含む", () => {
    expect([...ROLES_IN_DISPLAY_ORDER].sort()).toEqual(Object.keys(ROLE_DISPLAY_NAMES).sort());
  });

  test("内部識別子をそのまま表示名にしない", () => {
    for (const [role, label] of Object.entries(ROLE_DISPLAY_NAMES)) {
      expect(label).not.toBe(role);
    }
  });
});

describe("未ログイン・値域外の扱い", () => {
  test("未ログインは「未ログイン」と出す", () => {
    expect(roleDisplayName(null)).toBe("未ログイン");
  });

  test("値域外でも例外を投げない（アクセス制限画面が真っ白にならないように）", () => {
    // @ts-expect-error 値域外を意図的に渡す
    expect(() => roleDisplayName("superuser")).not.toThrow();
  });
});

describe("必要権限の文言", () => {
  test("運営の必要権限は管理者とコアメンバーの両方を挙げる", () => {
    expect(STAFF_REQUIRED_LABEL).toContain(ROLE_DISPLAY_NAMES.admin);
    expect(STAFF_REQUIRED_LABEL).toContain(ROLE_DISPLAY_NAMES.core_member);
  });

  test("管理者限定の文言にコアメンバーを含めない", () => {
    expect(ADMIN_REQUIRED_LABEL).not.toContain(ROLE_DISPLAY_NAMES.core_member);
  });
});

describe("変換表が1箇所であること（WBS 2-5 の完了条件）", () => {
  /** 画面が自前のロール表示名の表を持っていないか、実ファイルを読んで確かめる。 */
  const SCREENS_WITH_ROLE_LABELS = [
    "src/components/auth/AccessDenied.tsx",
    "src/app/admin/preview/page.tsx",
  ];

  test.each(SCREENS_WITH_ROLE_LABELS)("%s は自前の表示名の表を持たない", (relativePath) => {
    const source = readFileSync(join(__dirname, "..", relativePath), "utf8");
    // 「`core_member:` の右に日本語の表示名を書いている」＝ 2つ目の表がある、という形を検出する。
    expect(source).not.toMatch(/core_member:\s*"[^"]+"/);
  });
});
