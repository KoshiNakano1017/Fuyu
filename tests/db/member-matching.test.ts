// 名寄せの DB 側（`0039_member_link_requests.sql`・`0040_link_member_by_matching.sql` ／ WBS 10-2）の受入テスト。
//
// 根拠: 正本 v13 §5.8.3（STEP 2 の自動名寄せ ／ 誤名寄せの防止3点）、
//       `0003`（権限列の変更は操作者の申告が要る）、`0025`（検証済み連絡先の一意性）。
//
// ⚠️ ここで守っているのは**他人の宿泊券・Uii残高・XP の引き継ぎ**である。
//    アプリ層が正しくても、`service_role` 経由や PostgREST 直アクセスはそこを通らない。

import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

/** 事前登録済み（`pre_registered`・未結合）の会員。名寄せの対象になり得る唯一の状態。 */
const PRE_ID = TEST_MEMBERS.preRegistered.memberId;
/** まだどの会員にも紐づいていない Auth ユーザー（`spare`）。 */
const SPARE_AUTH = TEST_AUTH_USERS.spare.id;
const CONTACT = "fuyu-pre@example.invalid";

/** 事前登録会員の連絡先を1件入れた状態（未検証で入る＝移行時の姿）。 */
const WITH_IDENTIFIER = `
${FIXTURE_SQL}
INSERT INTO public.member_identifiers (member_id, kind, value)
VALUES ('${PRE_ID}', 'email', '${CONTACT}');
`;

const LINK = (memberId: string, authUserId: string, basis = "本人確認済みのメールが1件だけ一致") => `
SELECT public.link_member_by_matching(
  '${memberId}', '${authUserId}', '${TEST_MEMBERS.admin.memberId}', '${basis}',
  NULL, NULL, 'email', '${CONTACT}'
);
`;

describeDb("名寄せの成立は結合と監査を同時に行う（v13 §5.8.3 ③）", () => {
  test("結合され、`account_status` が active になる", () => {
    const row = query(`
      ${WITH_IDENTIFIER}
      ${LINK(PRE_ID, SPARE_AUTH)}
      SELECT (auth_user_id = '${SPARE_AUTH}')::text || '/' || account_status
      FROM   public.members WHERE member_id = '${PRE_ID}';
    `);
    expect(row).toBe("true/active");
  });

  test("★ 監査ログに根拠が残る（自動成立でも残す）", () => {
    const row = query(`
      ${WITH_IDENTIFIER}
      ${LINK(PRE_ID, SPARE_AUTH)}
      SELECT action || '/' || match_basis || '/' || (decided_by IS NULL)::text
      FROM   public.member_link_events WHERE member_id = '${PRE_ID}';
    `);
    // `decided_by` が NULL ＝ システムが決めた（自動成立）
    expect(row).toBe("成立/本人確認済みのメールが1件だけ一致/true");
  });

  test("★ 照合に使った連絡先が本人確認済みへ昇格する（§5.8.3 ②）", () => {
    const row = query(`
      ${WITH_IDENTIFIER}
      ${LINK(PRE_ID, SPARE_AUTH)}
      SELECT is_verified::text || '/' || (verified_at IS NOT NULL)::text
      FROM   public.member_identifiers WHERE member_id = '${PRE_ID}';
    `);
    expect(row).toBe("true/true");
  });

  test("根拠が空の名寄せは作れない（監査の意味が消える）", () => {
    expect(
      sqlstateOf(`
        ${WITH_IDENTIFIER}
        SELECT public.link_member_by_matching(
          '${PRE_ID}', '${SPARE_AUTH}', '${TEST_MEMBERS.admin.memberId}', '   '
        );
      `),
    ).toBe("23502");
  });

  test("同じ相手への再実行は冪等（監査を増やさない）", () => {
    const count = query(`
      ${WITH_IDENTIFIER}
      ${LINK(PRE_ID, SPARE_AUTH)}
      ${LINK(PRE_ID, SPARE_AUTH)}
      SELECT count(*) FROM public.member_link_events WHERE member_id = '${PRE_ID}';
    `);
    expect(count).toBe("1");
  });
});

describeDb("★ 名寄せは奪取の経路にならない", () => {
  test("既に別アカウントへ結合済みの会員は 42501 で落ちる", () => {
    expect(
      sqlstateOf(`
        ${WITH_IDENTIFIER}
        ${LINK(TEST_MEMBERS.self.memberId, SPARE_AUTH)}
      `),
    ).toBe("42501");
  });

  test("★ authenticated からは RPC 自体を呼べない（EXECUTE を剥がしてある）", () => {
    expect(
      sqlstateOf(`
        ${WITH_IDENTIFIER}
        SET ROLE authenticated;
        ${LINK(PRE_ID, SPARE_AUTH)}
      `),
    ).toBe("42501");
  });
});

describeDb("運営承認キュー（`member_link_requests` ／ §5.8.3 ①）", () => {
  const ENQUEUE = `
    INSERT INTO public.member_link_requests
      (auth_user_id, matched_kind, matched_value, candidate_count, reason)
    VALUES ('${SPARE_AUTH}', 'email', '${CONTACT}', 2, 'メールに2件が一致したため運営の確認へ回した');
  `;

  test("保留として積める", () => {
    const row = query(`
      ${FIXTURE_SQL}
      ${ENQUEUE}
      SELECT status || '/' || candidate_count::text FROM public.member_link_requests;
    `);
    expect(row).toBe("保留/2");
  });

  test("★ 同じ Auth ユーザーの保留は1件だけ（ログインのたびに積み上がらない）", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        ${ENQUEUE}
        ${ENQUEUE}
      `),
    ).toBe("23505");
  });

  test("候補0件の申請は作れない（キューに載せる理由が無い）", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        INSERT INTO public.member_link_requests
          (auth_user_id, matched_kind, matched_value, candidate_count, reason)
        VALUES ('${SPARE_AUTH}', 'email', '${CONTACT}', 0, '理由');
      `),
    ).toBe("23514");
  });

  test("承認は結合先・決定者・決定時刻が揃っていないと通らない", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        ${ENQUEUE}
        UPDATE public.member_link_requests SET status = '承認';
      `),
    ).toBe("23514");
  });

  test("却下は理由必須である", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        ${ENQUEUE}
        UPDATE public.member_link_requests
        SET    status = '却下', resolved_by = '${TEST_MEMBERS.admin.memberId}', resolved_at = now();
      `),
    ).toBe("23514");
  });

  test("却下に結合先は入らない（承認と読み違えない）", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        ${ENQUEUE}
        UPDATE public.member_link_requests
        SET    status = '却下', reject_reason = '別人と判断した',
               resolved_member_id = '${PRE_ID}',
               resolved_by = '${TEST_MEMBERS.admin.memberId}', resolved_at = now();
      `),
    ).toBe("23514");
  });
});

describeDb("キューと監査ログは staff だけが読める（PII-A を含む ／ §6-1）", () => {
  const ENQUEUE_AS_SUPERUSER = `
    ${FIXTURE_SQL}
    INSERT INTO public.member_link_requests
      (auth_user_id, matched_kind, matched_value, candidate_count, reason)
    VALUES ('${SPARE_AUTH}', 'email', '${CONTACT}', 2, '運営の確認へ回した');
  `;

  test("コアメンバーは読める", () => {
    const rows = query(`
      ${ENQUEUE_AS_SUPERUSER}
      ${loginAsSql(TEST_AUTH_USERS.core.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.member_link_requests;
    `);
    expect(rows).toBe("1");
  });

  test("★ 一般会員には1件も見えない", () => {
    const rows = query(`
      ${ENQUEUE_AS_SUPERUSER}
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.member_link_requests;
    `);
    expect(rows).toBe("0");
  });

  test("★ 監査ログへは誰も INSERT できない（根拠を偽れない）", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
        ${loginAsSql(TEST_AUTH_USERS.admin.id)}
        SET ROLE authenticated;
        INSERT INTO public.member_link_events (member_id, auth_user_id, action, match_basis)
        VALUES ('${PRE_ID}', '${SPARE_AUTH}', '成立', '偽の根拠');
      `),
    ).toBe("42501");
  });

  test("★ 監査ログは DELETE できない（証跡を消させない）", () => {
    expect(
      sqlstateOf(`
        ${WITH_IDENTIFIER}
        ${LINK(PRE_ID, SPARE_AUTH)}
        ${loginAsSql(TEST_AUTH_USERS.admin.id)}
        SET ROLE authenticated;
        DELETE FROM public.member_link_events;
      `),
    ).toBe("42501");
  });
});

describeDb("★ 承認は申請の決着まで1トランザクションで行う（`0040` の ⑤）", () => {
  const ENQUEUED = `
${WITH_IDENTIFIER}
INSERT INTO public.member_link_requests
  (request_id, auth_user_id, matched_kind, matched_value, candidate_count, reason)
VALUES ('00000000-0000-0000-0000-0000000000d9', '${SPARE_AUTH}', 'email', '${CONTACT}', 2,
        'メールに2件が一致したため運営の確認へ回した');
`;

  const APPROVE_VIA_REQUEST = `
SELECT public.link_member_by_matching(
  '${PRE_ID}', '${SPARE_AUTH}', '${TEST_MEMBERS.admin.memberId}',
  '運営承認（メールアドレスの一致 2件から選択）',
  '00000000-0000-0000-0000-0000000000d9', '${TEST_MEMBERS.admin.memberId}', 'email', '${CONTACT}'
);
`;

  test("申請が承認へ進み、決定者と結合先が入る", () => {
    const row = query(`
      ${ENQUEUED}
      ${APPROVE_VIA_REQUEST}
      SELECT status || '/' || (resolved_member_id = '${PRE_ID}')::text || '/'
             || (resolved_by = '${TEST_MEMBERS.admin.memberId}')::text
      FROM   public.member_link_requests WHERE request_id = '00000000-0000-0000-0000-0000000000d9';
    `);
    expect(row).toBe("承認/true/true");
  });

  test("監査ログに「運営が決めた」ことが残る（`decided_by` が入る）", () => {
    const row = query(`
      ${ENQUEUED}
      ${APPROVE_VIA_REQUEST}
      SELECT (decided_by = '${TEST_MEMBERS.admin.memberId}')::text || '/' || match_basis
      FROM   public.member_link_events WHERE member_id = '${PRE_ID}';
    `);
    expect(row).toBe("true/運営承認（メールアドレスの一致 2件から選択）");
  });

  test("★ 既に決着した申請では成立させられない（二重承認を通さない）", () => {
    expect(
      sqlstateOf(`
        ${ENQUEUED}
        UPDATE public.member_link_requests
        SET    status = '却下', reject_reason = '別人と判断した',
               resolved_by = '${TEST_MEMBERS.admin.memberId}', resolved_at = now()
        WHERE  request_id = '00000000-0000-0000-0000-0000000000d9';
        ${APPROVE_VIA_REQUEST}
      `),
    ).toBe("42501");
  });
});
