// 明細行の取消（論理削除）の受入テスト（`0031_order_items_void.sql` ／ WBS 7-2）。
//
// 根拠: v13 §5.6.2（品目の削除・論理削除）、§5.6.4（編集理由の必須入力）、
//       `0019_orders_and_settlement.sql`（`order_items` の RLS ／ GRANT）。
//
// ⚠️ 同じ規則はアプリ層（`src/lib/orders/slip-edit.ts`）にもある。
//    あちらが緑でも、ここが緩ければ PostgREST 直アクセスで理由なしの取消が通る。
//
// 止まる場所が相手で違う（`shopping-list-items.test.ts` と同じ整理）:
//   - staff … RLS の USING を通過 → CHECK 制約が 23514
//   - 非スタッフ … USING で落ちる → 例外は上がらず 0 行更新で正常終了

import {
  FIXTURE_SQL,
  loginAsSql,
  STAY_FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_CHECK_INS,
  TEST_MEMBERS,
} from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

const ORDER_ID = "00000000-0000-0000-0000-0000000000e1";
const ITEM_ID = "00000000-0000-0000-0000-0000000000e2";

const ORDER_FIXTURE = `
${FIXTURE_SQL}
${STAY_FIXTURE_SQL}
INSERT INTO public.orders (order_id, checkin_id, purchaser_id, total_amount_yen, total_amount_uii)
VALUES ('${ORDER_ID}', '${TEST_CHECK_INS.selfStay.checkinId}', '${TEST_MEMBERS.self.memberId}', 600, 480);
INSERT INTO public.order_items (item_id, order_id, product_name, unit_price_yen, unit_price_uii, quantity)
VALUES ('${ITEM_ID}', '${ORDER_ID}', 'おにぎり', 300, 240, 2);
`;

function loggedInAs(authUserId: string): string {
  return `${ORDER_FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
const asMember = loggedInAs(TEST_AUTH_USERS.self.id);

const VOID_WITH_REASON = (memberId: string) => `
UPDATE public.order_items
SET    voided_at = now(), voided_by = '${memberId}', void_reason = '誤って追加した'
WHERE  item_id = '${ITEM_ID}';
`;

const VOID_WITHOUT_REASON = (memberId: string) => `
UPDATE public.order_items
SET    voided_at = now(), voided_by = '${memberId}'
WHERE  item_id = '${ITEM_ID}';
`;

function affectedRows(prelude: string, statement: string): string {
  return query(`
    ${prelude}
    WITH changed AS (
      ${statement.trim().replace(/;\s*$/, "")}
      RETURNING 1
    )
    SELECT count(*) FROM changed;
  `);
}

describeDb("明細行の取消は運営だけが行える（v13 §5.6.2 ／ 0019 の order_items_update_staff）", () => {
  test("管理者は明細行を取り消せる", () => {
    expect(affectedRows(asAdmin, VOID_WITH_REASON(TEST_MEMBERS.admin.memberId))).toBe("1");
  });

  test("コアメンバーも取り消せる", () => {
    expect(affectedRows(asCore, VOID_WITH_REASON(TEST_MEMBERS.core.memberId))).toBe("1");
  });

  test("伝票の持ち主本人は自分の明細を取り消せない（0行で終わる）", () => {
    // `order_items` の UPDATE ポリシーは staff だけ。本人は USING で落ちるため例外は上がらない。
    expect(affectedRows(asMember, VOID_WITH_REASON(TEST_MEMBERS.self.memberId))).toBe("0");
  });
});

describeDb("理由のない取消は作れない（v13 §5.6.4）", () => {
  test("理由を省いた取消は CHECK 制約が拒否する（23514）", () => {
    expect(sqlstateOf(`${asAdmin}\n${VOID_WITHOUT_REASON(TEST_MEMBERS.admin.memberId)}`)).toBe("23514");
  });

  test("空白だけの理由も拒否する", () => {
    const blankReason = `
      UPDATE public.order_items
      SET    voided_at = now(), voided_by = '${TEST_MEMBERS.admin.memberId}', void_reason = '   '
      WHERE  item_id = '${ITEM_ID}';
    `;
    expect(sqlstateOf(`${asAdmin}\n${blankReason}`)).toBe("23514");
  });

  test("操作者のいない取消も拒否する", () => {
    const noOperator = `
      UPDATE public.order_items
      SET    voided_at = now(), void_reason = '誤って追加した'
      WHERE  item_id = '${ITEM_ID}';
    `;
    expect(sqlstateOf(`${asAdmin}\n${noOperator}`)).toBe("23514");
  });
});

describeDb("取消は論理削除である（v13 §5.6.2）", () => {
  test("取り消しても行は残る", () => {
    const remaining = query(`
      ${asAdmin}
      ${VOID_WITH_REASON(TEST_MEMBERS.admin.memberId)}
      RESET ROLE;
      SELECT count(*) FROM public.order_items WHERE item_id = '${ITEM_ID}';
    `);
    expect(remaining).toBe("1");
  });

  test("管理者でも明細行を物理削除できない（DELETE の GRANT が無い）", () => {
    expect(
      sqlstateOf(`${asAdmin}\nDELETE FROM public.order_items WHERE item_id = '${ITEM_ID}';`),
    ).toBe("42501");
  });
});
