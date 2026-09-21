// WBS 3-2（`check_ins` の DB 層）・3-3（キャンセル／ノーショー）・3-8（残枠ビュー）の受入テスト。
//
// 根拠: v13 §5.2.2・§5.2.5・§5.4.2（宿泊形態と収容枠の確定表）・§7、
//       DB物理設計.md §3-11・§3-12・§6-1 #5・§6-7、
//       `supabase/migrations/0014_check_ins_and_accommodation_types.sql` / `0015_room_availability_view.sql`
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import {
  FIXTURE_SQL,
  loginAsSql,
  STAY_FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_CHECK_INS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

const SEEDED = `${FIXTURE_SQL}\n${STAY_FIXTURE_SQL}`;
const asMember = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.self.id)}\nSET ROLE authenticated;`;
const asStaff = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;
const asOther = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.oyakata.id)}\nSET ROLE authenticated;`;

describeDb("accommodation_types（宿泊形態マスタ ／ v13 §5.4.2）", () => {
  test("6形態が登録されている", () => {
    expect(query("SELECT count(*) FROM public.accommodation_types;")).toBe("6");
  });

  test("人数枠型はドミトリー・キャンプサイト・車中泊の3形態である（v13 §9 #47）", () => {
    const perPerson = query(`
      SELECT string_agg(room_type, ',' ORDER BY room_type)
      FROM   public.accommodation_types WHERE allocation_mode = 'per_person';
    `);
    expect(perPerson).toBe("campsite,car,dormitory");
  });

  test("棟貸型はコテージ・アースバッグ・サロンの3形態である（v13 §9 #47）", () => {
    const perUnit = query(`
      SELECT string_agg(room_type, ',' ORDER BY room_type)
      FROM   public.accommodation_types WHERE allocation_mode = 'per_unit';
    `);
    expect(perUnit).toBe("cottage,earthbag,salon");
  });

  test("allocation_mode は2値以外を受け付けない", () => {
    const state = sqlstateOf(`
      INSERT INTO public.accommodation_types (room_type, display_name, allocation_mode)
      VALUES ('salon2', 'サロン2', 'per_room');
    `);
    expect(state).toBe("23514");
  });
});

describeDb("rooms の収容枠が v13 §5.4.2 の確定表（合計66）と一致する", () => {
  // 0006 の初期行は キャンプサイト=4 ／ 車中泊=2 で入っており、確定表と食い違っていた。
  // 0014 が UPDATE で是正している。ここを外すと残枠ビューの分母が 32 のままになる。
  test("キャンプサイトの収容枠は 10 である", () => {
    expect(query("SELECT capacity::text FROM public.rooms WHERE room_type = 'campsite';")).toBe("10");
  });

  test("車中泊の収容枠は 30 である", () => {
    expect(query("SELECT capacity::text FROM public.rooms WHERE room_type = 'car';")).toBe("30");
  });

  test("利用可の部屋の収容枠の合計は 66 である", () => {
    const total = query("SELECT sum(capacity)::text FROM public.rooms WHERE status = '利用可';");
    expect(total).toBe("66");
  });
});

describeDb("check_ins のスキーマ・制約（v13 §7）", () => {
  test("0泊の予約は作れない（残枠を1つも消費しないまま部屋が埋まるのを防ぐ）", () => {
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'cottage', '2030-06-01', '2030-06-01');
    `);
    expect(state).toBe("23514");
  });

  test("大人0名・子供0名の予約は作れない（幽霊予約の防止）", () => {
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.check_ins
        (member_id, room_type, check_in_date, check_out_date, adults_count, children_count)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'cottage', '2030-06-01', '2030-06-02', 0, 0);
    `);
    expect(state).toBe("23514");
  });

  test("宿泊形態はマスタに無い値を受け付けない", () => {
    const state = sqlstateOf(`
      ${SEEDED}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'tent', '2030-06-01', '2030-06-02');
    `);
    expect(state).toBe("23503");
  });

  test("予約経路の既定値は公開予約ページである（v13 §9 #46）", () => {
    const source = query(`
      ${SEEDED}
      SELECT reservation_source FROM public.check_ins
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(source).toBe("web_public");
  });

  test("滞在フラグは status から導出される（二重管理を作らない）", () => {
    const staying = query(`
      ${SEEDED}
      UPDATE public.check_ins SET status = 'staying'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
      SELECT is_staying::text FROM public.check_ins
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(staying).toBe("true");
  });
});

describeDb("キャンセル・ノーショーの記録（WBS 3-3 ／ v13 §5.2.2）", () => {
  const cancelHead = `${SEEDED}\nUPDATE public.check_ins SET status = 'cancelled', cancelled_at = now()`;

  test("理由種別・自由記述・操作者が揃っていればキャンセルできる", () => {
    const status = query(`
      ${cancelHead},
        cancel_reason_type = '会員都合', cancel_reason = '急用のため',
        cancelled_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
      SELECT status FROM public.check_ins WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(status).toBe("cancelled");
  });

  test("理由の自由記述が無いキャンセルは作れない（理由なし取消の禁止）", () => {
    const state = sqlstateOf(`
      ${cancelHead},
        cancel_reason_type = '会員都合', cancelled_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("23514");
  });

  test("理由が空白文字だけのキャンセルは作れない", () => {
    const state = sqlstateOf(`
      ${cancelHead},
        cancel_reason_type = 'ノーショー', cancel_reason = '   ',
        cancelled_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("23514");
  });

  test("操作者が無いキャンセルは作れない", () => {
    const state = sqlstateOf(`
      ${cancelHead},
        cancel_reason_type = '運営都合', cancel_reason = '設備点検のため'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("23514");
  });

  test("値域外の理由種別は受け付けない", () => {
    const state = sqlstateOf(`
      ${cancelHead},
        cancel_reason_type = 'その他', cancel_reason = '理由',
        cancelled_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("23514");
  });

  test("status だけ cancelled にして cancelled_at を入れない状態は作れない", () => {
    // 片方だけ更新すると、残枠ビューがキャンセル済みの予約を数え続ける。
    const state = sqlstateOf(`
      ${SEEDED}
      UPDATE public.check_ins SET status = 'cancelled'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("23514");
  });

  test("予約を物理削除できない（§5.2.2：論理削除であり履歴として残す）", () => {
    const state = sqlstateOf(`
      ${asStaff}
      DELETE FROM public.check_ins WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(state).toBe("42501");
  });
});

describeDb("check_ins の RLS（PII-B ／ DB物理設計 §6-1 #5）", () => {
  test("RLS が有効である", () => {
    const enabled = query(
      "SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.check_ins'::regclass;",
    );
    expect(enabled).toBe("true");
  });

  test("本人は自分の予約を SELECT できる", () => {
    expect(query(`${asMember} SELECT count(*) FROM public.check_ins;`)).toBe("1");
  });

  test("他人の予約は SELECT できない", () => {
    const rows = query(`
      ${asOther}
      SELECT count(*) FROM public.check_ins
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(rows).toBe("0");
  });

  test("staff は全員の予約を SELECT できる", () => {
    expect(query(`${asStaff} SELECT count(*) FROM public.check_ins;`)).toBe("2");
  });

  test("本人はアプリ内予約として自分名義の予約を INSERT できる（v13 §5.2.4）", () => {
    const added = query(`
      ${asMember}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'dormitory', '2030-07-01', '2030-07-02');
      SELECT count(*) FROM public.check_ins WHERE check_in_date = '2030-07-01';
    `);
    expect(added).toBe("1");
  });

  test("他人名義の予約は INSERT できない（なりすまし予約の防止）", () => {
    const state = sqlstateOf(`
      ${asMember}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date)
      VALUES ('${TEST_MEMBERS.oyakata.memberId}', 'dormitory', '2030-07-01', '2030-07-02');
    `);
    expect(state).toBe("42501");
  });

  test("本人が自分の予約を UPDATE しても 0行（チェックアウト・キャンセルは運営操作）", () => {
    const affected = query(`
      ${asMember}
      WITH changed AS (
        UPDATE public.check_ins SET check_out_date = '2030-05-10'
        WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });

  test("staff は予約を UPDATE できる", () => {
    const checkOut = query(`
      ${asStaff}
      UPDATE public.check_ins SET check_out_date = '2030-05-10'
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
      SELECT check_out_date::text FROM public.check_ins
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(checkOut).toBe("2030-05-10");
  });

  test("anon は予約を SELECT できない（0行ではなく権限エラー）", () => {
    const state = sqlstateOf(`${SEEDED} SET ROLE anon; SELECT count(*) FROM public.check_ins;`);
    expect(state).toBe("42501");
  });
});

describeDb("v_room_availability（残枠ビュー ／ WBS 3-8 ／ v13 §5.2.5）", () => {
  // フィクスチャの滞在: cottage 2名 × 2030-05-01〜05-03 ／ dormitory 1名 × 05-01〜05-02
  // ⚠️ ビューは current_date 起点の 180 日窓しか返さないため、
  //    2030 年のフィクスチャは窓の外にある。ここでは窓内の日付で「満室でない」ことと、
  //    分母（total）が確定表どおりであることを検証する。

  test("人数枠型の分母は定員の合計である（ドミトリー＝16）", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'dormitory';
    `);
    expect(total).toBe("16");
  });

  test("棟貸型の分母は棟数である（コテージ＝3棟）", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'cottage';
    `);
    expect(total).toBe("3");
  });

  test("キャンプサイトの分母は確定表どおり 10 である", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'campsite';
    `);
    expect(total).toBe("10");
  });

  test("1名の予約が3件入るとコテージの残枠は0になる（棟貸型の数え方）", () => {
    const available = query(`
      ${asStaff}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES
        ('${TEST_MEMBERS.self.memberId}',    'cottage', current_date + 10, current_date + 11, 1),
        ('${TEST_MEMBERS.oyakata.memberId}', 'cottage', current_date + 10, current_date + 11, 1),
        ('${TEST_MEMBERS.core.memberId}',    'cottage', current_date + 10, current_date + 11, 1);
      SELECT available::text FROM public.v_room_availability
      WHERE room_type = 'cottage' AND date = current_date + 10;
    `);
    expect(available).toBe("0");
  });

  test("ドミトリーに1名の予約が3件入っても残枠は13ある（人数枠型の数え方）", () => {
    const available = query(`
      ${asStaff}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES
        ('${TEST_MEMBERS.self.memberId}',    'dormitory', current_date + 10, current_date + 11, 1),
        ('${TEST_MEMBERS.oyakata.memberId}', 'dormitory', current_date + 10, current_date + 11, 1),
        ('${TEST_MEMBERS.core.memberId}',    'dormitory', current_date + 10, current_date + 11, 1);
      SELECT available::text FROM public.v_room_availability
      WHERE room_type = 'dormitory' AND date = current_date + 10;
    `);
    expect(available).toBe("13");
  });

  test("チェックアウト日は専有しない（退去日と次の到着日が重なる予約を弾かないため）", () => {
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'dormitory', current_date + 10, current_date + 12, 4);
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'dormitory' AND date = current_date + 12;
    `);
    expect(occupied).toBe("0");
  });

  test("キャンセル済みの予約は残枠を専有しない（v13 §5.2.2）", () => {
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins
        (member_id, room_type, check_in_date, check_out_date, adults_count,
         status, cancelled_at, cancel_reason_type, cancel_reason, cancelled_by)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'dormitory', current_date + 10, current_date + 11, 4,
              'cancelled', now(), 'ノーショー', '当日連絡なく未着', '${TEST_MEMBERS.admin.memberId}');
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'dormitory' AND date = current_date + 10;
    `);
    expect(occupied).toBe("0");
  });

  test("一般会員も残枠を読める（他人の予約が見えなくても占有量は正しく出る）", () => {
    // ★ security_invoker = false の意図。invoker 権限だと他人の占有が 0 と数えられ、
    //    空いていないのに「空き」と表示される。
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES ('${TEST_MEMBERS.oyakata.memberId}', 'dormitory', current_date + 10, current_date + 11, 5);
      RESET ROLE;
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SET ROLE authenticated;
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'dormitory' AND date = current_date + 10;
    `);
    expect(occupied).toBe("5");
  });

  test("anon は残枠ビューを SELECT できない（公開予約ページはサーバ経由で読む）", () => {
    const state = sqlstateOf(
      `${SEEDED} SET ROLE anon; SELECT count(*) FROM public.v_room_availability;`,
    );
    expect(state).toBe("42501");
  });
});
