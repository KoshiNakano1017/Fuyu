// WBS 5-2（受注申請・審査・実行指示）・5-3（完了報告）・5-4（承認／差戻し）・5-6（二段階化）
// の DB 側ガードの受入テスト。
//
// 根拠: v13 §5.3.2（二段階化の4つの確定論点）・§6 権限マトリクス L2147（最終承認は admin のみ）、
//       DB物理設計.md §3-1・§6-1 #18・#20・§6-7、
//       `supabase/migrations/0017_quest_applications_and_work_logs.sql`
//
// ★ ここが本丸である。アプリ側（`src/lib/quests/review.ts`）にも同じ規則があるが、
//   `service_role` は RLS も GRANT も迂回するため、**DB のトリガーが最後の砦**になる。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";

const QUEST_ID = "00000000-0000-0000-0000-0000000000d1";
const APPLICATION_ID = "00000000-0000-0000-0000-0000000000e1";
const LOG_ID = "00000000-0000-0000-0000-0000000000f1";

/**
 * クエスト1件 ＋ 受注申請1件 ＋ 完了報告1件。審査の起点になる状態を作る。
 *
 * ⚠️ 受注申請は **`申請中`（既定値）のまま**入れる。
 *    ここで `指示済み` にすると、フィクスチャ自身が
 *    `quest_applications_guard_review()` に引っかかる（superuser 実行では操作者を特定できず
 *    `current_actor_role()` が NULL を返すため、安全側に倒れて 42501 になる）。
 *    「操作者不明の審査を通さない」のはガードの意図どおりの挙動であり、
 *    **フィクスチャ側を素の状態に寄せるのが正しい**。
 */
const QUEST_FIXTURE = `
${FIXTURE_SQL}
INSERT INTO public.quests (quest_id, title, reward_uii, created_by)
VALUES ('${QUEST_ID}', '東の畑の草刈り', 200, '${TEST_MEMBERS.admin.memberId}');

INSERT INTO public.quest_applications (application_id, quest_id, member_id)
VALUES ('${APPLICATION_ID}', '${QUEST_ID}', '${TEST_MEMBERS.self.memberId}');

INSERT INTO public.work_logs (log_id, application_id, member_id, quest_id, work_hours)
VALUES ('${LOG_ID}', '${APPLICATION_ID}', '${TEST_MEMBERS.self.memberId}', '${QUEST_ID}', 2);
`;

function loggedInAs(authUserId: string): string {
  return `${QUEST_FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
const asMember = loggedInAs(TEST_AUTH_USERS.self.id);
/** 立場は親方だが権限は一般会員。`member_type` を認可に使う実装を検出する役（v13 §2）。 */
const asOyakata = loggedInAs(TEST_AUTH_USERS.oyakata.id);

const APPROVE = `
UPDATE public.work_logs
SET    approval_status = '承認完了', approved_by = public.current_member_id(), approved_at = now()
WHERE  log_id = '${LOG_ID}';
`;

/**
 * その実行者が `work_logs` を UPDATE したとき、**何行が更新されたか**を返す。
 *
 * ## なぜ「42501 が返ること」で書けないのか
 *
 * `work_logs` の UPDATE ポリシーは `work_logs_update_staff`（`USING (is_staff())`）の1本だけで、
 * **本人向けの UPDATE ポリシーは意図的に作っていない**（0017 のテーブルコメント
 * 「差戻し後の再提出は同じ申請に対する別行として積む（上書きしない）」）。
 *
 * PostgreSQL の RLS は `USING` と `WITH CHECK` で挙動が違う:
 *   - `USING` … 条件に合わない行は**最初から対象外**。例外は上がらず **0行更新で正常終了**する
 *   - `WITH CHECK` … 書き込む値が条件に合わなければ **42501**
 * 非スタッフは `USING` で落ちるため、`BEFORE UPDATE` のガードトリガーまで**到達しない**。
 * つまり 42501 を上げる経路が存在しない。
 *
 * 同じ状況を `check-ins-and-availability.test.ts`「本人が自分の予約を UPDATE しても 0行」も
 * この形で検証している。**止まる場所が相手で違う**ことを書き分ける:
 *   - staff（core_member）… `USING` を通過 → **トリガーが 42501**
 *   - 非スタッフ … `USING` で **0行**
 */
function affectedRows(prelude: string, update: string): string {
  return query(`
    ${prelude}
    WITH changed AS (
      ${update.trim().replace(/;\s*$/, "")}
      RETURNING 1
    )
    SELECT count(*) FROM changed;
  `);
}

/** 試行のあと、承認ステージが動いていないことを見る（結果としての不変）。 */
function approvalStatusAfter(prelude: string, update: string): string {
  return query(`
    ${prelude}
    ${update}
    RESET ROLE;
    SELECT approval_status FROM public.work_logs WHERE log_id = '${LOG_ID}';
  `);
}

describeDb("最終承認は管理者のみが行える（v13 §5.3.2・§6 L2147）", () => {
  test("管理者は完了報告を承認完了にできる", () => {
    const status = query(`
      ${asAdmin}
      ${APPROVE}
      SELECT approval_status FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(status).toBe("承認完了");
  });

  test("コアメンバーは完了報告を承認完了にできない（42501）", () => {
    expect(sqlstateOf(`${asCore}\n${APPROVE}`)).toBe("42501");
  });

  test("一般会員の承認は 0 行で終わる（RLS の USING で対象外）", () => {
    expect(affectedRows(asMember, APPROVE)).toBe("0");
  });

  test("一般会員が承認を試みても approval_status は 報告済み のまま", () => {
    expect(approvalStatusAfter(asMember, APPROVE)).toBe("報告済み");
  });

  test("member_type が親方でも role が一般会員なら承認は 0 行（v13 §2）", () => {
    expect(affectedRows(asOyakata, APPROVE)).toBe("0");
  });

  test("member_type が親方の一般会員が試みても approval_status は 報告済み のまま（v13 §2）", () => {
    expect(approvalStatusAfter(asOyakata, APPROVE)).toBe("報告済み");
  });
});

describeDb("コアメンバー確認は運営が行える（v13 §5.3.2）", () => {
  const CORE_CONFIRM = `
    UPDATE public.work_logs
    SET    approval_status = 'コアメンバー確認済',
           reviewed_by = public.current_member_id(), reviewed_at = now()
    WHERE  log_id = '${LOG_ID}';
  `;

  test("コアメンバーは確認済にできる", () => {
    const status = query(`
      ${asCore}
      ${CORE_CONFIRM}
      SELECT approval_status FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(status).toBe("コアメンバー確認済");
  });

  test("一般会員の確認は 0 行で終わる（RLS の USING で対象外）", () => {
    expect(affectedRows(asMember, CORE_CONFIRM)).toBe("0");
  });

  test("一般会員が確認を試みても approval_status は 報告済み のまま", () => {
    expect(approvalStatusAfter(asMember, CORE_CONFIRM)).toBe("報告済み");
  });
});

describeDb("確認のスキップが記録される（v13 §5.3.2）", () => {
  test("報告済みから直接承認すると review_skipped が立つ", () => {
    const skipped = query(`
      ${asAdmin}
      ${APPROVE}
      SELECT review_skipped::text FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(skipped).toBe("true");
  });

  test("コアメンバー確認を経た承認では review_skipped が立たない", () => {
    const skipped = query(`
      ${asAdmin}
      UPDATE public.work_logs
      SET    approval_status = 'コアメンバー確認済',
             reviewed_by = '${TEST_MEMBERS.core.memberId}', reviewed_at = now()
      WHERE  log_id = '${LOG_ID}';
      ${APPROVE}
      SELECT review_skipped::text FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(skipped).toBe("false");
  });

  test("確認者と承認者は別カラムに残る（同一人物だったかを後から追跡できる）", () => {
    const pair = query(`
      ${asAdmin}
      UPDATE public.work_logs
      SET    approval_status = 'コアメンバー確認済',
             reviewed_by = '${TEST_MEMBERS.core.memberId}', reviewed_at = now()
      WHERE  log_id = '${LOG_ID}';
      ${APPROVE}
      SELECT (reviewed_by <> approved_by)::text FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(pair).toBe("true");
  });
});

describeDb("差戻しは理由が必須である（v13 §5.3.2）", () => {
  test("理由があれば差し戻せる", () => {
    const status = query(`
      ${asCore}
      UPDATE public.work_logs
      SET    approval_status = '差戻し', rejected_by = public.current_member_id(),
             rejected_at = now(), rejection_reason = 'After写真が作業前の状態のままである'
      WHERE  log_id = '${LOG_ID}';
      SELECT approval_status FROM public.work_logs WHERE log_id = '${LOG_ID}';
    `);
    expect(status).toBe("差戻し");
  });

  test("理由が無い差戻しは作れない（23514）", () => {
    const state = sqlstateOf(`
      ${asCore}
      UPDATE public.work_logs
      SET    approval_status = '差戻し', rejected_by = public.current_member_id(), rejected_at = now()
      WHERE  log_id = '${LOG_ID}';
    `);
    expect(state).toBe("23514");
  });

  test("理由が空白文字だけの差戻しは作れない（23514）", () => {
    const state = sqlstateOf(`
      ${asCore}
      UPDATE public.work_logs
      SET    approval_status = '差戻し', rejected_by = public.current_member_id(),
             rejected_at = now(), rejection_reason = '   '
      WHERE  log_id = '${LOG_ID}';
    `);
    expect(state).toBe("23514");
  });
});

describeDb("受注申請の審査・実行指示は運営のみ（v13 §5.3-3・§6）", () => {
  const INSTRUCT = `
    UPDATE public.quest_applications
    SET    status = '指示済み', reviewed_by = public.current_member_id(), reviewed_at = now(),
           instruction_body = '畝の間を草刈りし、刈った草を堆肥場へ運ぶ'
    WHERE  application_id = '${APPLICATION_ID}';
  `;

  test("コアメンバーは実行指示を出せる", () => {
    const status = query(`
      ${asCore}
      ${INSTRUCT}
      SELECT status FROM public.quest_applications WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(status).toBe("指示済み");
  });

  test("一般会員は実行指示を出せない（42501）", () => {
    expect(sqlstateOf(`${asMember}\n${INSTRUCT}`)).toBe("42501");
  });

  test("同じ人が同じクエストへ二重に申請できない（23505）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.quest_applications (quest_id, member_id)
      VALUES ('${QUEST_ID}', '${TEST_MEMBERS.self.memberId}');
    `);
    expect(state).toBe("23505");
  });

  test("他人名義の受注申請は作れない（42501）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.quest_applications (quest_id, member_id)
      VALUES ('${QUEST_ID}', '${TEST_MEMBERS.oyakata.memberId}');
    `);
    expect(state).toBe("42501");
  });
});

describeDb("work_logs / quest_applications の RLS（PII-B ／ §6-1 #18・#20）", () => {
  test("本人は自分の受注申請を SELECT できる", () => {
    expect(query(`${asMember} SELECT count(*) FROM public.quest_applications;`)).toBe("1");
  });

  test("他人の受注申請は SELECT できない（誰がどのクエストに申請したかは PII-B）", () => {
    expect(query(`${asOyakata} SELECT count(*) FROM public.quest_applications;`)).toBe("0");
  });

  test("本人は自分の完了報告を SELECT できる", () => {
    expect(query(`${asMember} SELECT count(*) FROM public.work_logs;`)).toBe("1");
  });

  test("staff は全員の完了報告を SELECT できる", () => {
    expect(query(`${asCore} SELECT count(*) FROM public.work_logs;`)).toBe("1");
  });

  test("★ 評価コメントは被評価者に見せない（work_log_reviews に _select_self を作らない）", () => {
    const rows = query(`
      ${asCore}
      INSERT INTO public.work_log_reviews (log_id, reviewer_id, comment)
      VALUES ('${LOG_ID}', public.current_member_id(), '丁寧に刈れている');
      RESET ROLE;
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.work_log_reviews;
    `);
    expect(rows).toBe("0");
  });

  test("同一人物の二重確認は記録しない（23505）", () => {
    const state = sqlstateOf(`
      ${asCore}
      INSERT INTO public.work_log_reviews (log_id, reviewer_id) VALUES ('${LOG_ID}', public.current_member_id());
      INSERT INTO public.work_log_reviews (log_id, reviewer_id) VALUES ('${LOG_ID}', public.current_member_id());
    `);
    expect(state).toBe("23505");
  });

  test("完了報告は物理削除できない（42501）", () => {
    expect(sqlstateOf(`${asAdmin} DELETE FROM public.work_logs WHERE log_id = '${LOG_ID}';`)).toBe(
      "42501",
    );
  });

  test("anon は受注申請を SELECT できない（0行ではなく権限エラー）", () => {
    const state = sqlstateOf(
      `${QUEST_FIXTURE} SET ROLE anon; SELECT count(*) FROM public.quest_applications;`,
    );
    expect(state).toBe("42501");
  });
});
