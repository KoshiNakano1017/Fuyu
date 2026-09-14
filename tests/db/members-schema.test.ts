// WBS 2-1 の会員スキーマ（列構成・制約）の受入テスト。
//
// 根拠: 会員データモデル_ユーザーテーブル定義 §5.2 / §5.2a / §5.2b / §5.9、
//       DB物理設計 §2 / §6-6b⑤、正本 v13 §2 / §7。
//
// ⚠️ 値域（`role` 5値・`member_type` 4値）は**正本 v13 §2 を採る**。
//    会員データモデル §5.2 の列表は 4値/3値だが、CLAUDE.md §1.1（矛盾時は正本が勝つ）と
//    2026-09-14 オーナー回答（論点2・論点3）により正本側が正である。

import { describeDb, query, queryRows, runSql, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL } from "./helpers/fixtures";

/** 会員データモデル §5.2 の列表（`member_id` 〜 `created_at`/`updated_at`）。 */
const MEMBERS_COLUMNS = [
  "member_id",
  "auth_user_id",
  "legacy_member_no",
  "nickname",
  "member_type",
  "role",
  "account_status",
  "oyakata_star_flag",
  "skills",
  "certifications",
  "earned_xp",
  "stay_tickets",
  "total_stay_days",
  "uii_balance",
  "last_visited_on",
  "line_joined",
  "discord_joined",
  "imported_from",
  "imported_at",
  "invite_code",
  "linked_at",
  "created_at",
  "updated_at",
];

/**
 * 会員データモデル §5.2b の列表。
 * `full_name_normalized`（生成列）は 2026-09-14 オーナー回答（論点4＝入れない）により除外し、
 * `normalize_person_name()` ともども WBS 10-1 へ送る。
 */
const MEMBER_PROFILES_PRIVATE_COLUMNS = [
  "member_id",
  "full_name",
  "full_name_kana",
  "address",
  "hometown",
  "birth_ym",
  "created_at",
  "updated_at",
];

/** `members` から追い出した個人情報5列（v13 §7・DB物理設計 §2）。 */
const PII_COLUMNS_MOVED_OUT = ["address", "birth_ym", "full_name", "full_name_kana", "hometown"];

/** 列名の一覧を取得する。並びは照合順序に依存しないよう `COLLATE "C"` で固定する。 */
function columnsOf(table: string): string[] {
  return queryRows(`
    SELECT a.attname
    FROM   pg_attribute a
    WHERE  a.attrelid = '${table}'::regclass
      AND  a.attnum > 0
      AND  NOT a.attisdropped
    ORDER  BY a.attname COLLATE "C";
  `);
}

describeDb("members の列構成（完了条件1・2）", () => {
  test("members の列構成が 会員データモデル §5.2 の列表と一致する", () => {
    expect(columnsOf("public.members")).toEqual([...MEMBERS_COLUMNS].sort());
  });

  test("members に個人情報5列（full_name / full_name_kana / address / hometown / birth_ym）が1つも存在しない", () => {
    const remaining = columnsOf("public.members").filter((column) => PII_COLUMNS_MOVED_OUT.includes(column));
    expect(remaining).toEqual([]);
  });
});

describeDb("members.auth_user_id（完了条件3）", () => {
  test("auth_user_id の型が uuid である", () => {
    const type = query(`
      SELECT format_type(a.atttypid, a.atttypmod)
      FROM   pg_attribute a
      WHERE  a.attrelid = 'public.members'::regclass AND a.attname = 'auth_user_id';
    `);
    expect(type).toBe("uuid");
  });

  test("auth_user_id が NULL を許容する（NULL = アプリ未登録／§5.2a）", () => {
    const notNull = query(`
      SELECT a.attnotnull
      FROM   pg_attribute a
      WHERE  a.attrelid = 'public.members'::regclass AND a.attname = 'auth_user_id';
    `);
    expect(notNull).toBe("f");
  });

  test("auth_user_id に UNIQUE 制約がある（1つの Auth アカウントが2会員に紐づくのを防ぐ／§5.2a）", () => {
    const uniqueIndexes = query(`
      SELECT count(*)
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE  i.indrelid = 'public.members'::regclass
        AND  i.indisunique
        AND  i.indnatts = 1
        AND  a.attname = 'auth_user_id';
    `);
    expect(uniqueIndexes).toBe("1");
  });

  test("auth_user_id が auth.users(id) を参照する", () => {
    const reference = query(`
      SELECT c.confrelid::regclass::text || '(' ||
             (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) || ')'
      FROM   pg_constraint c
      WHERE  c.conrelid = 'public.members'::regclass
        AND  c.contype = 'f'
        AND  c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = 'public.members'::regclass
                                 AND a.attname = 'auth_user_id')]::smallint[];
    `);
    expect(reference).toBe("auth.users(id)");
  });
});

describeDb("members.account_status の値域（完了条件4）", () => {
  test("pre_registered / active / withdrawn の3値は INSERT できる", () => {
    const result = runSql(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      SELECT gen_random_uuid(), 'テスト街人', '街人（一般）', 'member', status
      FROM   unnest(ARRAY['pre_registered', 'active', 'withdrawn']) AS status;
    `);
    expect(result.ok).toBe(true);
  });

  test("3値以外の account_status を INSERT すると 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      VALUES (gen_random_uuid(), 'テスト街人', '街人（一般）', 'member', 'suspended');
    `);
    expect(sqlstate).toBe("23514");
  });
});

describeDb("members.role の値域（完了条件5・v13 §2 の5値）", () => {
  test("admin / core_member / member / guest / custom の5値は INSERT できる", () => {
    const result = runSql(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      SELECT gen_random_uuid(), 'テスト街人', '街人（一般）', role_value, 'active'
      FROM   unnest(ARRAY['admin', 'core_member', 'member', 'guest', 'custom']) AS role_value;
    `);
    expect(result.ok).toBe(true);
  });

  test("5値以外の role を INSERT すると 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      VALUES (gen_random_uuid(), 'テスト街人', '街人（一般）', 'superuser', 'active');
    `);
    expect(sqlstate).toBe("23514");
  });
});

describeDb("members.member_type の値域（完了条件5・v13 §2 の4値）", () => {
  test("親方 / 街人（コア） / 街人（一般） / ゲスト の4値は INSERT できる", () => {
    const result = runSql(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      SELECT gen_random_uuid(), 'テスト街人', type_value, 'member', 'active'
      FROM   unnest(ARRAY['親方', '街人（コア）', '街人（一般）', 'ゲスト']) AS type_value;
    `);
    expect(result.ok).toBe(true);
  });

  test("4値以外の member_type を INSERT すると 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(`
      INSERT INTO public.members (member_id, nickname, member_type, role, account_status)
      VALUES (gen_random_uuid(), 'テスト街人', '街人', 'member', 'active');
    `);
    expect(sqlstate).toBe("23514");
  });
});

describeDb("member_profiles_private（完了条件6）", () => {
  test("列構成が 会員データモデル §5.2b の表（full_name_normalized を除く）と一致する", () => {
    expect(columnsOf("public.member_profiles_private")).toEqual([...MEMBER_PROFILES_PRIVATE_COLUMNS].sort());
  });

  test("member_id が主キーである（PK 兼 FK ＝ 1対1／§5.2b）", () => {
    const primaryKey = queryRows(`
      SELECT a.attname
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE  i.indrelid = 'public.member_profiles_private'::regclass AND i.indisprimary
      ORDER  BY a.attname COLLATE "C";
    `);
    expect(primaryKey).toEqual(["member_id"]);
  });

  test("member_id が members(member_id) を ON DELETE CASCADE で参照する", () => {
    const reference = query(`
      SELECT c.confrelid::regclass::text || '/' || c.confdeltype
      FROM   pg_constraint c
      WHERE  c.conrelid = 'public.member_profiles_private'::regclass AND c.contype = 'f';
    `);
    expect(reference).toBe("members/c");
  });
});

describeDb("member_role_changes の CHECK 制約（完了条件7）", () => {
  /** 3つの CHECK を1つずつ試すための、他は妥当な1行。 */
  const insertRoleChange = (columns: { oldRole: string; newRole: string; operator: string; reason: string }) => `
    ${FIXTURE_SQL}
    INSERT INTO public.member_role_changes (member_id, old_role, new_role, operator_id, reason)
    VALUES ('00000000-0000-0000-0000-0000000000a2', '${columns.oldRole}', '${columns.newRole}',
            '${columns.operator}', '${columns.reason}');
  `;

  test("3つの CHECK をすべて満たす行は INSERT できる", () => {
    const result = runSql(
      insertRoleChange({
        oldRole: "member",
        newRole: "core_member",
        operator: "00000000-0000-0000-0000-0000000000a1",
        reason: "現場運営を担うため",
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("old_role と new_role が同じ行は 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(
      insertRoleChange({
        oldRole: "member",
        newRole: "member",
        operator: "00000000-0000-0000-0000-0000000000a1",
        reason: "現場運営を担うため",
      }),
    );
    expect(sqlstate).toBe("23514");
  });

  test("member_id と operator_id が同じ行（自己変更の記録）は 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(
      insertRoleChange({
        oldRole: "member",
        newRole: "core_member",
        operator: "00000000-0000-0000-0000-0000000000a2",
        reason: "現場運営を担うため",
      }),
    );
    expect(sqlstate).toBe("23514");
  });

  test("reason が空白だけの行は 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(
      insertRoleChange({
        oldRole: "member",
        newRole: "core_member",
        operator: "00000000-0000-0000-0000-0000000000a1",
        reason: "   ",
      }),
    );
    expect(sqlstate).toBe("23514");
  });
});
