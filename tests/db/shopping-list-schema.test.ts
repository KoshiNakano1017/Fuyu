// 買い物リストのスキーマ受入テスト（Issue #147 ／ WBS `5-8` 買い物リスト（ほしいものリスト））。
//
// 固定する完了条件:
//   1 `shopping_list_items` が存在し、v13 §7「★ 買い物リスト」が列挙する項目を列として持つ
//   2 品名だけを与えた INSERT が成功する（品名以外に NOT NULL 制約が無い）
//   3 品名が空文字・空白のみの INSERT は拒否される
//   4 ステータスは5値のみ・未指定時の既定は `希望`
//   5 優先度は3値のみ
//   6 立替実費に相当する列が存在しない
//   7 クエストとの紐付けは品目側の `quest_id` 1列で、中間テーブルを作らない
//   8 `見送り` かつ理由が空の行は INSERT でも UPDATE でも拒否される
//  21 重複候補は自動マージされず、同じ品名でも別の品目として登録できる（DB 側＝一意制約を置かない）
//
// 根拠: v13 §5.12.1（必須は品名のみ）／ §5.12.2（5つのステータス・見送りは理由必須）／
//       §5.12.4（立替実費を扱わない）／ §7（列の一覧・中間テーブルを作らない）。
//
// 拒否の検査は SQLSTATE ではなく `runSql().ok` で見る。値域を CHECK で持つか列挙型で持つかは
// 実装の選び方であり（23514 / 22P02 が変わる）、完了条件が求めているのは「受け付けないこと」である。

import {
  ITEM,
  resolveColumn,
  SHOPPING_FIXTURE_SQL,
  SHOPPING_TABLE,
  SECTION7_COLUMN_CANDIDATES,
  shoppingListColumns,
  valueAfterAttempt,
  AS_ADMIN,
} from "./helpers/shopping-list";
import { TEST_MEMBERS } from "./helpers/fixtures";
import { describeDb, query, queryRows, runSql } from "./helpers/psql";

const QUEST_ID = "00000000-0000-0000-0000-0000000000f9";

describeDb("テーブルと列構成（完了条件1 ／ v13 §7）", () => {
  test("shopping_list_items が存在する", () => {
    expect(query(`SELECT to_regclass('${SHOPPING_TABLE}') IS NOT NULL;`)).toBe("t");
  });

  test.each(Object.keys(SECTION7_COLUMN_CANDIDATES))("§7 の「%s」に相当する列がある", (concept) => {
    // 列名は仕様が固定していないため候補から解決する。解決できなければ例外で落ちる。
    expect(shoppingListColumns()).toContain(resolveColumn(concept));
  });
});

describeDb("必須は品名のみ（完了条件2 ／ v13 §5.12.1）", () => {
  test("品名以外に「既定値も無く NOT NULL」な列が1つも無い", () => {
    // 「気づいた瞬間に30秒で登録できる」ことが要件であり、入力必須が増えた時点で LINE に戻る。
    // 既定値を持つ列（`item_id` の採番や登録日時など）は入力を強いないため対象外にする。
    const required = queryRows(`
      SELECT a.attname
      FROM   pg_attribute a
      LEFT   JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE  a.attrelid = '${SHOPPING_TABLE}'::regclass
        AND  a.attnum > 0
        AND  NOT a.attisdropped
        AND  a.attnotnull
        AND  d.adbin IS NULL
      ORDER  BY a.attname COLLATE "C";
    `);
    expect(required.filter((column) => column !== resolveColumn("品名"))).toEqual([]);
  });

  test("品名と登録者だけを与えた INSERT が成功する", () => {
    // 登録者はセッションから決まる値であり、利用者が入力する項目ではない（§5.12.1 の入力項目表）。
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by)
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}');
    `);
    expect(result.ok).toBe(true);
  });
});

describeDb("品名は空にできない（完了条件3 ／ v13 §5.12.1）", () => {
  const insertNamed = (itemName: string) => `
    ${SHOPPING_FIXTURE_SQL}
    INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by)
    VALUES ('${itemName}', '${TEST_MEMBERS.self.memberId}');
  `;

  test("空文字の品名は拒否される", () => {
    expect(runSql(insertNamed("")).ok).toBe(false);
  });

  test("空白だけの品名は拒否される", () => {
    expect(runSql(insertNamed("   ")).ok).toBe(false);
  });
});

describeDb("ステータスの値域と既定（完了条件4 ／ v13 §5.12.2）", () => {
  test("希望 / 買う / 購入済 は受け付ける", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status)
      SELECT '軍手', '${TEST_MEMBERS.self.memberId}', s
      FROM   unnest(ARRAY['希望', '買う', '購入済']) AS s;
    `);
    expect(result.ok).toBe(true);
  });

  test("クエスト化済 は紐づくクエストを添えれば受け付ける", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO public.quests (quest_id, title, origin_type, execution_mode, created_by)
      VALUES ('${QUEST_ID}', '買い出し（1件）', 'shopping_list', 'remote', '${TEST_MEMBERS.admin.memberId}');
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status, quest_id)
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', 'クエスト化済', '${QUEST_ID}');
    `);
    expect(result.ok).toBe(true);
  });

  test("見送り は理由を添えれば受け付ける", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status, ${resolveColumn("見送り理由")})
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', '見送り', '在庫がまだある');
    `);
    expect(result.ok).toBe(true);
  });

  test("5値以外のステータスは受け付けない", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status)
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', '保留');
    `);
    expect(result.ok).toBe(false);
  });

  test("ステータスを指定しない登録の既定は 希望 である", () => {
    // 「希望」と「買う」を同じ状態にしない（§5.12.2）。登録しただけで買う対象にならないこと。
    expect(
      query(`
        ${SHOPPING_FIXTURE_SQL}
        SELECT status FROM ${SHOPPING_TABLE} WHERE item_id = '${ITEM.itemId}';
      `),
    ).toBe("希望");
  });
});

describeDb("優先度の値域（完了条件5 ／ v13 §7）", () => {
  test("至急 / 通常 / いつでも は受け付ける", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, ${resolveColumn("優先度")})
      SELECT '軍手', '${TEST_MEMBERS.self.memberId}', p
      FROM   unnest(ARRAY['至急', '通常', 'いつでも']) AS p;
    `);
    expect(result.ok).toBe(true);
  });

  test("3値以外の優先度は受け付けない", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, ${resolveColumn("優先度")})
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', '最優先');
    `);
    expect(result.ok).toBe(false);
  });
});

describeDb("立替実費を扱わない（完了条件6 ／ v13 §5.12.4）", () => {
  // 「作らない」と決めたことは後から作れるが、作ってしまったカラムは運用に入ると外せない。
  // 立替の器を買い物リスト側へ生やさないことを、ここで機械的に止める。
  test("advance_ で始まる列が1つも無い", () => {
    expect(shoppingListColumns().filter((column) => column.startsWith("advance"))).toEqual([]);
  });

  test("レシートのメディアを持つ列が1つも無い", () => {
    expect(shoppingListColumns().filter((column) => column.includes("receipt"))).toEqual([]);
  });
});

describeDb("クエストとの紐付けは品目側の1列（完了条件7 ／ v13 §7・§5.12.3）", () => {
  test("quest_id 列がある", () => {
    expect(shoppingListColumns()).toContain("quest_id");
  });

  test("quest_id が quests を参照している", () => {
    // ★ `regclass::text` と文字列を比べない。`public` が search_path にあるかどうかで
    //    `quests` と `public.quests` のどちらが返るかが変わり、環境依存で落ちる
    //    （実際に CI で `Expected: "public.quests" / Received: "quests"` で落ちた）。
    //    OID 同士（`= 'public.quests'::regclass`）で比べれば表記に依存しない。
    const referenced = query(`
      SELECT c.confrelid = 'public.quests'::regclass
      FROM   pg_constraint c
      WHERE  c.conrelid = '${SHOPPING_TABLE}'::regclass
        AND  c.contype = 'f'
        AND  c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = '${SHOPPING_TABLE}'::regclass
                                 AND a.attname = 'quest_id')]::smallint[];
    `);
    expect(referenced).toBe("t");
  });

  test("品目を参照する中間テーブルが1つも無い", () => {
    // 中間テーブルがあると「品目1つにつき1クエスト」を許す形になり、§5.12.3 の多対1が崩れる。
    const referencing = queryRows(`
      SELECT DISTINCT c.conrelid::regclass::text
      FROM   pg_constraint c
      WHERE  c.contype = 'f'
        AND  c.confrelid = '${SHOPPING_TABLE}'::regclass
      ORDER  BY 1;
    `);
    expect(referencing).toEqual([]);
  });
});

describeDb("見送りは理由を必ず伴う（完了条件8 ／ v13 §5.12.2）", () => {
  const skipReason = () => resolveColumn("見送り理由");

  test("理由の無い 見送り は INSERT できない", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status)
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', '見送り');
    `);
    expect(result.ok).toBe(false);
  });

  test("空白だけの理由を付けた 見送り も INSERT できない", () => {
    const result = runSql(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by, status, ${skipReason()})
      VALUES ('軍手', '${TEST_MEMBERS.self.memberId}', '見送り', '   ');
    `);
    expect(result.ok).toBe(false);
  });

  test("理由の無い 見送り への UPDATE は通らず、状態が 希望 のまま残る", () => {
    const statement = `UPDATE ${SHOPPING_TABLE} SET status = '見送り' WHERE item_id = '${ITEM.itemId}';`;
    expect(valueAfterAttempt(AS_ADMIN, statement, "status")).toBe("希望");
  });

  test("空白だけの理由を付けた UPDATE も通らず、状態が 希望 のまま残る", () => {
    const statement = `UPDATE ${SHOPPING_TABLE}
                          SET status = '見送り', ${skipReason()} = '   '
                        WHERE item_id = '${ITEM.itemId}';`;
    expect(valueAfterAttempt(AS_ADMIN, statement, "status")).toBe("希望");
  });
});

describeDb("同じ品名でも別の品目として登録できる（完了条件21 ／ v13 §5.12.1）", () => {
  // 「同じ洗剤」でも容量違いが別物であることが多いため自動マージしない。
  // DB 側でそれを担保するのは「品名に一意制約を置かないこと」である。
  test("品名だけの一意索引が無い", () => {
    const uniqueIndexes = query(`
      SELECT count(*)
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE  i.indrelid = '${SHOPPING_TABLE}'::regclass
        AND  i.indisunique
        AND  i.indnatts = 1
        AND  a.attname = '${resolveColumn("品名")}';
    `);
    expect(uniqueIndexes).toBe("0");
  });

  test("同じ品名の品目を2件登録できる", () => {
    const rows = query(`
      ${SHOPPING_FIXTURE_SQL}
      INSERT INTO ${SHOPPING_TABLE} (item_name, registered_by)
      VALUES ('${ITEM.itemName}', '${TEST_MEMBERS.admin.memberId}');
      SELECT count(*) FROM ${SHOPPING_TABLE} WHERE item_name = '${ITEM.itemName}';
    `);
    expect(rows).toBe("2");
  });
});
