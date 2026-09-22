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
// ⚠️ **2026-09-22 追記（WBS `2-7` ／ `0029`）**: 未決だった論点⑤（親方会員番号の採番方式）が
//    オーナー決定（v13 §9 #62：一意であれば何でもよい）で決着したため、
//    「**純粋な親方衆は親方会員番号で表示される**」段を追加した。
//    フォールバックの順序（街人番号 → 親方会員番号）が 2026-09-10 決定そのものであり、
//    入れ替わると「親方優先」＝**不採用と決まった挙動**へ戻る。

import { describeDb, query } from "./helpers/psql";

type DisplayNameFixture = {
  memberId: string;
  /** null = ニックネーム未設定 */
  nickname: string | null;
  /** null = 街人番号を持たない（純粋な親方衆・ゲスト） */
  legacyMemberNo: string | null;
  /** null = 親方会員番号を持たない（街人・ゲスト） */
  oyakataMemberNo: string | null;
  memberType: string;
};

/**
 * 取込元。`0029` の CHECK（取込由来でない会員はニックネーム必須）を満たすために要る。
 *
 * ニックネーム未設定を試験できるのは**移行会員だけ**である。アプリから作った会員に
 * 表示名が無い状態は WBS `2-7` で禁止したため、その組み合わせは DB が受け付けない。
 */
const IMPORTED_FROM = "テスト用取込（架空）";

const WITH_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c1",
  nickname: "テストきこり",
  legacyMemberNo: "T-0001",
  oyakataMemberNo: null,
  memberType: "街人（一般）",
};

const WITHOUT_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c2",
  nickname: null,
  legacyMemberNo: "T-0327",
  oyakataMemberNo: null,
  memberType: "街人（一般）",
};

/** 空白だけのニックネーム。「設定済み」と誤認すると画面に空の名前が並ぶ（§6-4 の `NULLIF(btrim(...))`）。 */
const BLANK_NICKNAME: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c3",
  nickname: "   ",
  legacyMemberNo: "T-0412",
  oyakataMemberNo: null,
  memberType: "街人（一般）",
};

/** 立場は親方だが街人番号を持つ会員。表示は街人番号（2026-09-10 決定）。 */
const OYAKATA_WITH_MACHIBITO_NO: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c4",
  nickname: null,
  legacyMemberNo: "T-0500",
  oyakataMemberNo: "OYA-901",
  memberType: "親方",
};

/** 純粋な親方衆（街人番号を持たない44名側）。表示は親方会員番号（2026-09-05 決定）。 */
const OYAKATA_ONLY: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c5",
  nickname: null,
  legacyMemberNo: null,
  oyakataMemberNo: "OYA-902",
  memberType: "親方",
};

/** どちらの番号も持たない会員。UUID 断片へ落ちる（最後の砦）。 */
const NO_NUMBER_AT_ALL: DisplayNameFixture = {
  memberId: "00000000-0000-0000-0000-0000000000c6",
  nickname: null,
  legacyMemberNo: null,
  oyakataMemberNo: null,
  memberType: "ゲスト",
};

/** 架空の実名。表示名へ漏れてはいけない（§5.2c の不可侵ルール）。 */
const FICTIONAL_FULL_NAME = "架空 太郎";

function sqlText(value: string | null): string {
  return value === null ? "NULL" : `'${value}'`;
}

function memberSql(fixture: DisplayNameFixture): string {
  return [
    "INSERT INTO public.members",
    "  (member_id, nickname, legacy_member_no, oyakata_member_no, member_type, role,",
    "   account_status, imported_from)",
    `VALUES ('${fixture.memberId}', ${sqlText(fixture.nickname)},`,
    `        ${sqlText(fixture.legacyMemberNo)}, ${sqlText(fixture.oyakataMemberNo)},`,
    `        '${fixture.memberType}', 'member', 'active', '${IMPORTED_FROM}');`,
  ].join("\n");
}

const FIXTURES_SQL = [
  WITH_NICKNAME,
  WITHOUT_NICKNAME,
  BLANK_NICKNAME,
  OYAKATA_WITH_MACHIBITO_NO,
  OYAKATA_ONLY,
  NO_NUMBER_AT_ALL,
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
    // 「親方優先」は 2026-09-10 に不採用。ここが `親方#OYA-901` になったら決定と食い違う。
    // このフィクスチャは**両方の番号を持つ**ため、フォールバックの順序がそのまま試される。
    expect(displayNameOf(OYAKATA_WITH_MACHIBITO_NO.memberId)).toBe("街人#T-0500");
  });

  test("純粋な親方衆は親方会員番号で表示される（0029 で第3段が埋まった）", () => {
    // 0029 より前は `legacy_member_no` が NULL のため UUID 断片へ落ちていた。
    expect(displayNameOf(OYAKATA_ONLY.memberId)).toBe("親方#OYA-902");
  });

  test("どちらの番号も無い会員は UUID 断片へ落ちる（実名へは落ちない）", () => {
    expect(displayNameOf(NO_NUMBER_AT_ALL.memberId)).toBe(
      `ゲスト#${NO_NUMBER_AT_ALL.memberId.slice(0, 8)}`,
    );
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
