// `quests` のゲスト可視性（WBS 5-1 ／ Issue #53 ／ 完了条件2）の受入テスト。
//
// 根拠: v13 §5.10.6 L1789「`guest_allowed = false` … **一覧には表示したうえで施錠表示**」、
//       v13 §5.9.3 L1622（行単位の制御は RLS で行う）。
//
// > [!important] ここは正本と派生設計が食い違っている箇所である
// > `DB物理設計.md` L2036-2044 の `quests_select_guest` は
// > 「ゲストには `guest_allowed = true` の行**だけ**を見せる」としている。
// > これだと施錠カードも解放件数バナーも成立しない。CLAUDE.md §1.1 により**正本 v13 が勝つ**ため、
// > ここでは「ゲストにも施錠行が返る」を受入基準として固定する（設計書側の追随は別途報告済み）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データ・実クエストを一切参照しない（CLAUDE.md §3.2・§7.1）。
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。

import { authUserInsertSql, loginAsSql, memberInsertSql } from "./helpers/fixtures";
import { describeDb, query } from "./helpers/psql";

/** ゲスト役。共有フィクスチャには `role = 'guest'` の会員が居ないため、本ファイルで用意する。 */
const GUEST_AUTH_USER = {
  id: "00000000-0000-0000-0000-0000000000b3",
  email: "fuyu-guest@example.invalid",
};

const GUEST_MEMBER = {
  memberId: "00000000-0000-0000-0000-0000000000a4",
  authUserId: GUEST_AUTH_USER.id,
  nickname: "テストゲスト",
  memberType: "ゲスト",
  role: "guest",
  accountStatus: "active",
};

const LOCKED_QUEST_ID = "11111111-1111-4111-8111-1111111111f1";
const OPEN_QUEST_ID = "11111111-1111-4111-8111-1111111111f2";

/**
 * クエスト2件を投入する。RLS を迂回できる所有者権限（psql の接続ユーザー）で流し、
 * 検査は `SET ROLE authenticated` の後に行う。
 */
const QUESTS_SQL = [
  "INSERT INTO public.quests (quest_id, title, origin_type, guest_allowed, status)",
  `VALUES ('${LOCKED_QUEST_ID}', 'テスト施錠クエスト', 'morning_meeting_auto', false, 'open'),`,
  `       ('${OPEN_QUEST_ID}',   'テスト開放クエスト', 'manual',               true,  'open');`,
].join("\n");

const asGuest = [
  authUserInsertSql(GUEST_AUTH_USER),
  memberInsertSql(GUEST_MEMBER),
  QUESTS_SQL,
  loginAsSql(GUEST_AUTH_USER.id),
  "SET ROLE authenticated;",
].join("\n");

describeDb("完了条件2: ゲストの `quests` 可視性（v13 §5.10.6 L1789）", () => {
  test("ゲストにも `guest_allowed=false` の公開中クエストが返る", () => {
    // 0 になったら、RLS が施錠行ごと隠している（＝派生設計の案のまま実装されている）。
    const rows = query(`
      ${asGuest}
      SELECT count(*) FROM public.quests WHERE quest_id = '${LOCKED_QUEST_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("ゲストに `guest_allowed=true` のクエストが返る", () => {
    const rows = query(`
      ${asGuest}
      SELECT count(*) FROM public.quests WHERE quest_id = '${OPEN_QUEST_ID}';
    `);
    expect(rows).toBe("1");
  });
});
