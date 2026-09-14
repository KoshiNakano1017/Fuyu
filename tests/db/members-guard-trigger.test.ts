// 権限列のガードトリガー（`BEFORE UPDATE ON members`）の受入テスト。
//
// 根拠: DB物理設計 §6-6b②③⑤、会員データモデル §5.2a、正本 v13 §7「★ 権限変更履歴」。
// CLAUDE.md §4.4 が「認可に関わるロジックは必ずテストを書く」と定める領域そのものであり、
// 許可側（できる）と拒否側（できない）を必ず対で書く（DB物理設計 §6-8⑤）。
//
// ⚠️ ここで守っているのは「自分で自分を admin にできない」ことである。
//    列単位 GRANT は `service_role` を素通りさせるため、関門はトリガーしかない（§6-6b の danger）。

import { describeDb, query, runSql, sqlstateOf } from "./helpers/psql";
import {
  FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
  declareOperatorSql,
  declareReasonSql,
} from "./helpers/fixtures";

const SELF = TEST_MEMBERS.self;
const ADMIN = TEST_MEMBERS.admin;
const PRE_REGISTERED = TEST_MEMBERS.preRegistered;

/** フィクスチャ投入 → 申告 → 更新、の順に流す1本のスクリプトを組む。 */
function script(...statements: string[]): string {
  return [FIXTURE_SQL, ...statements].join("\n");
}

const updateSelfRole = `UPDATE public.members SET role = 'admin' WHERE member_id = '${SELF.memberId}';`;

describeDb("role の自己変更（完了条件8）", () => {
  test("操作者＝対象本人である role の変更は 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(declareOperatorSql(SELF.memberId), declareReasonSql("自分で昇格したい"), updateSelfRole),
    );
    expect(sqlstate).toBe("42501");
  });

  test("他人の role を理由付きで変更する UPDATE は成功する", () => {
    const result = runSql(
      script(declareOperatorSql(ADMIN.memberId), declareReasonSql("現場運営を担うため"), updateSelfRole),
    );
    expect(result.ok).toBe(true);
  });
});

describeDb("role 変更の理由申告（完了条件9）", () => {
  test("他人の role を変更する UPDATE は app.change_reason が未設定のとき 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(script(declareOperatorSql(ADMIN.memberId), updateSelfRole));
    expect(sqlstate).toBe("23514");
  });

  test("app.change_reason が空白だけのときも 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(declareOperatorSql(ADMIN.memberId), declareReasonSql("   "), updateSelfRole),
    );
    expect(sqlstate).toBe("23514");
  });
});

describeDb("操作者を特定できない経路からの権限列 UPDATE（完了条件10）", () => {
  // auth.uid() も app.operator_id も無い ＝ 移行スクリプト・psql からの素の UPDATE。
  // 安全側の既定として、権限列4つのすべてが拒否される（DB物理設計 §6-6b② の danger）。
  test("role の UPDATE が 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(script(declareReasonSql("理由はあるが操作者が不明"), updateSelfRole));
    expect(sqlstate).toBe("42501");
  });

  test("auth_user_id の UPDATE が 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(
        `UPDATE public.members SET auth_user_id = '${TEST_AUTH_USERS.spare.id}' WHERE member_id = '${PRE_REGISTERED.memberId}';`,
      ),
    );
    expect(sqlstate).toBe("42501");
  });

  test("account_status の UPDATE が 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(`UPDATE public.members SET account_status = 'active' WHERE member_id = '${PRE_REGISTERED.memberId}';`),
    );
    expect(sqlstate).toBe("42501");
  });

  test("member_type の UPDATE が 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(`UPDATE public.members SET member_type = '親方' WHERE member_id = '${SELF.memberId}';`),
    );
    expect(sqlstate).toBe("42501");
  });
});

describeDb("auth_user_id の変更（完了条件11・12）", () => {
  test("操作者＝対象本人である auth_user_id の変更は拒否される", () => {
    // 本人ポリシーの根拠そのもの。他人の auth.uid() を書ければ、その人の行が「自分の行」になる（§5.2a）
    const sqlstate = sqlstateOf(
      script(
        declareOperatorSql(SELF.memberId),
        `UPDATE public.members SET auth_user_id = '${TEST_AUTH_USERS.spare.id}' WHERE member_id = '${SELF.memberId}';`,
      ),
    );
    expect(sqlstate).toBe("42501");
  });

  test("すでに非 NULL である auth_user_id の付け替えは拒否される", () => {
    const sqlstate = sqlstateOf(
      script(
        declareOperatorSql(ADMIN.memberId),
        `UPDATE public.members SET auth_user_id = '${TEST_AUTH_USERS.spare.id}' WHERE member_id = '${SELF.memberId}';`,
      ),
    );
    expect(sqlstate).toBe("42501");
  });

  test("NULL の auth_user_id へ他人が値を入れる（名寄せ成立）UPDATE は成功する", () => {
    const result = runSql(
      script(
        declareOperatorSql(ADMIN.memberId),
        `UPDATE public.members SET auth_user_id = '${TEST_AUTH_USERS.spare.id}' WHERE member_id = '${PRE_REGISTERED.memberId}';`,
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describeDb("account_status の自己変更（完了条件13）", () => {
  test("操作者＝対象本人である account_status の変更は active → withdrawn なら成功する", () => {
    const result = runSql(
      script(
        declareOperatorSql(SELF.memberId),
        `UPDATE public.members SET account_status = 'withdrawn' WHERE member_id = '${SELF.memberId}';`,
      ),
    );
    expect(result.ok).toBe(true);
  });

  test("操作者＝対象本人である account_status の pre_registered → active は 42501 で拒否される", () => {
    // 自力で active になれると、本人確認を飛ばして移行済み会員の宿泊券・Uii残高を掌握できる（§6-6b①）
    const sqlstate = sqlstateOf(
      script(
        declareOperatorSql(PRE_REGISTERED.memberId),
        `UPDATE public.members SET account_status = 'active' WHERE member_id = '${PRE_REGISTERED.memberId}';`,
      ),
    );
    expect(sqlstate).toBe("42501");
  });
});

describeDb("member_type の自己変更（完了条件14）", () => {
  test("操作者＝対象本人である member_type の変更は 42501 で拒否される", () => {
    const sqlstate = sqlstateOf(
      script(
        declareOperatorSql(SELF.memberId),
        `UPDATE public.members SET member_type = '親方' WHERE member_id = '${SELF.memberId}';`,
      ),
    );
    expect(sqlstate).toBe("42501");
  });

  test("他人の member_type を変更する UPDATE は成功する", () => {
    const result = runSql(
      script(
        declareOperatorSql(ADMIN.memberId),
        `UPDATE public.members SET member_type = '親方' WHERE member_id = '${SELF.memberId}';`,
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describeDb("権限列以外の UPDATE（完了条件15）", () => {
  test("nickname だけを変える UPDATE は app.operator_id の申告なしで成功する", () => {
    // 権限列が1つも変わっていなければトリガーは何もしない（§6-6b③ の素通り分岐）。
    // ここが塞がると、一般会員が自分のニックネームすら変えられなくなる
    const result = runSql(
      script(`UPDATE public.members SET nickname = 'テスト街人あらため' WHERE member_id = '${SELF.memberId}';`),
    );
    expect(result.ok).toBe(true);
  });
});

describeDb("role 変更の監査記録（完了条件16）", () => {
  test("他人の role を理由付きで変更すると member_role_changes に1行だけ記録される", () => {
    const recorded = query(
      script(
        declareOperatorSql(ADMIN.memberId),
        declareReasonSql("現場運営を担うため"),
        `UPDATE public.members SET role = 'core_member' WHERE member_id = '${SELF.memberId}';`,
        `SELECT format('%s|%s|%s|%s|%s', count(*), min(old_role), min(new_role), min(operator_id), min(reason))
         FROM   public.member_role_changes
         WHERE  member_id = '${SELF.memberId}';`,
      ),
    );
    expect(recorded).toBe(`1|member|core_member|${ADMIN.memberId}|現場運営を担うため`);
  });
});
