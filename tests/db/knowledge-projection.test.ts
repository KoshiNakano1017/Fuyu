// 投影と検索の入口（`0103_knowledge_projection.sql` ／ WBS 9-1）の受入テスト。
//
// 根拠: `CONSOLIDATED_DECISIONS.md` §17-6 #5・#6・§25-3、`0100`（`knowledge_chunks` の制約）、
//       `0102`（`rag.search_knowledge()`・`rag.scan_for_index()`）。
//
// ⚠️ ここで守っているのは **PII が索引とベクトルへ入らないこと**と、
//    **スコープが関数の外へ出ないこと**である。`knowledge_chunks` は `service_role` にしか
//    GRANT が無いため、絞り込みをアプリ側へ移すと呼び出しを1箇所書き忘れた瞬間に漏れる。
//
// ## 戻り値を一時表へ落としてから読む理由
//
// `query()` はスクリプト全体の標準出力を返す（`helpers/psql.ts`）。投影の RPC は5列を返すため、
// 続けて `SELECT` を書くと**2行分の出力が混ざって**列の位置がずれる。
// `CREATE TEMP TABLE ... AS SELECT` で受けると、psql のコマンド状態行は `query()` が落とすので
// **検査したい1つの値だけ**が残る。
//
// ⚠️ フィクスチャは自作のみ。氏名は架空であり、実在の会員データを参照・加工していない
//    （CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, TEST_MEMBERS } from "./helpers/fixtures";

/** 768次元のダミーベクトル。`extensions` スキーマの型へキャストする（`0013` が移した）。 */
const VECTOR = "array_fill(0.01::real, ARRAY[768])::extensions.vector";

const SOURCE_ID = "'00000000-0000-0000-0000-0000000009a1'::uuid";

/**
 * 既知氏名を1件だけ置く。**`blocked` はここが無いと再現しない。**
 *
 * `rag.redact_known_names()` は `member_profiles_private` を母集団にしており、
 * 会員が1人も居なければ「敬称なしの姓」を判定できない（＝どんな本文も `clean` になる）。
 * 姓は2文字以上でなければ判定対象外（`0100` の ③）なので3文字の姓を使う。
 *
 * ⚠️ 姓に「テスト」を使ってはならない。伏字化の置換先は**表示名（ニックネーム）**であり、
 * フィクスチャの `nickname` が「テスト街人」なので、置換した後の本文に姓が残ってしまい
 * `needs_review` が立つ（＝敬称つきでも `blocked` になる）。姓と置換先が文字を共有しない
 * 組み合わせを選ぶ必要がある。「架空田」は実在しない姓として置いた架空の値である。
 */
const KNOWN_NAME_SQL = `
${FIXTURE_SQL}
INSERT INTO public.member_profiles_private (member_id, full_name, full_name_kana)
VALUES ('${TEST_MEMBERS.self.memberId}', '架空田　太郎', 'カクウダ タロウ');
`;

/** 投影を1件行い、戻り値を一時表 `r<n>` に落とす SQL。 */
function upsertInto(
  table: string,
  options: {
    text: string;
    tier?: number;
    visibility?: string;
    sourceType?: string;
    chunkIndex?: number;
    hash?: string;
  },
): string {
  const {
    text,
    tier = 1,
    visibility = "公開",
    sourceType = "quest",
    chunkIndex = 0,
    hash = "hash-1",
  } = options;
  return `CREATE TEMP TABLE ${table} AS SELECT * FROM public.upsert_knowledge_chunk(
    '${sourceType}', ${SOURCE_ID}, ${chunkIndex}, 'recipe', '${text}', '${hash}',
    ${tier}::smallint, 'core_member', '${visibility}', NULL);`;
}

/** そのチャンクへ埋め込みを付ける SQL（戻り値は捨てる）。 */
const ATTACH_EMBEDDING = `
CREATE TEMP TABLE attached AS
SELECT public.set_knowledge_chunk_embedding(
  (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
  ${VECTOR}, 'gemini-embedding-001') AS ok;
`;

describeDb("★ 投影は走査を必ず通し、伏字化後の本文だけを保存する（§17-6 #6）", () => {
  test("PII が無ければ clean で保存される", () => {
    expect(query(`${upsertInto("r1", { text: "薪を割って乾かす" })}\nSELECT scan_status FROM r1;`)).toBe(
      "clean",
    );
  });

  test("★ 連絡先は伏字化して保存する（生テキストを索引へ入れない）", () => {
    const stored = query(`
      ${upsertInto("r1", { text: "連絡は taro@example.jp まで" })}
      SELECT chunk_text FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
    `);
    expect(stored).toBe("連絡は ［メールアドレス］ まで");
  });

  test("★ 埋め込むべきテキストも伏字化後である（ベクトルに PII を入れない）", () => {
    const textToEmbed = query(`
      ${upsertInto("r1", { text: "連絡は taro@example.jp まで" })}
      SELECT text_to_embed FROM r1;
    `);
    expect(textToEmbed).toBe("連絡は ［メールアドレス］ まで");
  });

  test("伏字化した件数を残す（検出した値は残さない）", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "連絡は taro@example.jp まで" })}
        SELECT pii_hit_count FROM r1;
      `),
    ).toBe("1");
  });

  test("本文が空のチャンクは拒否する", () => {
    expect(sqlstateOf(`${upsertInto("r1", { text: "   " })}`)).toBe("23502");
  });
});

describeDb("★ 敬称なしの既知氏名が残る本文は `blocked`（人間の確認へ回す ／ `0102` の判断）", () => {
  test("走査状態が blocked になる", () => {
    expect(
      query(`
        ${KNOWN_NAME_SQL}
        ${upsertInto("r1", { text: "架空田が担当した" })}
        SELECT scan_status FROM r1;
      `),
    ).toBe("blocked");
  });

  test("★ 埋め込むテキストを返さない（埋め込んではいけないものを手元へ渡さない）", () => {
    expect(
      query(`
        ${KNOWN_NAME_SQL}
        ${upsertInto("r1", { text: "架空田が担当した" })}
        SELECT coalesce(text_to_embed, 'null') FROM r1;
      `),
    ).toBe("null");
  });

  test("埋め込みが必要とは返さない", () => {
    expect(
      query(`
        ${KNOWN_NAME_SQL}
        ${upsertInto("r1", { text: "架空田が担当した" })}
        SELECT needs_embedding FROM r1;
      `),
    ).toBe("f");
  });

  test("★ `blocked` へは埋め込みを付けられない（42501）", () => {
    expect(
      sqlstateOf(`
        ${KNOWN_NAME_SQL}
        ${upsertInto("r1", { text: "架空田が担当した" })}
        ${ATTACH_EMBEDDING}
      `),
    ).toBe("42501");
  });

  test("★ 再投影で `blocked` へ落ちたら埋め込みも落ちる（`0100` の CHECK と噛み合う）", () => {
    const embedding = query(`
      ${KNOWN_NAME_SQL}
      ${upsertInto("r1", { text: "薪を乾かす" })}
      ${ATTACH_EMBEDDING}
      ${upsertInto("r2", { text: "架空田が担当した", hash: "hash-9" })}
      SELECT coalesce(embedding::text, 'null') FROM public.knowledge_chunks
      WHERE source_id = ${SOURCE_ID};
    `);
    expect(embedding).toBe("null");
  });

  test("敬称つきなら伏字化して通す（`blocked` にしない）", () => {
    expect(
      query(`
        ${KNOWN_NAME_SQL}
        ${upsertInto("r1", { text: "架空田さんが担当した" })}
        SELECT scan_status FROM r1;
      `),
    ).toBe("redacted");
  });
});

describeDb("差分検知（`content_hash` ／ 埋め込みの呼び直しを抑える）", () => {
  test("初回は埋め込みが必要", () => {
    expect(
      query(`${upsertInto("r1", { text: "薪を乾かす" })}\nSELECT needs_embedding FROM r1;`),
    ).toBe("t");
  });

  test("★ 本文が同じで埋め込み済みなら不要になる", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        ${ATTACH_EMBEDDING}
        ${upsertInto("r2", { text: "薪を乾かす" })}
        SELECT needs_embedding FROM r2;
      `),
    ).toBe("f");
  });

  test("本文が変われば再度必要になる", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        ${ATTACH_EMBEDDING}
        ${upsertInto("r2", { text: "薪を割る", hash: "hash-2" })}
        SELECT needs_embedding FROM r2;
      `),
    ).toBe("t");
  });
});

describeDb("★ LINE 書き出し可否は Tier・走査・公開の3つが揃ったときだけ（`0100` の CHECK）", () => {
  function exportableOf(options: Parameters<typeof upsertInto>[1]): string {
    return query(`
      ${upsertInto("r1", options)}
      SELECT exportable_to_line FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
    `);
  }

  test("Tier 1・clean・公開なら true", () => {
    expect(exportableOf({ text: "薪を乾かす", tier: 1, visibility: "公開" })).toBe("t");
  });

  test("★ Tier 2 は false（個人に紐づく実績を LINE へ出さない）", () => {
    expect(
      exportableOf({ text: "薪を乾かす", tier: 2, sourceType: "work_log", visibility: "公開" }),
    ).toBe("f");
  });

  test("★ 「運営のみ」は Tier 1 でも false", () => {
    expect(exportableOf({ text: "薪を乾かす", tier: 1, visibility: "運営のみ" })).toBe("f");
  });
});

describeDb("埋め込みの付け方（`0100` の CHECK と同じ前提を読めるエラーで返す）", () => {
  test("ベクトルとモデル名は対で渡す", () => {
    expect(
      sqlstateOf(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        SELECT public.set_knowledge_chunk_embedding(
          (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
          ${VECTOR}, NULL);
      `),
    ).toBe("23502");
  });

  test("存在しないチャンクは false を返す（例外にしない）", () => {
    expect(
      query(`SELECT public.set_knowledge_chunk_embedding(
        '00000000-0000-0000-0000-0000000009ff'::uuid, ${VECTOR}, 'gemini-embedding-001');`),
    ).toBe("f");
  });
});

describeDb("削除追随（行を消さずフラグで倒す）", () => {
  test("投影元が消えたら検索に出なくなる", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        ${ATTACH_EMBEDDING}
        CREATE TEMP TABLE marked AS
          SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true) AS n;
        SELECT count(*) FROM public.search_knowledge(${VECTOR}, 'app', 10);
      `),
    ).toBe("0");
  });

  test("★ 行は残る（消すと再投影のたびに同じ判断をやり直すことになる）", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        CREATE TEMP TABLE marked AS
          SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true) AS n;
        SELECT count(*) FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
      `),
    ).toBe("1");
  });

  test("再投影すると削除追随が解ける（元が生きている証）", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        CREATE TEMP TABLE marked AS
          SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true) AS n;
        ${upsertInto("r2", { text: "薪を乾かす" })}
        SELECT source_deleted FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
      `),
    ).toBe("f");
  });
});

describeDb("★ 検索の入口は `rag` を公開せずに1本だけ出す（前線2 を崩さない）", () => {
  test("アプリ経路で投影したチャンクが引ける", () => {
    expect(
      query(`
        ${upsertInto("r1", { text: "薪を乾かす" })}
        ${ATTACH_EMBEDDING}
        SELECT count(*) FROM public.search_knowledge(${VECTOR}, 'app', 10);
      `),
    ).toBe("1");
  });

  test("★ 未知のチャネルは広い方へ倒さず拒否する（ラッパでも同じ）", () => {
    expect(sqlstateOf(`SELECT * FROM public.search_knowledge(${VECTOR}, 'slack', 10);`)).toBe(
      "22023",
    );
  });

  test("★ authenticated からは検索を呼べない", () => {
    expect(
      sqlstateOf(`SET ROLE authenticated;\nSELECT * FROM public.search_knowledge(${VECTOR}, 'app', 10);`),
    ).toBe("42501");
  });

  test("★ authenticated からは投影を呼べない", () => {
    expect(
      sqlstateOf(`SET ROLE authenticated;
        SELECT * FROM public.upsert_knowledge_chunk('quest', ${SOURCE_ID}, 0, 'recipe', 'x', 'h',
          1::smallint, 'core_member', '公開', NULL);`),
    ).toBe("42501");
  });

  test("★ authenticated からは削除追随を呼べない", () => {
    expect(
      sqlstateOf(
        `SET ROLE authenticated;\nSELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true);`,
      ),
    ).toBe("42501");
  });

  test("`rag` スキーマは authenticated から使えないまま（`0100` の前線2）", () => {
    expect(sqlstateOf(`SET ROLE authenticated;\nSELECT * FROM rag.scan_for_index('x');`)).toBe(
      "42501",
    );
  });
});
