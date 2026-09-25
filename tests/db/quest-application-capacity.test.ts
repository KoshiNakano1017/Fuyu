// 受注申請の成立・募集人数の上限・重複申請の DB 側受入テスト
// （WBS `5-2` 受注申請・運営審査・実行指示 ／ Issue #167）。
//
// 根拠:
//   v13 §5.3（項目2）L835「ユーザーが「参加申請」を行うと、ステータスは「申請中」となる」
//   v13 §5.3 note L844「1クエスト＝運営が指定した**募集人数の範囲で**受注可」
//   `0007_quests_schema.sql` L73-74 `recruit_count integer NOT NULL DEFAULT 1`
//   `0017_quest_applications_and_work_logs.sql` L46-48（`member_id` 列コメント
//     「1クエストに複数行を許容する（**上限は `quests.recruit_count`**）」）
//   `0017` L78-80 `uq_quest_app_per_member UNIQUE (quest_id, member_id)`
//
// ★ 上限を DB でも縛る理由:
//   受注申請の行は `quest_applications_select_self` / `_select_staff` しか SELECT を許さないため、
//   **一般会員は他人の申請行を数えられない**（0017 L367-374）。アプリ側の判定だけでは
//   「何件受注済みか」の事実を持てず、`service_role` 経由の INSERT も素通りする。
//   同じ理由で審査ガードが DB 側に置かれている（`quest_applications_guard_review()`）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを参照していない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";

const QUEST_ID = "00000000-0000-0000-0000-0000000000d2";

/** 募集人数だけを変えたクエスト1件。受注者はフィクスチャの会員から充てる。 */
function questFixture(recruitCount: number): string {
  return `
${FIXTURE_SQL}
INSERT INTO public.quests (quest_id, title, reward_uii, created_by, recruit_count)
VALUES ('${QUEST_ID}', '母屋前の草刈り', 200, '${TEST_MEMBERS.admin.memberId}', ${recruitCount});
`;
}

/** その会員としてログインし、自分名義で受注申請を1件入れる（`_insert_self` に従う）。 */
function applyAs(authUserId: string, memberId: string): string {
  return `
RESET ROLE;
${loginAsSql(authUserId)}
SET ROLE authenticated;
INSERT INTO public.quest_applications (quest_id, member_id) VALUES ('${QUEST_ID}', '${memberId}');
`;
}

const APPLY_AS_SELF = applyAs(TEST_AUTH_USERS.self.id, TEST_MEMBERS.self.memberId);
const APPLY_AS_OYAKATA = applyAs(TEST_AUTH_USERS.oyakata.id, TEST_MEMBERS.oyakata.memberId);
const APPLY_AS_GUEST = applyAs(TEST_AUTH_USERS.guest.id, TEST_MEMBERS.guest.memberId);

/** 受注申請の件数。RLS を迂回できる superuser で数え、行が実際に増えたかを見る。 */
const COUNT_APPLICATIONS = `
RESET ROLE;
SELECT count(*) FROM public.quest_applications WHERE quest_id = '${QUEST_ID}';
`;

describeDb("完了条件6: 受注申請が成立すると 申請中 になる（v13 §5.3 項目2 L835）", () => {
  test("会員が自分名義で入れた受注申請は 申請中 で始まる", () => {
    const status = query(`
      ${questFixture(1)}
      ${APPLY_AS_SELF}
      RESET ROLE;
      SELECT status FROM public.quest_applications WHERE quest_id = '${QUEST_ID}';
    `);
    expect(status).toBe("申請中");
  });
});

describeDb("完了条件8: 募集人数の範囲でしか受注できない（v13 §5.3 note L844）", () => {
  test("募集1名のクエストへ1人目は受注申請できる", () => {
    expect(query(`${questFixture(1)}${APPLY_AS_SELF}${COUNT_APPLICATIONS}`)).toBe("1");
  });

  test("募集1名のクエストへ2人目は受注申請できない（境界値: 上限ちょうどで閉じる）", () => {
    // SQLSTATE を仕様が定めていないため、値は固定せず「拒否されたこと」だけを見る。
    // null が返ったら**受注申請が通ってしまった**ということであり、募集1名の枠に2名入る。
    const sqlstate = sqlstateOf(`${questFixture(1)}${APPLY_AS_SELF}${APPLY_AS_OYAKATA}`);
    expect(sqlstate).not.toBeNull();
  });

  test("募集2名のクエストへは2人目も受注申請できる（境界値: 上限の直前は開く）", () => {
    expect(query(`${questFixture(2)}${APPLY_AS_SELF}${APPLY_AS_OYAKATA}${COUNT_APPLICATIONS}`)).toBe(
      "2",
    );
  });

  test("募集2名のクエストへ3人目は受注申請できない", () => {
    const sqlstate = sqlstateOf(
      `${questFixture(2)}${APPLY_AS_SELF}${APPLY_AS_OYAKATA}${APPLY_AS_GUEST}`,
    );
    expect(sqlstate).not.toBeNull();
  });
});

describeDb("完了条件7: 同じ会員は同じクエストへ2件目を作れない（`uq_quest_app_per_member`）", () => {
  // 募集人数は 5 にしておく。ここで見たいのは**上限ではなく一意制約**であり、
  // 枠が埋まって落ちたのか重複で落ちたのかが混ざると、失敗の原因が一意に読めなくなる。
  test("同じ会員の2件目は一意制約違反になる（23505）", () => {
    const sqlstate = sqlstateOf(`${questFixture(5)}${APPLY_AS_SELF}${APPLY_AS_SELF}`);
    expect(sqlstate).toBe("23505");
  });

  test("★ 取り下げ（キャンセル）を経た再申請も一意制約違反になる（全ステータスが対象）", () => {
    // ここが 23505 になること自体は仕様どおり（`0017` L78-80）。
    // だからこそアプリ側はこれを「すでに申請済み」として扱わなければならず、
    // 汎用の処理失敗にまとめると利用者には「時間をおいて再試行」と表示される（完了条件7 後半）。
    const sqlstate = sqlstateOf(`
      ${questFixture(5)}
      ${APPLY_AS_SELF}
      UPDATE public.quest_applications SET status = 'キャンセル' WHERE quest_id = '${QUEST_ID}';
      ${APPLY_AS_SELF}
    `);
    expect(sqlstate).toBe("23505");
  });
});
