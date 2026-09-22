// 本人による受領報告のガード（`0032_eumo_self_receipt.sql` ／ WBS 5-7・8-4）の受入テスト。
//
// 根拠: v13 §5.3.1（受領確認は本人の受領報告でも可）、`0023_eumo_grants.sql`（staff 限定だった UPDATE）。
//
// ⚠️ ここで守っているのは「本人に開けた穴から金額を書き換えられないこと」である。
//    RLS は列を絞れないため、本人 UPDATE を開けた時点で `amount_uii` も射程に入る。
//    アプリ層（`src/app/me/actions.ts`）が正しくても、PostgREST 直アクセスはそこを通らない。

import {
  FIXTURE_SQL,
  loginAsSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

const GRANT_ID = "00000000-0000-0000-0000-0000000000f1";

/** 送付済みの給付1件（本人＝`self`宛）。受領報告の出発点になる状態。 */
const GRANT_FIXTURE = `
${FIXTURE_SQL}
INSERT INTO public.eumo_grants
  (grant_id, member_id, amount_uii, grant_type, purpose, status, sent_by, sent_at, sent_channel)
VALUES
  ('${GRANT_ID}', '${TEST_MEMBERS.self.memberId}', 5000, 'first_visit_cashback',
   '初回来訪キャッシュバック', '送付済', '${TEST_MEMBERS.admin.memberId}', now(), 'email');
`;

function loggedInAs(authUserId: string): string {
  return `${GRANT_FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asSelf = loggedInAs(TEST_AUTH_USERS.self.id);
const asOther = loggedInAs(TEST_AUTH_USERS.oyakata.id);
const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);

const REPORT_RECEIPT = (memberId: string) => `
UPDATE public.eumo_grants
SET    status = '受領確認済',
       received_confirmed_by = '${memberId}',
       received_confirmed_at = now()
WHERE  grant_id = '${GRANT_ID}';
`;

function statusAfter(prelude: string, statement: string): string {
  return query(`
    ${prelude}
    ${statement}
    RESET ROLE;
    SELECT status FROM public.eumo_grants WHERE grant_id = '${GRANT_ID}';
  `);
}

describeDb("本人の受領報告（v13 §5.3.1）", () => {
  test("本人は自分の給付を受領確認済みにできる", () => {
    expect(statusAfter(asSelf, REPORT_RECEIPT(TEST_MEMBERS.self.memberId))).toBe("受領確認済");
  });

  test("運営はこれまでどおり受領確認できる", () => {
    expect(statusAfter(asAdmin, REPORT_RECEIPT(TEST_MEMBERS.admin.memberId))).toBe("受領確認済");
  });

  test("他人の給付は更新できない（0行で終わる）", () => {
    // RLS の USING（本人 or staff）で落ちるため、例外は上がらず0行になる。
    const affected = query(`
      ${asOther}
      WITH changed AS (
        UPDATE public.eumo_grants
        SET    status = '受領確認済', received_confirmed_by = '${TEST_MEMBERS.oyakata.memberId}',
               received_confirmed_at = now()
        WHERE  grant_id = '${GRANT_ID}'
        RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });
});

describeDb("本人に許すのは受領報告だけである（0032 のトリガー）", () => {
  test("本人が給付額を書き換えようとすると拒否される（42501）", () => {
    const tamper = `
      UPDATE public.eumo_grants
      SET    status = '受領確認済', received_confirmed_by = '${TEST_MEMBERS.self.memberId}',
             received_confirmed_at = now(), amount_uii = 50000
      WHERE  grant_id = '${GRANT_ID}';
    `;
    expect(sqlstateOf(`${asSelf}\n${tamper}`)).toBe("42501");
  });

  test("本人が「送付済」を名乗ることはできない（送っていないものを送ったことにしない）", () => {
    const tamper = `
      UPDATE public.eumo_grants
      SET    sent_at = now(), sent_by = '${TEST_MEMBERS.self.memberId}'
      WHERE  grant_id = '${GRANT_ID}';
    `;
    expect(sqlstateOf(`${asSelf}\n${tamper}`)).toBe("42501");
  });

  test("受領確認者を他人にすり替えられない", () => {
    const tamper = `
      UPDATE public.eumo_grants
      SET    status = '受領確認済', received_confirmed_by = '${TEST_MEMBERS.admin.memberId}',
             received_confirmed_at = now()
      WHERE  grant_id = '${GRANT_ID}';
    `;
    expect(sqlstateOf(`${asSelf}\n${tamper}`)).toBe("42501");
  });

  test("受領確認済みを未送付へ巻き戻せない", () => {
    const rollback = `
      UPDATE public.eumo_grants SET status = '未送付' WHERE grant_id = '${GRANT_ID}';
    `;
    expect(sqlstateOf(`${asSelf}\n${rollback}`)).toBe("42501");
  });
});
