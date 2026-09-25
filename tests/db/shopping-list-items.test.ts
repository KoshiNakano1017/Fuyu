// 買い物リストの RLS ／ ガードトリガーの受入テスト（0030 ／ WBS 5-8・5-9）。
//
// 根拠: v13 §5.12.1（ゲストは登録不可）、§5.12.2（買う／見送りの判断は運営のみ・見送りは理由必須）、
//       §5.12.3（クエスト化は多対1）、§6 権限マトリクス。
//
// ⚠️ 同じ規則はアプリ層（`src/lib/shopping/status.ts`）にもある。
//    片方だけ変えてはならない。あちらが緑でも、ここが緩ければ service_role 経由で抜ける。
//
// 止まる場所が相手で違うことを書き分ける（`quest-review-guard.test.ts` と同じ整理）:
//   - staff … RLS の USING を通過 → トリガーが 42501
//   - 非スタッフ … USING で落ちる → 例外は上がらず 0 行更新で正常終了

import {
  FIXTURE_SQL,
  loginAsSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

const ITEM_ID = "00000000-0000-0000-0000-0000000000d1";

/**
 * ゲスト役は**共通フィクスチャ（`TEST_MEMBERS.guest`）**を使う。
 * 「ゲストは登録できない」は 2026-09-22 のオーナー確定であり、
 * **反証役が居ないと検証そのものが成立しない**（v13 §5.12.1・§9 #65②）。
 *
 * ⚠️ 以前はこのファイルの中で独自のゲストを作っていたが、2026-09-25 に共通フィクスチャへ
 * `guest` 役が入り、**同じメールアドレスで二重に `auth.users` を作ろうとして 23505 で落ちた**。
 * 役が要るなら共通フィクスチャへ足す（テストごとに作ると必ずこうなる）。
 */

const SHOPPING_FIXTURE = `
${FIXTURE_SQL}
INSERT INTO public.shopping_list_items (item_id, item_name, registered_by)
VALUES ('${ITEM_ID}', '食器用洗剤', '${TEST_MEMBERS.self.memberId}');
`;

function loggedInAs(authUserId: string): string {
  return `${SHOPPING_FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
const asMember = loggedInAs(TEST_AUTH_USERS.self.id);
const asOyakata = loggedInAs(TEST_AUTH_USERS.oyakata.id);
const asGuest = loggedInAs(TEST_AUTH_USERS.guest.id);

const INSERT_OWN = (memberId: string) =>
  `INSERT INTO public.shopping_list_items (item_name, registered_by) VALUES ('軍手', '${memberId}');`;

const DECIDE_BUY = `UPDATE public.shopping_list_items SET status = '買う' WHERE item_id = '${ITEM_ID}';`;

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

function statusAfter(prelude: string, statement: string): string {
  return query(`
    ${prelude}
    ${statement}
    RESET ROLE;
    SELECT status FROM public.shopping_list_items WHERE item_id = '${ITEM_ID}';
  `);
}

describeDb("ゲストは買い物リストへ登録できない（v13 §5.12.1 ／ §9 #65②）", () => {
  test("街人は登録できる", () => {
    expect(affectedRows(asMember, INSERT_OWN(TEST_MEMBERS.self.memberId))).toBe("1");
  });

  test("ゲストの登録はトリガーが拒否する（42501）", () => {
    expect(sqlstateOf(`${asGuest}\n${INSERT_OWN(TEST_MEMBERS.guest.memberId)}`)).toBe("42501");
  });

  test("他人名義では登録できない（RLS の WITH CHECK）", () => {
    expect(sqlstateOf(`${asMember}\n${INSERT_OWN(TEST_MEMBERS.admin.memberId)}`)).toBe("42501");
  });
});

describeDb("「買う」の判断は運営のみが行える（v13 §5.12.2・§6）", () => {
  test("管理者は購入対象として承認できる", () => {
    expect(statusAfter(asAdmin, DECIDE_BUY)).toBe("買う");
  });

  test("コアメンバーも承認できる", () => {
    expect(statusAfter(asCore, DECIDE_BUY)).toBe("買う");
  });

  test("登録者本人が自分の希望を承認しようとするとトリガーが拒否する（42501）", () => {
    // 本人は `_update_self` で USING を通過するため、トリガーまで到達して 42501 になる。
    expect(sqlstateOf(`${asMember}\n${DECIDE_BUY}`)).toBe("42501");
  });

  test("立場が親方でも role が member なら承認できない（v13 §2）", () => {
    // 他人の品目のため USING で落ち、0 行で終わる（例外は上がらない）。
    expect(affectedRows(asOyakata, DECIDE_BUY)).toBe("0");
  });

  test("拒否されたあとも状態は 希望 のまま", () => {
    expect(statusAfter(asOyakata, DECIDE_BUY)).toBe("希望");
  });
});

describeDb("見送りは理由と判断者を必ず残す（v13 §5.12.2）", () => {
  const skipWith = (reason: string) =>
    `UPDATE public.shopping_list_items
        SET status = '見送り', skip_reason = ${reason}, decided_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE item_id = '${ITEM_ID}';`;

  test("理由があれば見送れる", () => {
    expect(statusAfter(asAdmin, skipWith("'在庫がまだある'"))).toBe("見送り");
  });

  test("理由が NULL なら CHECK 制約で落ちる（23514）", () => {
    expect(sqlstateOf(`${asAdmin}\n${skipWith("NULL")}`)).toBe("23514");
  });

  test("理由が空白文字だけでも落ちる", () => {
    expect(sqlstateOf(`${asAdmin}\n${skipWith("'   '")}`)).toBe("23514");
  });
});

describeDb("登録者は後から書き換えられない（v13 §5.12.1）", () => {
  test("運営でも登録者の付け替えはできない（42501）", () => {
    const sql = `UPDATE public.shopping_list_items
                    SET registered_by = '${TEST_MEMBERS.admin.memberId}'
                  WHERE item_id = '${ITEM_ID}';`;
    expect(sqlstateOf(`${asAdmin}\n${sql}`)).toBe("42501");
  });
});

describeDb("物理削除はできない（論理削除のみ／v13 §5.12.1）", () => {
  // ⚠️ RLS ポリシーが無いだけでなく、DELETE の GRANT 自体を与えていない
  //   （`0030_shopping_list_items.sql` の REVOKE ALL → SELECT/INSERT/UPDATE のみ GRANT）。
  //   GRANT が無いと RLS の評価まで到達せず、0 行ではなく 42501 で落ちる
  //   （`lodging_register_entries` の DELETE 全拒否と同じ作法）。
  test("運営でも DELETE できない（42501・GRANT 自体が無い）", () => {
    expect(
      sqlstateOf(`${asAdmin}\nDELETE FROM public.shopping_list_items WHERE item_id = '${ITEM_ID}';`),
    ).toBe("42501");
  });
});

describeDb("相乗りは RPC 経由でのみ増える（v13 §5.12.1）", () => {
  test("他人の品目にも相乗りできる", () => {
    const rows = query(`
      ${asCore}
      SELECT public.shopping_item_add_requester('${ITEM_ID}');
      RESET ROLE;
      SELECT array_length(requesters, 1) FROM public.shopping_list_items WHERE item_id = '${ITEM_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("ゲストは相乗りできない（42501）", () => {
    expect(sqlstateOf(`${asGuest}\nSELECT public.shopping_item_add_requester('${ITEM_ID}');`)).toBe("42501");
  });

  test("他人の品目を直接 UPDATE することはできない（0 行）", () => {
    const sql = `UPDATE public.shopping_list_items
                    SET requesters = ARRAY['${TEST_MEMBERS.oyakata.memberId}']::uuid[]
                  WHERE item_id = '${ITEM_ID}';`;
    expect(affectedRows(asOyakata, sql)).toBe("0");
  });
});

describeDb("クエスト化済には必ずクエストが紐づく（v13 §5.12.3）", () => {
  test("quest_id が無いままクエスト化済にはできない（23514）", () => {
    const sql = `UPDATE public.shopping_list_items SET status = 'クエスト化済' WHERE item_id = '${ITEM_ID}';`;
    expect(sqlstateOf(`${asAdmin}\n${sql}`)).toBe("23514");
  });
});

describeDb("買い物リスト起点のクエストを起案できる（v13 §5.12.3）", () => {
  test("origin_type に shopping_list を入れられる", () => {
    const questId = "00000000-0000-0000-0000-0000000000e1";
    const sql = `
      ${asAdmin}
      INSERT INTO public.quests (quest_id, title, origin_type, execution_mode, created_by)
      VALUES ('${questId}', '買い出し（2件）', 'shopping_list', 'remote', '${TEST_MEMBERS.admin.memberId}');
      RESET ROLE;
      SELECT origin_type FROM public.quests WHERE quest_id = '${questId}';
    `;
    expect(query(sql)).toBe("shopping_list");
  });
});
