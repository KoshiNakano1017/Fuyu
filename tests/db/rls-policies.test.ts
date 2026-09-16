// WBS 2-2 の RLS ポリシーの受入テスト。
//
// 根拠: DB物理設計.md §6-2②③・§6-6・§6-6b⑥・§6-8⑤、v13 §5.9.3・§8。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
//
// ⚠️ 値を返す関数を `SELECT` で呼ぶと標準出力へ混ざるため `DO` ブロックで包む
//    （helpers/fixtures.ts の作法）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";

/** 一般会員（`role = 'member'`）としてログインした状態を作る。 */
const asMember = `${FIXTURE_SQL}\n${loginAsSql(TEST_AUTH_USERS.self.id)}\nSET ROLE authenticated;`;

/** 管理者（`role = 'admin'`）としてログインした状態を作る。 */
const asAdmin = `${FIXTURE_SQL}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;

describeDb("members の SELECT（DB物理設計 §6-2②）", () => {
  test("一般会員には自分の1行だけが返る", () => {
    const rows = query(`${asMember} SELECT count(*) FROM public.members;`);
    expect(rows).toBe("1");
  });

  test("一般会員に返るのは自分の行である", () => {
    const memberId = query(`${asMember} SELECT member_id::text FROM public.members;`);
    expect(memberId).toBe(TEST_MEMBERS.self.memberId);
  });

  test("staff には全会員の行が返る", () => {
    // フィクスチャ3名 ＋ 0004 のシステム操作者 = 4行以上
    const rows = Number(query(`${asAdmin} SELECT count(*) FROM public.members;`));
    expect(rows).toBeGreaterThanOrEqual(4);
  });
});

describeDb("members の UPDATE（§6-2② ＋ §6-6 の列単位 GRANT）", () => {
  test("一般会員は自分の nickname を変更できる", () => {
    const updated = query(`
      ${asMember}
      UPDATE public.members SET nickname = '変更後' WHERE member_id = '${TEST_MEMBERS.self.memberId}';
      SELECT nickname FROM public.members WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(updated).toBe("変更後");
  });

  test("一般会員が他人の行を UPDATE しても更新行数が 0 になる", () => {
    // RLS の USING が行を見せないため、エラーではなく「0行更新」になる。
    const affected = query(`
      ${asMember}
      WITH changed AS (
        UPDATE public.members SET nickname = '乗っ取り'
        WHERE member_id = '${TEST_MEMBERS.admin.memberId}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });

  test("★ 一般会員は自分を admin へ昇格できない（列単位 GRANT が本体 ／ §6-2② danger）", () => {
    // これが通ると**全会員が自力で管理者になれる**。RLS 的には「自分の行の更新」であり
    // 正当なので、防いでいるのは GRANT UPDATE の列リストに role が無いことである。
    // 42501 = insufficient_privilege
    const state = sqlstateOf(`
      ${asMember}
      UPDATE public.members SET role = 'admin' WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(state).toBe("42501");
  });

  test("★ 一般会員は自分の account_status を変更できない（列単位 GRANT）", () => {
    const state = sqlstateOf(`
      ${asMember}
      UPDATE public.members SET account_status = 'active'
      WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(state).toBe("42501");
  });

  test("★ 集計キャッシュ（uii_balance）を直接 UPDATE できない（§1-1 の DB 権限による担保）", () => {
    const state = sqlstateOf(`
      ${asMember}
      UPDATE public.members SET uii_balance = 999999
      WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(state).toBe("42501");
  });

  test("authenticated から members へ INSERT できない（ポリシー無し＝全拒否）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.members (nickname, member_type, role, account_status)
      VALUES ('不正', 'ゲスト', 'admin', 'active');
    `);
    expect(state).not.toBeNull();
  });

  test("authenticated から members を DELETE できない（§1-3 物理削除の禁止）", () => {
    // GRANT に DELETE が無いため 42501（permission denied）で弾かれる。
    // ポリシー不在による「0行」より手前で止まっており、**より強く守られている**。
    const state = sqlstateOf(`
      ${asMember}
      DELETE FROM public.members WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(state).toBe("42501");
  });
});

describeDb("member_profiles_private（PII-A ／ §6-8⑤）", () => {
  test("他人の PII は 0行になる（エラーではなく0行）", () => {
    // エラーで返すと「その会員が存在すること」自体が漏れる。0行が正しい。
    const rows = query(`
      ${asMember}
      SELECT count(*) FROM public.member_profiles_private
      WHERE member_id = '${TEST_MEMBERS.admin.memberId}';
    `);
    expect(rows).toBe("0");
  });

  test("staff は全会員の PII を SELECT できる", () => {
    const rows = query(`${asAdmin} SELECT count(*) FROM public.member_profiles_private;`);
    expect(Number(rows)).toBeGreaterThanOrEqual(0);
  });

  test("一般会員は他人の member_id を指定した INSERT ができない（WITH CHECK 違反）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.member_profiles_private (member_id, full_name)
      VALUES ('${TEST_MEMBERS.admin.memberId}', 'なりすまし');
    `);
    expect(state).toBe("42501");
  });

  test("authenticated から DELETE できない（匿名化は UPDATE で行う）", () => {
    // GRANT に DELETE が無いため 42501 で弾かれる。退会30日後の匿名化は
    // 「行を消す」のではなく「値をダミーへ UPDATE する」で行う（§6-2③）。
    const state = sqlstateOf(`
      ${asMember}
      DELETE FROM public.member_profiles_private
      WHERE member_id = '${TEST_MEMBERS.self.memberId}';
    `);
    expect(state).toBe("42501");
  });
});

describeDb("member_role_changes（権限変更履歴 ／ §6-6b⑥）", () => {
  test("admin は SELECT できる", () => {
    const rows = query(`${asAdmin} SELECT count(*) FROM public.member_role_changes;`);
    expect(Number(rows)).toBeGreaterThanOrEqual(0);
  });

  test("一般会員には 0行（本人の降格理由も本人に開かない）", () => {
    const rows = query(`${asMember} SELECT count(*) FROM public.member_role_changes;`);
    expect(rows).toBe("0");
  });
});

describeDb("member_invitations（招待台帳 ／ 2-1b から送られたポリシー）", () => {
  test("staff は SELECT できる", () => {
    const rows = query(`${asAdmin} SELECT count(*) FROM public.member_invitations;`);
    expect(Number(rows)).toBeGreaterThanOrEqual(0);
  });

  test("一般会員には 0行（宛先アドレスは PII）", () => {
    const rows = query(`${asMember} SELECT count(*) FROM public.member_invitations;`);
    expect(rows).toBe("0");
  });

  test("authenticated から INSERT できない（送信は service_role 経由のみ）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.member_invitations (member_id, sent_to_email, sent_by, expires_at)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'x@example.invalid',
              '${TEST_MEMBERS.self.memberId}', now() + interval '24 hours');
    `);
    expect(state).not.toBeNull();
  });
});

describeDb("anon の権限ゼロ化（2026-09-05 決定「前線2」／ §6-6①）", () => {
  test("anon は members を SELECT できない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      SET ROLE anon;
      SELECT count(*) FROM public.members;
    `);
    expect(state).toBe("42501");
  });

  test("anon は member_profiles_private を SELECT できない", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      SET ROLE anon;
      SELECT count(*) FROM public.member_profiles_private;
    `);
    expect(state).toBe("42501");
  });

  test("★ 今後追加されるテーブルにも自動で適用される（ALTER DEFAULT PRIVILEGES）", () => {
    // 「新テーブルを作ったら anon に全開だった」を規約ではなく既定値で防ぐ。
    const state = sqlstateOf(`
      CREATE TABLE public.tmp_default_privilege_probe (id int);
      SET ROLE anon;
      SELECT count(*) FROM public.tmp_default_privilege_probe;
    `);
    expect(state).toBe("42501");
  });
});
