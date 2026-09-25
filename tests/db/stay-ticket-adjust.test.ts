// 宿泊券の手動増減の DB 側ガード（`0016_membership_plans_and_stay_tickets.sql` ／ WBS 10-4）の受入テスト。
//
// 根拠: v13 §5.8.5（運営による手動増減・理由入力の必須化・調整ログ・消費との整合）、
//       2026-09-25 オーナー決定 §23-3（操作ロールは正本 §5.8.5 が正しい ＝ admin ／ core_member）。
//
// ⚠️ ここで守っているのは**宿泊券という金銭価値を持つ権利**である。
//    画面（C8）と Server Action が正しくても、PostgREST 直アクセスはそこを通らない。
//    「理由なしの増減」「他人による増減」「残高の直接上書き」を止めるのは DB 側だけである。

import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

const TABLE = "public.stay_ticket_transactions";

function loggedInAs(authUserId: string): string {
  return `${FIXTURE_SQL}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
const asSelf = loggedInAs(TEST_AUTH_USERS.self.id);

/** `self` へ宿泊券4泊を初期付与した状態（街人登録の付与を模す）。 */
const GRANTED = `
  INSERT INTO ${TABLE} (member_id, tx_type, nights)
  VALUES ('${TEST_MEMBERS.self.memberId}', 'initial_grant', 4);
`;

function adjustSql(params: {
  nights: number;
  reason?: string | null;
  operatorId?: string | null;
}): string {
  const reason = params.reason === null || params.reason === undefined ? "NULL" : `'${params.reason}'`;
  const operator =
    params.operatorId === null || params.operatorId === undefined ? "NULL" : `'${params.operatorId}'`;
  return `
    INSERT INTO ${TABLE} (member_id, tx_type, nights, reason, operator_id)
    VALUES ('${TEST_MEMBERS.self.memberId}', 'staff_adjust', ${params.nights}, ${reason}, ${operator});
  `;
}

describeDb("運営は宿泊券を増減できる（v13 §5.8.5 ／ 決定 §23-3）", () => {
  test("管理者の加算が残高へ反映される", () => {
    const balance = query(`
      ${asAdmin}
      ${GRANTED}
      ${adjustSql({ nights: 3, reason: "出資追加", operatorId: TEST_MEMBERS.admin.memberId })}
      SELECT public.stay_ticket_balance('${TEST_MEMBERS.self.memberId}');
    `);
    expect(balance).toBe("7");
  });

  test("★ コアメンバーも増減できる（`stay_tx_insert_staff` は staff である）", () => {
    const balance = query(`
      ${asCore}
      ${GRANTED}
      ${adjustSql({ nights: -1, reason: "誤登録の訂正", operatorId: TEST_MEMBERS.core.memberId })}
      SELECT public.stay_ticket_balance('${TEST_MEMBERS.self.memberId}');
    `);
    expect(balance).toBe("3");
  });

  test("残高は取引の積み上げである（複数の調整が合算される）", () => {
    const balance = query(`
      ${asAdmin}
      ${GRANTED}
      ${adjustSql({ nights: 2, reason: "イベント招待枠", operatorId: TEST_MEMBERS.admin.memberId })}
      ${adjustSql({ nights: -3, reason: "誤登録の訂正", operatorId: TEST_MEMBERS.admin.memberId })}
      SELECT public.stay_ticket_balance('${TEST_MEMBERS.self.memberId}');
    `);
    expect(balance).toBe("3");
  });
});

describeDb("本人は自分の宿泊券を増やせない", () => {
  test("一般会員の INSERT は RLS で拒否される", () => {
    expect(
      sqlstateOf(`
        ${asSelf}
        ${adjustSql({ nights: 10, reason: "自分で足す", operatorId: TEST_MEMBERS.self.memberId })}
      `),
    ).toBe("42501");
  });

  test("本人は明細を読める（v13 §5.8.5「本人への反映」）", () => {
    const visible = query(`
      ${asAdmin}
      ${GRANTED}
      ${adjustSql({ nights: 1, reason: "特例付与", operatorId: TEST_MEMBERS.admin.memberId })}
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM ${TABLE} WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(visible).toBe("2");
  });

  test("他人の明細は見えない", () => {
    const visible = query(`
      ${asAdmin}
      ${GRANTED}
      ${loginAsSql(TEST_AUTH_USERS.oyakata.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(visible).toBe("0");
  });
});

describeDb("理由なしの増減を物理的に作れない（chk_stay_tx_manual_needs_reason）", () => {
  test("理由が NULL の staff_adjust は拒否される", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${adjustSql({ nights: 1, reason: null, operatorId: TEST_MEMBERS.admin.memberId })}
      `),
    ).toBe("23514");
  });

  test("空白文字だけの理由も拒否される", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${adjustSql({ nights: 1, reason: "   ", operatorId: TEST_MEMBERS.admin.memberId })}
      `),
    ).toBe("23514");
  });

  test("操作者が空の staff_adjust は拒否される（誰が調整したか分からない行を残さない）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${adjustSql({ nights: 1, reason: "特例付与", operatorId: null })}
      `),
    ).toBe("23514");
  });

  test("0 泊の取引は拒否される", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${adjustSql({ nights: 0, reason: "意味のない調整", operatorId: TEST_MEMBERS.admin.memberId })}
      `),
    ).toBe("23514");
  });
});

describeDb("残高を直接上書きする経路が無い（v13 §5.8.5「消費との整合」）", () => {
  test("積んだ取引を UPDATE できない（GRANT を与えていない）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${GRANTED}
        UPDATE ${TABLE} SET nights = 100 WHERE member_id = '${TEST_MEMBERS.self.memberId}';
      `),
    ).toBe("42501");
  });

  test("積んだ取引を DELETE できない", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${GRANTED}
        DELETE FROM ${TABLE} WHERE member_id = '${TEST_MEMBERS.self.memberId}';
      `),
    ).toBe("42501");
  });
});

describeDb("調整ログに要る列が揃っている（v13 §5.8.5「誰が・いつ・なぜ」）", () => {
  test("reason ／ operator_id ／ occurred_at を保持している", () => {
    const row = query(`
      ${asAdmin}
      ${adjustSql({ nights: 2, reason: "出資追加", operatorId: TEST_MEMBERS.admin.memberId })}
      RESET ROLE;
      SELECT reason || '/' || operator_id::text || '/' || (occurred_at IS NOT NULL)::text
      FROM   ${TABLE} WHERE tx_type = 'staff_adjust';
    `);
    expect(row).toBe(`出資追加/${TEST_MEMBERS.admin.memberId}/true`);
  });

  test("★ `note` という列は存在しない（読み出し側の列名誤りを固定する）", () => {
    // 2026-09-25 まで `fetchStayTicketHistory()` が `note` を select しており、
    // 列が無いので毎回エラー→明細が常に空だった。同じ誤りを再発させないための歯止め。
    const exists = query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = '${TABLE}'::regclass AND attname = 'note' AND NOT attisdropped
      );
    `);
    expect(exists).toBe("f");
  });
});
