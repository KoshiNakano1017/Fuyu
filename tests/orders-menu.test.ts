// 品書きの絞り込みと並べ替え（WBS 6-1・6-3）の受入テスト。
//
// 根拠: v13 §5.4.1（売り切れは消さずに出す）、`0018_menu_items.sql`。

import {
  canOrderMenuItem,
  groupMenuItemsByCategory,
  isMenuItemListableOn,
  type MenuItem,
} from "@/lib/orders/menu";

function menuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    menuItemId: "00000000-0000-0000-0000-000000000001",
    name: "テスト商品",
    category: "フード",
    subcategory: null,
    unitPriceYen: 500,
    description: null,
    isSoldOut: false,
    isPublished: true,
    availableFrom: null,
    availableUntil: null,
    displayOrder: 0,
    ...overrides,
  };
}

describe("isMenuItemListableOn", () => {
  test("公開中・期間の指定なしなら品書きに載る", () => {
    expect(isMenuItemListableOn(menuItem(), "2026-09-21")).toBe(true);
  });

  test("未公開なら品書きに載らない", () => {
    expect(isMenuItemListableOn(menuItem({ isPublished: false }), "2026-09-21")).toBe(false);
  });

  test("提供開始日より前なら品書きに載らない", () => {
    expect(isMenuItemListableOn(menuItem({ availableFrom: "2026-09-22" }), "2026-09-21")).toBe(
      false,
    );
  });

  test("提供終了日を過ぎていれば品書きに載らない", () => {
    expect(isMenuItemListableOn(menuItem({ availableUntil: "2026-09-20" }), "2026-09-21")).toBe(
      false,
    );
  });

  test("提供開始日の当日は品書きに載る", () => {
    expect(isMenuItemListableOn(menuItem({ availableFrom: "2026-09-21" }), "2026-09-21")).toBe(
      true,
    );
  });

  test("提供終了日の当日は品書きに載る", () => {
    expect(isMenuItemListableOn(menuItem({ availableUntil: "2026-09-21" }), "2026-09-21")).toBe(
      true,
    );
  });

  // v13 §5.4.1: 売り切れは「表示したうえで注文できなくする」。一覧から消すと
  // 「元々無い」のか「今日は売り切れた」のかが利用者に区別できない。
  test("売り切れでも品書きには載る", () => {
    expect(isMenuItemListableOn(menuItem({ isSoldOut: true }), "2026-09-21")).toBe(true);
  });
});

describe("canOrderMenuItem", () => {
  test("売り切れの商品は注文できない", () => {
    expect(canOrderMenuItem(menuItem({ isSoldOut: true }))).toBe(false);
  });

  test("売り切れていない商品は注文できる", () => {
    expect(canOrderMenuItem(menuItem({ isSoldOut: false }))).toBe(true);
  });
});

describe("groupMenuItemsByCategory", () => {
  test("カテゴリごとにまとまる", () => {
    const grouped = groupMenuItemsByCategory([
      menuItem({ menuItemId: "a", category: "フード" }),
      menuItem({ menuItemId: "b", category: "ドリンク" }),
      menuItem({ menuItemId: "c", category: "フード" }),
    ]);
    expect(grouped.map((group) => group.category)).toEqual(["フード", "ドリンク"]);
  });

  test("カテゴリの並びは最初に現れた順を保つ", () => {
    const grouped = groupMenuItemsByCategory([
      menuItem({ menuItemId: "a", category: "ドリンク", displayOrder: 1 }),
      menuItem({ menuItemId: "b", category: "フード", displayOrder: 2 }),
    ]);
    expect(grouped[0].category).toBe("ドリンク");
  });

  test("カテゴリ内は display_order の昇順で並ぶ", () => {
    const grouped = groupMenuItemsByCategory([
      menuItem({ menuItemId: "a", name: "あと", displayOrder: 2 }),
      menuItem({ menuItemId: "b", name: "さき", displayOrder: 1 }),
    ]);
    expect(grouped[0].items.map((item) => item.name)).toEqual(["さき", "あと"]);
  });

  // display_order が同値のときに並びが実行ごとに変わると、店員が「さっきと位置が違う」
  // 状態で操作することになり、タブレットの誤タップを招く。
  test("display_order が同値なら名前順で安定する", () => {
    const grouped = groupMenuItemsByCategory([
      menuItem({ menuItemId: "a", name: "ぶどう", displayOrder: 1 }),
      menuItem({ menuItemId: "b", name: "あんず", displayOrder: 1 }),
    ]);
    expect(grouped[0].items.map((item) => item.name)).toEqual(["あんず", "ぶどう"]);
  });
});
