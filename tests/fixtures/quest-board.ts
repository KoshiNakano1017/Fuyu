// クエストボード（WBS 5-1）の受入テスト用フィクスチャ。
//
// 🚫 実在の会員データ・実クエストを一切参照しない（CLAUDE.md §3.2・§7.1）。
//    ここにある値はすべて手で作った架空値であり、**実データの加工・匿名化による流用も行っていない**。
//    会員を模した値は氏名ではなくニックネーム（「テスト〜」）と架空IDだけに留める。
//
// 列の対応: DB物理設計 §2-1 の `quests` DDL
//   （`origin_type` / `guest_allowed` / `required_certification` / `status` / `reward_uii`）。
//   TS 側の綴りは既存コードの作法に合わせて camelCase とする。
//
// ▼ 2026-09-25（WBS `5-2` ／ Issue #167）追加: `recruitCount` / `applicationCount`
//   v13 §5.3 note（L844）「1クエスト＝運営が指定した**募集人数の範囲で**受注可」を判定するには、
//   募集人数（`quests.recruit_count`）と現在の受注申請の件数の**両方**が判定関数へ渡る必要がある。
//   判定点を増やさない（v13 §5.9.3）ため、件数はクエスト側の属性として持たせ、
//   画面・API・Server Action は従来どおり同じ判定関数だけを呼ぶ。
//   `applicationCount` は**有効な受注申請の件数**（取り下げ済みを枠として数え続けないため）。

/** 一覧に並ぶ順序をそのまま固定する。ここを並べ替えるとテストの期待値も変わる。 */

/** 手動起案・公開中・ゲストに開放済み（v13 §5.10.6 `guest_allowed = true`）。 */
export const MANUAL_OPEN_QUEST = {
  questId: "11111111-1111-4111-8111-111111111101",
  title: "薪棚の積み直し",
  categoryId: "22222222-2222-4222-8222-222222222201",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 800,
  recruitCount: 1,
  applicationCount: 0,
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
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 1200,
  recruitCount: 1,
  applicationCount: 0,
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
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 0,
  recruitCount: 1,
  applicationCount: 0,
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
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 500,
  recruitCount: 1,
  applicationCount: 0,
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
  coreOnlyReward: false,
  requiredCertification: ["チェーンソー"],
  rewardUii: 1500,
  recruitCount: 1,
  applicationCount: 0,
  description: "伐倒方向の指示を受けてから着手する",
  assigneeName: "テスト管理者",
};

/**
 * 施錠中かつ `core_only_reward = true`（v13 §5.10.6 2026-09-20改訂）。
 * 一般会員（`MEMBER_VIEWER`）にも報酬額・指示内容を返してはならない、コア・管理者専用の1件。
 */
export const CORE_ONLY_LOCKED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111106",
  title: "非公開の特別依頼",
  categoryId: "22222222-2222-4222-8222-222222222206",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: false,
  coreOnlyReward: true,
  requiredCertification: [] as string[],
  rewardUii: 5000,
  recruitCount: 1,
  applicationCount: 0,
  description: "詳細は口頭のみで共有する。名簿記載は最小限に留める",
  assigneeName: "テストコア",
};

/**
 * 募集3名のうち2名が受注済み（境界値: **上限の直前**）。まだ1枠ある。
 * v13 §5.3 note L844「募集人数の**範囲で**受注可」の「範囲内」側。
 */
export const PARTIALLY_RECRUITED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111107",
  title: "母屋前の草刈り（3人募集）",
  categoryId: "22222222-2222-4222-8222-222222222207",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 900,
  recruitCount: 3,
  applicationCount: 2,
  description: "刈った草は堆肥場へ運ぶ",
  assigneeName: "テスト街人",
};

/** 募集3名に受注申請が3件（境界値: **上限ちょうど**）。ここで閉じる。 */
export const FULLY_RECRUITED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111108",
  title: "薪割り（3人募集・充足）",
  categoryId: "22222222-2222-4222-8222-222222222208",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 1100,
  recruitCount: 3,
  applicationCount: 3,
  description: "薪の長さは現場で指示する",
  assigneeName: "テスト街人",
};

/**
 * 募集1名に受注申請が2件（境界値: **上限の超過**）。
 * 上限判定を `=== recruitCount` で書くとここだけすり抜け、既に溢れているクエストが開く。
 */
export const OVER_RECRUITED_QUEST = {
  questId: "11111111-1111-4111-8111-111111111109",
  title: "鶏小屋の掃除（1人募集・溢れている）",
  categoryId: "22222222-2222-4222-8222-222222222209",
  originType: "manual" as const,
  status: "open" as const,
  guestAllowed: true,
  coreOnlyReward: false,
  requiredCertification: [] as string[],
  rewardUii: 700,
  recruitCount: 1,
  applicationCount: 2,
  description: "床の敷料を入れ替える",
  assigneeName: "テスト街人",
};

/** クエストボードへ渡す全件。手動起案と朝会自動抽出が混在している（v13 §5.3 L754）。 */
export const ALL_QUESTS = [
  MANUAL_OPEN_QUEST,
  MORNING_MEETING_LOCKED_QUEST,
  LOCKED_ZERO_REWARD_QUEST,
  LOCKED_CLOSED_QUEST,
  CERTIFICATION_REQUIRED_QUEST,
  CORE_ONLY_LOCKED_QUEST,
  PARTIALLY_RECRUITED_QUEST,
  FULLY_RECRUITED_QUEST,
  OVER_RECRUITED_QUEST,
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

/** コアメンバー。`core_only_reward` の施錠クエストでも報酬額・指示内容が返る（v13 §5.10.6 2026-09-20改訂）。 */
export const CORE_MEMBER_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333306",
  role: "core_member" as const,
  memberType: "街人（コア）",
  certifications: [] as string[],
};

/** 管理者。コアメンバーと同様、`core_only_reward` でも詳細が返る側。 */
export const ADMIN_VIEWER = {
  memberId: "33333333-3333-4333-8333-333333333307",
  role: "admin" as const,
  memberType: "街人（コア）",
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
