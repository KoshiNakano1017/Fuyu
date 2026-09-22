// WBS `2-7`（ニックネームの必須化 ＆ 親方会員番号の採番 ／ `0029`）の受入テスト。
//
// 根拠: 2026-09-22 オーナー決定（v13 §9 #62 ／ 決定ログ §22-4）
//         ②`nickname` は必須化する（既存370名は設定されるまで会員番号で表示）
//         ⑤親方会員番号の採番方式は**一意であれば何でもよい**（桁数・起点・接頭辞は実装裁量。
//           条件は `legacy_member_no` の `10xxx`／`20xxx` と識別できることだけ）
//       2026-09-10 オーナー決定（両方の番号を持つ会員は街人番号で表示する ／ 決定ログ §16-4）、
//       `会員データモデル_ユーザーテーブル定義.md` §6.2（親方衆 `No.` 1〜44 の移行）、
//       `DB物理設計.md` §6-6b①（採番系は列単位 GRANT の対象外＝会員本人は触れない）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, runSql, sqlstateOf } from "./helpers/psql";

/** 取込由来の会員。ニックネーム未設定を許される側（`0029` の CHECK）。 */
const IMPORTED_FROM = "テスト用取込（架空）";

function insertMember(columns: string, values: string): string {
  return `INSERT INTO public.members (member_type, role, account_status, ${columns})
          VALUES ('親方', 'member', 'pre_registered', ${values});`;
}

describeDb("members.oyakata_member_no（親方会員番号 ／ 0029）", () => {
  test("OYA- ＋ 3桁ゼロ埋めの番号は INSERT できる", () => {
    const result = runSql(
      insertMember("oyakata_member_no, imported_from", `'OYA-001', '${IMPORTED_FROM}'`),
    );
    expect(result.ok).toBe(true);
  });

  test("桁が足りない番号は 23514 で拒否される", () => {
    // `OYA-9` を許すと、文字列順の並べ替えで `OYA-10` より後ろへ来る。
    const sqlstate = sqlstateOf(
      insertMember("oyakata_member_no, imported_from", `'OYA-9', '${IMPORTED_FROM}'`),
    );
    expect(sqlstate).toBe("23514");
  });

  test("★ 接頭辞の無い番号は 23514 で拒否される（街人番号と識別できることが唯一の条件）", () => {
    // オーナー決定⑤が課した条件は「`10xxx`／`20xxx` と識別できること」だけである。
    // 接頭辞を外せる実装にすると、その唯一の条件が破れる。
    const sqlstate = sqlstateOf(
      insertMember("oyakata_member_no, imported_from", `'10234', '${IMPORTED_FROM}'`),
    );
    expect(sqlstate).toBe("23514");
  });

  test("同じ親方会員番号を2人に付けると 23505 で拒否される（一意性＝決定⑤の条件）", () => {
    const sqlstate = sqlstateOf(`
      ${insertMember("oyakata_member_no, imported_from", `'OYA-777', '${IMPORTED_FROM}'`)}
      ${insertMember("oyakata_member_no, imported_from", `'OYA-777', '${IMPORTED_FROM}'`)}
    `);
    expect(sqlstate).toBe("23505");
  });

  test("★ 街人番号と親方会員番号は同じ行に共存できる（親方兼街人 ／ v13 §9 #26）", () => {
    // ここが通らないと 2026-09-10 決定（両方を持つ会員は街人番号で表示）が実装不能になる。
    // 接頭辞1列方式を採らなかった理由そのものを固定する試験である。
    const result = runSql(
      insertMember(
        "legacy_member_no, oyakata_member_no, imported_from",
        `'T-0500', 'OYA-500', '${IMPORTED_FROM}'`,
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describeDb("next_oyakata_member_no()（採番 ／ 0029）", () => {
  test("採番の起点は 45（1〜44 は移行の予約枠 ／ 会員データモデル §6.2）", () => {
    // 親方衆リストの `No.` 1〜44 をそのまま親方会員番号にするため、
    // 連番の起点が 45 でなければ移行データと衝突する。
    //
    // ⚠️ `nextval()` の結果で検査しない。シーケンスの進みは ROLLBACK で戻らないため、
    //    絶対値を期待すると2回目のテスト実行で落ちる（試験が自分の副作用で壊れる）。
    const startValue = query(`
      SELECT start_value FROM pg_sequences
      WHERE  schemaname = 'public' AND sequencename = 'seq_oyakata_member_no';
    `);
    expect(startValue).toBe("45");
  });

  test("払い出す形式は OYA- ＋ 3桁で、呼ぶたびに1つ進む", () => {
    const numbers = query(`
      SELECT public.next_oyakata_member_no()
      UNION ALL SELECT public.next_oyakata_member_no();
    `).split("\n");

    expect(numbers.every((number) => /^OYA-\d{3}$/.test(number))).toBe(true);

    // 差の絶対値で見る。`UNION ALL` は行の並びを保証しないため、順序に依存させない。
    const [first, second] = numbers.map((number) => Number(number.slice("OYA-".length)));
    expect(Math.abs(second - first)).toBe(1);
  });

  test("会員本人（authenticated）は採番関数を実行できない（§6-6b①）", () => {
    const sqlstate = sqlstateOf(`
      SET LOCAL ROLE authenticated;
      SELECT public.next_oyakata_member_no();
    `);
    expect(sqlstate).toBe("42501");
  });
});

describeDb("members.nickname（0029 ／ v13 §9 #62）", () => {
  test("取込由来の会員はニックネーム未設定でも INSERT できる（移行370名 ／ §6.2）", () => {
    // §5.2c が「本名を初期値に入れてはならない」と定めるため、移行時に埋める値が無い。
    // オーナー決定も「設定されるまでの間だけ会員番号で表示する」と未設定を許している。
    const result = runSql(insertMember("imported_from", `'${IMPORTED_FROM}'`));
    expect(result.ok).toBe(true);
  });

  test("ニックネームを持たない会員はサーバ側から作れる（必須化は DB で縛らない）", () => {
    // ★ 初版は「取込由来でない会員は nickname 必須」の CHECK を置いていたが、
    //    `imported_from` を「アプリ経由で作られたか」の代理にすると、
    //    サーバ側で表示名を持たない会員行を正当に作る経路（k匿名コホートの試験など）を
    //    巻き添えで落とすことが CI で判明したため外した。
    //    オーナー決定が求めるのは**本登録フォームでの必須入力**（WBS 12-1）である。
    const result = runSql(insertMember("nickname", "NULL"));
    expect(result.ok).toBe(true);
  });

  test("★ 空白だけのニックネームは 23514 で拒否される（0029 以降は保存できない）", () => {
    // 「未設定」と「設定済み」の境界を壊す値。以前はビュー側の NULLIF(btrim(...)) だけが
    // 受け止めており、保存自体は通っていた（`member-display-name` の旧フィクスチャ）。
    const sqlstate = sqlstateOf(insertMember("nickname", "'   '"));
    expect(sqlstate).toBe("23514");
  });

  test("ニックネームがあればアプリからの登録は通る", () => {
    const result = runSql(insertMember("nickname", "'テスト親方'"));
    expect(result.ok).toBe(true);
  });
});
