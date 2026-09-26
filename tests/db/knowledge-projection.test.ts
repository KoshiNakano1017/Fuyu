// 投影と検索の入口（`0103_knowledge_projection.sql` ／ WBS 9-1）の受入テスト。
//
// 根拠: `CONSOLIDATED_DECISIONS.md` §17-6 #5・#6・§25-3、`0100`（`knowledge_chunks` の制約）、
//       `0102`（`rag.search_knowledge()`・`rag.scan_for_index()`）。
//
// ⚠️ ここで守っているのは **PII が索引とベクトルへ入らないこと**と、
//    **スコープが関数の外へ出ないこと**である。`knowledge_chunks` は `service_role` にしか
//    GRANT が無いため、絞り込みをアプリ側へ移すと呼び出しを1箇所書き忘れた瞬間に漏れる。

import { describeDb, query, sqlstateOf } from "./helpers/psql";

/** 768次元のダミーベクトル。`extensions` スキーマの型へキャストする（`0013` が移した）。 */
const VECTOR = "array_fill(0.01::real, ARRAY[768])::extensions.vector";

const SOURCE_ID = "'00000000-0000-0000-0000-0000000009a1'::uuid";

/** 投影を1件行う SQL。`p_tier` は呼び出し側が決める（アプリ層の `tierFor()` と対）。 */
function upsert(options: {
  text: string;
  tier?: number;
  visibility?: string;
  sourceType?: string;
  chunkIndex?: number;
  hash?: string;
}): string {
  const {
    text,
    tier = 1,
    visibility = "公開",
    sourceType = "quest",
    chunkIndex = 0,
    hash = "hash-1",
  } = options;
  return `SELECT * FROM public.upsert_knowledge_chunk(
    '${sourceType}', ${SOURCE_ID}, ${chunkIndex}, 'recipe', '${text}', '${hash}',
    ${tier}::smallint, 'core_member', '${visibility}', NULL);`;
}

describeDb("★ 投影は走査を必ず通し、伏字化後の本文だけを保存する（§17-6 #6）", () => {
  test("PII が無ければ clean で保存される", () => {
    expect(query(`${upsert({ text: "薪を割って乾かす" })}`).split("|")[1]).toBe("clean");
  });

  test("★ 連絡先は伏字化して保存する（生テキストを索引へ入れない）", () => {
    const stored = query(`
      ${upsert({ text: "連絡は taro@example.jp まで" })}
      SELECT chunk_text FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
    `);
    expect(stored).toBe("連絡は ［メールアドレス］ まで");
  });

  test("★ 埋め込むべきテキストも伏字化後である（ベクトルに PII を入れない）", () => {
    const textToEmbed = query(`${upsert({ text: "連絡は taro@example.jp まで" })}`).split("|")[3];
    expect(textToEmbed).toBe("連絡は ［メールアドレス］ まで");
  });

  test("★ `blocked` のときは埋め込むテキストを返さない", () => {
    // 敬称なしの姓が残る＝地名・一般語と区別できない（`0102` の判断）。人間の確認へ回す。
    const row = query(`${upsert({ text: "山田が担当した" })}`).split("|");
    expect(row[1]).toBe("blocked");
    expect(row[3]).toBe("");
    expect(row[4]).toBe("f");
  });

  test("本文が空のチャンクは拒否する", () => {
    expect(sqlstateOf(`${upsert({ text: "   " })}`)).toBe("23502");
  });
});

describeDb("差分検知（`content_hash` ／ 埋め込みの呼び直しを抑える）", () => {
  test("初回は埋め込みが必要", () => {
    expect(query(`${upsert({ text: "薪を乾かす" })}`).split("|")[4]).toBe("t");
  });

  test("★ 本文が同じで埋め込み済みなら不要になる", () => {
    const needs = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.set_knowledge_chunk_embedding(
        (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
        ${VECTOR}, 'gemini-embedding-001');
      ${upsert({ text: "薪を乾かす" })}
    `);
    expect(needs.split("|")[4]).toBe("f");
  });

  test("本文が変われば再度必要になる", () => {
    const needs = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.set_knowledge_chunk_embedding(
        (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
        ${VECTOR}, 'gemini-embedding-001');
      ${upsert({ text: "薪を割る", hash: "hash-2" })}
    `);
    expect(needs.split("|")[4]).toBe("t");
  });
});

describeDb("★ LINE 書き出し可否は Tier・走査・公開の3つが揃ったときだけ（`0100` の CHECK）", () => {
  function exportableOf(options: Parameters<typeof upsert>[0]): string {
    return query(`
      ${upsert(options)}
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

describeDb("★ 走査を通っていないチャンクへ埋め込みを付けられない", () => {
  test("`blocked` へは 42501 で拒否する", () => {
    expect(
      sqlstateOf(`
        ${upsert({ text: "山田が担当した" })}
        SELECT public.set_knowledge_chunk_embedding(
          (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
          ${VECTOR}, 'gemini-embedding-001');
      `),
    ).toBe("42501");
  });

  test("ベクトルとモデル名は対で渡す", () => {
    expect(
      sqlstateOf(`
        ${upsert({ text: "薪を乾かす" })}
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

  test("★ 再投影で `blocked` へ落ちたら埋め込みも落ちる（`0100` の CHECK と噛み合う）", () => {
    const embedding = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.set_knowledge_chunk_embedding(
        (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
        ${VECTOR}, 'gemini-embedding-001');
      ${upsert({ text: "山田が担当した", hash: "hash-9" })}
      SELECT coalesce(embedding::text, 'null') FROM public.knowledge_chunks
      WHERE source_id = ${SOURCE_ID};
    `);
    expect(embedding).toBe("null");
  });
});

describeDb("削除追随（行を消さずフラグで倒す）", () => {
  test("投影元が消えたら検索に出なくなる", () => {
    const hits = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.set_knowledge_chunk_embedding(
        (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
        ${VECTOR}, 'gemini-embedding-001');
      SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true);
      SELECT count(*) FROM public.search_knowledge(${VECTOR}, 'app', 10);
    `);
    expect(hits).toBe("0");
  });

  test("★ 行は残る（消すと再投影のたびに同じ判断をやり直すことになる）", () => {
    const rows = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true);
      SELECT count(*) FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
    `);
    expect(rows).toBe("1");
  });

  test("再投影すると削除追随が解ける（元が生きている証）", () => {
    const deleted = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true);
      ${upsert({ text: "薪を乾かす" })}
      SELECT source_deleted FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID};
    `);
    expect(deleted).toBe("f");
  });
});

describeDb("★ 検索の入口は `rag` を公開せずに1本だけ出す（前線2 を崩さない）", () => {
  test("アプリ経路で投影したチャンクが引ける", () => {
    const hits = query(`
      ${upsert({ text: "薪を乾かす" })}
      SELECT public.set_knowledge_chunk_embedding(
        (SELECT chunk_id FROM public.knowledge_chunks WHERE source_id = ${SOURCE_ID}),
        ${VECTOR}, 'gemini-embedding-001');
      SELECT count(*) FROM public.search_knowledge(${VECTOR}, 'app', 10);
    `);
    expect(hits).toBe("1");
  });

  test("★ 未知のチャネルは広い方へ倒さず拒否する（ラッパでも同じ）", () => {
    expect(sqlstateOf(`SELECT * FROM public.search_knowledge(${VECTOR}, 'slack', 10);`)).toBe(
      "22023",
    );
  });

  test("★ authenticated からは投影も検索も呼べない", () => {
    for (const statement of [
      `SELECT * FROM public.search_knowledge(${VECTOR}, 'app', 10);`,
      `SELECT * FROM public.upsert_knowledge_chunk('quest', ${SOURCE_ID}, 0, 'recipe', 'x', 'h', 1::smallint, 'core_member', '公開', NULL);`,
      `SELECT public.mark_knowledge_source_deleted('quest', ${SOURCE_ID}, true);`,
    ]) {
      expect(sqlstateOf(`SET ROLE authenticated;\n${statement}`)).toBe("42501");
    }
  });

  test("`rag` スキーマは authenticated から使えないまま（`0100` の前線2）", () => {
    expect(sqlstateOf(`SET ROLE authenticated;\nSELECT * FROM rag.scan_for_index('x');`)).toBe(
      "42501",
    );
  });
});
