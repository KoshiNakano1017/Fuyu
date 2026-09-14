// RLS の有効化（ポリシー本体は WBS 2-2）と、RLS ヘルパ関数の受入テスト。
//
// 根拠: DB物理設計 §6-2①（ヘルパ関数4本と EXECUTE の限定）・§6-7（デフォルト拒否）・
//       §6-8②（付け忘れを機械的に検出するメタテスト）、2026-09-14 オーナー回答 論点1＝A。

import { describeDb, query, queryRows } from "./helpers/psql";

/** 本パッケージ（WBS 2-1）で作成するテーブル。 */
const TABLES_IN_THIS_PACKAGE = ["members", "member_profiles_private", "member_role_changes"];

/**
 * §6-2① のヘルパ関数4本と、§6-6b② の `current_operator_id()`。
 * 前者は行の可視性を判定し、後者は誰が操作したかを判定する。目的が違うので分けてある。
 */
const HELPER_FUNCTIONS = [
  "current_member_id",
  "current_member_role",
  "is_staff",
  "is_admin",
  "current_operator_id",
];

const helperFunctionList = `'${HELPER_FUNCTIONS.join("', '")}'`;

describeDb("RLS の有効化（完了条件17・18）", () => {
  test("本パッケージで作成した全テーブルで RLS が有効である", () => {
    const rlsDisabled = queryRows(`
      SELECT c.relname
      FROM   pg_class c
      WHERE  c.relnamespace = 'public'::regnamespace
        AND  c.relname IN ('${TABLES_IN_THIS_PACKAGE.join("', '")}')
        AND  NOT c.relrowsecurity
      ORDER  BY c.relname COLLATE "C";
    `);
    expect(rlsDisabled).toEqual([]);
  });

  test("members に FORCE ROW LEVEL SECURITY が設定されていない", () => {
    // 付けると SECURITY DEFINER のヘルパ関数にも RLS が適用され、
    // members のポリシー → is_staff() → members のポリシー … と再帰して 42P17 で全クエリが落ちる（§6-2① の danger）
    const forced = query(`
      SELECT c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'public.members'::regclass;
    `);
    expect(forced).toBe("f");
  });
});

describeDb("RLS ヘルパ関数（完了条件19）", () => {
  test("ヘルパ関数4本と current_operator_id() が定義されている", () => {
    const defined = queryRows(`
      SELECT p.proname
      FROM   pg_proc p
      WHERE  p.pronamespace = 'public'::regnamespace
        AND  p.proname IN (${helperFunctionList})
      ORDER  BY p.proname COLLATE "C";
    `);
    expect(defined).toEqual([...HELPER_FUNCTIONS].sort());
  });

  test("authenticated に EXECUTE が付与されている", () => {
    const missing = queryRows(`
      SELECT p.proname
      FROM   pg_proc p
      WHERE  p.pronamespace = 'public'::regnamespace
        AND  p.proname IN (${helperFunctionList})
        AND  NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      ORDER  BY p.proname COLLATE "C";
    `);
    expect(missing).toEqual([]);
  });

  test("anon には EXECUTE が付与されていない", () => {
    // 「付いている」側だけを見ると、PUBLIC へ開けっ放しでも試験が通る（§6-8⑤ の対で書く規律）
    const granted = queryRows(`
      SELECT p.proname
      FROM   pg_proc p
      WHERE  p.pronamespace = 'public'::regnamespace
        AND  p.proname IN (${helperFunctionList})
        AND  has_function_privilege('anon', p.oid, 'EXECUTE')
      ORDER  BY p.proname COLLATE "C";
    `);
    expect(granted).toEqual([]);
  });

  test("PUBLIC には EXECUTE が付与されていない", () => {
    const granted = queryRows(`
      SELECT p.proname
      FROM   pg_proc p, aclexplode(p.proacl) acl
      WHERE  p.pronamespace = 'public'::regnamespace
        AND  p.proname IN (${helperFunctionList})
        AND  acl.grantee = 0
        AND  acl.privilege_type = 'EXECUTE'
      ORDER  BY p.proname COLLATE "C";
    `);
    expect(granted).toEqual([]);
  });
});
