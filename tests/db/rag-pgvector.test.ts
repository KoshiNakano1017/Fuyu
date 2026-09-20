// 0100（pgvector / RAG 基盤）の受入テスト。
//
// 根拠: CONSOLIDATED_DECISIONS.md §17（2026-09-11 オーナー決定「ベクトル基盤を Supabase pgvector へ一本化」）、
//       DB物理設計.md §6-2 / §6-6 / §6-7、CLAUDE.md §4.4（個人情報に関わるロジックは必ずテストを書く）。
//
// なぜ今これが要るか:
//   0100 は 2026-09-11 に追加されて以来、**どの環境でも一度も実行されたことがない**。
//   `.github/workflows/ci.yml` が `supabase start` の直前に 0100 を退避していたため、
//   `CREATE EXTENSION vector` も HNSW 索引も PII ガード関数も構文検査すら通っていなかった。
//   退避の理由（前提テーブル `public.work_categories` 未作成）は 0007（2026-09-19）で解消済みであり、
//   退避ステップは本コミットで撤去した。本ファイルはその撤去とセットで入る「初めての検証」である。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.1・§3.2）。
//
// ⚠️ 0100 本体は `tests/migrations-baseline.test.ts` が 424 行・SQL 文リスト完全一致で
//    不改変を固定している。ここで不足が判明しても 0100 は書き換えず、後続の連番で足すこと。

import { describeDb, query, queryRows, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, TEST_MEMBERS } from "./helpers/fixtures";

/** k 匿名性の下限。0100 の `HAVING count(*) >= 5` と同じ値（下げてはならない）。 */
const K_ANONYMITY_FLOOR = 5;

/** コホートを1つに揃えるための共通属性。これが揃っていないと `GROUP BY` が分かれて k を検証できない。 */
const COHORT = { ageBracket: "30s", memberType: "街人（一般）", skillTag: "農業" };

/** `rag.member_behavior_features` へ1行入れる SQL。埋め込みは NULL（`ck_behavior_model_paired` と整合）。 */
function behaviorRowSql(memberId: string): string {
  return `
    INSERT INTO rag.member_behavior_features
      (member_id, age_bracket, role, member_type, skill_tags, feature_text)
    VALUES
      ('${memberId}', '${COHORT.ageBracket}', 'member', '${COHORT.memberType}',
       ARRAY['${COHORT.skillTag}']::text[], 'テスト用の特徴文（氏名・生年月日を含まない）');
  `;
}

// ───────────────────────────────────────────────────────────
// 1. オブジェクトが実在すること（＝ 0100 が適用されたこと）
// ───────────────────────────────────────────────────────────
describeDb("0100 の適用結果（オブジェクトの実在）", () => {
  test("vector 拡張が有効になっている", () => {
    expect(query(`SELECT count(*) FROM pg_extension WHERE extname = 'vector';`)).toBe("1");
  });

  test("rag スキーマが作られている", () => {
    expect(query(`SELECT count(*) FROM pg_namespace WHERE nspname = 'rag';`)).toBe("1");
  });

  test("Tier 1/2 の public.knowledge_chunks が作られている", () => {
    expect(query(`SELECT to_regclass('public.knowledge_chunks') IS NOT NULL;`)).toBe("t");
  });

  test("Tier 3 の rag.member_behavior_features が作られている", () => {
    expect(query(`SELECT to_regclass('rag.member_behavior_features') IS NOT NULL;`)).toBe("t");
  });

  test("k 匿名ビュー rag.v_cohort_stats が作られている", () => {
    expect(query(`SELECT to_regclass('rag.v_cohort_stats') IS NOT NULL;`)).toBe("t");
  });

  test("PII ガード関数2本とトリガー関数が作られている", () => {
    const names = queryRows(`
      SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'rag' ORDER BY 1;
    `);
    expect(names).toEqual(["contains_known_names", "redact_known_names", "touch_updated_at"]);
  });

  test("updated_at のトリガーが knowledge_chunks に張られている", () => {
    expect(
      query(`
        SELECT count(*) FROM pg_trigger
        WHERE tgname = 'trg_knowledge_chunks_touch' AND NOT tgisinternal;
      `),
    ).toBe("1");
  });

  test("ANN 索引2本が HNSW で作られている", () => {
    // 索引が btree へ落ちていると検索が全件走査になり、性能劣化に気づけないまま本番へ出る
    const rows = queryRows(`
      SELECT c.relname FROM pg_class c
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname IN ('ix_chunks_ann', 'ix_behavior_ann') AND am.amname = 'hnsw'
      ORDER BY 1;
    `);
    expect(rows).toEqual(["ix_behavior_ann", "ix_chunks_ann"]);
  });
});

// ───────────────────────────────────────────────────────────
// 2. 拡張の配置先（Supabase の extension_in_public 対策）
// ───────────────────────────────────────────────────────────
describeDb("vector 拡張の配置先", () => {
  test("vector 拡張が public スキーマに作られていない", () => {
    // Supabase の DB Advisor が `extension_in_public` として警告する類型。
    // 一度 public に作ると、依存する型・索引があるため `ALTER EXTENSION ... SET SCHEMA` で
    // 後から動かすのが難しい。空の DB のうちに確定させる。
    //
    // ⚠️ 0100:29 は `CREATE EXTENSION IF NOT EXISTS vector;` とだけ書いており
    //    スキーマを指定していない。この試験が落ちる場合、0100 は書き換えられない
    //    （migrations-baseline が固定）ため、0100 より前の連番で
    //    `CREATE EXTENSION vector WITH SCHEMA extensions;` を先行させて解決すること。
    const schema = query(`
      SELECT n.nspname FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector';
    `);
    expect(schema).not.toBe("public");
  });
});

// ───────────────────────────────────────────────────────────
// 3. RLS 全拒否（0100 §6 — ポリシーを1本も定義しない設計）
// ───────────────────────────────────────────────────────────
describeDb("RLS の全拒否（0100 §6）", () => {
  test.each([
    ["public", "knowledge_chunks"],
    ["rag", "member_behavior_features"],
  ])("%s.%s は RLS が有効である", (schema, table) => {
    expect(
      query(`
        SELECT c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}' AND c.relname = '${table}';
      `),
    ).toBe("t");
  });

  test.each([
    ["public", "knowledge_chunks"],
    ["rag", "member_behavior_features"],
  ])("%s.%s にポリシーが1本も無い（＝全拒否）", (schema, table) => {
    // ポリシーが1本でも増えたら設計判断の変更であり、レビューを要する。
    // 「便利だから authenticated に読ませる」が RLS 前提を崩す最短経路になる。
    expect(
      query(`SELECT count(*) FROM pg_policies WHERE schemaname = '${schema}' AND tablename = '${table}';`),
    ).toBe("0");
  });
});

// ───────────────────────────────────────────────────────────
// 4. GRANT（0100 §7 — 到達できるのは service_role のみ）
// ───────────────────────────────────────────────────────────
describeDb("GRANT の絞り込み（0100 §7）", () => {
  test.each(["anon", "authenticated"])("%s は knowledge_chunks に一切の権限を持たない", (role) => {
    const privileges = queryRows(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'knowledge_chunks' AND grantee = '${role}';
    `);
    expect(privileges).toEqual([]);
  });

  test("authenticated が knowledge_chunks を SELECT すると 42501 で拒まれる", () => {
    expect(sqlstateOf(`SET ROLE authenticated; SELECT count(*) FROM public.knowledge_chunks;`)).toBe("42501");
  });

  test("anon が knowledge_chunks を SELECT すると 42501 で拒まれる", () => {
    expect(sqlstateOf(`SET ROLE anon; SELECT count(*) FROM public.knowledge_chunks;`)).toBe("42501");
  });

  test("authenticated は rag スキーマへ到達できない（USAGE が無い）", () => {
    expect(sqlstateOf(`SET ROLE authenticated; SELECT count(*) FROM rag.member_behavior_features;`)).toBe("42501");
  });

  test("authenticated は k 匿名ビューにも到達できない", () => {
    expect(sqlstateOf(`SET ROLE authenticated; SELECT count(*) FROM rag.v_cohort_stats;`)).toBe("42501");
  });

  test("service_role にも DELETE は与えられていない（失効は source_deleted で表す）", () => {
    // DB物理設計 §1「物理削除の原則禁止」。DELETE が生えたら削除の事実が追跡不能になる。
    const privileges = queryRows(`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'knowledge_chunks' AND grantee = 'service_role'
      ORDER BY 1;
    `);
    expect(privileges).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

// ───────────────────────────────────────────────────────────
// 5. PII ガード関数の実行権限（0100 §3）
// ───────────────────────────────────────────────────────────
describeDb("PII ガード関数の実行権限（0100 §3）", () => {
  test.each(["redact_known_names", "contains_known_names"])(
    "authenticated は rag.%s を実行できない",
    (fn) => {
      // SECURITY DEFINER のため、EXECUTE が漏れると会員の実名照合器を誰でも叩けることになる。
      expect(sqlstateOf(`SET ROLE authenticated; SELECT rag.${fn}('テスト');`)).toBe("42501");
    },
  );

  test("PII ガード関数は search_path を固定している（乗っ取り防止）", () => {
    // SECURITY DEFINER で `SET search_path` が無いと、呼び出し側のスキーマ解決を乗っ取れる。
    const unguarded = queryRows(`
      SELECT p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'rag' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')
      ORDER BY 1;
    `);
    expect(unguarded).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────
// 6. k 匿名性 k=5（0100 §5 — 小規模コホートの再識別防止）
// ───────────────────────────────────────────────────────────
describeDb("k 匿名性の下限（0100 §5）", () => {
  const cohortMembers = [
    TEST_MEMBERS.admin.memberId,
    TEST_MEMBERS.self.memberId,
    TEST_MEMBERS.core.memberId,
    TEST_MEMBERS.oyakata.memberId,
  ];

  test("ビュー定義が HAVING で下限を強制している", () => {
    const definition = query(`SELECT pg_get_viewdef('rag.v_cohort_stats'::regclass, true);`);
    expect(definition.replace(/\s+/g, " ")).toContain(`>= ${K_ANONYMITY_FLOOR}`);
  });

  test(`${K_ANONYMITY_FLOOR}名未満のコホートは1行も出ない`, () => {
    const rows = query(`
      ${FIXTURE_SQL}
      ${cohortMembers.map(behaviorRowSql).join("\n")}
      SELECT count(*) FROM rag.v_cohort_stats;
    `);
    expect(rows).toBe("0");
  });

  test(`${K_ANONYMITY_FLOOR}名に達したコホートは集計として出る`, () => {
    // 下限ちょうどで出ることまで見ないと、「常に0行」でも上の試験は通ってしまう。
    const fifthMemberId = "00000000-0000-0000-0000-0000000000af";
    const rows = query(`
      ${FIXTURE_SQL}
      INSERT INTO public.members (member_id, member_type, role, account_status)
      VALUES ('${fifthMemberId}', '${COHORT.memberType}', 'member', 'active');
      ${[...cohortMembers, fifthMemberId].map(behaviorRowSql).join("\n")}
      SELECT cohort_size FROM rag.v_cohort_stats;
    `);
    expect(rows).toBe(String(K_ANONYMITY_FLOOR));
  });
});

// ───────────────────────────────────────────────────────────
// 7. 氏名伏字（0100 §3 — 投入パイプラインの機械的ガード）
// ───────────────────────────────────────────────────────────
describeDb("既知氏名の伏字（0100 §3）", () => {
  /** 会員の実名は `member_profiles_private` にしかない。フィクスチャで架空の氏名を1件だけ置く。 */
  const profileSql = `
    ${FIXTURE_SQL}
    INSERT INTO public.member_profiles_private (member_id, full_name, full_name_kana)
    VALUES ('${TEST_MEMBERS.self.memberId}', '架空 太郎', 'カクウ タロウ');
  `;

  // ⚠️ `redact_known_names` は平文ではなく
  //    `RETURNS TABLE (redacted_text text, hit_count integer, needs_review boolean)` を返す（0100:177）。
  //    `SELECT rag.redact_known_names(...)` と書くと `(本文,0,f)` という複合型の文字列表現になり、
  //    本文と比較できない。必ず列を名指しして取り出すこと。
  const WITH_NAME = "本日 架空 太郎 さんが参加しました";
  const WITHOUT_NAME = "本日の朝会では収穫の段取りを確認しました";

  test("本文に含まれる既知の氏名が伏せられる", () => {
    const redacted = query(`${profileSql} SELECT redacted_text FROM rag.redact_known_names('${WITH_NAME}');`);
    expect(redacted).not.toContain("架空 太郎");
  });

  test("伏せた箇所は公開表示名へ置換され、本文の他の部分は壊れない", () => {
    // 「消す」のではなく「公開してよい名前に差し替える」ことで、文脈を保ったまま検索対象にできる。
    // 全部消すと投入パイプラインが本文の意味を失う。
    //
    // 置換後の名前は v_member_public（0009）と同じ規則で決まる:
    //   nickname → 接頭辞+legacy_member_no → 接頭辞+member_id の先頭8桁。
    // フィクスチャの self は nickname を持つため、ここではニックネームに置き換わる。
    const redacted = query(`${profileSql} SELECT redacted_text FROM rag.redact_known_names('${WITH_NAME}');`);
    expect(redacted).toBe(`本日 ${TEST_MEMBERS.self.nickname} さんが参加しました`);
  });

  test("伏字が起きた本文は hit_count が 1 以上になる", () => {
    // hit_count は knowledge_chunks.pii_hit_count（0100:98）へ記録され、
    // 後から「何件伏せたか」を監査するための唯一の手掛かりになる。
    const hits = query(`${profileSql} SELECT hit_count FROM rag.redact_known_names('${WITH_NAME}');`);
    expect(Number(hits)).toBeGreaterThanOrEqual(1);
  });

  test("既知氏名を含む本文は contains_known_names が true を返す", () => {
    expect(query(`${profileSql} SELECT rag.contains_known_names('架空 太郎 さんの記録');`)).toBe("t");
  });

  test("誰の氏名も含まない本文は素通りする", () => {
    // 過剰検出で本文が壊れると、投入パイプラインが無害な文章まで伏字にしてしまう。
    const row = query(`
      ${profileSql}
      SELECT redacted_text || '|' || hit_count FROM rag.redact_known_names('${WITHOUT_NAME}');
    `);
    expect(row).toBe(`${WITHOUT_NAME}|0`);
  });

  test("誰の氏名も含まない本文は contains_known_names が false を返す", () => {
    expect(query(`${profileSql} SELECT rag.contains_known_names('${WITHOUT_NAME}');`)).toBe("f");
  });
});
