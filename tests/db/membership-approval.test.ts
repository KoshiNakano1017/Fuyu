// 街人登録の承認 RPC（`0038_membership_approval.sql` ／ WBS 12-2 Step 5・12-3）の受入テスト。
//
// 根拠: v13 §5.10.4（Step 5 の承認操作をもって登録成立）・§5.10.5（完了処理：昇格・宿泊券付与・
//       キャッシュバック起票）・§6（申請一覧は admin）、`0003`（role 変更の監査）。
//
// ⚠️ ここで守っているのは**権限の昇格と金銭価値の付与**である。
//    承認は4つの書き込みが揃って初めて意味を持つ。分割すると
//    「権限は上がったが宿泊券が無い」「申込中のまま付与済み」が残り、後者は**二重付与**に直結する。
//    アプリ層が正しくても、`service_role` 経由や PostgREST 直アクセスはそこを通らない。

import { FIXTURE_SQL, TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query, sqlstateOf } from "./helpers/psql";

const APPLICATION_ID = "00000000-0000-0000-0000-0000000000e1";

/** ★ `role = 'guest'` の役。共通フィクスチャへ追加した（昇格の検証に要る） */
const GUEST_ID = TEST_MEMBERS.guest.memberId;

/**
 * ゲストの申請を「入金の記録まで済んだ状態」で置く。
 *
 * ★ 申請の INSERT は運営の代理として行う（`0037` のガードが操作者の申告を要求する。
 * `postgres` で流すと `current_actor_role()` が NULL になり「本人以外の申請」として弾かれる）。
 */
const APPLIED = `
${FIXTURE_SQL}
DO $$ BEGIN PERFORM set_config('app.operator_id', '${TEST_MEMBERS.admin.memberId}', true); END $$;
INSERT INTO public.membership_applications
  (application_id, member_id, billed_amount_yen, granted_nights, payment_method, paid_at)
VALUES ('${APPLICATION_ID}', '${GUEST_ID}', 0, 0, 'settlement_qr', now());
`;

const APPROVE = (operatorId: string) => `
SELECT public.approve_membership_application('${APPLICATION_ID}', '${operatorId}');
`;

describeDb("承認は4つの書き込みが揃う（v13 §5.10.5）", () => {
  test("申請が承認済みになり、承認日時・昇格日時・付与日時が入る", () => {
    const row = query(`
      ${APPLIED}
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT status || '/' || (approved_at IS NOT NULL)::text || '/'
             || (role_upgraded_at IS NOT NULL)::text || '/'
             || (stay_tickets_granted_at IS NOT NULL)::text
      FROM   public.membership_applications WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(row).toBe("承認済み/true/true/true");
  });

  test("★ ゲストが街人へ昇格する（guest → member）", () => {
    const role = query(`
      ${APPLIED}
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT role FROM public.members WHERE member_id = '${GUEST_ID}';
    `);
    expect(role).toBe("member");
  });

  test("★ 宿泊券がプランの枚数ぶん付与される（種別は plan_grant）", () => {
    const granted = query(`
      ${APPLIED}
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT tx_type || '/' || nights::text FROM public.stay_ticket_transactions
      WHERE  member_id = '${GUEST_ID}';
    `);
    // 現行の登録導線プラン（`0016` の `phase3`）＝ 宿泊券4泊
    expect(granted).toBe("plan_grant/4");
  });

  test("★ 登録キャッシュバックが「未送付」で起票される（発行はしない ／ §5.3.1）", () => {
    const grant = query(`
      ${APPLIED}
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT amount_uii::text || '/' || grant_type || '/' || status
      FROM   public.eumo_grants WHERE member_id = '${GUEST_ID}';
    `);
    expect(grant).toBe("5000/registration_cashback/未送付");
  });

  test("権限変更が監査台帳へ残る（`0003` の AFTER トリガー）", () => {
    const logged = query(`
      ${APPLIED}
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT old_role || '→' || new_role || '/' || (btrim(coalesce(reason, '')) <> '')::text
      FROM   public.member_role_changes WHERE member_id = '${GUEST_ID}';
    `);
    expect(logged).toBe("guest→member/true");
  });
});

describeDb("二重承認を通さない（付与は取り消せない）", () => {
  test("★ 2回目の承認は 42501 で落ちる（黙って成功させない）", () => {
    expect(
      sqlstateOf(`
        ${APPLIED}
        ${APPROVE(TEST_MEMBERS.admin.memberId)}
        ${APPROVE(TEST_MEMBERS.admin.memberId)}
      `),
    ).toBe("42501");
  });

  test("却下済みの申請は承認できない", () => {
    expect(
      sqlstateOf(`
        ${APPLIED}
        UPDATE public.membership_applications
        SET    status = '却下', rejection_reason = '本人確認が取れなかった'
        WHERE  application_id = '${APPLICATION_ID}';
        ${APPROVE(TEST_MEMBERS.admin.memberId)}
      `),
    ).toBe("42501");
  });
});

describeDb("承認できるのは admin だけ（v13 §6）", () => {
  test("★ コアメンバーの承認は 42501 で落ちる", () => {
    expect(
      sqlstateOf(`
        ${APPLIED}
        ${APPROVE(TEST_MEMBERS.core.memberId)}
      `),
    ).toBe("42501");
  });

  test("一般会員の承認も落ちる", () => {
    expect(
      sqlstateOf(`
        ${APPLIED}
        ${APPROVE(TEST_MEMBERS.self.memberId)}
      `),
    ).toBe("42501");
  });

  test("★ authenticated からは RPC 自体を呼べない（EXECUTE を剥がしてある）", () => {
    expect(
      sqlstateOf(`
        ${APPLIED}
        SET ROLE authenticated;
        ${APPROVE(TEST_MEMBERS.admin.memberId)}
      `),
    ).toBe("42501");
  });
});

describeDb("決済の記録が承認の前提である（v13 §5.10.4）", () => {
  test("★ 決済手段・受領日時が無い申請は承認できない", () => {
    expect(
      sqlstateOf(`
        ${FIXTURE_SQL}
                DO $$ BEGIN PERFORM set_config('app.operator_id', '${TEST_MEMBERS.admin.memberId}', true); END $$;
        INSERT INTO public.membership_applications
          (application_id, member_id, billed_amount_yen, granted_nights)
        VALUES ('${APPLICATION_ID}', '${GUEST_ID}', 0, 0);
        ${APPROVE(TEST_MEMBERS.admin.memberId)}
      `),
    ).toBe("42501");
  });
});

describeDb("既に会員の相手には role を触らない", () => {
  test("★ core_member の申請を承認しても role は下がらない", () => {
    const role = query(`
      ${FIXTURE_SQL}
      DO $$ BEGIN PERFORM set_config('app.operator_id', '${TEST_MEMBERS.admin.memberId}', true); END $$;
      INSERT INTO public.membership_applications
        (application_id, member_id, billed_amount_yen, granted_nights, payment_method, paid_at)
      VALUES ('${APPLICATION_ID}', '${TEST_MEMBERS.core.memberId}', 0, 0, 'uii_qr', now());
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT role FROM public.members WHERE member_id = '${TEST_MEMBERS.core.memberId}';
    `);
    expect(role).toBe("core_member");
  });

  test("それでも宿泊券とキャッシュバックは付与される（承認の効果は落とさない）", () => {
    const granted = query(`
      ${FIXTURE_SQL}
      DO $$ BEGIN PERFORM set_config('app.operator_id', '${TEST_MEMBERS.admin.memberId}', true); END $$;
      INSERT INTO public.membership_applications
        (application_id, member_id, billed_amount_yen, granted_nights, payment_method, paid_at)
      VALUES ('${APPLICATION_ID}', '${TEST_MEMBERS.core.memberId}', 0, 0, 'uii_qr', now());
      ${APPROVE(TEST_MEMBERS.admin.memberId)}
      SELECT public.stay_ticket_balance('${TEST_MEMBERS.core.memberId}')::text;
    `);
    expect(granted).toBe("4");
  });
});
