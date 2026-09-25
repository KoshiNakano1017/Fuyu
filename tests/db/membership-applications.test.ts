// 街人登録申込（`0037_membership_applications.sql` ／ WBS 12-2・Issue #110）の受入テスト。
//
// 根拠: 正本 v13 §5.10.1〜§5.10.7（申請〜決済〜承認）／§7「★ 街人登録申込」／§6 権限マトリクス、
//       `DB物理設計.md` §3-5・§6-1 #16。
//
// ⚠️ ここで守っているのは**金額と昇格である**。
//    本表は「本人が INSERT できる」唯一の PII-B テーブルであり（§6-1 #16）、
//    RLS は列を絞れないため、開けた穴から `billed_amount_yen` と `status` が射程に入る。
//    「0円で申し込んで自分で承認済みにする」を止めているのは 0037 のトリガーだけである。
//    アプリ層（Server Action）が正しくても PostgREST 直アクセスはそこを通らない。

import {
  FIXTURE_SQL,
  loginAsSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";
import { describeDb, query, queryRows, sqlstateOf } from "./helpers/psql";

const TABLE = "public.membership_applications";

/** 現行の登録導線プラン（`0016` の `phase3`）＝ 30,000円・宿泊券4枚。 */
const CURRENT_PLAN_FEE_YEN = 30000;
const CURRENT_PLAN_NIGHTS = 4;

const APPLICATION_ID = "00000000-0000-0000-0000-0000000000e1";

function loggedInAs(authUserId: string): string {
  return `${FIXTURE_SQL}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asSelf = loggedInAs(TEST_AUTH_USERS.self.id);
const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);

/** 本人が出す最小の申請。金額・泊数・プランは送らない（トリガーがプランから写す）。 */
function applySelfSql(memberId: string = TEST_MEMBERS.self.memberId): string {
  return `
    INSERT INTO ${TABLE} (application_id, member_id, billed_amount_yen, granted_nights)
    VALUES ('${APPLICATION_ID}', '${memberId}', 0, 0);
  `;
}

/** 運営が承認済みの申請を1件置く（承認後の不変条件を検証する出発点）。 */
const APPROVED_FIXTURE = `
  INSERT INTO ${TABLE}
    (application_id, member_id, plan_id, billed_amount_yen, granted_nights, status,
     payment_method, paid_at, payment_confirmed_by, approved_at)
  SELECT '${APPLICATION_ID}', '${TEST_MEMBERS.self.memberId}', p.plan_id, 0, 0, '承認済み',
         'settlement_qr', now(), '${TEST_MEMBERS.admin.memberId}', now()
  FROM   public.membership_plans p WHERE p.is_current_signup_plan LIMIT 1;
`;

describeDb("街人登録申込のスキーマ（v13 §7）", () => {
  test("テーブルが存在する", () => {
    expect(query(`SELECT to_regclass('${TABLE}') IS NOT NULL;`)).toBe("t");
  });

  test("RLS が有効になっている", () => {
    expect(
      query(`SELECT relrowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass;`),
    ).toBe("t");
  });

  test("申込ステータスは正本の5値だけを取る", () => {
    const definition = query(`
      SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
      WHERE  c.conrelid = '${TABLE}'::regclass AND c.conname = 'chk_membership_app_status';
    `);
    for (const status of ["申込中", "QR送付済み", "承認済み", "却下", "保留"]) {
      expect(definition).toContain(status);
    }
    // 正本に無い値は CHECK で弾く
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET status = '申込済' WHERE application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });

  test("クレジットカードは決済手段に入っていない（Phase 2 ／ v13 §5.10.7）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET payment_method = 'credit_card'
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });
});

describeDb("金額と付与泊数はプランから写す（v13 §7「コードに直書きしない」）", () => {
  test("本人が 0円・0泊で申し込んでも、プランの 30,000円・4泊になる", () => {
    const written = query(`
      ${asSelf}
      ${applySelfSql()}
      RESET ROLE;
      SELECT billed_amount_yen || '/' || granted_nights
      FROM   ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(written).toBe(`${CURRENT_PLAN_FEE_YEN}/${CURRENT_PLAN_NIGHTS}`);
  });

  test("本人はプランを選べない（安いプランを名乗って申し込めない）", () => {
    // `phase2_standard` を指定しても、本人経路では現行の登録導線プランへ差し替わる。
    const planCode = query(`
      ${asSelf}
      INSERT INTO ${TABLE} (application_id, member_id, plan_id, billed_amount_yen, granted_nights)
      SELECT '${APPLICATION_ID}', '${TEST_MEMBERS.self.memberId}', p.plan_id, 0, 0
      FROM   public.membership_plans p WHERE p.plan_code = 'phase2_standard';
      RESET ROLE;
      SELECT p.plan_code FROM ${TABLE} a
        JOIN public.membership_plans p ON p.plan_id = a.plan_id
      WHERE  a.application_id = '${APPLICATION_ID}';
    `);
    expect(planCode).toBe("phase3");
  });

  test("運営は過去プランを指定して代理申請できる（既存街人の登録／v13 §5.10.8）", () => {
    const written = query(`
      ${asAdmin}
      INSERT INTO ${TABLE} (application_id, member_id, plan_id, billed_amount_yen, granted_nights)
      SELECT '${APPLICATION_ID}', '${TEST_MEMBERS.self.memberId}', p.plan_id, 0, 0
      FROM   public.membership_plans p WHERE p.plan_code = 'phase1';
      RESET ROLE;
      SELECT billed_amount_yen || '/' || granted_nights
      FROM   ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    // phase1 ＝ 年会費 40,000円・宿泊券7泊（`0016` の初期行）
    expect(written).toBe("40000/7");
  });
});

describeDb("二重申請の防止（v13 §5.10.3）", () => {
  test("申込中の申請がある会員は2件目を作れない", () => {
    expect(
      sqlstateOf(`
        ${asSelf}
        ${applySelfSql()}
        INSERT INTO ${TABLE} (member_id, billed_amount_yen, granted_nights)
        VALUES ('${TEST_MEMBERS.self.memberId}', 0, 0);
      `),
    ).toBe("23505");
  });

  test("却下された申請が残っていても再申請できる", () => {
    const count = query(`
      ${asAdmin}
      ${applySelfSql()}
      UPDATE ${TABLE} SET status = '却下', rejection_reason = '本人確認が取れなかった'
      WHERE  application_id = '${APPLICATION_ID}';
      INSERT INTO ${TABLE} (member_id, billed_amount_yen, granted_nights)
      VALUES ('${TEST_MEMBERS.self.memberId}', 0, 0);
      RESET ROLE;
      SELECT count(*) FROM ${TABLE} WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(count).toBe("2");
  });
});

describeDb("本人に許すのは「申し込んだ」という事実だけ（0037 のトリガー）", () => {
  test("本人は自分の申請を作れる", () => {
    const status = query(`
      ${asSelf}
      ${applySelfSql()}
      RESET ROLE;
      SELECT status FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(status).toBe("申込中");
  });

  test("本人が「承認済み」で申し込むことはできない（無償の昇格を塞ぐ）", () => {
    expect(
      sqlstateOf(`
        ${asSelf}
        INSERT INTO ${TABLE}
          (member_id, billed_amount_yen, granted_nights, status,
           payment_method, paid_at, payment_confirmed_by, approved_at)
        VALUES ('${TEST_MEMBERS.self.memberId}', 0, 0, '承認済み',
                'cash', now(), '${TEST_MEMBERS.self.memberId}', now());
      `),
    ).toBe("42501");
  });

  test("本人が入金QRを自前で仕込むことはできない", () => {
    expect(
      sqlstateOf(`
        ${asSelf}
        INSERT INTO ${TABLE}
          (member_id, billed_amount_yen, granted_nights,
           qr_token_hash, qr_issued_by, qr_issued_at, qr_expires_at)
        VALUES ('${TEST_MEMBERS.self.memberId}', 0, 0,
                repeat('a', 64), '${TEST_MEMBERS.self.memberId}', now(), now() + interval '7 days');
      `),
    ).toBe("42501");
  });

  test("他人の名前で申請できない（RLS の WITH CHECK）", () => {
    expect(
      sqlstateOf(`
        ${asSelf}
        INSERT INTO ${TABLE} (member_id, billed_amount_yen, granted_nights)
        VALUES ('${TEST_MEMBERS.oyakata.memberId}', 0, 0);
      `),
    ).toBe("42501");
  });

  test("本人は自分の申請を更新できない（0行で終わる）", () => {
    const affected = query(`
      ${asAdmin}
      ${applySelfSql()}
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      WITH changed AS (
        UPDATE ${TABLE} SET status = '保留' WHERE application_id = '${APPLICATION_ID}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });
});

describeDb("申請一覧が見えるのは本人と管理者だけ（v13 §6）", () => {
  const applied = `${asAdmin}\n${applySelfSql()}`;

  test("本人は自分の申請を読める", () => {
    expect(
      query(`
        ${applied}
        ${loginAsSql(TEST_AUTH_USERS.self.id)}
        SELECT count(*) FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
      `),
    ).toBe("1");
  });

  test("管理者は全件読める", () => {
    expect(
      query(`
        ${applied}
        SELECT count(*) FROM ${TABLE};
      `),
    ).toBe("1");
  });

  test("★ コアメンバーには見えない（申請一覧は admin のみ）", () => {
    expect(
      query(`
        ${applied}
        ${loginAsSql(TEST_AUTH_USERS.core.id)}
        SELECT count(*) FROM ${TABLE};
      `),
    ).toBe("0");
  });

  test("他人の申請は見えない", () => {
    expect(
      query(`
        ${applied}
        ${loginAsSql(TEST_AUTH_USERS.oyakata.id)}
        SELECT count(*) FROM ${TABLE};
      `),
    ).toBe("0");
  });
});

describeDb("QR発行・承認は管理者の操作である（v13 §5.10.4 Step 3〜5）", () => {
  const issueQr = `
    UPDATE ${TABLE}
    SET    status = 'QR送付済み',
           qr_token_hash = repeat('b', 64),
           qr_issued_by = '${TEST_MEMBERS.admin.memberId}',
           qr_issued_at = now(),
           qr_expires_at = now() + interval '7 days',
           qr_delivery_channel = 'line',
           payment_method = 'settlement_qr'
    WHERE  application_id = '${APPLICATION_ID}';
  `;

  test("管理者は申込中の申請へQRを発行できる", () => {
    expect(
      query(`
        ${asAdmin}
        ${applySelfSql()}
        ${issueQr}
        RESET ROLE;
        SELECT status FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
      `),
    ).toBe("QR送付済み");
  });

  test("コアメンバーのQR発行は1行も通らない（RLS で行が見えない）", () => {
    const status = query(`
      ${asAdmin}
      ${applySelfSql()}
      ${loginAsSql(TEST_AUTH_USERS.core.id)}
      ${issueQr}
      RESET ROLE;
      SELECT status FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    // UPDATE は例外にならず0行で終わる（RLS の USING で行が見えないため）
    expect(status).toBe("申込中");
  });

  test("承認の確定でQRが失効する（単回使用 ／ 2026-09-10 A案）", () => {
    const consumed = query(`
      ${asAdmin}
      ${applySelfSql()}
      ${issueQr}
      UPDATE ${TABLE}
      SET    status = '承認済み', paid_at = now(),
             payment_confirmed_by = '${TEST_MEMBERS.admin.memberId}', approved_at = now()
      WHERE  application_id = '${APPLICATION_ID}';
      RESET ROLE;
      SELECT qr_consumed_at IS NOT NULL FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(consumed).toBe("t");
  });

  test("★ 現金へ切り替えると発行済みQRが失効する（二重受領の防止 ／ v13 §5.10.7）", () => {
    const consumed = query(`
      ${asAdmin}
      ${applySelfSql()}
      ${issueQr}
      UPDATE ${TABLE} SET payment_method = 'cash' WHERE application_id = '${APPLICATION_ID}';
      RESET ROLE;
      SELECT qr_consumed_at IS NOT NULL FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
    `);
    expect(consumed).toBe("t");
  });

  test("承認済みの申請は状態を戻せない（付与の二重計上を防ぐ）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${APPROVED_FIXTURE}
        UPDATE ${TABLE} SET status = '却下', rejection_reason = 'やり直し'
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("42501");
  });

  test("申請者を付け替えられない（監査の連続性）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET member_id = '${TEST_MEMBERS.oyakata.memberId}'
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("42501");
  });
});

describeDb("承認・却下・現金受領の不変条件（CHECK 制約）", () => {
  test("却下は理由必須（空白だけも通らない）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET status = '却下', rejection_reason = '   '
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });

  test("決済手段が空のまま承認済みにできない", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET status = '承認済み', approved_at = now()
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });

  test("現金で受領したのに受領者が空だと通らない（v13 §5.10.7）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET payment_method = 'cash', paid_at = now()
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });

  test("送付経路だけ入れてトークンが無い状態を作れない", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE} SET qr_delivery_channel = 'line' WHERE application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });

  test("期限の無いQRは発行できない（失効しないQRを作らない）", () => {
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        UPDATE ${TABLE}
        SET    qr_token_hash = repeat('c', 64), qr_issued_by = '${TEST_MEMBERS.admin.memberId}',
               qr_issued_at = now()
        WHERE  application_id = '${APPLICATION_ID}';
      `),
    ).toBe("23514");
  });
});

describeDb("申請の証跡は消せない（§1-3 論理削除）", () => {
  test("管理者でも DELETE できない（GRANT を与えていない）", () => {
    // RLS のポリシー不在（＝0行）ではなく、テーブル権限そのものが無い状態にしている。
    // ポリシーだけで塞ぐと、後から DELETE ポリシーを1本足した瞬間に消せるようになる。
    expect(
      sqlstateOf(`
        ${asAdmin}
        ${applySelfSql()}
        DELETE FROM ${TABLE} WHERE application_id = '${APPLICATION_ID}';
      `),
    ).toBe("42501");
  });
});

describeDb("不要な列を持たない（v13 §5.10.4 ／ 決済はアプリ外で完結する）", () => {
  test("決済トランザクションを保持する列が無い", () => {
    const columns = queryRows(`
      SELECT a.attname FROM pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    `);
    // 決済代行の取引ID・カード情報・残高はいずれも Phase 1 の範囲外（§5.10.7 の④）
    expect(columns.filter((column) => /transaction_id|card|balance/.test(column))).toEqual([]);
  });

  test("会員の氏名・連絡先を持たない（PII は member_profiles_private 側）", () => {
    const columns = queryRows(`
      SELECT a.attname FROM pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    `);
    expect(columns.filter((column) => /name|email|phone|address|birth/.test(column))).toEqual([]);
  });
});
