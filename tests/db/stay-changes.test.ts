// WBS 3-10（滞在中の宿泊形態・部屋・日程・人数の変更）の DB 層の受入テスト。
//
// 根拠: v13 §5.6.9（2026-08-25 決定 ／ §9 #50）・§5.2.5（残枠）・§6（権限マトリクス）、
//       `supabase/migrations/0041_check_in_changes.sql`
//
// ここで固定するのは、アプリ側の判定（`tests/stay-change.test.ts`）では守れない3点である。
//   ① 追記専用であること（UPDATE / DELETE が拒まれる）と、理由なしの行が入らないこと
//   ② `v_check_in_nights` が**その夜に効いている形態**を返すこと
//   ③ 残枠ビューが「明日から移る」変更で**今夜を空きにしない**こと
//   ④ `rooms.room_type` を書き換えられないこと（部屋台帳を壊す経路をふさぐ）
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import {
  FIXTURE_SQL,
  loginAsSql,
  STAY_FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

const SEEDED = `${FIXTURE_SQL}\n${STAY_FIXTURE_SQL}`;
/** 下準備のあとで一般会員へ切り替えるための断片（`SEEDED` を含まない）。 */
const asMemberRole = `${loginAsSql(TEST_AUTH_USERS.self.id)}
SET ROLE authenticated;`;
const asStaff = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;

/** 窓（`current_date` 起点の180日）の内側に、変更を試す滞在を1件作る。 */
const STAY_IN_WINDOW = `
  INSERT INTO public.check_ins
    (checkin_id, member_id, room_type, check_in_date, check_out_date, adults_count)
  VALUES ('00000000-0000-0000-0000-0000000000d1', '${TEST_MEMBERS.self.memberId}',
          'campsite', current_date + 10, current_date + 13, 2);
`;

const STAY_ID = "00000000-0000-0000-0000-0000000000d1";

/** 「明後日（+12）からコテージへ移る」変更を1件積む。 */
const MOVE_TO_COTTAGE = `
  INSERT INTO public.check_in_changes
    (checkin_id, effective_date, room_type_before, room_type_after, reason, changed_by)
  VALUES ('${STAY_ID}', current_date + 12, 'campsite', 'cottage',
          '雨天のためコテージへ移動', '${TEST_MEMBERS.admin.memberId}');
`;

describeDb("check_in_changes の RLS（v13 §5.6.9 の権限＝管理者・コアメンバー）", () => {
  test("staff は変更を記録できる", () => {
    const count = query(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      SELECT count(*)::text FROM public.check_in_changes WHERE checkin_id = '${STAY_ID}';
    `);
    expect(count).toBe("1");
  });

  test("一般会員は自分の滞在でも変更を記録できない", () => {
    // ★ 下準備（滞在の投入）はロールを切り替える**前**に済ませる。
    //   authenticated へ落ちたあとに戻す書き方にすると、何を検証しているのかがぼやける。
    const state = sqlstateOf(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      ${asMemberRole}
      ${MOVE_TO_COTTAGE.replace(TEST_MEMBERS.admin.memberId, TEST_MEMBERS.self.memberId)}
    `);
    expect(state).toBe("42501");
  });

  test("一般会員は変更履歴を読めない（運営の編集理由は本人に見せない）", () => {
    const count = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      ${asMemberRole}
      SELECT count(*)::text FROM public.check_in_changes WHERE checkin_id = '${STAY_ID}';
    `);
    expect(count).toBe("0");
  });

  test("★ 記録した変更は書き換えられない（追記専用 ／ UPDATE のポリシーを置いていない）", () => {
    const state = sqlstateOf(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      UPDATE public.check_in_changes SET reason = '書き換え' WHERE checkin_id = '${STAY_ID}';
    `);
    expect(state).toBe("42501");
  });

  test("★ 記録した変更は削除できない", () => {
    const state = sqlstateOf(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      DELETE FROM public.check_in_changes WHERE checkin_id = '${STAY_ID}';
    `);
    expect(state).toBe("42501");
  });
});

describeDb("check_in_changes の制約（理由必須・空の変更行を作らせない）", () => {
  test("理由が空白だけの行は入らない（v13 §5.6.9 の理由必須）", () => {
    const state = sqlstateOf(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      INSERT INTO public.check_in_changes
        (checkin_id, effective_date, room_type_before, room_type_after, reason, changed_by)
      VALUES ('${STAY_ID}', current_date + 12, 'campsite', 'cottage', '   ',
              '${TEST_MEMBERS.admin.memberId}');
    `);
    expect(state).toBe("23514");
  });

  test("何も変わっていない行は入らない", () => {
    const state = sqlstateOf(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      INSERT INTO public.check_in_changes (checkin_id, effective_date, reason, changed_by)
      VALUES ('${STAY_ID}', current_date + 12, '理由だけ', '${TEST_MEMBERS.admin.memberId}');
    `);
    expect(state).toBe("23514");
  });

  test("変更前と変更後が同じ形態の行は入らない", () => {
    const state = sqlstateOf(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      INSERT INTO public.check_in_changes
        (checkin_id, effective_date, room_type_before, room_type_after, reason, changed_by)
      VALUES ('${STAY_ID}', current_date + 12, 'campsite', 'campsite', '同じ形態',
              '${TEST_MEMBERS.admin.memberId}');
    `);
    expect(state).toBe("23514");
  });
});

describeDb("v_check_in_nights（その夜に効いている形態・人数 ／ v13 §5.6.9）", () => {
  // ⚠️ このビューは **authenticated へ GRANT していない**（行レベルの情報を返すため）。
  //    そのため検査はロールを切り替えずに（＝所有者のまま）流す。
  //    残枠ビューが所有者権限でこれを読む、という実際の経路と同じ条件になる。

  test("変更が無ければ check_ins の現在値を返す", () => {
    const roomType = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      SELECT room_type FROM public.v_check_in_nights
      WHERE checkin_id = '${STAY_ID}' AND date = current_date + 10;
    `);
    expect(roomType).toBe("campsite");
  });

  test("★ 変更が効く前の夜は、変更前の形態を返す（滞在全体を塗り替えない）", () => {
    const roomTypes = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      -- 形態の現在値も移動後に合わせて更新する（アプリは履歴と本体の両方を書く）
      UPDATE public.check_ins SET room_type = 'cottage' WHERE checkin_id = '${STAY_ID}';
      SELECT string_agg(room_type, ',' ORDER BY date) FROM public.v_check_in_nights
      WHERE checkin_id = '${STAY_ID}';
    `);
    expect(roomTypes).toBe("campsite,campsite,cottage");
  });

  test("人数だけを直した変更のあとでも形態は失われない（項目ごとに引くため）", () => {
    const roomType = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      INSERT INTO public.check_in_changes
        (checkin_id, effective_date, adults_before, adults_after, reason, changed_by)
      VALUES ('${STAY_ID}', current_date + 12, 2, 3, '同伴者1名追加',
              '${TEST_MEMBERS.admin.memberId}');
      SELECT room_type FROM public.v_check_in_nights
      WHERE checkin_id = '${STAY_ID}' AND date = current_date + 12;
    `);
    expect(roomType).toBe("cottage");
  });

  test("人数は変更が効く夜から切り替わる", () => {
    const counts = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      INSERT INTO public.check_in_changes
        (checkin_id, effective_date, adults_before, adults_after, reason, changed_by)
      VALUES ('${STAY_ID}', current_date + 12, 2, 4, '同伴者2名追加',
              '${TEST_MEMBERS.admin.memberId}');
      UPDATE public.check_ins SET adults_count = 4 WHERE checkin_id = '${STAY_ID}';
      SELECT string_agg(adults_count::text, ',' ORDER BY date) FROM public.v_check_in_nights
      WHERE checkin_id = '${STAY_ID}';
    `);
    expect(counts).toBe("2,2,4");
  });

  test("キャンセルした滞在は1泊も出てこない（残枠を専有しない ／ v13 §5.2.2）", () => {
    const count = query(`
      ${SEEDED}
      ${STAY_IN_WINDOW}
      UPDATE public.check_ins
      SET status = 'cancelled', cancelled_at = now(), cancel_reason_type = '会員都合',
          cancel_reason = 'テスト', cancelled_by = '${TEST_MEMBERS.admin.memberId}'
      WHERE checkin_id = '${STAY_ID}';
      SELECT count(*)::text FROM public.v_check_in_nights WHERE checkin_id = '${STAY_ID}';
    `);
    expect(count).toBe("0");
  });

  test("★ 一般会員・anon には GRANT していない（行レベルの情報を画面へ出さない）", () => {
    expect(
      sqlstateOf(`
        ${SEEDED}
        ${STAY_IN_WINDOW}
        ${asMemberRole}
        SELECT count(*) FROM public.v_check_in_nights;
      `),
    ).toBe("42501");

    expect(
      sqlstateOf(`${SEEDED} SET ROLE anon; SELECT count(*) FROM public.v_check_in_nights;`),
    ).toBe("42501");
  });
});

describeDb("v_room_availability が「その夜の形態」で占有を数える（WBS 3-10 ／ 3-8）", () => {
  test("★ 明後日から移る変更は、それより前の夜の旧形態を空きにしない", () => {
    // キャンプサイト（定員10・人数枠型）に2名。+12 からコテージへ移る。
    const occupied = query(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      UPDATE public.check_ins SET room_type = 'cottage' WHERE checkin_id = '${STAY_ID}';
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'campsite' AND date = current_date + 10;
    `);
    // ここが 0 になる実装だと、今夜のキャンプサイトへ別の予約を通してしまう（ダブルブッキング）。
    expect(occupied).toBe("2");
  });

  test("★ 移った先の形態は、移る夜から埋まる（それより前の夜は埋まらない）", () => {
    const before = query(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      UPDATE public.check_ins SET room_type = 'cottage' WHERE checkin_id = '${STAY_ID}';
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'cottage' AND date = current_date + 11;
    `);
    expect(before).toBe("0");

    const after = query(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      ${MOVE_TO_COTTAGE}
      UPDATE public.check_ins SET room_type = 'cottage' WHERE checkin_id = '${STAY_ID}';
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'cottage' AND date = current_date + 12;
    `);
    // 2名でコテージ（1棟の定員2）＝1棟
    expect(after).toBe("1");
  });

  test("変更履歴が無い滞在の数え方は従来と同じ（`0015` の振る舞いを壊していない）", () => {
    const occupied = query(`
      ${asStaff}
      ${STAY_IN_WINDOW}
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'campsite' AND date = current_date + 12;
    `);
    expect(occupied).toBe("2");
  });
});

describeDb("rooms.room_type は書き換えられない（v13 §5.6.9 の [!important]）", () => {
  test("★ staff でも部屋台帳の宿泊形態は変更できない", () => {
    const state = sqlstateOf(`
      ${asStaff}
      UPDATE public.rooms SET room_type = 'campsite' WHERE room_type = 'cottage';
    `);
    expect(state).toBe("42501");
  });

  test("service_role でも拒まれる（RLS ではなくトリガーで守っているため）", () => {
    const state = sqlstateOf(`
      SET ROLE service_role;
      UPDATE public.rooms SET room_type = 'campsite' WHERE room_type = 'cottage';
    `);
    expect(state).toBe("42501");
  });

  test("部屋名・ステータスの変更は通る（形態だけを止めている）", () => {
    const status = query(`
      ${asStaff}
      UPDATE public.rooms SET status = 'メンテナンス中'
      WHERE room_type = 'cottage' AND status = '利用可';
      SELECT DISTINCT status FROM public.rooms WHERE room_type = 'cottage';
    `);
    expect(status).toBe("メンテナンス中");
  });
});
