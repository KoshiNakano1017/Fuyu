// 残枠ビュー `v_room_availability` の受入テスト（WBS 3-8 ／ Issue #169）。
//
// 根拠: v13 §5.2.5①（算出式・有効な予約・除外条件・キャンセル分）／ v13 §9 #25・#47 ／
//       v13 L1019–1043「★ 宿泊形態と収容枠の確定」／ DB物理設計.md §3-12（L830・L859・L874）。
//
// ここで固定するのは **「何から・どう数えるか」と「何を持たせないか」** である。
// 既に `tests/db/check-ins-and-availability.test.ts` が固定している条件
// （収容枠の合計66・キャンセル分の非専有・チェックアウト日の非専有・`anon` 不可・一般会員は読める）は
// 重複させない。本ファイルは残りの受入条件だけを見る。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query } from "./helpers/psql";
import {
  FIXTURE_SQL,
  loginAsSql,
  STAY_FIXTURE_SQL,
  TEST_AUTH_USERS,
  TEST_CHECK_INS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

const SEEDED = `${FIXTURE_SQL}\n${STAY_FIXTURE_SQL}`;
const asStaff = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;
const asGuest = `${SEEDED}\n${loginAsSql(TEST_AUTH_USERS.guest.id)}\nSET ROLE authenticated;`;

/** ビューの窓（`current_date` 起点）の内側にある日。過去日・181日先は窓の外で行が返らない。 */
const TARGET_DATE = "current_date + 10";
const NEXT_DATE = "current_date + 11";

describeDb("残枠ビューの形（完了条件1 ／ v13 §5.2.5① 算出式）", () => {
  test("ある日付について宿泊形態6種ぶんの行が返る（日付 × 宿泊形態の粒度である）", () => {
    const rows = query(`
      ${asStaff}
      SELECT count(*)::text FROM public.v_room_availability WHERE date = ${TARGET_DATE};
    `);
    expect(rows).toBe("6");
  });

  test("各行が total・occupied・available を値として持つ（NULL を返さない）", () => {
    const nulls = query(`
      ${asStaff}
      SELECT count(*)::text FROM public.v_room_availability
      WHERE total IS NULL OR occupied IS NULL OR available IS NULL;
    `);
    expect(nulls).toBe("0");
  });
});

describeDb("占有量の算出元（完了条件2 ／ v13 §9 #47）", () => {
  // 旧設計は `room_assignments` の件数から数えており、自動確定した予約が残枠を
  // 1つも減らさなかった（DB物理設計 §3-12 の important）。算出元が戻っていないことを見る。
  test("ビュー定義が check_ins を参照する", () => {
    const definition = query("SELECT pg_get_viewdef('public.v_room_availability'::regclass);");
    expect(definition).toContain("check_ins");
  });

  test("ビュー定義が room_assignments を参照しない", () => {
    const definition = query("SELECT pg_get_viewdef('public.v_room_availability'::regclass);");
    expect(definition).not.toContain("room_assignments");
  });
});

describeDb("人数枠型の数え方（完了条件3 ／ v13 §5.2.5① の warning）", () => {
  test("ドミトリーの occupied は予約人数の合計になる（大人2名＋子供1名で3）", () => {
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins
        (member_id, room_type, check_in_date, check_out_date, adults_count, children_count)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'dormitory', ${TARGET_DATE}, ${NEXT_DATE}, 2, 1);
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'dormitory' AND date = ${TARGET_DATE};
    `);
    expect(occupied).toBe("3");
  });

  test("車中泊の分母は確定表どおり 30 である", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'car';
    `);
    expect(total).toBe("30");
  });
});

describeDb("棟貸型の数え方（完了条件4 ／ v13 §5.2.5① の warning）", () => {
  test("コテージの occupied は占有棟数になる（1名の予約1件で1棟）", () => {
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins
        (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'cottage', ${TARGET_DATE}, ${NEXT_DATE}, 1);
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'cottage' AND date = ${TARGET_DATE};
    `);
    expect(occupied).toBe("1");
  });

  test("1棟あたり定員2名を超える3名の予約は2棟を消費する", () => {
    const occupied = query(`
      ${asStaff}
      INSERT INTO public.check_ins
        (member_id, room_type, check_in_date, check_out_date, adults_count)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'cottage', ${TARGET_DATE}, ${NEXT_DATE}, 3);
      SELECT occupied::text FROM public.v_room_availability
      WHERE room_type = 'cottage' AND date = ${TARGET_DATE};
    `);
    expect(occupied).toBe("2");
  });

  test("アースバッグの分母は1棟である", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'earthbag';
    `);
    expect(total).toBe("1");
  });

  test("サロンの分母は1室である", () => {
    const total = query(`
      ${asStaff}
      SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'salon';
    `);
    expect(total).toBe("1");
  });
});

describeDb("分母からの除外（完了条件6 ／ v13 §5.2.5① 除外条件・§5.2.1）", () => {
  // どの行を落とすかを主キー名に依存させないため ctid で1行だけ選ぶ。
  const disableOneCottage = (status: string) => `
    UPDATE public.rooms SET status = '${status}'
    WHERE ctid = (SELECT ctid FROM public.rooms WHERE room_type = 'cottage' LIMIT 1);
  `;

  // 部屋台帳の更新は運営操作（v13 §5.2.1）なので、ロールを切り替える前に流す。
  const totalOfCottageAfter = (status: string) => `
    ${SEEDED}
    ${disableOneCottage(status)}
    ${loginAsSql(TEST_AUTH_USERS.admin.id)}
    SET ROLE authenticated;
    SELECT DISTINCT total::text FROM public.v_room_availability WHERE room_type = 'cottage';
  `;

  test("メンテナンス中の部屋は total に数えない（3棟のうち1棟を外すと2棟になる）", () => {
    expect(query(totalOfCottageAfter("メンテナンス中"))).toBe("2");
  });

  test("利用停止の部屋は total に数えない", () => {
    expect(query(totalOfCottageAfter("利用停止"))).toBe("2");
  });
});

describeDb("occupied に数える状態（完了条件8 ／ v13 §5.2.5① 有効な予約）", () => {
  const insertDormitoryWith = (status: string) => `
    INSERT INTO public.check_ins
      (member_id, room_type, check_in_date, check_out_date, adults_count, status)
    VALUES ('${TEST_MEMBERS.self.memberId}', 'dormitory', ${TARGET_DATE}, ${NEXT_DATE}, 4, '${status}');
  `;
  const occupiedOnTargetDate = `
    SELECT occupied::text FROM public.v_room_availability
    WHERE room_type = 'dormitory' AND date = ${TARGET_DATE};
  `;

  test.each(["pre_registered", "confirmed", "staying"])(
    "%s の予約は occupied に数える",
    (status) => {
      const occupied = query(`${asStaff}\n${insertDormitoryWith(status)}\n${occupiedOnTargetDate}`);
      expect(occupied).toBe("4");
    },
  );

  test("checked_out の予約は occupied に数えない（滞在が終わった枠を空けないと二重に埋まる）", () => {
    const occupied = query(`${asStaff}\n${insertDormitoryWith("checked_out")}\n${occupiedOnTargetDate}`);
    expect(occupied).toBe("0");
  });
});

describeDb("残枠を保存しない（完了条件10 ／ v13 §5.2.5① の warning・§9 #25）", () => {
  test("残枠を保持する列がどのテーブルにも無い", () => {
    // 加減算方式へ戻す改変（`rooms.available_count` 等の追加）を検出する。
    const columns = query(`
      SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name LIKE '%available%' OR column_name LIKE '%remaining%' OR column_name LIKE '%vacanc%')
        AND table_name IN ('rooms', 'accommodation_types', 'check_ins', 'room_assignments');
    `);
    expect(columns).toBe("0");
  });

  test("残枠をキャッシュするマテリアライズドビューが存在しない", () => {
    const matviews = query(`
      SELECT count(*)::text FROM pg_matviews
      WHERE schemaname = 'public' AND matviewname LIKE '%availability%';
    `);
    expect(matviews).toBe("0");
  });
});

describeDb("ビューに個人を載せない（完了条件13 ／ DB物理設計 L874・L1322）", () => {
  test("集計に要る列以外を1つも持たない（member_id・氏名・備考を足させない）", () => {
    const extras = query(`
      SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v_room_availability'
        AND column_name NOT IN ('date', 'room_type', 'allocation_mode', 'total', 'occupied', 'available');
    `);
    expect(extras).toBe("0");
  });
});

describeDb("本人向けカレンダーの元データ（完了条件17 ／ v13 §6「自身の宿泊予定・履歴カレンダー＝全ロール〇」）", () => {
  const guestStay = `
    INSERT INTO public.check_ins
      (member_id, room_type, check_in_date, check_out_date, adults_count)
    VALUES ('${TEST_MEMBERS.guest.memberId}', 'dormitory', ${TARGET_DATE}, ${NEXT_DATE}, 1);
  `;

  test("許可側: ゲストロールの利用者も自分の滞在を SELECT できる", () => {
    const rows = query(`
      ${SEEDED}
      ${guestStay}
      ${loginAsSql(TEST_AUTH_USERS.guest.id)}
      SET ROLE authenticated;
      SELECT count(*)::text FROM public.check_ins
      WHERE member_id = '${TEST_MEMBERS.guest.memberId}';
    `);
    expect(rows).toBe("1");
  });

  test("拒否側: ゲストロールの利用者に他人の滞在は1件も見えない", () => {
    const rows = query(`
      ${asGuest}
      SELECT count(*)::text FROM public.check_ins
      WHERE checkin_id = '${TEST_CHECK_INS.selfStay.checkinId}';
    `);
    expect(rows).toBe("0");
  });
});
