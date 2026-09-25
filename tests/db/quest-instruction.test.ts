// 運営審査・実行指示（WBS `5-2` ／ Issue #167）の DB 側受入テスト。
//
// 根拠:
//   v13 §5.3（項目3）L838「運営側が「**いつ・どこで・何を任せるか**」の指示を出して承認
//     （マッチング成立）」
//   v13 §5.3.2 L892 遷移図 `申請中 → 指示済み`
//   v13 §6 権限マトリクス L2307「クエスト審査・実行指示出し（申請中処理）」＝
//     管理者〇／コアメンバー〇／会員−／ゲスト−
//   v13 §5.9.3 L1713-1714「DOM非表示は認可ではない」
//   `0017_quest_applications_and_work_logs.sql` L63-68（`scheduled_start_at` / `instruction_place` /
//     `instruction_body`）・L82-85（`chk_quest_app_reviewed_has_operator`）・
//     L322-356（`quest_applications_guard_review()`）・L367-374（`_select_self` / `_select_staff`）
//
// ★ ここが最後の砦である。アプリ側（`src/lib/quests/review.ts`）にも同じ規則があるが、
//   `service_role` は RLS も GRANT も迂回するため、画面のボタンを外して直接 UPDATE する経路は
//   DB のトリガーでしか止まらない（既存 `tests/db/quest-review-guard.test.ts` と同じ考え方）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを参照していない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import {
  FIXTURE_SQL,
  declareOperatorSql,
  loginAsSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

const QUEST_ID = "00000000-0000-0000-0000-0000000000d3";
const APPLICATION_ID = "00000000-0000-0000-0000-0000000000e3";

/** 指示の3点（いつ・どこで・何を）。期待値として使い回す。 */
const SCHEDULED_START_AT = "2030-05-01 09:00+09";
const INSTRUCTION_PLACE = "東の畑の入口";
const INSTRUCTION_BODY = "畝の間を草刈りし、刈った草を堆肥場へ運ぶ";

/**
 * クエスト1件 ＋ 受注申請1件（`申請中`）。審査の起点。
 *
 * ⚠️ 受注申請は `申請中`（既定値）のまま入れる。superuser の INSERT で `指示済み` にすると
 *    `quest_applications_guard_review()` が操作者を特定できず 42501 になる（意図どおりの挙動）。
 */
const FIXTURE = `
${FIXTURE_SQL}
INSERT INTO public.quests (quest_id, title, reward_uii, created_by)
VALUES ('${QUEST_ID}', '東の畑の草刈り', 200, '${TEST_MEMBERS.admin.memberId}');

INSERT INTO public.quest_applications (application_id, quest_id, member_id)
VALUES ('${APPLICATION_ID}', '${QUEST_ID}', '${TEST_MEMBERS.self.memberId}');
`;

function loggedInAs(authUserId: string): string {
  return `${FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
/** 受注者本人（`role = member`）。自分の申請行なので RLS の USING は通り、トリガーまで届く。 */
const asApplicant = loggedInAs(TEST_AUTH_USERS.self.id);
/** ゲスト。他人の申請行なので USING で対象外になる。 */
const asGuest = loggedInAs(TEST_AUTH_USERS.guest.id);
/** 立場は親方だが権限は一般会員。`member_type` を認可に使う実装を検出する役（v13 §2）。 */
const asOyakata = loggedInAs(TEST_AUTH_USERS.oyakata.id);

/** 実行指示を出す UPDATE。いつ・どこで・何を ＋ 審査者を1回で書く。 */
const INSTRUCT = `
UPDATE public.quest_applications
SET    status = '指示済み',
       scheduled_start_at = '${SCHEDULED_START_AT}',
       instruction_place  = '${INSTRUCTION_PLACE}',
       instruction_body   = '${INSTRUCTION_BODY}',
       reviewed_by = public.current_member_id(),
       reviewed_at = now()
WHERE  application_id = '${APPLICATION_ID}';
`;

/**
 * その実行者の UPDATE で**何行が更新されたか**。
 * RLS の `USING` で対象外になる相手は例外を上げず 0行で正常終了するため、
 * 「42501 が返ること」では書けない（`tests/db/quest-review-guard.test.ts` の同名関数と同じ理由）。
 */
function affectedRows(prelude: string): string {
  return query(`
    ${prelude}
    WITH changed AS (
      ${INSTRUCT.trim().replace(/;\s*$/, "")}
      RETURNING 1
    )
    SELECT count(*) FROM changed;
  `);
}

/** 試行のあとのステータス（結果としての不変を見る）。 */
function statusAfterAttempt(prelude: string): string {
  return query(`
    ${prelude}
    ${INSTRUCT}
    RESET ROLE;
    SELECT status FROM public.quest_applications WHERE application_id = '${APPLICATION_ID}';
  `);
}

/** 指示を出したあとに、その列を superuser で読む（保存されたかを見る）。 */
function columnAfterInstruct(selectExpression: string): string {
  return query(`
    ${asCore}
    ${INSTRUCT}
    RESET ROLE;
    SELECT ${selectExpression} FROM public.quest_applications WHERE application_id = '${APPLICATION_ID}';
  `);
}

describeDb("完了条件10: 実行指示は admin / core_member だけが出せる（v13 §6 L2307）", () => {
  test("管理者は 申請中 を 指示済み へ遷移させられる", () => {
    expect(statusAfterAttempt(asAdmin)).toBe("指示済み");
  });

  test("コアメンバーは 申請中 を 指示済み へ遷移させられる", () => {
    expect(statusAfterAttempt(asCore)).toBe("指示済み");
  });

  test("受注者本人（一般会員）は自分の申請を 指示済み へ遷移させられない（42501）", () => {
    expect(sqlstateOf(`${asApplicant}\n${INSTRUCT}`)).toBe("42501");
  });

  test("ゲストの実行指示は 0 行で終わる（RLS の USING で対象外）", () => {
    expect(affectedRows(asGuest)).toBe("0");
  });

  test("ゲストが試みても 申請中 のままである", () => {
    expect(statusAfterAttempt(asGuest)).toBe("申請中");
  });

  test("member_type が親方でも role が一般会員なら 0 行で終わる（v13 §2）", () => {
    expect(affectedRows(asOyakata)).toBe("0");
  });

  test("member_type が親方の一般会員が試みても 申請中 のままである（v13 §2）", () => {
    expect(statusAfterAttempt(asOyakata)).toBe("申請中");
  });
});

describeDb("完了条件11: 画面を経由しない UPDATE でも拒否される（v13 §5.9.3 L1713）", () => {
  test("service_role 相当（RLS 迂回）で一般会員を操作者として申告しても拒否される（42501）", () => {
    // ボタンを外して直接 UPDATE する経路。RLS を迂回できても
    // `quest_applications_guard_review()` は `current_actor_role()` を見るため通らない。
    const sqlstate = sqlstateOf(`
      ${FIXTURE}
      ${declareOperatorSql(TEST_MEMBERS.self.memberId)}
      ${INSTRUCT}
    `);
    expect(sqlstate).toBe("42501");
  });

  test("操作者を申告しない UPDATE も拒否される（42501）", () => {
    // 操作者不明の審査を通さない。ここが緩むと「誰が指示したか分からない 指示済み」が作れる。
    expect(sqlstateOf(`${FIXTURE}\n${INSTRUCT}`)).toBe("42501");
  });
});

describeDb("完了条件12: いつ・どこで・何を が保存される（v13 §5.3 項目3 L838）", () => {
  test("いつ（scheduled_start_at）が保存される", () => {
    expect(columnAfterInstruct(`(scheduled_start_at = '${SCHEDULED_START_AT}'::timestamptz)::text`)).toBe(
      "true",
    );
  });

  test("どこで（instruction_place）が保存される", () => {
    expect(columnAfterInstruct("instruction_place")).toBe(INSTRUCTION_PLACE);
  });

  test("何を（instruction_body）が保存される", () => {
    expect(columnAfterInstruct("instruction_body")).toBe(INSTRUCTION_BODY);
  });
});

describeDb("完了条件14: 受注者本人は自分に出された指示を読める（0017 `_select_self`）", () => {
  /** 指示を出したあと、`viewer` としてログインし直して読む。 */
  function readBackAs(authUserId: string, selectExpression: string): string {
    return query(`
      ${asCore}
      ${INSTRUCT}
      RESET ROLE;
      ${loginAsSql(authUserId)}
      SET ROLE authenticated;
      SELECT ${selectExpression} FROM public.quest_applications;
    `);
  }

  test("受注者本人は指示の内容（何を）を読める", () => {
    expect(readBackAs(TEST_AUTH_USERS.self.id, "instruction_body")).toBe(INSTRUCTION_BODY);
  });

  test("受注者本人は指示の場所（どこで）を読める", () => {
    expect(readBackAs(TEST_AUTH_USERS.self.id, "instruction_place")).toBe(INSTRUCTION_PLACE);
  });

  test("受注者本人は指示の日時（いつ）を読める", () => {
    expect(
      readBackAs(TEST_AUTH_USERS.self.id, `(scheduled_start_at = '${SCHEDULED_START_AT}'::timestamptz)::text`),
    ).toBe("true");
  });

  test("他人に出された指示は読めない（誰がどのクエストに入るかは PII-B）", () => {
    // 指示には集合場所と日時が入る。他人の行が見えると会員の動静が読めてしまう。
    expect(readBackAs(TEST_AUTH_USERS.oyakata.id, "count(*)")).toBe("0");
  });
});

describeDb("完了条件15: 申請中 が審査待ちに並び、指示済み は外れる（v13 §5.3.2 L892）", () => {
  const PENDING_COUNT = `SELECT count(*) FROM public.quest_applications WHERE status = '申請中';`;

  test("申請中 の受注申請は運営から審査待ちとして見える", () => {
    expect(query(`${asCore}\n${PENDING_COUNT}`)).toBe("1");
  });

  test("指示済み へ遷移した受注申請は審査待ちから外れる", () => {
    expect(query(`${asCore}\n${INSTRUCT}\n${PENDING_COUNT}`)).toBe("0");
  });
});

describeDb("完了条件16: 指示を出した運営と日時が記録される（`chk_quest_app_reviewed_has_operator`）", () => {
  test("指示を出した運営の member_id が reviewed_by に入る", () => {
    expect(columnAfterInstruct("reviewed_by")).toBe(TEST_MEMBERS.core.memberId);
  });

  test("指示を出した日時が reviewed_at に入る", () => {
    expect(columnAfterInstruct("(reviewed_at IS NOT NULL)::text")).toBe("true");
  });

  test("審査者のいない 指示済み は作れない（23514）", () => {
    // 「誰が指示したか分からない 指示済み」を残さないための最後の砦。
    const sqlstate = sqlstateOf(`
      ${asCore}
      UPDATE public.quest_applications
      SET    status = '指示済み', instruction_body = '${INSTRUCTION_BODY}', reviewed_at = now()
      WHERE  application_id = '${APPLICATION_ID}';
    `);
    expect(sqlstate).toBe("23514");
  });
});
