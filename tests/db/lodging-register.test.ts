// WBS 2-4（Issue #58）宿泊者名簿 `lodging_register_entries` の受入テスト。
//
// 根拠: 正本 v13 §5.2（宿泊法対応の収集項目）・v13 §7「★ 宿泊者名簿」（専用テーブル／スナップショット／
//       ON DELETE SET NULL／3年保存が匿名化に優先）、v13 §2（認可は role・member_type は立場）、
//       DB物理設計.md §3-13②③④（DDL・退会時のふるまい・保存期限）・§6-1 表 No.32（PII-A の読み書き）・
//       §6-6①（anon の権限ゼロ化）・§6-7（RLS 有効化）・§6-8④⑤（テスト役6種と「対で書く」規律）。
//
// ⚠️ フィクスチャは自作のみ。氏名・住所・前泊地はすべて架空であり、
//    実在の会員データを参照・加工・匿名化したものではない（CLAUDE.md §3.2・§7.1）。
//
// ⚠️ このテーブルは本リポジトリで最も保護区分の高い PII-A である。
//    許可側だけを書くと「見えすぎる実装」が緑になるため、全ポリシーを許可／拒否の対で書く（§6-8⑤）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describeDb, query, queryRows, runSql, sqlstateOf } from "./helpers/psql";
import {
  checkInInsertSql,
  FIXTURE_SQL,
  loginAsSql,
  TEST_AUTH_USERS,
  TEST_CHECK_INS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

const TABLE = "public.lodging_register_entries";

const SELF = TEST_MEMBERS.self;
const ADMIN = TEST_MEMBERS.admin;
const CORE = TEST_MEMBERS.core;
const OYAKATA = TEST_MEMBERS.oyakata;

/**
 * `oyakata` の滞在（`TEST_CHECK_INS.otherStay`）を指す。FK 制約を満たす実在の checkin_id。
 *
 * ⚠️ **`selfStay`（`self` の滞在）を指してはならない。** 本ファイルは「`self` 会員を物理削除しても
 * 名簿行は残る」ことを検証するために `DELETE FROM members WHERE member_id = SELF.memberId` を
 * 複数回実行する。`checkin_id` が `self` の滞在を指していると、`check_ins.member_id` の FK
 * （`members` への参照。`ON DELETE` 句なし＝デフォルト RESTRICT）が先に違反し、
 * 名簿とは無関係な理由（23503）で会員削除そのものが失敗する。`oyakata` はこのファイルで
 * 一度も物理削除されないため、`otherStay` を指せば名簿の FK 検証と会員削除の両方が両立する。
 */
const ANY_CHECK_IN = TEST_CHECK_INS.otherStay.checkinId;

/**
 * 会員フィクスチャ ＋ `otherStay`（`oyakata` の滞在）**だけ**。
 *
 * ⚠️ **`STAY_FIXTURE_SQL`（`fixtures.ts` の既定セット）を使ってはならない。** それは
 * `selfStay`（`self` の滞在）も無条件に投入するため、`checkin_id` の参照先を `otherStay` へ
 * 変えても `self` は依然として `check_ins` から参照された状態になり、`self` の物理削除が
 * `check_ins_member_id_fkey` で失敗し続ける（`ANY_CHECK_IN` の参照先とは独立に発生する）。
 * 本ファイルが必要とするのは FK を満たす実在の `checkin_id` 1件のみであり、
 * `self` を参照する滞在行を1つも作らないことが要件である。
 */
const SETUP_SQL = FIXTURE_SQL + "\n" + checkInInsertSql(TEST_CHECK_INS.otherStay);

const ENTRY_ID = "dddddddd-0000-4000-8000-00000000e001";

/** 宿泊日。3年後の保存期限が一意に決まるよう固定値にする（うるう年をまたがない日を選ぶ）。 */
const CHECKED_IN_ON = "2026-09-19";
const CHECKED_OUT_ON = "2026-09-21";

/** 架空の宿泊者。§6-8④ の指定どおり氏名はダミー、住所は実在しない地名で組む。 */
const SYNTHETIC = {
  fullName: "テスト 太郎",
  fullNameKana: "テスト タロウ",
  address: "テスト県テスト市テスト町1-2-3",
  previousLocation: "テスト県前泊市",
  nextDestination: "テスト県後泊市",
};

/** §3-13② の列表。 */
const COLUMNS = [
  "entry_id",
  "checkin_id",
  "member_id",
  "full_name_snapshot",
  "full_name_kana_snapshot",
  "address_snapshot",
  "previous_location",
  "next_destination",
  "checked_in_on",
  "checked_out_on",
  "is_representative",
  "recorded_by",
  "recorded_at",
  "source",
  "retention_until_on",
  "created_at",
  "updated_at",
];

/**
 * §3-13② が `NOT NULL` を付けている8列 ＋ 主キー `entry_id`（PK は暗黙に NOT NULL）。
 * 生成列 `retention_until_on` は `NOT NULL` を宣言していないため含まない。
 */
const NOT_NULL_COLUMNS = [
  "entry_id",
  "full_name_snapshot",
  "address_snapshot",
  "checked_in_on",
  "is_representative",
  "recorded_at",
  "source",
  "created_at",
  "updated_at",
];

/** v13 §7 が列挙する記録経路の4値。 */
const SOURCES = ["checkin", "web_public", "staff_manual", "migration"];

/** §3-13② の索引3本。 */
const INDEXES = [
  "ix_lodging_register_member",
  "ix_lodging_register_period",
  "ix_lodging_register_retention",
];

function quoted(value: string | null): string {
  return value === null ? "NULL" : `'${value}'`;
}

type EntryOptions = {
  entryId?: string;
  memberId?: string | null;
  fullName?: string;
  address?: string;
  checkedInOn?: string;
  checkedOutOn?: string | null;
  isRepresentative?: boolean;
  recordedBy?: string | null;
  source?: string;
};

/** 名簿1行を投入する SQL。既定は「`self` 会員の代表者・滞在中」の行。 */
function insertEntrySql(options: EntryOptions = {}): string {
  const {
    entryId = ENTRY_ID,
    memberId = SELF.memberId,
    fullName = SYNTHETIC.fullName,
    address = SYNTHETIC.address,
    checkedInOn = CHECKED_IN_ON,
    checkedOutOn = null,
    isRepresentative = true,
    recordedBy = ADMIN.memberId,
    source = "checkin",
  } = options;

  return `
    INSERT INTO ${TABLE}
      (entry_id, checkin_id, member_id, full_name_snapshot, full_name_kana_snapshot,
       address_snapshot, previous_location, next_destination,
       checked_in_on, checked_out_on, is_representative, recorded_by, source)
    VALUES ('${entryId}', '${ANY_CHECK_IN}', ${quoted(memberId)},
            '${fullName}', '${SYNTHETIC.fullNameKana}',
            '${address}', '${SYNTHETIC.previousLocation}', '${SYNTHETIC.nextDestination}',
            DATE '${checkedInOn}', ${checkedOutOn === null ? "NULL" : `DATE '${checkedOutOn}'`},
            ${isRepresentative}, ${quoted(recordedBy)}, '${source}');
  `;
}

/** 指定した Auth アカウントで `authenticated` としてログインした状態を作る。 */
function loginAs(authUserId: string): string {
  return `${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

// ───────────────────────────────────────────
// 完了条件1: §3-13② の DDL どおりに作成される
// ───────────────────────────────────────────

describeDb("lodging_register_entries の DDL（完了条件1 ／ DB物理設計 §3-13②）", () => {
  test("列構成が §3-13② の DDL と一致する", () => {
    const columns = queryRows(`
      SELECT a.attname
      FROM   pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass
        AND  a.attnum > 0
        AND  NOT a.attisdropped
      ORDER  BY a.attname COLLATE "C";
    `);
    expect(columns).toEqual([...COLUMNS].sort());
  });

  test("NOT NULL の列が §3-13② の指定と一致する", () => {
    const notNullColumns = queryRows(`
      SELECT a.attname
      FROM   pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass
        AND  a.attnum > 0
        AND  NOT a.attisdropped
        AND  a.attnotnull
      ORDER  BY a.attname COLLATE "C";
    `);
    expect(notNullColumns).toEqual([...NOT_NULL_COLUMNS].sort());
  });

  test("entry_id の既定値が gen_random_uuid() である（§1-6）", () => {
    const defaultExpression = query(`
      SELECT pg_get_expr(d.adbin, d.adrelid)
      FROM   pg_attrdef d
      JOIN   pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE  d.adrelid = '${TABLE}'::regclass AND a.attname = 'entry_id';
    `);
    expect(defaultExpression).toBe("gen_random_uuid()");
  });

  test("source の既定値が 'checkin' である", () => {
    const source = query(`
      ${SETUP_SQL}
      INSERT INTO ${TABLE} (full_name_snapshot, address_snapshot, checked_in_on)
      VALUES ('${SYNTHETIC.fullName}', '${SYNTHETIC.address}', DATE '${CHECKED_IN_ON}');
      SELECT source FROM ${TABLE};
    `);
    expect(source).toBe("checkin");
  });

  test("is_representative の既定値が true である（false = 同伴者）", () => {
    const isRepresentative = query(`
      ${SETUP_SQL}
      INSERT INTO ${TABLE} (full_name_snapshot, address_snapshot, checked_in_on)
      VALUES ('${SYNTHETIC.fullName}', '${SYNTHETIC.address}', DATE '${CHECKED_IN_ON}');
      SELECT is_representative::text FROM ${TABLE};
    `);
    expect(isRepresentative).toBe("true");
  });

  test("同伴者の行（is_representative = false）を作れる（§3-13②）", () => {
    // `check_ins` は人数しか持たないため、同伴者ひとりひとりの記録先は本表しかない（§3-13①）
    const companions = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ entryId: ENTRY_ID, isRepresentative: true })}
      ${insertEntrySql({
        entryId: "dddddddd-0000-4000-8000-00000000e002",
        memberId: null,
        fullName: "テスト 花子",
        isRepresentative: false,
      })}
      SELECT count(*) FROM ${TABLE} WHERE is_representative = false;
    `);
    expect(companions).toBe("1");
  });

  test("索引3本が §3-13② のとおり作成されている", () => {
    const indexes = queryRows(`
      SELECT c.relname
      FROM   pg_index i
      JOIN   pg_class c ON c.oid = i.indexrelid
      WHERE  i.indrelid = '${TABLE}'::regclass
        AND  c.relname LIKE 'ix_lodging_register%'
      ORDER  BY c.relname COLLATE "C";
    `);
    expect(indexes).toEqual([...INDEXES].sort());
  });

  test("ix_lodging_register_member が member_id IS NOT NULL の部分索引である", () => {
    // 退会・削除で NULL になった行まで索引に載せない（§3-13② の WHERE 句）
    const isPartial = query(`
      SELECT (i.indpred IS NOT NULL)::text
      FROM   pg_index i
      JOIN   pg_class c ON c.oid = i.indexrelid
      WHERE  i.indrelid = '${TABLE}'::regclass AND c.relname = 'ix_lodging_register_member';
    `);
    expect(isPartial).toBe("true");
  });

  test("テーブルコメントが付いている（§3-13② の COMMENT）", () => {
    const comment = query(`
      SELECT coalesce(obj_description('${TABLE}'::regclass, 'pg_class'), '');
    `);
    expect(comment).not.toBe("");
  });

  test("address_snapshot の列コメントが member_profiles_private の参照禁止を述べている", () => {
    // コメントが「なぜスナップショットなのか」を運ぶ。ここが空だと、
    // 後任が善意で JOIN へ書き換える（＝法定記録の遡及改変）ことを止められない（CLAUDE.md §4.3）
    const comment = query(`
      SELECT coalesce(col_description('${TABLE}'::regclass, a.attnum), '')
      FROM   pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass AND a.attname = 'address_snapshot';
    `);
    expect(comment).toContain("member_profiles_private");
  });
});

describeDb("chk_stay_period（完了条件1 ／ §3-13②）", () => {
  test("チェックアウト日がチェックイン日より前の行は 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${insertEntrySql({ checkedInOn: CHECKED_IN_ON, checkedOutOn: "2026-09-18" })}
    `);
    expect(sqlstate).toBe("23514");
  });

  test("チェックアウト日とチェックイン日が同日の行は INSERT できる（境界値：同日は許可）", () => {
    const result = runSql(`
      ${SETUP_SQL}
      ${insertEntrySql({ checkedInOn: CHECKED_IN_ON, checkedOutOn: CHECKED_IN_ON })}
    `);
    expect(result.ok).toBe(true);
  });

  test("チェックアウト日が NULL の行（滞在中）は INSERT できる", () => {
    const result = runSql(`${SETUP_SQL}\n${insertEntrySql({ checkedOutOn: null })}`);
    expect(result.ok).toBe(true);
  });
});

describeDb("source の値域（完了条件1 ／ v13 §7 の4値）", () => {
  test("checkin / web_public / staff_manual / migration の4値は INSERT できる", () => {
    const result = runSql(`
      ${SETUP_SQL}
      INSERT INTO ${TABLE} (full_name_snapshot, address_snapshot, checked_in_on, source)
      SELECT '${SYNTHETIC.fullName}', '${SYNTHETIC.address}', DATE '${CHECKED_IN_ON}', source_value
      FROM   unnest(ARRAY['${SOURCES.join("', '")}']) AS source_value;
    `);
    expect(result.ok).toBe(true);
  });

  test("4値以外の source は 23514 で拒否される", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${insertEntrySql({ source: "self_report" })}
    `);
    expect(sqlstate).toBe("23514");
  });
});

// ───────────────────────────────────────────
// 完了条件2: 会員行が消えても名簿は残る（当時値のスナップショット）
// ───────────────────────────────────────────

describeDb("会員が消えても名簿は残る（完了条件2 ／ v13 §7 ・ §3-13③）", () => {
  test("member_id の外部キーが members を ON DELETE SET NULL で参照する", () => {
    // `n` = SET NULL。ここが `c`（CASCADE）だと、会員の退会で法定記録が消える（v13 §7）
    const reference = query(`
      SELECT c.confrelid::regclass::text || '/' || c.confdeltype::text
      FROM   pg_constraint c
      WHERE  c.conrelid = '${TABLE}'::regclass
        AND  c.contype = 'f'
        AND  c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = '${TABLE}'::regclass
                                 AND a.attname = 'member_id')]::smallint[];
    `);
    expect(reference).toBe("members/n");
  });

  test("recorded_by の外部キーが members を ON DELETE SET NULL で参照する", () => {
    const reference = query(`
      SELECT c.confrelid::regclass::text || '/' || c.confdeltype::text
      FROM   pg_constraint c
      WHERE  c.conrelid = '${TABLE}'::regclass
        AND  c.contype = 'f'
        AND  c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                               WHERE a.attrelid = '${TABLE}'::regclass
                                 AND a.attname = 'recorded_by')]::smallint[];
    `);
    expect(reference).toBe("members/n");
  });

  test("member_id が NULL を許容する（SET NULL が成立する前提）", () => {
    const notNull = query(`
      SELECT a.attnotnull
      FROM   pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass AND a.attname = 'member_id';
    `);
    expect(notNull).toBe("f");
  });

  test("会員行を物理削除しても名簿行は消えない", () => {
    const remaining = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      DELETE FROM public.members WHERE member_id = '${SELF.memberId}';
      SELECT count(*) FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(remaining).toBe("1");
  });

  test("会員行を物理削除しても氏名スナップショットが残る", () => {
    const fullName = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      DELETE FROM public.members WHERE member_id = '${SELF.memberId}';
      SELECT full_name_snapshot FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(fullName).toBe(SYNTHETIC.fullName);
  });

  test("会員行を物理削除しても住所スナップショットが残る", () => {
    const address = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      DELETE FROM public.members WHERE member_id = '${SELF.memberId}';
      SELECT address_snapshot FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(address).toBe(SYNTHETIC.address);
  });

  test("会員行を物理削除すると member_id だけが NULL になる", () => {
    const memberIdIsNull = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      DELETE FROM public.members WHERE member_id = '${SELF.memberId}';
      SELECT (member_id IS NULL)::text FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(memberIdIsNull).toBe("true");
  });

  test("記録者（recorded_by）の会員行を物理削除しても名簿行は残る", () => {
    const remaining = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ recordedBy: ADMIN.memberId })}
      DELETE FROM public.members WHERE member_id = '${ADMIN.memberId}';
      SELECT count(*) FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}' AND recorded_by IS NULL;
    `);
    expect(remaining).toBe("1");
  });

  test("★ 会員マスタの住所を更新しても address_snapshot は変わらない（遡及改変の禁止）", () => {
    // ここが `member_profiles_private` への参照だと、引っ越した瞬間に3年前の名簿の住所まで変わる（v13 §7）
    const address = query(`
      ${SETUP_SQL}
      INSERT INTO public.member_profiles_private (member_id, full_name, address)
      VALUES ('${SELF.memberId}', '${SYNTHETIC.fullName}', '${SYNTHETIC.address}');
      ${insertEntrySql({ memberId: SELF.memberId, address: SYNTHETIC.address })}
      UPDATE public.member_profiles_private SET address = 'テスト県引越市引越町9-9-9'
      WHERE  member_id = '${SELF.memberId}';
      SELECT address_snapshot FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(address).toBe(SYNTHETIC.address);
  });

  test("名簿から member_profiles_private への外部キーが1本も無い（参照ではなく写しである）", () => {
    const references = query(`
      SELECT count(*)
      FROM   pg_constraint c
      WHERE  c.conrelid = '${TABLE}'::regclass
        AND  c.contype = 'f'
        AND  c.confrelid = 'public.member_profiles_private'::regclass;
    `);
    expect(references).toBe("0");
  });
});

// ───────────────────────────────────────────
// 完了条件3: retention_until_on は自動算出・直接書き込み不可
// ───────────────────────────────────────────

describeDb("retention_until_on（完了条件3 ／ §3-13②④ ・ v13 §7 の3年保存）", () => {
  test("retention_until_on が STORED の生成列である", () => {
    const generated = query(`
      SELECT a.attgenerated
      FROM   pg_attribute a
      WHERE  a.attrelid = '${TABLE}'::regclass AND a.attname = 'retention_until_on';
    `);
    expect(generated).toBe("s");
  });

  test("滞在中（checked_out_on が NULL）はチェックイン日の3年後になる", () => {
    const retention = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ checkedInOn: CHECKED_IN_ON, checkedOutOn: null })}
      SELECT retention_until_on::text FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(retention).toBe("2029-09-19");
  });

  test("チェックアウト済みならチェックアウト日の3年後になる", () => {
    const retention = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ checkedInOn: CHECKED_IN_ON, checkedOutOn: CHECKED_OUT_ON })}
      SELECT retention_until_on::text FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(retention).toBe("2029-09-21");
  });

  test("チェックアウト日を後から入れると保存期限が追随する", () => {
    const retention = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ checkedInOn: CHECKED_IN_ON, checkedOutOn: null })}
      UPDATE ${TABLE} SET checked_out_on = DATE '${CHECKED_OUT_ON}' WHERE entry_id = '${ENTRY_ID}';
      SELECT retention_until_on::text FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(retention).toBe("2029-09-21");
  });

  test("INSERT で retention_until_on を直接指定できない（428C9）", () => {
    // 保存期限を短く詐称できると、3年保存義務が書き込み側の裁量になる
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      INSERT INTO ${TABLE}
        (full_name_snapshot, address_snapshot, checked_in_on, retention_until_on)
      VALUES ('${SYNTHETIC.fullName}', '${SYNTHETIC.address}',
              DATE '${CHECKED_IN_ON}', DATE '2026-10-01');
    `);
    expect(sqlstate).toBe("428C9");
  });

  test("UPDATE で retention_until_on を直接書き換えられない（428C9）", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${insertEntrySql()}
      UPDATE ${TABLE} SET retention_until_on = DATE '2026-10-01' WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(sqlstate).toBe("428C9");
  });
});

// ───────────────────────────────────────────
// 完了条件4: RLS（SELECT は本人＋staff、書き込みは staff、DELETE 全拒否、anon はゼロ）
// ───────────────────────────────────────────

describeDb("RLS の有効化（完了条件4 ／ §6-7 ・ §1-8）", () => {
  test("lodging_register_entries で RLS が有効である", () => {
    // 無効なら「GRANT の範囲でインターネットへ全開」になる（§1-8）
    const enabled = query(`
      SELECT c.relrowsecurity::text FROM pg_class c WHERE c.oid = '${TABLE}'::regclass;
    `);
    expect(enabled).toBe("true");
  });

  test("★ ポリシー条件に member_type が1つも現れない（v13 §2 ／ §6-1 の note）", () => {
    // 認可は role のみで判定する。ここに member_type が入ると、立場と権限の分離が崩れる
    const policies = queryRows(`
      SELECT p.policyname
      FROM   pg_policies p
      WHERE  p.schemaname = 'public'
        AND  p.tablename = 'lodging_register_entries'
        AND  (coalesce(p.qual, '') LIKE '%member_type%'
              OR coalesce(p.with_check, '') LIKE '%member_type%')
      ORDER  BY p.policyname COLLATE "C";
    `);
    expect(policies).toEqual([]);
  });
});

describeDb("RLS：SELECT は本人の行 ＋ admin/core_member（完了条件4 ／ §6-1 表 No.32）", () => {
  test("本人は自分の名簿行を SELECT できる", () => {
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("1");
  });

  test("一般会員は他人の名簿行を1行も取得できない（エラーではなく0行）", () => {
    // エラーで返すと「その人が泊まったこと」自体が漏れる。0行が正しい（§6-8⑤）
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: ADMIN.memberId })}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("0");
  });

  test("admin は他人の名簿行を SELECT できる（法定出力のため）", () => {
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.admin.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("1");
  });

  test("core_member は他人の名簿行を SELECT できる", () => {
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.core.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("1");
  });

  test("★ member_type が親方の一般会員でも他人の名簿行は1行も取得できない（v13 §2）", () => {
    // 立場（member_type）ではなく権限（role）で判定していることの反証テスト
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.oyakata.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("0");
  });

  test("member_id が NULL の行（退会者・同伴者）は一般会員から見えない", () => {
    // 「持ち主のいない行」が誰にでも見えると、氏名・住所が全会員へ開く
    const rows = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: null })}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM ${TABLE};
    `);
    expect(rows).toBe("0");
  });
});

describeDb("RLS：書き込みは staff のみ（完了条件4 ／ §6-1 表 No.32）", () => {
  test("admin は名簿行を INSERT できる", () => {
    const rows = query(`
      ${SETUP_SQL}
      ${loginAs(TEST_AUTH_USERS.admin.id)}
      ${insertEntrySql({ memberId: SELF.memberId })}
      SELECT count(*) FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("core_member は名簿行を INSERT できる（現地チェックインの記録者）", () => {
    const rows = query(`
      ${SETUP_SQL}
      ${loginAs(TEST_AUTH_USERS.core.id)}
      ${insertEntrySql({ memberId: SELF.memberId, recordedBy: CORE.memberId })}
      SELECT count(*) FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("一般会員は自分の名簿行であっても INSERT できない（42501）", () => {
    // 自己申告で名簿を作れると、法定名簿が「本人の言い値」になる（書き込みは staff ／ §3-13⑤）
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      ${insertEntrySql({ memberId: SELF.memberId, recordedBy: null })}
    `);
    expect(sqlstate).toBe("42501");
  });

  test("member_type が親方の一般会員も名簿行を INSERT できない（42501）", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${loginAs(TEST_AUTH_USERS.oyakata.id)}
      ${insertEntrySql({ memberId: OYAKATA.memberId, recordedBy: null })}
    `);
    expect(sqlstate).toBe("42501");
  });

  test("admin は名簿行を UPDATE できる（誤記の訂正）", () => {
    const nextDestination = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.admin.id)}
      UPDATE ${TABLE} SET next_destination = 'テスト県訂正市' WHERE entry_id = '${ENTRY_ID}';
      SELECT next_destination FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(nextDestination).toBe("テスト県訂正市");
  });

  test("本人は自分の名簿行を UPDATE しても更新行数が0になる（法定記録の自己改変を許さない）", () => {
    const affected = query(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      WITH changed AS (
        UPDATE ${TABLE} SET address_snapshot = 'テスト県改ざん市'
        WHERE entry_id = '${ENTRY_ID}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `);
    expect(affected).toBe("0");
  });
});

describeDb("RLS：DELETE は全拒否（完了条件4 ／ §1-3 ・ §3-13③）", () => {
  test("admin でも名簿行を DELETE できない（42501）", () => {
    // 3年経過分の削除は `retention_until_on < current_date` の定期ジョブ（service_role）だけが行う
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.admin.id)}
      DELETE FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(sqlstate).toBe("42501");
  });

  test("一般会員も名簿行を DELETE できない（42501）", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      ${insertEntrySql({ memberId: SELF.memberId })}
      ${loginAs(TEST_AUTH_USERS.self.id)}
      DELETE FROM ${TABLE} WHERE entry_id = '${ENTRY_ID}';
    `);
    expect(sqlstate).toBe("42501");
  });
});

describeDb("anon の権限ゼロ化（完了条件4 ／ §6-6①）", () => {
  test("anon は名簿を SELECT できない（0行ではなく権限エラー）", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      SET ROLE anon;
      SELECT count(*) FROM ${TABLE};
    `);
    expect(sqlstate).toBe("42501");
  });

  test("anon は名簿へ INSERT できない", () => {
    const sqlstate = sqlstateOf(`
      ${SETUP_SQL}
      SET ROLE anon;
      ${insertEntrySql({ memberId: null, recordedBy: null })}
    `);
    expect(sqlstate).toBe("42501");
  });
});

// ───────────────────────────────────────────
// 完了条件5: このテストが CI の db-test ジョブで実行される
// （接続先が無い環境では上の describeDb が skip されるため、ここは DB 非依存で固定する）
// ───────────────────────────────────────────

describe("宿泊者名簿の DB テストが CI で実行される（完了条件5）", () => {
  const REPOSITORY_ROOT = join(__dirname, "..", "..");

  test("本テストが tests/db 配下に置かれている", () => {
    expect(existsSync(join(REPOSITORY_ROOT, "tests/db/lodging-register.test.ts"))).toBe(true);
  });

  test("CI の db-test ジョブが tests/db を実行対象にしている", () => {
    const workflow = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("jest tests/db");
  });
});
