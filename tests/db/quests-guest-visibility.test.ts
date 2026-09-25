// `quests` のゲスト可視性（WBS 5-1 ／ Issue #53 ／ 完了条件2）の受入テスト。
//
// 根拠: v13 §5.10.6 L1789「`guest_allowed = false` … **一覧には表示したうえで施錠表示**」、
//       v13 §5.9.3 L1622（行単位の制御は RLS で行う）。
//
// > [!important] 派生設計と正本の食い違いは 0012 で解消した（2026-09-20）
// > `DB物理設計.md` L2036-2044 の `quests_select_guest`（「ゲストには `guest_allowed = true` の行
// > **だけ**を見せる」）は派生設計側の誤りであり、正本 v13 §5.10.6 が定める「行は表示・列だけ絞る」を
// > `0008_quests_rls_and_board_view.sql` は正しく実装していた（CLAUDE.md §1.1）。本ファイル下部の
// > 「PostgREST直叩き」系テストは、`0008` の GRANT が列（`reward_uii`・`description`）まで
// > `authenticated` へ広く与えていたために、正しい行レベル設計の**下**で列が素通りしていた別の穴
// > （オーナー指摘・2026-09-20）を固定する。派生文書（`DB物理設計.md`・`API設計.md`）側の訂正も
// > 同日中に実施済み。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データ・実クエストを一切参照しない（CLAUDE.md §3.2・§7.1）。
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。

import { authUserInsertSql, loginAsSql, memberInsertSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

/**
 * ゲスト役は**共通フィクスチャ（`TEST_MEMBERS.guest`）**を使う（2026-09-25 に追加された）。
 *
 * ⚠️ 以前はこのファイルで独自に用意しており、**`core` 役と同じ ID（`…b3` / `…a4`）を
 * 使い回していた**。共通フィクスチャと同時に投入した時点で一意制約に当たる作りだったため、
 * 共有の役へ寄せた。役が要るなら共通フィクスチャへ足す。
 */

const LOCKED_QUEST_ID = "11111111-1111-4111-8111-1111111111f1";
const OPEN_QUEST_ID = "11111111-1111-4111-8111-1111111111f2";
const CORE_ONLY_QUEST_ID = "11111111-1111-4111-8111-1111111111f3";

/**
 * クエスト3件を投入する。RLS を迂回できる所有者権限（psql の接続ユーザー）で流し、
 * 検査は `SET ROLE authenticated` の後に行う。
 */
const QUESTS_SQL = [
  "INSERT INTO public.quests (quest_id, title, origin_type, guest_allowed, core_only_reward, reward_uii, description, status)",
  `VALUES ('${LOCKED_QUEST_ID}',   'テスト施錠クエスト',     'morning_meeting_auto', false, false, 1000, '通常の指示内容', 'open'),`,
  `       ('${OPEN_QUEST_ID}',     'テスト開放クエスト',     'manual',               true,  false,  800, '開放クエストの指示内容', 'open'),`,
  `       ('${CORE_ONLY_QUEST_ID}','テスト非公開クエスト',   'manual',               false, true,  5000, 'コア限定の指示内容', 'open');`,
].join("\n");

const asGuest = [
  authUserInsertSql(TEST_AUTH_USERS.guest),
  memberInsertSql(TEST_MEMBERS.guest),
  QUESTS_SQL,
  loginAsSql(TEST_AUTH_USERS.guest.id),
  "SET ROLE authenticated;",
].join("\n");

/** 一般街人（`role = 'member'`）としてログインする。共有フィクスチャの `self` 役を使う。 */
const asMember = [
  authUserInsertSql(TEST_AUTH_USERS.self),
  memberInsertSql(TEST_MEMBERS.self),
  QUESTS_SQL,
  loginAsSql(TEST_AUTH_USERS.self.id),
  "SET ROLE authenticated;",
].join("\n");

/** コアメンバー（`role = 'core_member'`）としてログインする。共有フィクスチャの `core` 役を使う。 */
const asCoreMember = [
  authUserInsertSql(TEST_AUTH_USERS.core),
  memberInsertSql(TEST_MEMBERS.core),
  QUESTS_SQL,
  loginAsSql(TEST_AUTH_USERS.core.id),
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

describeDb(
  "完了条件9: PostgREST 直叩きでは報酬額・指示内容を読めない（0012／オーナー指摘・2026-09-20）",
  () => {
    test("ゲストは `quests` テーブルを直接 SELECT しても reward_uii を読めない（列単位GRANTで拒否）", () => {
      const sqlstate = sqlstateOf(`
        ${asGuest}
        SELECT reward_uii FROM public.quests WHERE quest_id = '${LOCKED_QUEST_ID}';
      `);
      expect(sqlstate).toBe("42501");
    });

    test("一般街人も `quests` テーブルを直接 SELECT すると description を読めない（会員にも列は開かない）", () => {
      const sqlstate = sqlstateOf(`
        ${asMember}
        SELECT description FROM public.quests WHERE quest_id = '${OPEN_QUEST_ID}';
      `);
      expect(sqlstate).toBe("42501");
    });

    test("`v_quest_board` 経由なら一般街人にも通常クエストの reward_uii が返る（列の拒否はテーブル直叩きのみ）", () => {
      const rows = query(`
        ${asMember}
        SELECT reward_uii FROM public.v_quest_board WHERE quest_id = '${LOCKED_QUEST_ID}';
      `);
      expect(rows).toBe("1000");
    });

    test("`core_only_reward=true` のクエストは `v_quest_board` 経由でも一般街人には NULL が返る", () => {
      const rows = query(`
        ${asMember}
        SELECT reward_uii IS NULL AS is_null FROM public.v_quest_board WHERE quest_id = '${CORE_ONLY_QUEST_ID}';
      `);
      expect(rows).toBe("t");
    });

    test("`core_only_reward=true` のクエストでもコアメンバーには `v_quest_board` 経由で実値が返る", () => {
      const rows = query(`
        ${asCoreMember}
        SELECT reward_uii FROM public.v_quest_board WHERE quest_id = '${CORE_ONLY_QUEST_ID}';
      `);
      expect(rows).toBe("5000");
    });
  },
);
