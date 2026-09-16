// WBS 2-1b のログイン導線 DB 側（システム操作者・招待台帳・初回結合）の受入テスト。
//
// 根拠: v13 §5.2.6（会員のログイン方式：メールOTP）／§9 #64、
//       Issue #39 の 2026-09-15 オーナー決定（論点①＝B・②＝A・③＝A）、
//       DB物理設計 §6-6b（service_role は RLS も GRANT も迂回するため関門はトリガーだけ）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
//
// ⚠️ 値を返す関数を `SELECT` で呼ぶと標準出力へ混ざり、後続の検査クエリの結果と
//    区別できなくなる。`helpers/fixtures.ts` と同じく `DO` ブロックで包む。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { declareOperatorSql, FIXTURE_SQL, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";

/** `0004_login_binding_and_invitations.sql` が作る固定 UUID。 */
const SYSTEM_OPERATOR = "00000000-0000-0000-0000-000000000001";

/** 戻り値を標準出力へ出さずに結合を行う。 */
function bindSql(memberId: string, authUserId: string, operatorId: string): string {
  return (
    "DO $$ BEGIN PERFORM public.bind_member_auth_user(" +
    `'${memberId}'::uuid, '${authUserId}'::uuid, '${operatorId}'::uuid); END $$;`
  );
}

describeDb("システム操作者（Issue #39 論点① ＝ 決定B）", () => {
  test("固定 UUID の行が1件だけ存在する", () => {
    const found = query(
      `SELECT count(*) FROM public.members WHERE member_id = '${SYSTEM_OPERATOR}';`,
    );
    expect(found).toBe("1");
  });

  test("ログインの入口を持たない（auth_user_id が NULL）", () => {
    const authUserId = query(
      `SELECT coalesce(auth_user_id::text, 'NULL') FROM public.members
       WHERE member_id = '${SYSTEM_OPERATOR}';`,
    );
    expect(authUserId).toBe("NULL");
  });

  test("active ではないため本人ポリシーの対象外である", () => {
    const status = query(
      `SELECT account_status FROM public.members WHERE member_id = '${SYSTEM_OPERATOR}';`,
    );
    expect(status).not.toBe("active");
  });

  test("最小権限である（admin を持たない）", () => {
    // ガードトリガーは操作者の EXISTS しか見ないため、ここに admin は要らない。
    // 置くと、この行を乗っ取れた場合の被害が跳ね上がる。
    const role = query(
      `SELECT role FROM public.members WHERE member_id = '${SYSTEM_OPERATOR}';`,
    );
    expect(role).toBe("guest");
  });
});

describeDb("member_invitations（経路B の監査台帳 ／ Issue #39 論点② ＝ A）", () => {
  test("v13 §5.2.6 の danger が必須とする4項目を列として持つ", () => {
    const columns = query(`
      SELECT string_agg(column_name, ',' ORDER BY column_name)
      FROM   information_schema.columns
      WHERE  table_schema = 'public' AND table_name = 'member_invitations';
    `).split(",");

    for (const required of [
      "member_id", // どの会員へ
      "sent_to_email", // どのアドレスへ
      "sent_by", // 誰が
      "sent_at", // いつ
      "expires_at", // 有効期限
      "consumed_at", // 消費（誤送信の追跡に使う）
    ]) {
      expect(columns).toContain(required);
    }
  });

  test("RLS が有効である（ポリシー本体は 2-2 だが、既定は全拒否で安全側）", () => {
    const enabled = query(
      "SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.member_invitations'::regclass;",
    );
    expect(enabled).toBe("true");
  });

  test("期限が送信時刻より後でなければ INSERT できない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.member_invitations (member_id, sent_to_email, sent_by, sent_at, expires_at)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'invite@example.invalid',
              '${TEST_MEMBERS.admin.memberId}', now(), now() - interval '1 hour');
    `);
    expect(state).toBe("23514");
  });

  test("送信先アドレスが空白だけなら INSERT できない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.member_invitations (member_id, sent_to_email, sent_by, expires_at)
      VALUES ('${TEST_MEMBERS.self.memberId}', '   ',
              '${TEST_MEMBERS.admin.memberId}', now() + interval '24 hours');
    `);
    expect(state).toBe("23514");
  });

  test("正当な招待は記録できる", () => {
    const count = query(`
      ${FIXTURE_SQL}
      INSERT INTO public.member_invitations (member_id, sent_to_email, sent_by, expires_at)
      VALUES ('${TEST_MEMBERS.preRegistered.memberId}', 'invite@example.invalid',
              '${TEST_MEMBERS.admin.memberId}', now() + interval '24 hours');
      SELECT count(*) FROM public.member_invitations
      WHERE  member_id = '${TEST_MEMBERS.preRegistered.memberId}';
    `);
    expect(count).toBe("1");
  });
});

describeDb("bind_member_auth_user（初回結合）", () => {
  test("結合前の会員に auth_user_id が入り active へ遷移する", () => {
    const result = query(`
      ${FIXTURE_SQL}
      ${bindSql(TEST_MEMBERS.preRegistered.memberId, TEST_AUTH_USERS.spare.id, SYSTEM_OPERATOR)}
      SELECT auth_user_id::text || '/' || account_status
      FROM   public.members WHERE member_id = '${TEST_MEMBERS.preRegistered.memberId}';
    `);
    expect(result).toBe(`${TEST_AUTH_USERS.spare.id}/active`);
  });

  test("既に結合済みの会員は付け替えられない", () => {
    // `self` は既に auth_user_id を持つ。付け替えは名寄せ事故そのものなので拒否される。
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      ${bindSql(TEST_MEMBERS.self.memberId, TEST_AUTH_USERS.spare.id, SYSTEM_OPERATOR)}
    `);
    expect(state).toBe("42501");
  });

  test("authenticated から実行できない（権限列を書き換える入口にしない）", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      SET ROLE authenticated;
      ${bindSql(TEST_MEMBERS.preRegistered.memberId, TEST_AUTH_USERS.spare.id, SYSTEM_OPERATOR)}
    `);
    expect(state).toBe("42501");
  });

  test("anon から実行できない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      SET ROLE anon;
      ${bindSql(TEST_MEMBERS.preRegistered.memberId, TEST_AUTH_USERS.spare.id, SYSTEM_OPERATOR)}
    `);
    expect(state).toBe("42501");
  });
});

describeDb("ガードトリガーに穴を開けていないこと（決定C を採らなかった確認）", () => {
  test("本人が自分の auth_user_id を入れることは依然としてできない", () => {
    // 決定C（ガードトリガーの改訂）を採っていたら、ここが通ってしまう。
    // **通らないことが「最後の関門を残した」ことの証拠**になる。
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      ${declareOperatorSql(TEST_MEMBERS.preRegistered.memberId)}
      UPDATE public.members
      SET    auth_user_id = '${TEST_AUTH_USERS.spare.id}'
      WHERE  member_id = '${TEST_MEMBERS.preRegistered.memberId}';
    `);
    expect(state).toBe("42501");
  });

  test("本人が自力で pre_registered → active にできない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      ${declareOperatorSql(TEST_MEMBERS.preRegistered.memberId)}
      UPDATE public.members
      SET    account_status = 'active'
      WHERE  member_id = '${TEST_MEMBERS.preRegistered.memberId}';
    `);
    expect(state).toBe("42501");
  });
});
