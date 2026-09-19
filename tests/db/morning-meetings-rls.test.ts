// WBS 4-1（Issue #23）朝会テキスト投入の受入テスト（DB 層）。
//
// 根拠: v13 §9 #63 L2537（アプリは音声を扱わない／コピー＆ペーストで投入し**貼り付け時点で格納**する）、
//       v13 §7「★ 朝会・議事録データ」L2166-2168（朝会ID・実施日・全文文字起こし・作成者ID）、
//       v13 §6 L2106（朝会＝管理者〇・コアメンバー〇・会員−・ゲスト−）、
//       v13 §5.9.3 L1631-1638（DOM非表示は認可ではない／RLS で `role` に基づき制御する）、
//       v13 §8 L2436-2469（認可の二重防御・ポリシー未定義はデフォルト拒否）、
//       DB物理設計.md §6-6b L1152（`morning_meetings` は **PII-A**・公開範囲は staff のみ）・§6 ⑦。
//
// ⚠️ 認可の判定は `role` のみで行う（CLAUDE.md §4.1）。`member_type = '親方'` かつ `role = 'member'` の
//    役を拒否側に含め、**立場（`member_type`）では通らない**ことを対で固定する。
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。`morning_meetings` はまだ存在しないため、
//    現時点では全件が失敗する。

import { describeDb, query, sqlstateOf } from "./helpers/psql";
import {
  authUserInsertSql,
  FIXTURE_SQL,
  loginAsSql,
  memberInsertSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./helpers/fixtures";

/**
 * ゲスト役。共有フィクスチャには `role = 'guest'` の会員が居ないため、本ファイルで用意する
 * （`tests/db/quests-guest-visibility.test.ts` と同じ作法）。
 * ID は共有フィクスチャ（`...b1`〜`b4`・`...a1`〜`a5`）と衝突しない値を取る。
 */
const GUEST_AUTH_USER = {
  id: "00000000-0000-0000-0000-0000000000b5",
  email: "fuyu-mm-guest@example.invalid",
};

const GUEST_MEMBER = {
  memberId: "00000000-0000-0000-0000-0000000000a6",
  authUserId: GUEST_AUTH_USER.id,
  nickname: "テストゲスト",
  memberType: "ゲスト",
  role: "guest",
  accountStatus: "active",
};

/** 会員フィクスチャ（共有5名 ＋ ゲスト1名）。 */
const MEMBERS_SQL = [FIXTURE_SQL, authUserInsertSql(GUEST_AUTH_USER), memberInsertSql(GUEST_MEMBER)].join("\n");

/** 既に保存されている議事録。RLS を迂回できる接続ユーザー（テーブル所有者）で投入する。 */
const SAVED_MEETING_ID = "33333333-3333-4333-8333-3333333333f1";
const SAVED_HELD_ON = "2026-09-18";
const SAVED_TRANSCRIPT = "テスト朝会の文字起こし。テスト親方が畑の水やりを共有し、テストコアが宿の清掃を共有した。";

const SAVED_MEETING_SQL = [
  "INSERT INTO public.morning_meetings (meeting_id, held_on, transcript_text, created_by)",
  `VALUES ('${SAVED_MEETING_ID}', DATE '${SAVED_HELD_ON}', '${SAVED_TRANSCRIPT}',`,
  `        '${TEST_MEMBERS.admin.memberId}');`,
].join("\n");

/** 貼り付けを模した投入本文。実装が本文を欠落・加工していないかを見るため、読み出し側でも同じ値を使う。 */
const PASTED_MEETING_ID = "33333333-3333-4333-8333-3333333333f2";
const PASTED_HELD_ON = "2026-09-19";
const PASTED_TRANSCRIPT =
  "テスト朝会の貼り付け本文。テスト街人が薪割りの段取りを相談し、テスト管理者が来客対応の割り当てを決めた。";

/** 文字起こしテキストを1件投入する SQL（`created_by` は投入者自身）。 */
function pasteMinutesSql(createdBy: string): string {
  return [
    "INSERT INTO public.morning_meetings (meeting_id, held_on, transcript_text, created_by)",
    `VALUES ('${PASTED_MEETING_ID}', DATE '${PASTED_HELD_ON}', '${PASTED_TRANSCRIPT}', '${createdBy}');`,
  ].join("\n");
}

/** 議事録がまだ1件も無い状態で、指定の会員としてログインする。 */
function signedInAs(authUserId: string): string {
  return [MEMBERS_SQL, loginAsSql(authUserId), "SET ROLE authenticated;"].join("\n");
}

/** 議事録が1件保存済みの状態で、指定の会員としてログインする。 */
function signedInWithSavedMinutesAs(authUserId: string): string {
  return [MEMBERS_SQL, SAVED_MEETING_SQL, loginAsSql(authUserId), "SET ROLE authenticated;"].join("\n");
}

/** 議事録が1件保存済みの状態で、ログインしていない（`anon`）状態を作る。 */
const asSignedOut = [MEMBERS_SQL, SAVED_MEETING_SQL, "SET ROLE anon;"].join("\n");

describeDb("完了条件1: staff が文字起こし済みテキストを投入できる（v13 §9 #63・§6 L2106）", () => {
  test("admin は朝会の文字起こしテキストを投入できる", () => {
    const saved = query(`
      ${signedInAs(TEST_AUTH_USERS.admin.id)}
      ${pasteMinutesSql(TEST_MEMBERS.admin.memberId)}
      SELECT count(*) FROM public.morning_meetings WHERE meeting_id = '${PASTED_MEETING_ID}';
    `);
    expect(saved).toBe("1");
  });

  test("core_member は朝会の文字起こしテキストを投入できる", () => {
    // 派生設計（DB物理設計 §6 ⑦ `mm_insert_admin`）は INSERT を `is_admin()` に絞っているが、
    // 正本 v13 §6 L2106 はコアメンバーも〇である。正本が勝つ（CLAUDE.md §1.1）。
    const saved = query(`
      ${signedInAs(TEST_AUTH_USERS.core.id)}
      ${pasteMinutesSql(TEST_MEMBERS.core.memberId)}
      SELECT count(*) FROM public.morning_meetings WHERE meeting_id = '${PASTED_MEETING_ID}';
    `);
    expect(saved).toBe("1");
  });
});

describeDb("完了条件2: 貼り付け時点で議事録として保存される（v13 §9 #63）", () => {
  test("投入した本文が、その場で1件の議事録として存在する", () => {
    const saved = query(`
      ${signedInAs(TEST_AUTH_USERS.admin.id)}
      ${pasteMinutesSql(TEST_MEMBERS.admin.memberId)}
      SELECT count(*) FROM public.morning_meetings WHERE transcript_text = '${PASTED_TRANSCRIPT}';
    `);
    expect(saved).toBe("1");
  });

  test("サマリー未生成のままでも議事録として保存される", () => {
    // 「貼り付け時点で格納する」ため、サマリー生成（WBS 4-2）を待たずに行が成立する必要がある。
    // `summary_text` に NOT NULL が付いていると、この試験が落ちる。
    const pending = query(`
      ${signedInAs(TEST_AUTH_USERS.admin.id)}
      ${pasteMinutesSql(TEST_MEMBERS.admin.memberId)}
      SELECT count(*) FROM public.morning_meetings
      WHERE meeting_id = '${PASTED_MEETING_ID}' AND summary_text IS NULL;
    `);
    expect(pending).toBe("1");
  });
});

describeDb("完了条件3: 保存した議事録から4項目が読み出せる（v13 §7 L2166-2168）", () => {
  /** 投入 → 同じセッションで読み出す。列ごとに1アサーションへ分ける（CLAUDE.md §4.4）。 */
  function readBackAs(column: string): string {
    return query(`
      ${signedInAs(TEST_AUTH_USERS.admin.id)}
      ${pasteMinutesSql(TEST_MEMBERS.admin.memberId)}
      SELECT ${column} FROM public.morning_meetings WHERE meeting_id = '${PASTED_MEETING_ID}';
    `);
  }

  test("朝会IDが読み出せる", () => {
    expect(readBackAs("meeting_id::text")).toBe(PASTED_MEETING_ID);
  });

  test("実施日が読み出せる", () => {
    expect(readBackAs("held_on::text")).toBe(PASTED_HELD_ON);
  });

  test("全文文字起こしテキストが、投入した本文のまま読み出せる", () => {
    expect(readBackAs("transcript_text")).toBe(PASTED_TRANSCRIPT);
  });

  test("作成者IDが読み出せる", () => {
    expect(readBackAs("created_by::text")).toBe(TEST_MEMBERS.admin.memberId);
  });
});

describeDb("完了条件4: staff 以外の投入をサーバサイドで拒否する（v13 §5.9.3・§8）", () => {
  // 42501 = insufficient_privilege。GRANT が無い場合も、RLS の WITH CHECK 違反も同じ SQLSTATE になる。
  test("member は議事録を投入できない", () => {
    const state = sqlstateOf(`
      ${signedInAs(TEST_AUTH_USERS.self.id)}
      ${pasteMinutesSql(TEST_MEMBERS.self.memberId)}
    `);
    expect(state).toBe("42501");
  });

  test("guest は議事録を投入できない", () => {
    const state = sqlstateOf(`
      ${signedInAs(GUEST_AUTH_USER.id)}
      ${pasteMinutesSql(GUEST_MEMBER.memberId)}
    `);
    expect(state).toBe("42501");
  });

  test("member_type が親方でも role が member なら議事録を投入できない", () => {
    // ここが通ると、認可が `member_type`（立場）で判定されている（CLAUDE.md §4.1 違反）。
    const state = sqlstateOf(`
      ${signedInAs(TEST_AUTH_USERS.oyakata.id)}
      ${pasteMinutesSql(TEST_MEMBERS.oyakata.memberId)}
    `);
    expect(state).toBe("42501");
  });

  test("未認証（anon）は議事録を投入できない", () => {
    const state = sqlstateOf(`
      ${MEMBERS_SQL}
      SET ROLE anon;
      ${pasteMinutesSql(TEST_MEMBERS.admin.memberId)}
    `);
    expect(state).toBe("42501");
  });

  test("未認証（anon）は議事録を読み出せない", () => {
    const state = sqlstateOf(`
      ${asSignedOut}
      SELECT count(*) FROM public.morning_meetings;
    `);
    expect(state).toBe("42501");
  });
});

describeDb("完了条件5: 保存した議事録は staff 以外から読めない（PII-A ／ v13 §6・§8）", () => {
  test("admin は保存された議事録を読み出せる", () => {
    const rows = query(`
      ${signedInWithSavedMinutesAs(TEST_AUTH_USERS.admin.id)}
      SELECT count(*) FROM public.morning_meetings WHERE meeting_id = '${SAVED_MEETING_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("core_member は保存された議事録を読み出せる", () => {
    const rows = query(`
      ${signedInWithSavedMinutesAs(TEST_AUTH_USERS.core.id)}
      SELECT count(*) FROM public.morning_meetings WHERE meeting_id = '${SAVED_MEETING_ID}';
    `);
    expect(rows).toBe("1");
  });

  test("member には保存された議事録が0行になる", () => {
    // エラーではなく0行が正しい（エラーで返すと「その朝会が存在すること」自体が漏れる ／ §6-8⑤）。
    const rows = query(`
      ${signedInWithSavedMinutesAs(TEST_AUTH_USERS.self.id)}
      SELECT count(*) FROM public.morning_meetings;
    `);
    expect(rows).toBe("0");
  });

  test("guest には保存された議事録が0行になる", () => {
    const rows = query(`
      ${signedInWithSavedMinutesAs(GUEST_AUTH_USER.id)}
      SELECT count(*) FROM public.morning_meetings;
    `);
    expect(rows).toBe("0");
  });

  test("member_type が親方でも role が member なら保存された議事録が0行になる", () => {
    const rows = query(`
      ${signedInWithSavedMinutesAs(TEST_AUTH_USERS.oyakata.id)}
      SELECT count(*) FROM public.morning_meetings;
    `);
    expect(rows).toBe("0");
  });
});

describeDb("完了条件6: 音声ファイルの経路を持たない（v13 §9 #63）", () => {
  test("morning_meetings に NOT NULL の音声ファイル列が無い", () => {
    // アプリは音声を扱わないため、`audio_storage_path text NOT NULL`（DB物理設計 §3-4 L324）には
    // 埋める値が存在しない。列を置かないか、置くなら NULL 許容にする。
    const columns = query(`
      SELECT coalesce(string_agg(column_name, ',' ORDER BY column_name), '')
      FROM   information_schema.columns
      WHERE  table_schema = 'public'
        AND  table_name   = 'morning_meetings'
        AND  is_nullable  = 'NO'
        AND  column_name LIKE '%audio%';
    `);
    expect(columns).toBe("");
  });
});
