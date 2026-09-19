// クエストボード（WBS 5-1）の受入テスト用フィクスチャ。
//
// 🚫 実在の会員データ・実クエストを一切参照しない（CLAUDE.md §3.2・§7.1）。
//    ここにある値はすべて手で作った架空値であり、**実データの加工・匿名化による流用も行っていない**。
//    会員を模した値は氏名ではなくニックネーム（「テスト〜」）と架空IDだけに留める。
//
// 列の対応: DB物理設計 §2-1 の `quests` DDL
//   （`origin_type` / `guest_allowed` / `required_certification` / `status` / `reward_uii`）。
//   TS 側の綴りは既存コードの作法に合わせて camelCase とする。

/** 一覧に並ぶ順序をそのまま固定する。ここを並べ替えるとテストの期待値も変わる。 */

/** 手動起案・公開中・ゲストに開放済み（v13 §5.10.6 `guest_allowed = true`）。 */
export const MANUAL_OPEN_QUEST = {
  questId: "11111111-1111-4111-8111-111111111101",
  title: "薪棚の積み直し",
  categoryId: "22222222-2222-4222-8222-222222222201",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  requiredCertification: [] as string[],
  rewardUii: 800,
  /** 指示内容。ゲストには返さない（v13 §5.10.6 L1800） */
  description: "9時に薪棚前集合。積み方はその場で指示する",
  /** 担当者情報。ゲストには返さない（同上） */
  assigneeName: "テスト街人",
};

/** 朝会からの自動抽出・公開中・**ゲスト非開放**（施錠表示の対象）。 */
export const MORNING_MEETING_LOCKED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111102",
  title: "堆肥場の切り返し",
  categoryId: "22222222-2222-4222-8222-222222222202",
  originType: "morning_meeting_auto" as const,
  status: "open" as const,
  guestAllowed: false,
  requiredCertification: [] as string[],
  rewardUii: 1200,
  description: "切り返しの回数と水分量は当日の指示に従う",
  assigneeName: "テスト管理者",
};

/**
 * 報酬額 0 の施錠クエスト（境界値）。
 * `0` は falsy なので「値が無い」と取り違えられやすい。**キーごと返らない**ことを固定するために置く。
 */
export const LOCKED_ZERO_REWARD_QUEST = {
  questId: "11111111-1111-4111-8111-111111111103",
  title: "朝の掃き掃除",
  categoryId: "22222222-2222-4222-8222-222222222203",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: false,
  requiredCertification: [] as string[],
  rewardUii: 0,
  description: "母屋前の落ち葉を掃く",
  assigneeName: "テスト街人",
};

/** 施錠されているが**公開中ではない**。解放件数バナーの N に数えてはいけない（`status = 'open'` 条件）。 */
export const LOCKED_CLOSED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111104",
  title: "終了した草刈り",
  categoryId: "22222222-2222-4222-8222-222222222204",
  originType: "manual" as const,
  status: "closed" as const,
  guestAllowed: false,
  requiredCertification: [] as string[],
  rewardUii: 500,
  description: "受付は終了している",
  assigneeName: "テスト街人",
};

/**
 * 資格が要る公開中クエスト。ゲストにも開放されている（`guest_allowed = true`）が、
 * 資格ゲートは街人登録では解放されない別の軸である（v13 §5.10.6 L1790）。
 */
export const CERTIFICATION_REQUIRED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111105",
  title: "チェーンソーでの間伐",
  categoryId: "22222222-2222-4222-8222-222222222205",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  requiredCertification: ["チェーンソー"],
  rewardUii: 1500,
  description: "伐倒方向の指示を受けてから着手する",
  assigneeName: "テスト管理者",
};

/** クエストボードへ渡す全件。手動起案と朝会自動抽出が混在している（v13 §5.3 L754）。 */
export const ALL_QUESTS = [
  MANUAL_OPEN_QUEST,
  MORNING_MEETING_LOCKED_QUEST,
  LOCKED_ZERO_REWARD_QUEST,
  LOCKED_CLOSED_QUEST,
  CERTIFICATION_REQUIRED_QUEST,
];

/** `guest_allowed = false` かつ `status = 'open'` の件数。解放件数バナーの N の期待値。 */
export const LOCKED_OPEN_QUEST_COUNT = 2;

// ▼ 閲覧者。
//    認可の根拠は `role` のみ（v13 §2 L171-172・§5.9.3）。`memberType` は
//    「**認可に使っていない**」ことを対で確かめるためだけに持たせてある。
//    インラインのオブジェクトリテラルではなく const として渡すこと
//    （余剰プロパティ検査を避け、実装側の型に `memberType` が無くても渡せるようにするため）。

/** ゲスト。 */
export const GUEST_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333301",
  role: "guest" as const,
  memberType: "ゲスト",
  certifications: [] as string[],
};

/** 街人（一般）。資格は持たない。 */
export const MEMBER_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333302",
  role: "member" as const,
  memberType: "街人（一般）",
  certifications: [] as string[],
};

/** 街人（一般）でチェーンソーの資格を持つ。 */
export const CERTIFIED_MEMBER_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333303",
  role: "member" as const,
  memberType: "街人（一般）",
  certifications: ["チェーンソー"],
};

/**
 * 立場は「親方」だが権限は `guest`。
 * `member_type` を認可に混ぜると、この閲覧者に施錠クエストが開いてしまう（v13 §2 L172）。
 */
export const OYAKATA_BUT_GUEST_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333304",
  role: "guest" as const,
  memberType: "親方",
  certifications: [] as string[],
};

/**
 * 立場は「ゲスト」だが権限は `member`（登録直後に `member_type` の更新が追いついていない状態）。
 * `member_type` を認可に混ぜると、正当な街人が施錠される。
 */
export const GUEST_TYPED_MEMBER_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333305",
  role: "member" as const,
  memberType: "ゲスト",
  certifications: [] as string[],
};
