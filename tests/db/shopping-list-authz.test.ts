// 買い物リストの認可受入テスト（Issue #147 ／ WBS `5-8` 買い物リスト（ほしいものリスト））。
//
// 固定する完了条件:
//   9 街人（`member`）は `希望` → `買う` へ変更できない
//  10 管理者・コアメンバーは `希望` → `買う`、および `見送り`（理由つき）へ変更できる
//  11 取下げは論理削除であり、理由を伴わない取下げは拒否される
//  12 品目の行を物理削除できるロールが存在しない
//  13 ゲストの登録がサーバサイドで拒否される（画面を経由しない直接リクエストでも通らない）
//  14 ゲストは買い物リストを閲覧できる
//  15 管理者・コアメンバー・街人は「自分も欲しい」を付けられ、`requesters[]` に自分の会員IDが加わる
//  16 同じ会員が2回実行しても `requesters[]` の要素は増えない
//  17 ゲストは「自分も欲しい」を実行できない
//  18 相乗りの操作で `requesters[]` 以外の列が書き換わらない
//  19 登録者本人が、自分が登録した品目を編集・取下げできる
//
// 根拠: v13 §5.12.1（登録ロール・相乗り・編集・取下げ）／ §5.12.2（買う・見送りの判断者）／
//       §6 権限マトリクス L2357〜2362 ／ §5.9.3（DOM 非表示は認可ではない・RLS で担保する）。
//
// CLAUDE.md §4.4: 認可は**許可側と拒否側を対で**書く。片側だけでは境界が固定されない。
// 判定キーは `role` であって `member_type` ではない（CLAUDE.md §4.1）。`oyakata` 役
// （`member_type = '親方'` ／ `role = 'member'`）が拒否される側に居ることでそれを示す。
//
// 拒否の検査は SQLSTATE ではなく「状態が変わらないこと」で見る。RLS の USING で 0 行になるか
// トリガーが 42501 を投げるかは実装の選び方であり、完了条件が求めているのは結果のほうである。

import {
  AS_ADMIN,
  AS_CORE,
  AS_GUEST,
  AS_OTHER_MEMBER,
  AS_OWNER,
  GUEST_MEMBER,
  ITEM,
  resolveColumn,
  rowCountAfterAttempt,
  SHOPPING_FIXTURE_SQL,
  SHOPPING_TABLE,
  swallowing,
  valueAfterAttempt,
  withdrawAssignment,
  withdrawnPredicate,
} from "./helpers/shopping-list";
import { loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query } from "./helpers/psql";

/** 相乗りの入口。品目を直接 UPDATE させず、この関数越しにだけ `requesters[]` を伸ばす。 */
const ADD_REQUESTER = `PERFORM public.shopping_item_add_requester('${ITEM.itemId}');`;

const DECIDE_BUY = `UPDATE ${SHOPPING_TABLE} SET status = '買う' WHERE item_id = '${ITEM.itemId}';`;

/** 見送りは「誰が」「なぜ」を必ず残す（§5.12.2）。判断者は操作している本人を入れる。 */
const skipSql = (deciderMemberId: string, reason: string) => `
  UPDATE ${SHOPPING_TABLE}
     SET status = '見送り', ${resolveColumn("見送り理由")} = '${reason}',
         ${resolveColumn("見送り者ID")} = '${deciderMemberId}'
   WHERE item_id = '${ITEM.itemId}';`;

const withdrawSql = (reason: string | null) => {
  const reasonValue = reason === null ? "NULL" : `'${reason}'`;
  return `
    UPDATE ${SHOPPING_TABLE}
       SET ${withdrawAssignment()}, ${resolveColumn("取下げ理由")} = ${reasonValue}
     WHERE item_id = '${ITEM.itemId}';`;
};

describeDb("「買う」の判断は運営だけができる（完了条件9・10 ／ v13 §5.12.2・§6）", () => {
  test("管理者は 希望 から 買う へ変更できる", () => {
    expect(valueAfterAttempt(AS_ADMIN, DECIDE_BUY, "status")).toBe("買う");
  });

  test("コアメンバーは 希望 から 買う へ変更できる", () => {
    expect(valueAfterAttempt(AS_CORE, DECIDE_BUY, "status")).toBe("買う");
  });

  test("街人は自分が登録した品目でも 買う へ変更できない", () => {
    // 登録がそのまま購入対象になると、運営のフィルタを通らない「希望の墓場」ができる（§5.12.2）。
    expect(valueAfterAttempt(AS_OWNER, DECIDE_BUY, "status")).toBe("希望");
  });

  test("立場が親方でも role が member なら 買う へ変更できない", () => {
    expect(valueAfterAttempt(AS_OTHER_MEMBER, DECIDE_BUY, "status")).toBe("希望");
  });

  test("ゲストは 買う へ変更できない", () => {
    expect(valueAfterAttempt(AS_GUEST, DECIDE_BUY, "status")).toBe("希望");
  });
});

describeDb("見送りは運営が理由を添えて行う（完了条件10 ／ v13 §5.12.2）", () => {
  test("管理者は理由を添えて 見送り にできる", () => {
    expect(valueAfterAttempt(AS_ADMIN, skipSql(TEST_MEMBERS.admin.memberId, "在庫がまだある"), "status")).toBe(
      "見送り",
    );
  });

  test("コアメンバーも理由を添えて 見送り にできる", () => {
    expect(valueAfterAttempt(AS_CORE, skipSql(TEST_MEMBERS.core.memberId, "在庫がまだある"), "status")).toBe("見送り");
  });

  test("街人は 見送り にできない", () => {
    expect(valueAfterAttempt(AS_OTHER_MEMBER, skipSql(TEST_MEMBERS.oyakata.memberId, "要らないと思う"), "status")).toBe(
      "希望",
    );
  });
});

describeDb("取下げは理由つきの論理削除（完了条件11・19 ／ v13 §5.12.1）", () => {
  test("登録者本人は理由を添えて取り下げられる", () => {
    expect(valueAfterAttempt(AS_OWNER, withdrawSql("自分で買った"), withdrawnPredicate())).toBe("t");
  });

  test("取り下げても行は消えない（論理削除である）", () => {
    expect(rowCountAfterAttempt(AS_OWNER, withdrawSql("自分で買った"))).toBe("1");
  });

  test("理由を伴わない取下げは通らない", () => {
    // 却下・取下げの履歴は、翌週また同じ品目が登録されるのを減らすために残す（§5.12.2）。
    expect(valueAfterAttempt(AS_OWNER, withdrawSql(null), withdrawnPredicate())).toBe("f");
  });

  test("空白だけの理由でも取り下げられない", () => {
    expect(valueAfterAttempt(AS_OWNER, withdrawSql("   "), withdrawnPredicate())).toBe("f");
  });
});

describeDb("物理削除できるロールが無い（完了条件12 ／ v13 §5.12.1）", () => {
  const DELETE_ITEM = `DELETE FROM ${SHOPPING_TABLE} WHERE item_id = '${ITEM.itemId}';`;
  const PRELUDE_BY_ROLE: Record<string, string> = {
    管理者: AS_ADMIN,
    コアメンバー: AS_CORE,
    登録者本人: AS_OWNER,
    他の街人: AS_OTHER_MEMBER,
    ゲスト: AS_GUEST,
  };

  test.each(Object.keys(PRELUDE_BY_ROLE))("%s が DELETE を試みても行が残る", (role) => {
    expect(rowCountAfterAttempt(PRELUDE_BY_ROLE[role], DELETE_ITEM)).toBe("1");
  });
});

describeDb("ゲストは登録できない（完了条件13 ／ v13 §5.12.1・§9 #65②）", () => {
  const insertAs = (memberId: string) =>
    `INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by) VALUES ('軍手', '${memberId}');`;

  const registeredCount = (prelude: string, memberId: string) =>
    query(`
      ${prelude}
      ${swallowing(insertAs(memberId))}
      RESET ROLE;
      SELECT count(*) FROM ${SHOPPING_TABLE} WHERE registered_by = '${memberId}' AND item_name = '軍手';
    `);

  test("街人は登録できる", () => {
    expect(registeredCount(AS_OTHER_MEMBER, TEST_MEMBERS.oyakata.memberId)).toBe("1");
  });

  test("ゲストの登録は DB まで届いても保存されない", () => {
    // 画面から導線を消すだけでは認可にならない（§5.9.3）。直接叩かれた場合をここで止める。
    expect(registeredCount(AS_GUEST, GUEST_MEMBER.memberId)).toBe("0");
  });

  test("街人が他人名義で登録することもできない", () => {
    expect(registeredCount(AS_OTHER_MEMBER, TEST_MEMBERS.admin.memberId)).toBe("0");
  });
});

describeDb("ゲストは閲覧できる（完了条件14 ／ v13 §6 買い物リストの閲覧）", () => {
  test("ゲストからも品目が1件見える", () => {
    expect(
      query(`
        ${AS_GUEST}
        SELECT count(*) FROM ${SHOPPING_TABLE} WHERE item_id = '${ITEM.itemId}';
      `),
    ).toBe("1");
  });
});

describeDb("相乗り（完了条件15・16・17 ／ v13 §5.12.1）", () => {
  const joinedBy = (prelude: string, memberId: string) =>
    valueAfterAttempt(prelude, ADD_REQUESTER, `('${memberId}' = ANY(requesters))`);

  test("管理者は他人の品目に自分も欲しいを付けられる", () => {
    expect(joinedBy(AS_ADMIN, TEST_MEMBERS.admin.memberId)).toBe("t");
  });

  test("コアメンバーは他人の品目に自分も欲しいを付けられる", () => {
    expect(joinedBy(AS_CORE, TEST_MEMBERS.core.memberId)).toBe("t");
  });

  test("街人は他人の品目に自分も欲しいを付けられる", () => {
    expect(joinedBy(AS_OTHER_MEMBER, TEST_MEMBERS.oyakata.memberId)).toBe("t");
  });

  test("同じ会員が2回実行しても requesters の要素は増えない", () => {
    // 希望者数が運営の優先順位の根拠になるため、同一人の重複は数を歪める（§5.12.1）。
    expect(
      valueAfterAttempt(AS_CORE, `${ADD_REQUESTER}\n${ADD_REQUESTER}`, "coalesce(array_length(requesters, 1), 0)"),
    ).toBe("1");
  });

  test("ゲストは自分も欲しいを付けられない", () => {
    expect(valueAfterAttempt(AS_GUEST, ADD_REQUESTER, "coalesce(array_length(requesters, 1), 0)")).toBe("0");
  });
});

describeDb("相乗りは requesters 以外を書き換えない（完了条件18 ／ v13 §5.12.1）", () => {
  test("相乗りの前後で requesters 以外の列がすべて同じである", () => {
    // 品名・参考価格を相乗りの経路から書き換えられると、登録者の意図が他人に上書きされる。
    const unchanged = query(`
      ${SHOPPING_FIXTURE_SQL}
      CREATE TEMP TABLE shopping_snapshot AS
      SELECT to_jsonb(t) AS item_json FROM ${SHOPPING_TABLE} t WHERE item_id = '${ITEM.itemId}';
      ${loginAsSql(TEST_AUTH_USERS.core.id)}
      SET ROLE authenticated;
      ${swallowing(ADD_REQUESTER)}
      RESET ROLE;
      SELECT (SELECT to_jsonb(t) - 'requesters' - 'updated_at' FROM ${SHOPPING_TABLE} t
               WHERE item_id = '${ITEM.itemId}')
           = (SELECT item_json - 'requesters' - 'updated_at' FROM shopping_snapshot);
    `);
    expect(unchanged).toBe("t");
  });

  test("相乗りしても品名が変わらない", () => {
    expect(valueAfterAttempt(AS_CORE, ADD_REQUESTER, "item_name")).toBe(ITEM.itemName);
  });
});

describeDb("登録者本人は自分の品目を編集できる（完了条件19 ／ v13 §5.12.1・§6）", () => {
  const rename = `UPDATE ${SHOPPING_TABLE} SET item_name = '食器用洗剤（詰替）' WHERE item_id = '${ITEM.itemId}';`;

  test("登録者本人の編集は反映される", () => {
    expect(valueAfterAttempt(AS_OWNER, rename, "item_name")).toBe("食器用洗剤（詰替）");
  });

  test("他の街人は他人の品目を編集できない", () => {
    expect(valueAfterAttempt(AS_OTHER_MEMBER, rename, "item_name")).toBe(ITEM.itemName);
  });

  test("ゲストは他人の品目を編集できない", () => {
    expect(valueAfterAttempt(AS_GUEST, rename, "item_name")).toBe(ITEM.itemName);
  });
});
