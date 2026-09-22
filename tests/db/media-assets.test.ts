// WBS 2-1c（`media_assets` のスキーマ ＋ RLS）の受入テスト。
//
// 根拠: v13 §5.11.2（署名付きURL方式）・§5.11.7（全ロール開放・用途タグ必須）・
//       §7「★ メディアアセット」（列構成の正）、
//       `DB物理設計.md` §3-7・§6-1 #22（PII-B と公開範囲）・§6-7、
//       `supabase/migrations/0021_media_assets.sql`、
//       2026-09-22 オーナー決定 C（正本 §7 の全面採用）。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import { FIXTURE_SQL, loginAsSql, TEST_AUTH_USERS, TEST_MEMBERS } from "./helpers/fixtures";

const PUBLIC_MEDIA_ID = "00000000-0000-0000-0000-00000000ab01";
const STAFF_ONLY_MEDIA_ID = "00000000-0000-0000-0000-00000000ab02";

/**
 * 会員 ＋ メディア2件。どちらも `self`（一般会員）の投稿。
 *   - `公開`     … 他人からも見える想定の行
 *   - `運営のみ` … 投稿者本人と staff にしか見えない想定の行
 * 「他人には公開のものだけが見える」を対で検証するために2件要る（§6-8④ の作法）。
 */
const MEDIA_FIXTURE = `
${FIXTURE_SQL}
INSERT INTO public.media_assets
  (media_id, member_id, media_type, content_type, storage_path, purpose_tags, visibility)
VALUES
  ('${PUBLIC_MEDIA_ID}', '${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg',
   'media/2026/09/public.jpg', ARRAY['クエスト報告'], '公開'),
  ('${STAFF_ONLY_MEDIA_ID}', '${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg',
   'media/2026/09/staff-only.jpg', ARRAY['施設紹介'], '運営のみ');
`;

function loggedInAs(authUserId: string): string {
  return `${MEDIA_FIXTURE}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

const asAdmin = loggedInAs(TEST_AUTH_USERS.admin.id);
const asCore = loggedInAs(TEST_AUTH_USERS.core.id);
const asSelf = loggedInAs(TEST_AUTH_USERS.self.id);
/** 投稿者ではない一般会員。「他人からどう見えるか」を確かめる役。 */
const asOther = loggedInAs(TEST_AUTH_USERS.oyakata.id);

/** 列の CHECK を1つずつ突くための、最小限の INSERT。 */
function insertMedia(columns: string, values: string): string {
  return `
    ${FIXTURE_SQL}
    INSERT INTO public.media_assets
      (member_id, media_type, content_type, storage_path, purpose_tags${columns})
    VALUES
      ('${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg', 'media/2026/09/a.jpg',
       ARRAY['クエスト報告']${values});
  `;
}

describeDb("用途タグは必須である（v13 §5.11.7 ②）", () => {
  test("用途タグが1つあれば作れる", () => {
    expect(
      query(`${MEDIA_FIXTURE} SELECT count(*) FROM public.media_assets;`),
    ).toBe("2");
  });

  test("★ 用途タグが空の配列では作れない（23514）", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg', 'media/2026/09/a.jpg', ARRAY[]::text[]);
    `);
    expect(state).toBe("23514");
  });

  test("用途タグを省略しても既定値が空配列のため作れない（23514）", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.media_assets (member_id, media_type, content_type, storage_path)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg', 'media/2026/09/a.jpg');
    `);
    expect(state).toBe("23514");
  });
});

describeDb("ファイル種別は正本 §7 の3値である（2026-09-22 決定 C）", () => {
  test.each(["image", "video", "pdf"])("%s は入る", (mediaType) => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.self.memberId}', '${mediaType}', 'image/jpeg',
              'media/2026/09/a.jpg', ARRAY['クエスト報告']);
    `);
    expect(state).toBeNull();
  });

  test("★ 派生設計の旧値 photo は入らない（23514）", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'photo', 'image/jpeg',
              'media/2026/09/a.jpg', ARRAY['クエスト報告']);
    `);
    expect(state).toBe("23514");
  });
});

describeDb("署名へ焼き込んだ値を保存する列（v13 §7 ／ §5.11.5）", () => {
  test("content_type が空文字では作れない（23514）", () => {
    const state = sqlstateOf(`
      ${FIXTURE_SQL}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'image', '   ', 'media/2026/09/a.jpg',
              ARRAY['クエスト報告']);
    `);
    expect(state).toBe("23514");
  });

  test("file_size_bytes は署名時点では未確定でよい（NULL が入る）", () => {
    expect(sqlstateOf(insertMedia("", ""))).toBeNull();
  });

  test("file_size_bytes に 0 以下は入らない（23514）", () => {
    expect(sqlstateOf(insertMedia(", file_size_bytes", ", 0"))).toBe("23514");
  });

  test("ai_tags 列が存在する（v13 §9 #57 ／ 派生設計の追随漏れ分）", () => {
    expect(
      query(`${FIXTURE_SQL} SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'media_assets' AND column_name = 'ai_tags';`),
    ).toBe("1");
  });

  test.each(["usage_scene", "knowledge_id", "category_id", "content_type", "file_size_bytes"])(
    "正本 §7 の %s 列が存在する（決定 C）",
    (columnName) => {
      expect(
        query(`${FIXTURE_SQL} SELECT count(*) FROM information_schema.columns
               WHERE table_name = 'media_assets' AND column_name = '${columnName}';`),
      ).toBe("1");
    },
  );
});

describeDb("アップロードの生死と AI 解析は別の列である（v13 §5.11.2 note）", () => {
  test("既定は pending（署名を出しただけの状態）", () => {
    expect(
      query(`${MEDIA_FIXTURE}
             SELECT upload_state FROM public.media_assets WHERE media_id = '${PUBLIC_MEDIA_ID}';`),
    ).toBe("pending");
  });

  test("★ AI 解析の状態とは独立している（Phase 1 は常に pending のため孤児判定に使えない）", () => {
    expect(
      query(`${MEDIA_FIXTURE}
             SELECT ai_processing_status FROM public.media_assets WHERE media_id = '${PUBLIC_MEDIA_ID}';`),
    ).toBe("pending");
  });

  test("値域にない状態は入らない（23514）", () => {
    expect(sqlstateOf(insertMedia(", upload_state", ", 'ready'"))).toBe("23514");
  });

  test("stored にしたのに到着時刻が無い行は作れない（23514）", () => {
    expect(sqlstateOf(insertMedia(", upload_state", ", 'stored'"))).toBe("23514");
  });

  test("pending のまま到着時刻だけがある行は作れない（23514）", () => {
    expect(sqlstateOf(insertMedia(", stored_at", ", now()"))).toBe("23514");
  });

  test("stored と到着時刻が揃っていれば作れる", () => {
    expect(sqlstateOf(insertMedia(", upload_state, stored_at", ", 'stored', now()"))).toBeNull();
  });
});

describeDb("公開範囲と論理削除（v13 §7 ／ §5.11.7）", () => {
  test("既定の公開範囲は 公開（ゲストの投稿も既定で公開）", () => {
    expect(sqlstateOf(insertMedia("", ""))).toBeNull();
  });

  test("値域にない公開範囲は入らない（23514）", () => {
    expect(sqlstateOf(insertMedia(", visibility", ", '限定公開'"))).toBe("23514");
  });

  test("★ 操作者の無い論理削除は作れない（誰が消したか分からない非表示化を残さない）", () => {
    expect(sqlstateOf(insertMedia(", deleted_at", ", now()"))).toBe("23514");
  });

  test("操作者があれば論理削除できる", () => {
    expect(
      sqlstateOf(
        insertMedia(", deleted_at, deleted_by", `, now(), '${TEST_MEMBERS.admin.memberId}'`),
      ),
    ).toBeNull();
  });
});

describeDb("RLS：投稿者本人 ＋ staff は全件、他は 公開 のみ（DB物理設計 §6-1 #22）", () => {
  test("本人は自分の投稿を全件 SELECT できる", () => {
    expect(query(`${asSelf} SELECT count(*) FROM public.media_assets;`)).toBe("2");
  });

  test("管理者は全件 SELECT できる", () => {
    expect(query(`${asAdmin} SELECT count(*) FROM public.media_assets;`)).toBe("2");
  });

  test("コアメンバーは全件 SELECT できる", () => {
    expect(query(`${asCore} SELECT count(*) FROM public.media_assets;`)).toBe("2");
  });

  test("★ 他人には 公開 の1件だけが見える", () => {
    expect(query(`${asOther} SELECT count(*) FROM public.media_assets;`)).toBe("1");
  });

  test("★ 他人に見えるのは 運営のみ ではないほうである", () => {
    expect(query(`${asOther} SELECT visibility FROM public.media_assets;`)).toBe("公開");
  });

  test("★ 論理削除された投稿は他人から見えなくなる（運営措置の非表示化が効く）", () => {
    const visibleCount = query(`
      ${asAdmin}
      UPDATE public.media_assets
      SET    deleted_at = now(), deleted_by = public.current_member_id(), delete_reason = '運営措置'
      WHERE  media_id = '${PUBLIC_MEDIA_ID}';
      RESET ROLE;
      ${loginAsSql(TEST_AUTH_USERS.oyakata.id)}
      SET ROLE authenticated;
      SELECT count(*) FROM public.media_assets;
    `);
    expect(visibleCount).toBe("0");
  });
});

describeDb("RLS：投稿は本人名義でのみ作れる（v13 §5.11.7 ①）", () => {
  test("本人名義の投稿は作れる", () => {
    const state = sqlstateOf(`
      ${asSelf}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES (public.current_member_id(), 'image', 'image/jpeg', 'media/2026/09/new.jpg',
              ARRAY['クエスト報告']);
    `);
    expect(state).toBeNull();
  });

  test("★ 他人名義の投稿は作れない（42501）", () => {
    const state = sqlstateOf(`
      ${asSelf}
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.oyakata.memberId}', 'image', 'image/jpeg', 'media/2026/09/new.jpg',
              ARRAY['クエスト報告']);
    `);
    expect(state).toBe("42501");
  });
});

describeDb("RLS：削除と未ログイン（§6-7 デフォルト拒否）", () => {
  test("★ 物理削除はできない（42501）。削除は deleted_at による論理削除である", () => {
    expect(
      sqlstateOf(`${asAdmin} DELETE FROM public.media_assets WHERE media_id = '${PUBLIC_MEDIA_ID}';`),
    ).toBe("42501");
  });

  test("★ anon は SELECT できない（0行ではなく権限エラー）", () => {
    expect(
      sqlstateOf(`${MEDIA_FIXTURE} SET ROLE anon; SELECT count(*) FROM public.media_assets;`),
    ).toBe("42501");
  });

  test("anon は INSERT もできない（42501）", () => {
    const state = sqlstateOf(`
      ${MEDIA_FIXTURE}
      SET ROLE anon;
      INSERT INTO public.media_assets
        (member_id, media_type, content_type, storage_path, purpose_tags)
      VALUES ('${TEST_MEMBERS.self.memberId}', 'image', 'image/jpeg', 'media/2026/09/a.jpg',
              ARRAY['クエスト報告']);
    `);
    expect(state).toBe("42501");
  });
});

describeDb("先送りされていた外部キーの接続（0017・0018 の申し送り）", () => {
  test("★ work_logs の Before 写真が実在しない媒体を指せない（23503）", () => {
    const state = sqlstateOf(`
      ${MEDIA_FIXTURE}
      INSERT INTO public.quests (quest_id, title, reward_uii, created_by)
      VALUES ('00000000-0000-0000-0000-0000000000d1', '草刈り', 200, '${TEST_MEMBERS.admin.memberId}');
      INSERT INTO public.quest_applications (application_id, quest_id, member_id)
      VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1',
              '${TEST_MEMBERS.self.memberId}');
      INSERT INTO public.work_logs (application_id, member_id, quest_id, before_photo_media_id)
      VALUES ('00000000-0000-0000-0000-0000000000e1', '${TEST_MEMBERS.self.memberId}',
              '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000ffff');
    `);
    expect(state).toBe("23503");
  });

  test("実在する媒体なら Before 写真として指せる", () => {
    const state = sqlstateOf(`
      ${MEDIA_FIXTURE}
      INSERT INTO public.quests (quest_id, title, reward_uii, created_by)
      VALUES ('00000000-0000-0000-0000-0000000000d1', '草刈り', 200, '${TEST_MEMBERS.admin.memberId}');
      INSERT INTO public.quest_applications (application_id, quest_id, member_id)
      VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1',
              '${TEST_MEMBERS.self.memberId}');
      INSERT INTO public.work_logs (application_id, member_id, quest_id, before_photo_media_id)
      VALUES ('00000000-0000-0000-0000-0000000000e1', '${TEST_MEMBERS.self.memberId}',
              '00000000-0000-0000-0000-0000000000d1', '${PUBLIC_MEDIA_ID}');
    `);
    expect(state).toBeNull();
  });

  test("★ menu_items の商品画像が実在しない媒体を指せない（23503）", () => {
    const state = sqlstateOf(`
      ${MEDIA_FIXTURE}
      INSERT INTO public.menu_items (name, category, unit_price_yen, image_media_id)
      VALUES ('テスト商品', 'フード', 500, '00000000-0000-0000-0000-00000000ffff');
    `);
    expect(state).toBe("23503");
  });
});
