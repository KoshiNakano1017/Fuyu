import {
  AREAS,
  areaForPath,
  canAccessPath,
  visibilityFor,
  visibleAreasFor,
} from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

/**
 * v13 §5.9.1 の表示マトリクスの受入テスト（WBS 2-3）。
 *
 * CLAUDE.md §4.4「認可に関わるロジックは必ずテストを書く」。
 * ここが崩れると「画面には出ないが URL を直接叩けば入れる」状態が生まれる。
 */

describe("§5.9.1 表示マトリクス：運営専用領域", () => {
  const STAFF_ONLY_KEYS = [
    "staffTablet",
    "questApproval",
    "knowledgeForm",
    "eumoGrants",
    "stayCalendar",
  ];

  test.each(STAFF_ONLY_KEYS)("%s は一般会員に非表示", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    expect(visibilityFor(area, "member")).toBe("hidden");
  });

  test.each(STAFF_ONLY_KEYS)("%s はゲストに非表示", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    expect(visibilityFor(area, "guest")).toBe("hidden");
  });

  test.each(STAFF_ONLY_KEYS)("%s はコアメンバーに表示", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    expect(visibilityFor(area, "core_member")).toBe("visible");
  });
});

describe("§5.9.1 表示マトリクス：管理者専用領域", () => {
  const ADMIN_ONLY_KEYS = ["adminDashboard", "masterData", "rolePreview"];

  test.each(ADMIN_ONLY_KEYS)("%s はコアメンバーにも非表示", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    expect(visibilityFor(area, "core_member")).toBe("hidden");
  });

  test.each(ADMIN_ONLY_KEYS)("%s は管理者に表示", (key) => {
    const area = AREAS.find((a) => a.key === key)!;
    expect(visibilityFor(area, "admin")).toBe("visible");
  });
});

describe("ゲストのクエストは △（限定）", () => {
  test("ゲストには limited", () => {
    const quests = AREAS.find((a) => a.key === "quests")!;
    expect(visibilityFor(quests, "guest")).toBe("limited");
  });

  test("limited は非表示ではない（ナビには出る）", () => {
    expect(visibleAreasFor("guest").map((a) => a.key)).toContain("quests");
  });
});

describe("visibleAreasFor は hidden を配列に入れない（§5.9.2 DOM ごと描画しない）", () => {
  test("一般会員のナビに運営専用が1つも無い", () => {
    const keys = visibleAreasFor("member").map((a) => a.key);
    for (const staffOnly of ["staffTablet", "adminDashboard", "masterData", "rolePreview"]) {
      expect(keys).not.toContain(staffOnly);
    }
  });

  test("管理者は全領域を見られる", () => {
    expect(visibleAreasFor("admin")).toHaveLength(AREAS.length);
  });
});

describe("areaForPath：長い path を優先する", () => {
  test("/admin/master が /admin に食われない", () => {
    expect(areaForPath("/admin/master")?.key).toBe("masterData");
  });

  test("/admin は管理ダッシュボード", () => {
    expect(areaForPath("/admin")?.key).toBe("adminDashboard");
  });

  test("配下の経路も同じ領域として扱う", () => {
    expect(areaForPath("/staff/quests/123")?.key).toBe("questApproval");
  });
});

describe("canAccessPath：ナビと同じ表を根拠にする", () => {
  test("一般会員は /admin へ入れない", () => {
    expect(canAccessPath("/admin", "member")).toBe(false);
  });

  test("コアメンバーも /admin へ入れない", () => {
    expect(canAccessPath("/admin", "core_member")).toBe(false);
  });

  test("コアメンバーは /staff/orders へ入れる", () => {
    expect(canAccessPath("/staff/orders", "core_member")).toBe(true);
  });

  test("表に無い経路は許可する（ログイン画面など管理対象外）", () => {
    // ここを false にすると、表へ行を足し忘れた瞬間にアプリ全体が止まる。
    expect(canAccessPath("/login", "guest")).toBe(true);
  });
});

describe("custom ロールの扱い（DB物理設計 §6-9⑥：権限内容が未定義）", () => {
  test("運営専用領域には入れない（暫定で member 相当）", () => {
    expect(canAccessPath("/staff/orders", "custom")).toBe(false);
  });

  test("全ロールが表に定義されている（定義漏れがあると undefined になる）", () => {
    const roles: Role[] = ["admin", "core_member", "member", "guest", "custom"];
    for (const area of AREAS) {
      for (const role of roles) {
        expect(visibilityFor(area, role)).toBeDefined();
      }
    }
  });
});
