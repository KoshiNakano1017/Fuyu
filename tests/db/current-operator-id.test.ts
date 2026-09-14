// `current_operator_id()` の受入テスト（DB物理設計 §6-6b②）。
//
// この関数は「誰が権限列を変更したか」を決める唯一の入口であり、
// ここが緩むとガードトリガー（§6-6b③）の判定ごと無意味になる。
// 申告値（`app.operator_id`）は詐称できるが、JWT 由来の `auth.uid()` は詐称できない。
// **両方が得られて食い違う場合は、なりすましの疑いとして拒否する。**

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, TEST_AUTH_USERS, TEST_MEMBERS, declareOperatorSql, loginAsSql } from "./helpers/fixtures";

const SELF = TEST_MEMBERS.self;
const ADMIN = TEST_MEMBERS.admin;
const CALL = "SELECT public.current_operator_id();";

function script(...statements: string[]): string {
  return [FIXTURE_SQL, ...statements].join("\n");
}

describeDb("current_operator_id() の操作者特定（完了条件23）", () => {
  test("app.operator_id を uuid として解釈できないとき 22023 を投げる", () => {
    const sqlstate = sqlstateOf(script(declareOperatorSql("親方その1"), CALL));
    expect(sqlstate).toBe("22023");
  });

  test("auth.uid() 由来の操作者と申告された操作者が食い違うとき 42501 を投げる", () => {
    const sqlstate = sqlstateOf(script(loginAsSql(TEST_AUTH_USERS.self.id), declareOperatorSql(ADMIN.memberId), CALL));
    expect(sqlstate).toBe("42501");
  });

  test("auth.uid() 由来の操作者と申告された操作者が一致すれば、その member_id を返す", () => {
    const operatorId = query(script(loginAsSql(TEST_AUTH_USERS.self.id), declareOperatorSql(SELF.memberId), CALL));
    expect(operatorId).toBe(SELF.memberId);
  });

  test("ログインセッションだけでも（申告が無くても）その member_id を返す", () => {
    const operatorId = query(script(loginAsSql(TEST_AUTH_USERS.self.id), CALL));
    expect(operatorId).toBe(SELF.memberId);
  });

  test("auth.uid() も app.operator_id も無ければ NULL を返す（拒否の判断はトリガー側）", () => {
    const operatorId = query(script(CALL));
    expect(operatorId).toBe("");
  });
});
