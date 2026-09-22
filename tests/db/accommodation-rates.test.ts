// WBS 3-9（宿泊料金マスタ）の受入テスト。Issue #106。
//
// 根拠: v13 §5.4.2②（適用期間付きの履歴／操作権限は管理者のみ）、
//       `DB物理設計.md` §3-10 と同節の [!danger]（旧名称の CHECK を実装してはならない）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS } from "./helpers/fixtures";

const asAdmin = `${FIXTURE_SQL}\n${loginAsSql(TEST_AUTH_USERS.admin.id)}\nSET ROLE authenticated;`;
const asMember = `${FIXTURE_SQL}\n${loginAsSql(TEST_AUTH_USERS.self.id)}\nSET ROLE authenticated;`;

/** 料金を1行入れる SQL。`room_type` は `accommodation_types` に実在する値を使う。 */
function insertRate(options: {
  roomType?: string;
  category?: string;
  from: string;
  until: string | null;
  priceYen?: number;
}): string {
  const until = options.until === null ? "NULL" : `'${options.until}'`;
  return `INSERT INTO public.accommodation_rates
            (room_type, member_category, price_per_night_yen, effective_from, effective_until)
          VALUES ('${options.roomType ?? "dormitory"}', '${options.category ?? "member"}',
                  ${options.priceYen ?? 4000}, '${options.from}', ${until});`;
}

describeDb("accommodation_rates のスキーマ（v13 §5.4.2② ／ DB物理設計 §3-10）", () => {
  test("テーブルが存在する", () => {
    expect(query("SELECT to_regclass('public.accommodation_rates') IS NOT NULL;")).toBe("t");
  });

  // ★ DB物理設計 §3-10 の DDL は改称前の名前（`ゲストハウス` 等）を CHECK で列挙しており、
  //   同書自身が「このまま実装してはならない」と警告している。外部キーにすれば
  //   形態の改称が起きても料金マスタ側は追随不要になる。
  test("room_type は accommodation_types への外部キーである", () => {
    const hasFk = query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN   pg_class t  ON t.oid = c.conrelid
        JOIN   pg_class rt ON rt.oid = c.confrelid
        WHERE  t.relname = 'accommodation_rates'
          AND  c.contype = 'f'
          AND  rt.relname = 'accommodation_types'
      );`);
    expect(hasFk).toBe("t");
  });

  test("存在しない宿泊形態の料金は入れられない", () => {
    expect(sqlstateOf(`${asAdmin}\n${insertRate({ roomType: "ゲストハウス", from: "2026-01-01", until: null })}`)).toBe(
      "23503",
    );
  });

  test("負の単価は入れられない", () => {
    expect(
      sqlstateOf(`${asAdmin}\n${insertRate({ from: "2026-01-01", until: null, priceYen: -1 })}`),
    ).toBe("23514");
  });

  test("終了日が開始日より前の行は入れられない", () => {
    expect(
      sqlstateOf(`${asAdmin}\n${insertRate({ from: "2026-02-01", until: "2026-01-31" })}`),
    ).toBe("23514");
  });

  test("会員区分は member / non_member の2値に限られる", () => {
    expect(
      sqlstateOf(`${asAdmin}\n${insertRate({ category: "vip", from: "2026-01-01", until: null })}`),
    ).toBe("23514");
  });
});

describeDb("適用期間の重なりを DB が禁じる（v13 §5.4.2② の履歴管理）", () => {
  // 重なりを許すと「その日の料金」が2行に決まり、どちらで請求したかを後から説明できない。
  test("同じ形態・同じ会員区分で期間が重なる行は入れられない", () => {
    const body = `${asAdmin}
      ${insertRate({ from: "2026-01-01", until: "2026-06-30" })}
      ${insertRate({ from: "2026-06-01", until: "2026-12-31" })}`;
    expect(sqlstateOf(body)).toBe("23P01");
  });

  test("現行行（終了日 NULL）と重なる行も入れられない", () => {
    const body = `${asAdmin}
      ${insertRate({ from: "2026-01-01", until: null })}
      ${insertRate({ from: "2026-06-01", until: "2026-12-31" })}`;
    expect(sqlstateOf(body)).toBe("23P01");
  });

  test("期間が重ならなければ2行入る", () => {
    const body = `${asAdmin}
      ${insertRate({ from: "2026-01-01", until: "2026-06-30" })}
      ${insertRate({ from: "2026-07-01", until: null })}
      SELECT count(*) FROM public.accommodation_rates;`;
    expect(query(body)).toBe("2");
  });

  test("会員区分が違えば同じ期間でも入る", () => {
    const body = `${asAdmin}
      ${insertRate({ category: "member", from: "2026-01-01", until: null })}
      ${insertRate({ category: "non_member", from: "2026-01-01", until: null })}
      SELECT count(*) FROM public.accommodation_rates;`;
    expect(query(body)).toBe("2");
  });
});

describeDb("認可（v13 §5.4.2②「操作権限：管理者のみ」）", () => {
  test("管理者は料金を登録できる", () => {
    expect(sqlstateOf(`${asAdmin}\n${insertRate({ from: "2026-01-01", until: null })}`)).toBeNull();
  });

  // CLAUDE.md §4.4：金額に関わる認可は必ず許可側と拒否側を対で置く。
  test("一般会員は料金を登録できない", () => {
    expect(sqlstateOf(`${asMember}\n${insertRate({ from: "2026-01-01", until: null })}`)).toBe(
      "42501",
    );
  });

  test("一般会員も料金を参照できる（会員・ゲストに見せる情報である）", () => {
    const body = `${asAdmin}
      ${insertRate({ from: "2026-01-01", until: null })}
      ${loginAsSql(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM public.accommodation_rates;`;
    expect(query(body)).toBe("1");
  });

  // 料金は履歴である。消せると過去の予約を当時の料金で再計算できなくなる。
  test("管理者でも料金の行は削除できない", () => {
    const body = `${asAdmin}
      ${insertRate({ from: "2026-01-01", until: null })}
      DELETE FROM public.accommodation_rates;`;
    expect(sqlstateOf(body)).toBe("42501");
  });
});
