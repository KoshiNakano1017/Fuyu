/**
 * ニックネームの入力検査（WBS `2-7`「ニックネームの必須化」のアプリ側）。
 *
 * ## なぜ判定を1箇所に置くのか
 *
 * ニックネームは**他者向け表示名の第1候補**であり（`v_member_public.display_name`）、
 * ここを通った文字列がクエストボード・注文者表示・受注者表示にそのまま並ぶ。
 * 画面ごとに検査を書くと、1つ緩い入口が空いた瞬間にその画面経由で
 * 表示名の規則が破れる。判定はこのモジュールだけに置き、
 * 本登録（WBS `12-1`）・ログイン後の設定画面（`/nickname`）の双方がここを呼ぶ。
 *
 * ## DB 側の CHECK と対で維持する
 *
 * `0029_oyakata_member_no_and_nickname.sql` が
 * ①空白のみの禁止 ②取込由来でない会員（アプリから作る会員）での必須
 * を CHECK で押さえている。DB は最後の関門であって入力検査ではない
 * （落ちても利用者には SQLSTATE 23514 しか見えない）。ここが先に落とす。
 */

/** 表示名として許す最大文字数。**仕様に明文が無いため実装側で決めた**（WBS `2-7`）。 */
export const NICKNAME_MAX_LENGTH = 20;

/**
 * 会員番号による表示のなりすましを防ぐための接頭辞。
 *
 * `display_name` は「`nickname` が無ければ `街人#<番号>`」という順で落ちる
 * （`v_member_public`）。したがって `街人#10234` をニックネームに設定できると、
 * **他人の会員番号を自分の表示名として掲げられる**。画面上は本物と区別できない。
 * 番号による表示は「本人がまだ設定していないこと」の印なので、
 * 名乗れてしまうと印の意味が消える。
 */
export const RESERVED_DISPLAY_NAME_PREFIXES = ["街人#", "親方#", "ゲスト#"] as const;

export type NicknameRejection =
  | "empty"
  | "too_long"
  | "control_characters"
  | "reserved_prefix";

export type NicknameValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: NicknameRejection; message: string };

const MESSAGE: Record<NicknameRejection, string> = {
  empty: "ニックネームを入力してください。",
  too_long: `ニックネームは${NICKNAME_MAX_LENGTH}文字以内で入力してください。`,
  control_characters: "ニックネームに改行や制御文字は使えません。",
  reserved_prefix:
    "「街人#」「親方#」「ゲスト#」から始まるニックネームは、会員番号の表示と見分けがつかないため使えません。",
};

function reject(reason: NicknameRejection): NicknameValidation {
  return { ok: false, reason, message: MESSAGE[reason] };
}

/**
 * 入力されたニックネームを検査し、保存してよい形へ整える。
 *
 * 前後の空白は落とす（`　` 全角空白を含む）。落とさずに保存すると、
 * DB 側は `btrim` しか見ないため全角空白だけの名前が通り、
 * 画面には**幅だけがある空の名前**が並ぶ。
 *
 * ⚠️ **本名かどうかは判定しない。** `会員データモデル` §5.2c が禁じているのは
 * 「システムが本名を初期値として入れること」であって、本人が本名を
 * 名乗ることは禁止されていない。ここで本名らしさを推定すると、
 * 実在の姓に似たニックネームを弾く誤判定になる。
 */
export function validateNickname(input: string): NicknameValidation {
  // 全角空白を含めて落とす。`\s` は全角空白（U+3000）に一致するため、これで足りる。
  const normalized = input.replace(/^\s+|\s+$/gu, "");

  if (normalized === "") {
    return reject("empty");
  }
  // 改行・タブ等（Cc）と、書字方向を反転させる不可視文字（Cf ／ 例: U+202E）。
  // 後者を通すと、画面上の見た目と保存値が食い違う表示名を作れる。
  if (/\p{Cc}|\p{Cf}/u.test(normalized)) {
    return reject("control_characters");
  }
  // 文字数は書記素ではなくコードポイントで数える。絵文字1個が2文字に数えられるが、
  // 「表示幅の上限」としてはそちらのほうが実態に近い。
  if ([...normalized].length > NICKNAME_MAX_LENGTH) {
    return reject("too_long");
  }
  if (RESERVED_DISPLAY_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return reject("reserved_prefix");
  }

  return { ok: true, normalized };
}
