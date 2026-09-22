import type { Role } from "./session";

/**
 * アプリ内領域の表示マトリクス（v13 §5.9.1）。
 *
 * ## なぜ表をコードで持つのか
 *
 * WBS `2-6` が「**ナビ定義と §5.9.1 表を同一ロール定義から生成**」と定めている。
 * ナビゲーションの並びと「誰に見せるか」の判定が別々の場所にあると、
 * 片方だけ直したときに**画面には出ないが URL を直接叩けば入れる**状態が生まれる。
 *
 * ここを唯一の出所にし、ナビの描画（§5.9.2 の DOM 非描画）と
 * サーバサイド認可（§5.9.3）の**両方がこの表を参照する**。
 *
 * ## ⚠️ この表だけで守らない
 *
 * v13 §5.9.3 は「画面上の非表示と**サーバサイド認可を必ず併置する**」と定めている。
 * この表は「何を描画するか」を決めるだけで、防壁ではない。
 * 守りたい処理の隣には `requireStaff()` / `requireAdmin()` を置くこと（`guard.ts`）。
 */

/** 表示可否の3値（§5.9.1 の ◯ / △ / 非表示）。 */
export type Visibility = "visible" | "limited" | "hidden";

export type AreaKey =
  | "home"
  | "quests"
  | "shoppingList"
  | "cafeOrder"
  | "myPage"
  | "upload"
  | "stayReservation"
  | "staffTablet"
  | "questApproval"
  | "knowledgeForm"
  | "adminDashboard"
  | "eumoGrants"
  | "stayCalendar"
  | "masterData"
  | "rolePreview";

export type Area = {
  key: AreaKey;
  /** 利用者に見せる名称。内部識別子をそのまま出さない。 */
  label: string;
  /** 経路。ナビの href とサーバサイド認可の対象を一致させるために持つ。 */
  path: string;
  visibility: Record<Role, Visibility>;
};

/** よく出る組み合わせ。表の意図を読みやすくするための短縮。 */
const ALL: Record<Role, Visibility> = {
  admin: "visible",
  core_member: "visible",
  member: "visible",
  guest: "visible",
  // `custom`（出資者・VIP）は **`member`（街人）と同等**として扱う。
  // これは暫定ではなく**正式仕様**である（2026-09-22 オーナー決定 ／ v13 §9 #66・
  // 決定ログ §22-3）。出資者・VIP はバッジ表示や呼称などの演出で区別し、
  // **認可へは持ち込まない**（`member_type` を認可に使わない原則と同じ考え方）。
  // ⚠️ したがって `custom` に staff 相当を足さないこと。足すなら v13 §2 の側から改訂する。
  custom: "visible",
};

const STAFF_ONLY: Record<Role, Visibility> = {
  admin: "visible",
  core_member: "visible",
  member: "hidden",
  guest: "hidden",
  custom: "hidden",
};

const ADMIN_ONLY: Record<Role, Visibility> = {
  admin: "visible",
  core_member: "hidden",
  member: "hidden",
  guest: "hidden",
  custom: "hidden",
};

/**
 * v13 §5.9.1 の表をそのまま写したもの。**行を足すときは仕様の表にも足すこと。**
 *
 * ⚠️ 「AIコンシェルジュ（FAQチャット）」行は §9 #31 により無効（2026-08-16）。
 *    アプリ内チャット UI は持たず、LINE（line-rag-bot）へ一本化したため**載せない**。
 */
export const AREAS: readonly Area[] = [
  { key: "home", label: "ホーム", path: "/", visibility: ALL },
  {
    key: "quests",
    label: "クエスト",
    path: "/quests",
    // ゲストは △（限定クエストのみ）。§6 権限マトリクスの「〇（限定あり）」と同義。
    visibility: { ...ALL, guest: "limited" },
  },
  {
    key: "shoppingList",
    label: "買い物リスト",
    path: "/shopping",
    // ゲストは △（閲覧のみ・登録不可／v13 §5.12.1・§6 ／ 2026-09-22 オーナー確定）。
    // 経路自体は開ける。登録フォームと操作ボタンを描画しないのはページ側の責務。
    visibility: { ...ALL, guest: "limited" },
  },
  { key: "cafeOrder", label: "カフェ注文", path: "/orders", visibility: ALL },
  { key: "myPage", label: "マイページ", path: "/me", visibility: ALL },
  { key: "upload", label: "アップロード", path: "/upload", visibility: ALL },
  { key: "stayReservation", label: "宿泊予約", path: "/reservations", visibility: ALL },

  { key: "staffTablet", label: "店員用タブレット", path: "/staff/orders", visibility: STAFF_ONLY },
  { key: "questApproval", label: "クエスト承認・査定", path: "/staff/quests", visibility: STAFF_ONLY },
  { key: "knowledgeForm", label: "ナレッジ登録", path: "/staff/knowledge", visibility: STAFF_ONLY },
  { key: "eumoGrants", label: "Eumo給付一覧", path: "/staff/eumo", visibility: STAFF_ONLY },
  { key: "stayCalendar", label: "宿泊予定カレンダー", path: "/staff/calendar", visibility: STAFF_ONLY },

  { key: "adminDashboard", label: "管理ダッシュボード", path: "/admin", visibility: ADMIN_ONLY },
  { key: "masterData", label: "マスタ管理", path: "/admin/master", visibility: ADMIN_ONLY },
  { key: "rolePreview", label: "ロール切替プレビュー", path: "/admin/preview", visibility: ADMIN_ONLY },
] as const;

/** そのロールに対する表示可否。 */
export function visibilityFor(area: Area, role: Role): Visibility {
  return area.visibility[role];
}

/**
 * ナビゲーションに出す領域。**`hidden` は配列に入れない。**
 *
 * v13 §5.9.2 は「権限外のタブバー・ナビゲーション要素を **DOM ごと描画しない**」と
 * 定めている。CSS で隠すと、要素そのものは DOM に残るため
 * 開発者ツールから経路が読める。返す配列から外すことで描画自体を起こさない。
 */
export function visibleAreasFor(role: Role): Area[] {
  return AREAS.filter((area) => visibilityFor(area, role) !== "hidden");
}

/** 経路からその領域を引く。サーバサイド認可が「この URL は誰に許すか」を判断するのに使う。 */
export function areaForPath(path: string): Area | undefined {
  // 長い path から先に照合する。`/admin/master` が `/admin` に食われないようにするため。
  return [...AREAS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((area) => path === area.path || path.startsWith(`${area.path}/`));
}

/**
 * その経路へ入ってよいか。**ナビの表示と同じ表を根拠にする。**
 *
 * 表に無い経路は `true` を返す（ログイン画面など、マトリクスの管理対象外）。
 * ここを `false` にすると、表へ行を足し忘れた瞬間にアプリ全体が止まる。
 */
export function canAccessPath(path: string, role: Role): boolean {
  const area = areaForPath(path);
  if (!area) {
    return true;
  }
  return visibilityFor(area, role) !== "hidden";
}
