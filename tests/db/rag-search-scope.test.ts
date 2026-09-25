// 検索スコープと PII 検出の拡張（`0102_rag_search_scope_and_pii.sql` ／ WBS 1-6 の決定 A）の受入テスト。
//
// 根拠: `CONSOLIDATED_DECISIONS.md` §17-6 #5（検索時スコープ）・#6（PII 検出の拡張）、
//       §16-2 #61（**判定軸はロールではなくチャネル**）、`0100`（RAG 基盤）。
//
// ⚠️ ここで守っているのは **Tier 2（個人に紐づく実績）が LINE 経路へ出ないこと**である。
//    `knowledge_chunks` は `service_role` にしか GRANT が無く、絞り込みをアプリ側に置くと
//    呼び出しを1箇所書き忘れた瞬間に漏れる。だから DB の関数に固定してある。

import { describeDb, query, sqlstateOf } from "./helpers/psql";

/** 768次元のダミーベクトル。`extensions` スキーマの型へキャストする（`0013` が移した）。 */
const VECTOR = "array_fill(0.01::real, ARRAY[768])::extensions.vector";

/** Tier 1（公開・LINE 書き出し可）と Tier 2（運営のみ）を1件ずつ置く。 */
const CHUNKS = `
INSERT INTO public.knowledge_chunks
  (chunk_id, tier, source_type, source_id, content_type, chunk_text, embedding, embedding_model,
   content_hash, pii_scan_status, visibility, exportable_to_line)
VALUES
  ('00000000-0000-0000-0000-00000000c001', 1, 'quest', gen_random_uuid(), 'recipe',
   '薪の割り方', ${VECTOR}, 'gemini-embedding-001', 'hash-1', 'clean', '公開', true),
  ('00000000-0000-0000-0000-00000000c002', 2, 'work_log', gen_random_uuid(), 'work_log',
   '街人#45 の作業記録', ${VECTOR}, 'gemini-embedding-001', 'hash-2', 'clean', '運営のみ', false);
`;

const SEARCH = (channel: string) =>
  `SELECT count(*) FROM rag.search_knowledge(${VECTOR}, '${channel}', 10);`;

describeDb("★ LINE 経路は Tier 2 を1行も返さない（§17-6 #5 ／ §16-2 #61）", () => {
  test("アプリ経路では Tier 1・2 の両方が返る", () => {
    expect(query(`${CHUNKS}\n${SEARCH("app")}`)).toBe("2");
  });

  test("★ LINE 経路では Tier 1 だけが返る", () => {
    expect(query(`${CHUNKS}\n${SEARCH("line")}`)).toBe("1");
  });

  test("★ 書き出し許可の無い Tier 1 も LINE へ出さない", () => {
    expect(
      query(`
        ${CHUNKS}
        UPDATE public.knowledge_chunks SET exportable_to_line = false;
        ${SEARCH("line")}
      `),
    ).toBe("0");
  });

  test("「運営のみ」のチャンクは LINE へ出さない（Tier 1 でも）", () => {
    expect(
      query(`
        ${CHUNKS}
        UPDATE public.knowledge_chunks SET visibility = '運営のみ'
        WHERE  chunk_id = '00000000-0000-0000-0000-00000000c001';
        ${SEARCH("line")}
      `),
    ).toBe("0");
  });

  test("★ 未知のチャネルは広い方へ倒さず拒否する", () => {
    expect(sqlstateOf(`${CHUNKS}\nSELECT * FROM rag.search_knowledge(${VECTOR}, 'slack', 10);`)).toBe(
      "22023",
    );
  });

  test("★ authenticated からは検索関数を呼べない（EXECUTE を剥がしてある）", () => {
    expect(
      sqlstateOf(`
        ${CHUNKS}
        SET ROLE authenticated;
        SELECT * FROM rag.search_knowledge(${VECTOR}, 'app', 10);
      `),
    ).toBe("42501");
  });
});

describeDb("スキャンと削除の追随（`0100` の不変条件を検索側でも守る）", () => {
  test("削除追随したチャンクはアプリ経路でも返らない", () => {
    expect(
      query(`
        ${CHUNKS}
        UPDATE public.knowledge_chunks SET source_deleted = true;
        ${SEARCH("app")}
      `),
    ).toBe("0");
  });

  test("★ 走査を通っていないチャンクは返さない", () => {
    // `pending` / `blocked` は `ck_chunk_embedding_requires_scan` により embedding を持てず、
    // `ck_chunk_export_tier1_only` により LINE へも出せない。
    // したがって**走査状態を戻すときは埋め込みと書き出し許可も一緒に落とす**
    // （3つの制約が噛み合っていることの確認でもある）。
    expect(
      query(`
        ${CHUNKS}
        UPDATE public.knowledge_chunks
        SET    embedding = NULL, embedding_model = NULL, exportable_to_line = false;
        UPDATE public.knowledge_chunks SET pii_scan_status = 'blocked';
        ${SEARCH("app")}
      `),
    ).toBe("0");
  });

  test("件数の上限は関数側で押さえる（呼び出し側から無制限にできない）", () => {
    const rows = query(`
      ${CHUNKS}
      SELECT count(*) FROM rag.search_knowledge(${VECTOR}, 'app', 999);
    `);
    // 2件しか無いので件数は2。**例外にならずに丸められる**ことを確かめる。
    expect(rows).toBe("2");
  });
});

describeDb("PII 検出の拡張（§17-6 #6）", () => {
  test("メールアドレスを伏字化する", () => {
    expect(
      query(`SELECT redacted_text FROM rag.redact_contact_info('連絡は taro.a+1@example.jp まで');`),
    ).toBe("連絡は ［メールアドレス］ まで");
  });

  test("★ 電話番号を郵便番号と誤認しない（先に電話を処理する）", () => {
    // 逆順だと `090-1234` が郵便番号として落ち、`-5678` が残る（実測で踏んだ）。
    expect(
      query(`SELECT redacted_text FROM rag.redact_contact_info('電話 090-1234-5678 まで');`),
    ).toBe("電話 ［電話番号］ まで");
  });

  test("郵便番号は 〒 つきのときだけ落とす", () => {
    expect(query(`SELECT redacted_text FROM rag.redact_contact_info('〒123-4567 の拠点');`)).toBe(
      "［郵便番号］ の拠点",
    );
    // 裸の数字列は電話の断片・型番・日付と区別できないため落とさない
    expect(query(`SELECT redacted_text FROM rag.redact_contact_info('型番 123-4567');`)).toBe(
      "型番 123-4567",
    );
  });

  test("★ 金額は落とさない（レシピ・道具の説明が壊れない）", () => {
    expect(
      query(`SELECT redacted_text FROM rag.redact_contact_info('薪ストーブは 38000円、塩は 300g');`),
    ).toBe("薪ストーブは 38000円、塩は 300g");
  });

  test("検出件数だけを返す（検出した値は返さない）", () => {
    const columns = query(`
      SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
      FROM   pg_proc p
      JOIN   pg_namespace n ON n.oid = p.pronamespace
      CROSS  JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(attname, attnum)
      WHERE  n.nspname = 'rag' AND p.proname = 'redact_contact_info';
    `);
    expect(columns).toBe("p_text,redacted_text,hit_count");
  });
});

describeDb("索引前の走査は氏名と連絡先の両方を通す（`scan_for_index`）", () => {
  test("連絡先だけなら redacted になる", () => {
    expect(query(`SELECT scan_status FROM rag.scan_for_index('問い合わせは info@example.jp');`)).toBe(
      "redacted",
    );
  });

  test("PII が無ければ clean", () => {
    expect(query(`SELECT scan_status FROM rag.scan_for_index('薪を割って乾かす');`)).toBe("clean");
  });

  test("★ authenticated からは走査関数を呼べない", () => {
    expect(
      sqlstateOf(`
        SET ROLE authenticated;
        SELECT * FROM rag.scan_for_index('問い合わせは info@example.jp');
      `),
    ).toBe("42501");
  });
});

describeDb("★ member_notes は索引の投影元に入っていない（§17-6 #6 の「危うい情報」）", () => {
  test("`source_type` の値域に運営メモが無い", () => {
    const definition = query(`
      SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
      WHERE  c.conrelid = 'public.knowledge_chunks'::regclass
        AND  pg_get_constraintdef(c.oid) LIKE '%source_type%';
    `);
    for (const allowed of ["media", "morning_meeting", "work_log", "quest"]) {
      expect(definition).toContain(allowed);
    }
    // 運営メモ（`member_notes`）・会員の連絡先は投影元にしない＝伏字化以前に索引へ入らない
    expect(definition).not.toContain("member_note");
    expect(definition).not.toContain("member_identifier");
  });
});
