// DB テスト用の会員フィクスチャ。
//
// 🚫 実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
//    氏名は架空、メールは `@example.invalid`（DB物理設計 §6-8④ の指定）。
//    実データの加工・匿名化による流用も禁止であり、ここにある値はすべて手で作った架空値である。
//
// 役は5種。「他人」役が居ないと、
// 「**自分自身**の権限列は変更できない／**他人**のなら変更できる」の対を検証できない（§6-8④）。
// `core` と `oyakata` は 2026-09-19（WBS 2-4 ／ Issue #58）に追加した。
// §6-8④ が要求する6種のうち `core_member` と「`member_type` だけが上位の一般会員」が欠けており、
// **PII-A の読み取りが `role` で決まり `member_type` では決まらない**ことを対で検証できなかったため。

export type TestAuthUser = { id: string; email: string };

export type TestMember = {
  memberId: string;
  /** null = アプリ未登録（`account_status = pre_registered`／会員データモデル §5.2a） */
  authUserId: string | null;
  nickname: string;
  memberType: string;
  role: string;
  accountStatus: string;
};

/** Supabase Auth 側のテストユーザー。`members.auth_user_id` の FK 先になる。 */
export const TEST_AUTH_USERS = {
  admin: { id: "00000000-0000-0000-0000-0000000000b1", email: "fuyu-admin@example.invalid" },
  self: { id: "00000000-0000-0000-0000-0000000000b2", email: "fuyu-self@example.invalid" },
  core: { id: "00000000-0000-0000-0000-0000000000b3", email: "fuyu-core@example.invalid" },
  oyakata: { id: "00000000-0000-0000-0000-0000000000b4", email: "fuyu-oyakata@example.invalid" },
  /** まだどの会員にも紐づいていないアカウント。名寄せ成立・付け替えの試験に使う */
  spare: { id: "00000000-0000-0000-0000-0000000000b9", email: "fuyu-spare@example.invalid" },
  /** ★ `role = 'guest'` の利用者。街人登録（§5.10）とメディアの全ロール開放（§5.11.7）で要る */
  guest: { id: "00000000-0000-0000-0000-0000000000b8", email: "fuyu-guest@example.invalid" },
};

export const TEST_MEMBERS = {
  /** 操作者役（他人の role を変更する側） */
  admin: {
    memberId: "00000000-0000-0000-0000-0000000000a1",
    authUserId: TEST_AUTH_USERS.admin.id,
    nickname: "テスト管理者",
    memberType: "街人（コア）",
    role: "admin",
    accountStatus: "active",
  },
  /** 対象役（自分自身の権限を変えようとする側） */
  self: {
    memberId: "00000000-0000-0000-0000-0000000000a2",
    authUserId: TEST_AUTH_USERS.self.id,
    nickname: "テスト街人",
    memberType: "街人（一般）",
    role: "member",
    accountStatus: "active",
  },
  /**
   * staff 側のもう一方（`role = 'core_member'`）。
   * `member_type` はあえて一般のままにし、**staff 判定が `role` だけで決まる**ことを示す。
   */
  core: {
    memberId: "00000000-0000-0000-0000-0000000000a4",
    authUserId: TEST_AUTH_USERS.core.id,
    nickname: "テストコア",
    memberType: "街人（一般）",
    role: "core_member",
    accountStatus: "active",
  },
  /**
   * **立場は上位・権限は一般**の会員（`member_type = '親方'` ／ `role = 'member'`）。
   * v13 §2 の不可侵ルール（`member_type` を認可に使わない）の反証役。
   * この役が居ないと「`member_type` で通ってしまう実装」を検出できない（§6-8⑤ #2）。
   */
  oyakata: {
    memberId: "00000000-0000-0000-0000-0000000000a5",
    authUserId: TEST_AUTH_USERS.oyakata.id,
    nickname: "テスト親方",
    memberType: "親方",
    role: "member",
    accountStatus: "active",
  },
  /**
   * ★ **ゲスト**（`role = 'guest'`）。
   *
   * 街人登録の導線（v13 §5.10）は「ゲストだけが通る」ことが要件であり、
   * 昇格（`guest` → `member`）を検証するには最初から `guest` の会員が要る。
   * **既存の会員を `guest` へ UPDATE して用意することはできない** — `0003` のガードが
   * 権限列の変更に操作者と理由の申告を要求するため、フィクスチャの準備そのものが 42501 で落ちる
   * （CI で実際に踏んだ）。INSERT はガードの対象ではないので、最初からこの役を置く。
   */
  guest: {
    memberId: "00000000-0000-0000-0000-0000000000a9",
    authUserId: TEST_AUTH_USERS.guest.id,
    nickname: "テストゲスト",
    memberType: "ゲスト",
    role: "guest",
    accountStatus: "active",
  },
  /** 取込直後の空枠。`auth_user_id` は NULL（会員データモデル §5.2a） */
  preRegistered: {
    memberId: "00000000-0000-0000-0000-0000000000a3",
    authUserId: null,
    nickname: "テスト未登録",
    memberType: "街人（一般）",
    role: "member",
    accountStatus: "pre_registered",
  },
};

/** すべてのフィクスチャのメール。実データ由来でないことの回帰テストに使う。 */
export const FIXTURE_EMAILS = Object.values(TEST_AUTH_USERS).map((user) => user.email);

export type TestCheckIn = {
  checkinId: string;
  memberId: string;
  /** `accommodation_types.room_type` の6値のいずれか */
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adultsCount: number;
};

/**
 * 滞在のフィクスチャ（WBS 3-2 ／ `0014_check_ins_and_accommodation_types.sql`）。
 *
 * `room_assignments` は `check_ins` への外部キーを持つ（0014 で 0006 から回収した）。
 * そのため**部屋割当を作る試験は、先にここの滞在を投入しなければならない**。
 * 日付を未来の固定値にしているのは、`v_room_availability` が
 * `current_date` 起点の 180 日窓を持つため（過去日だと窓から外れて残枠の試験ができない）。
 */
export const TEST_CHECK_INS = {
  /** 一般会員（`self`）の滞在。本人ポリシーの試験に使う */
  selfStay: {
    checkinId: "00000000-0000-0000-0000-0000000000c1",
    memberId: TEST_MEMBERS.self.memberId,
    roomType: "cottage",
    checkInDate: "2030-05-01",
    checkOutDate: "2030-05-03",
    adultsCount: 2,
  },
  /** 別人（`oyakata`）の滞在。「他人の行は見えない」を対で検証するために要る */
  otherStay: {
    checkinId: "00000000-0000-0000-0000-0000000000c2",
    memberId: TEST_MEMBERS.oyakata.memberId,
    roomType: "dormitory",
    checkInDate: "2030-05-01",
    checkOutDate: "2030-05-02",
    adultsCount: 1,
  },
};

export function checkInInsertSql(checkIn: TestCheckIn): string {
  return [
    "INSERT INTO public.check_ins",
    "  (checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count)",
    `VALUES ('${checkIn.checkinId}', '${checkIn.memberId}', '${checkIn.roomType}',`,
    `        '${checkIn.checkInDate}', '${checkIn.checkOutDate}', ${checkIn.adultsCount});`,
  ].join("\n");
}

/** 会員フィクスチャ ＋ 滞在2件。`room_assignments` や `orders` を扱う試験の冒頭で流す。 */
export const STAY_FIXTURE_SQL = [
  ...Object.values(TEST_CHECK_INS).map(checkInInsertSql),
].join("\n");

const AUTH_INSTANCE_ID = "00000000-0000-0000-0000-000000000000";

export function authUserInsertSql(user: TestAuthUser): string {
  return [
    "INSERT INTO auth.users",
    "  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)",
    `VALUES ('${AUTH_INSTANCE_ID}', '${user.id}', 'authenticated', 'authenticated',`,
    `        '${user.email}', '', now(), now(), now());`,
  ].join("\n");
}

/**
 * 会員1名を投入する。
 * 列は §5.2 の必須項目だけを明示し、`earned_xp`（既定 0）等は既定値に委ねる。
 */
export function memberInsertSql(member: TestMember): string {
  const authUserId = member.authUserId === null ? "NULL" : `'${member.authUserId}'`;
  return [
    "INSERT INTO public.members (member_id, auth_user_id, nickname, member_type, role, account_status)",
    `VALUES ('${member.memberId}', ${authUserId}, '${member.nickname}',`,
    `        '${member.memberType}', '${member.role}', '${member.accountStatus}');`,
  ].join("\n");
}

/** 3名＋Authアカウント3件。各テストのトランザクション冒頭で流す。 */
export const FIXTURE_SQL = [
  ...Object.values(TEST_AUTH_USERS).map(authUserInsertSql),
  ...Object.values(TEST_MEMBERS).map(memberInsertSql),
].join("\n");

// 申告系は DO ブロックで包む。`SELECT set_config(...)` と書くと戻り値が標準出力へ混ざり、
// 後続の検査クエリの結果と区別できなくなるため。

/** `service_role` 経由の操作者申告（DB物理設計 §6-6b②）。 */
export function declareOperatorSql(memberId: string): string {
  return `DO $$ BEGIN PERFORM set_config('app.operator_id', '${memberId}', true); END $$;`;
}

/** `role` 変更に必須の理由申告（DB物理設計 §6-6b③①）。 */
export function declareReasonSql(reason: string): string {
  return `DO $$ BEGIN PERFORM set_config('app.change_reason', '${reason}', true); END $$;`;
}

/**
 * ログインセッションを偽装する（DB物理設計 §6-8③）。
 * `auth.uid()` は `request.jwt.claims` の `sub` を読むため、JWT を署名しなくてもよい。
 */
export function loginAsSql(authUserId: string): string {
  return [
    "DO $$ BEGIN",
    "  PERFORM set_config('request.jwt.claims',",
    `                     json_build_object('sub', '${authUserId}', 'role', 'authenticated')::text,`,
    "                     true);",
    "END $$;",
  ].join("\n");
}
