import {
  NICKNAME_MAX_LENGTH,
  RESERVED_DISPLAY_NAME_PREFIXES,
  validateNickname,
} from "@/lib/members/nickname";

/**
 * ニックネーム入力検査の単体テスト（WBS `2-7` ／ v13 §9 #62 ／ CLAUDE.md §4.4）。
 *
 * ニックネームは他者向け表示名の第1候補であり、ここを通った文字列が
 * そのまま他会員の画面へ出る。個人情報の露出となりすましの2点に効くため、
 * 「個人情報の取り扱いに関わるロジック」としてテストを必須とする。
 */

describe("validateNickname（必須化 ／ WBS 2-7）", () => {
  test("通常のニックネームは通る", () => {
    expect(validateNickname("きこり")).toEqual({ ok: true, normalized: "きこり" });
  });

  test("前後の空白は落として保存する", () => {
    expect(validateNickname("  きこり  ")).toEqual({ ok: true, normalized: "きこり" });
  });

  test("空文字は拒否する（必須化の本体）", () => {
    expect(validateNickname("").ok).toBe(false);
  });

  test("全角空白だけの入力は空として拒否する", () => {
    // DB 側の btrim は全角空白を落とさない。ここで拒否しないと
    // 「幅だけがある空の名前」が画面に並ぶ。
    expect(validateNickname("　　").ok).toBe(false);
  });

  test(`${NICKNAME_MAX_LENGTH}文字は通り、1文字超えると拒否する`, () => {
    expect(validateNickname("あ".repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateNickname("あ".repeat(NICKNAME_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
      reason: "too_long",
    });
  });

  test("改行を含む入力は拒否する", () => {
    expect(validateNickname("きこり\n運営")).toMatchObject({
      ok: false,
      reason: "control_characters",
    });
  });

  test("書字方向を反転させる不可視文字（U+202E）は拒否する", () => {
    // 通すと画面上の見た目と保存値が食い違い、別人に見える表示名を作れる。
    expect(validateNickname("きこり‮").ok).toBe(false);
  });

  test("★ 会員番号の表示形式を名乗れない（なりすましの防止）", () => {
    // `display_name` は nickname が無いとき `街人#<番号>` に落ちる。
    // これを自分で名乗れると、他人の会員番号を表示名に掲げられてしまう。
    for (const prefix of RESERVED_DISPLAY_NAME_PREFIXES) {
      expect(validateNickname(`${prefix}10234`)).toMatchObject({
        ok: false,
        reason: "reserved_prefix",
      });
    }
  });

  test("接頭辞が途中にあるだけなら通る", () => {
    // なりすましは先頭一致で成立する。途中に含むだけの名前まで弾くと過剰になる。
    expect(validateNickname("森の街人#1番地").ok).toBe(true);
  });
});
