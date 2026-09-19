// 他者向け表示名（WBS 5-1 ／ Issue #53 ／ 完了条件8）の受入テスト。
//
// 根拠: 2026-09-10 オーナー決定（`WBS_Phase1.md` L443）
//         ①`nickname` 未設定時は**会員番号** ②**親方兼街人は街人番号**
//         ⚠️「親方優先」は不採用。`member_type` は表示番号の選択に影響しない
//       DB物理設計 §6-4（L1523-1535 `v_member_public.display_name`）、
//       `0001_members_schema.sql` L19「`v_member_public` ビューと表示規則 … WBS 2-3 / 5-1」・
//       L50「未設定時に full_name へフォールバックしてはならない（§5.2c の不可侵ルール）」。
//
// ⚠️ フィクスチャは自作のみ。実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。
//    氏名は架空、メールは `@example.invalid`。
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。`v_member_public` は未作成。
//
// 未決の論点⑤（純粋な親方衆の会員番号の採番方式／QUESTIONS.md）には踏み込まない。
// ここで固定するのは「**街人番号を持つ会員は、立場が親方でもその番号で表示される**」までである。

import { describeDb, query } from "./helpers/psql";

type DisplayNameFixture = {
  memberId: string;
  /** null = ニックネーム未設定 */
  nickname: string | null;
  legacyMemberNo: string;
  memberType: string;
};

const WITH_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c1",
  nickname: "テストきこり",
  legacyMemberNo: "T-0001",
  memberType: "街人（一般）",
};

const WITHOUT_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c2",
  nickname: null,
  legacyMemberNo: "T-0327",
  memberType: "街人（一般）",
};

/** 空白だけのニックネーム。「設定済み」と誤認すると画面に空の名前が並ぶ（§6-4 の `NULLIF(btrim(...))`）。 */
const BLANK_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c3",
  nickname: "   ",
  legacyMemberNo: "T-0412",
  memberType: "街人（一般）",
};

/** 立場は親方だが街人番号を持つ会員。表示は街人番号（2026-09-10 決定）。 */
const OYAKATA_WITH_MACHIBITO_NO: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c4",
  nickname: null,
  legacyMemberNo: "T-0500",
  memberType: "親方",
};

/** 架空の実名。表示名へ漏れてはいけない（§5.2c の不可侵ルール）。 */
const FICTIONAL_FULL_NAME = "架空 太郎";

function memberSql(fixture: DisplayNameFixture): string {
  const nickname = fixture.nickname === null ? "NULL" : `'${fixture.nickname}'`;
  return [
    "INSERT INTO public.members",
    "  (member_id, nickname, legacy_member_no, member_type, role, account_status)",
    `VALUES ('${fixture.memberId}', ${nickname}, '${fixture.legacyMemberNo}',`,
    `        '${fixture.memberType}', 'member', 'active');`,
  ].join("\n");
}

const FIXTURES_SQL = [
  WITH_NICKNAME,
  WITHOUT_NICKNAME,
  BLANK_NICKNAME,
  OYAKATA_WITH_MACHIBITO_NO,
]
  .map(memberSql)
  .join("\n");

/** 表示名を1件だけ取り出す。 */
function displayNameOf(memberId: string): string {
  return query(`
    ${FIXTURES_SQL}
    SELECT display_name FROM public.v_member_public WHERE member_id = '${memberId}';
  `);
}

describeDb("完了条件8: 他者向け表示名（2026-09-10 決定 ／ DB物理設計 §6-4）", () => {
  test("ニックネームが設定済みならニックネームで表示される", () => {
    expect(displayNameOf(WITH_NICKNAME.memberId)).toBe("テストきこり");
  });

  test("ニックネーム未設定なら会員番号で表示される", () => {
    expect(displayNameOf(WITHOUT_NICKNAME.memberId)).toBe("街人#T-0327");
  });

  test("空白だけのニックネームは未設定として扱われる", () => {
    expect(displayNameOf(BLANK_NICKNAME.memberId)).toBe("街人#T-0412");
  });

  test("親方兼街人は街人番号で表示される（`member_type` は表示番号を変えない）", () => {
    // 「親方優先」は 2026-09-10 に不採用。ここが `親方#` になったら決定と食い違う。
    expect(displayNameOf(OYAKATA_WITH_MACHIBITO_NO.memberId)).toBe("街人#T-0500");
  });

  test("★ ニックネーム未設定でも表示名に実名が現れない（§5.2c の不可侵ルール）", () => {
    // 実名へフォールバックすると、クエストボードを開いた全員に氏名が露出する。
    const name = query(`
      ${FIXTURES_SQL}
      INSERT INTO public.member_profiles_private (member_id, full_name)
      VALUES ('${WITHOUT_NICKNAME.memberId}', '${FICTIONAL_FULL_NAME}');
      SELECT display_name FROM public.v_member_public
      WHERE  member_id = '${WITHOUT_NICKNAME.memberId}';
    `);
    expect(name).not.toContain(FICTIONAL_FULL_NAME);
  });
});
