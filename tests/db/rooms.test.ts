// WBS 3-1 の部屋台帳・部屋割当の受入テスト。
//
// 根拠: v13 §5.2.1・§7「★ 部屋台帳・部屋割当」・§5.6.8、
//       DB物理設計.md §6-1 #11・#29・§6-7・§1-3、
//       Issue #31 の 2026-09-15 オーナー決定（スコープ＝DB層まで ／ check_ins 参照分は 3-2 へ）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import {
  FIXTURE_SQL,
  loginAsSql,
  STAY_FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_CHECK_INS,
} from "./helpers/fixtures";

/**
 * 会員 ＋ 滞在のフィクスチャ。
 *
 * ⚠️ 2026-09-20 に `0014_check_ins_and_accommodation_types.sql` が
 *    `room_assignments.check_in_id` へ外部キーを張った（0006 がコメントで後続へ
 *    送っていた ALTER の回収）。そのため**架空のチェックインIDでは部屋割当を作れない**
 *    （23503 になる）。実在する滞在を先に投入する。
 */
const SEEDED = `${FIXTURE_SQL}\n${STAY_FIXTURE_SQL}`;

const asMember = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.self.id)}\nSET ROLE authenticated;`;
const asStaff = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;

/** 部屋割当の対象にする滞在（一般会員 `self` のもの）。 */
const ANY_CHECK_IN = TEST_CHECK_INS.selfStay.checkinId;

describeDb("rooms のスキーマ・制約（v13 §7）", () => {
  test("初期行が 8 行ある（Issue #31 の完了条件）", () => {
    expect(query("SELECT count(*) FROM public.rooms;")).toBe("8");
  });

  test("room_type ごとの構成が仕様どおり", () => {
    const composition = query(`
      SELECT string_agg(room_type || ':' || n, ',' ORDER BY room_type)
      FROM  (SELECT room_type, count(*) AS n FROM public.rooms GROUP BY room_type) t;
    `);
    expect(composition).toBe("campsite:1,car:1,cottage:3,dormitory:1,earthbag:1,salon:1");
  });

  test("cottage の capacity はいずれも 2", () => {
    const distinct = query(
      "SELECT string_agg(DISTINCT capacity::text, ',') FROM public.rooms WHERE room_type = 'cottage';",
    );
    expect(distinct).toBe("2");
  });

  test("dormitory の capacity は 16", () => {
    expect(
      query("SELECT capacity::text FROM public.rooms WHERE room_type = 'dormitory';"),
    ).toBe("16");
  });

  test("status が3値以外なら INSERT できない", () => {
    const state = sqlstateOf(`
      INSERT INTO public.rooms (room_name, capacity, room_type, status)
      VALUES ('不正', 1, 'cottage', '廃止');
    `);
    expect(state).toBe("23514");
  });

  test("room_type が §3-12 の6値以外なら INSERT できない", () => {
    // accommodation_types.room_type と揃えないと、宿泊形態と部屋の対応が取れなくなる。
    const state = sqlstateOf(`
      INSERT INTO public.rooms (room_name, capacity, room_type)
      VALUES ('不正', 1, 'tent');
    `);
    expect(state).toBe("23514");
  });

  test("capacity が 0 以下なら INSERT できない", () => {
    const state = sqlstateOf(`
      INSERT INTO public.rooms (room_name, capacity, room_type) VALUES ('不正', 0, 'cottage');
    `);
    expect(state).toBe("23514");
  });
});

describeDb("room_assignments のスキーマ・制約（v13 §7・§5.6.8）", () => {
  test("同じチェックインに ended_at IS NULL の行を2件は作れない（部分一意インデックス）", () => {
    // 終了し忘れた行が残ると「今どの部屋に居るか」が二重になる。
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.room_assignments
        (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms LIMIT 1;
      INSERT INTO public.room_assignments
        (check_in_id, room_id, room_name_snapshot, assignment_reason)
      SELECT '${ANY_CHECK_IN}', room_id, room_name, '部屋移動' FROM public.rooms OFFSET 1 LIMIT 1;
    `);
    expect(state).toBe("23505");
  });

  test("部屋移動を行うと履歴が 2 行になる（既存行は終了するだけで上書きしない）", () => {
    const rows = query(`
      ${SEEDED}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms LIMIT 1;

      UPDATE public.room_assignments SET ended_at = now()
      WHERE check_in_id = '${ANY_CHECK_IN}' AND ended_at IS NULL;

      INSERT INTO public.room_assignments
        (check_in_id, room_id, room_name_snapshot, assignment_reason)
      SELECT '${ANY_CHECK_IN}', room_id, room_name, '部屋移動' FROM public.rooms OFFSET 1 LIMIT 1;

      SELECT count(*) FROM public.room_assignments WHERE check_in_id = '${ANY_CHECK_IN}';
    `);
    expect(rows).toBe("2");
  });

  test("★ rooms をリネームしても既存の room_name_snapshot は変わらない（§5.6.8）", () => {
    // 過去の宿泊履歴は割当時点の名前で表示する。ここが rooms への参照だと、
    // 部屋をリネームした瞬間に過去の履歴が書き換わる。
    const snapshot = query(`
      ${SEEDED}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms WHERE room_name = 'コテージ1';

      UPDATE public.rooms SET room_name = 'コテージ壱' WHERE room_name = 'コテージ1';

      SELECT room_name_snapshot FROM public.room_assignments WHERE check_in_id = '${ANY_CHECK_IN}';
    `);
    expect(snapshot).toBe("コテージ1");
  });

  test("assignment_reason で「初回」と「部屋移動」を区別できる", () => {
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.room_assignments
        (check_in_id, room_id, room_name_snapshot, assignment_reason)
      SELECT '${ANY_CHECK_IN}', room_id, room_name, '不正な理由' FROM public.rooms LIMIT 1;
    `);
    expect(state).toBe("23514");
  });

  test("ended_at が started_at より前なら INSERT できない", () => {
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.room_assignments
        (check_in_id, room_id, room_name_snapshot, started_at, ended_at)
      SELECT '${ANY_CHECK_IN}', room_id, room_name, now(), now() - interval '1 hour'
      FROM public.rooms LIMIT 1;
    `);
    expect(state).toBe("23514");
  });
});

describeDb("rooms の RLS（§6-1 #29・§6-7）", () => {
  test("RLS が有効である", () => {
    const enabled = query(
      "SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.rooms'::regclass;",
    );
    expect(enabled).toBe("true");
  });

  test("一般会員でも rooms を SELECT できる（残枠表示のため authenticated 全員）", () => {
    // ここを staff に絞ると guest が残枠を見られなくなる。
    expect(query(`${asMember} SELECT count(*) FROM public.rooms;`)).toBe("8");
  });

  test("一般会員は rooms を INSERT できない（書き込みは is_staff()）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.rooms (room_name, capacity, room_type) VALUES ('勝手に増設', 1, 'cottage');
    `);
    expect(state).toBe("42501");
  });

  test("一般会員が rooms を UPDATE しても 0行（RLS が行を見せない）", () => {
    const affected = query(`
      ${asMember}
      WITH changed AS (
        UPDATE public.rooms SET status = '利用停止' WHERE room_name = 'サロン' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });

  test("staff は rooms を INSERT できる（v13 §5.2.1「登録・変更は管理者・コアメンバーのみ」）", () => {
    const added = query(`
      ${asStaff}
      INSERT INTO public.rooms (room_name, capacity, room_type) VALUES ('増設テスト', 1, 'cottage');
      SELECT count(*) FROM public.rooms WHERE room_name = '増設テスト';
    `);
    expect(added).toBe("1");
  });

  test("staff は rooms を UPDATE できる", () => {
    const status = query(`
      ${asStaff}
      UPDATE public.rooms SET status = 'メンテナンス中' WHERE room_name = 'サロン';
      SELECT status FROM public.rooms WHERE room_name = 'サロン';
    `);
    expect(status).toBe("メンテナンス中");
  });

  test("rooms を DELETE できない（§1-3：履歴からの参照が切れるため）", () => {
    const state = sqlstateOf(`${asStaff} DELETE FROM public.rooms WHERE room_name = 'サロン';`);
    expect(state).toBe("42501");
  });
});

describeDb("room_assignments の RLS（PII-B ／ §6-1 #11）", () => {
  test("RLS が有効である", () => {
    const enabled = query(
      "SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.room_assignments'::regclass;",
    );
    expect(enabled).toBe("true");
  });

  // 2026-09-20：`0014` が `ra_select_self` を追加した（0006 がコメントで後続へ送っていたもの）。
  // これにより本人は「自分がどの部屋に泊まったか」を読めるようになった（v13 §5.6.8）。
  test("本人は自分の滞在に紐づく部屋割当を SELECT できる（§5.6.8）", () => {
    const rows = query(`
      ${asStaff}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms LIMIT 1;
      RESET ROLE;
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.room_assignments;
    `);
    expect(rows).toBe("1");
  });

  test("他人の滞在に紐づく部屋割当は SELECT できない（誰がどの部屋に泊まったかは PII-B）", () => {
    const rows = query(`
      ${asStaff}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${TEST_CHECK_INS.otherStay.checkinId}', room_id, room_name FROM public.rooms LIMIT 1;
      RESET ROLE;
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.room_assignments;
    `);
    expect(rows).toBe("0");
  });

  test("staff は room_assignments を SELECT できる", () => {
    const rows = query(`
      ${asStaff}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms LIMIT 1;
      SELECT count(*) FROM public.room_assignments;
    `);
    expect(rows).toBe("1");
  });

  test("一般会員は room_assignments を INSERT できない（_insert_self を作らない）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.room_assignments (check_in_id, room_id, room_name_snapshot)
      SELECT '${ANY_CHECK_IN}', room_id, room_name FROM public.rooms LIMIT 1;
    `);
    expect(state).toBe("42501");
  });
});

describeDb("anon の権限ゼロ化（§6-6① ／ 0行ではなく権限エラー）", () => {
  test("anon は rooms を SELECT できない", () => {
    const state = sqlstateOf(`${FIXTURE_SQL} SET ROLE anon; SELECT count(*) FROM public.rooms;`);
    expect(state).toBe("42501");
  });

  test("anon は room_assignments を SELECT できない", () => {
    const state = sqlstateOf(
      `${FIXTURE_SQL} SET ROLE anon; SELECT count(*) FROM public.room_assignments;`,
    );
    expect(state).toBe("42501");
  });
});
