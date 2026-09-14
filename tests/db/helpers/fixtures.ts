// DB テスト用の会員フィクスチャ。
//
// 🚫 実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
//    氏名は架空、メールは `@example.invalid`（DB物理設計 §6-8④ の指定）。
//    実データの加工・匿名化による流用も禁止であり、ここにある値はすべて手で作った架空値である。
//
// 役は3種。「他人」役が居ないと、本タスクの中心である
// 「**自分自身**の権限列は変更できない／**他人**のなら変更できる」の対を検証できない（§6-8④）。

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
  /** まだどの会員にも紐づいていないアカウント。名寄せ成立・付け替えの試験に使う */
  spare: { id: "00000000-0000-0000-0000-0000000000b9", email: "fuyu-spare@example.invalid" },
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
