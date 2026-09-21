// カフェメニューの絞り込みと並べ替え（WBS 6-1 セルフ注文 ／ 6-3 SOLDOUT ／ 6-4 メニューマスタ）。
//
// 純関数だけを置く。DB もセッションも要らない状態を保つのは、
// `fetch-board.ts` と `board.ts` を分けてあるのと同じ理由である（判定の試験を軽くするため）。
//
// 根拠: v13 §5.4.1（カフェ注文）、`0018_menu_items.sql`（`is_published` / `available_from` /
//       `available_until` / `is_sold_out` / `display_order` の意味）。

/** `menu_items` の行のうち、注文画面が使う分だけ（camelCase への変換は fetch 層で行う）。 */
export type MenuItem = {
  menuItemId: string;
  name: string;
  category: string;
  subcategory: string | null;
  unitPriceYen: number;
  description: string | null;
  isSoldOut: boolean;
  isPublished: boolean;
  /** 提供期間。`null` は「期間の制限なし」。 */
  availableFrom: string | null;
  availableUntil: string | null;
  displayOrder: number;
};

export type MenuCategory = {
  category: string;
  items: MenuItem[];
};

/**
 * その日に品書きへ載せてよいか。
 *
 * ⚠️ **売り切れ（`isSoldOut`）はここで落とさない。** 落とすと品書きから消えてしまい、
 * 利用者には「最初から無かった」のか「今日は売り切れた」のかが区別できない。
 * v13 §5.4.1 は売り切れを**表示したうえで注文できなくする**ことを求めている
 * （カードに SOLDOUT を出すのは画面側の仕事）。
 *
 * 落とすのは「公開されていない」「提供期間の外」の2つだけである。
 */
export function isMenuItemListableOn(item: MenuItem, today: string): boolean {
  if (!item.isPublished) {
    return false;
  }
  if (item.availableFrom !== null && today < item.availableFrom) {
    return false;
  }
  if (item.availableUntil !== null && today > item.availableUntil) {
    return false;
  }
  return true;
}

/** 売り切れは注文できない（v13 §5.4.1）。判定を画面へ散らさないためここに置く。 */
export function canOrderMenuItem(item: MenuItem): boolean {
  return !item.isSoldOut;
}

/**
 * 品書きをカテゴリ単位にまとめる。
 *
 * 並び順は `display_order` → `name` の2段。`display_order` が同値のときに
 * 並びが実行ごとに変わると、店員が「さっきと位置が違う」状態で操作することになる
 * （タブレットの誤タップの原因になる）。第2キーを置くのはそのためである。
 *
 * カテゴリの並びは**最初に現れた順**を保つ。`0018` の初期データが
 * 意図した順（フード→ドリンク→…）で `display_order` を振っているため、
 * カテゴリ名の五十音で並べ替えるとその意図が壊れる。
 */
export function groupMenuItemsByCategory(items: readonly MenuItem[]): MenuCategory[] {
  const sorted = [...items].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "ja"),
  );

  const byCategory = new Map<string, MenuItem[]>();
  for (const item of sorted) {
    const bucket = byCategory.get(item.category);
    if (bucket === undefined) {
      byCategory.set(item.category, [item]);
    } else {
      bucket.push(item);
    }
  }

  return [...byCategory.entries()].map(([category, group]) => ({ category, items: group }));
}
