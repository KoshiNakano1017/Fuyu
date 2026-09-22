/**
 * 内部識別子（`role`）→ 利用者向け表示名の変換表（WBS 2-5 ／ v13 §2・§5.9.4）。
 *
 * ## 呼称は据え置きになったが、変換表は置く
 *
 * #58（利用者向けロール表示名の最終ラベル）は **2026-09-22 に「改称しない」で決着**した。
 * つまり `admin` は「管理者」、`core_member` は「コアメンバー」のままである。
 *
 * それでもこの表を1箇所に置くのは、**いま一致していることと、今後も一致し続けることは別**だからである。
 * 表示名が画面ごとに直書きされていると、呼称を変える判断が出た瞬間に
 * 「どこを直せば全部直るのか」が誰にも分からなくなる。実際、本ファイルを作る前の時点で
 * 同じ表が `AccessDenied.tsx` と `admin/preview/page.tsx` の**2箇所**にあった。
 *
 * ## 内部識別子をそのまま画面へ出さない
 *
 * `core_member` のような値は**認可の根拠**であって利用者への説明ではない（v13 §2）。
 * 画面へ出すと、利用者は「コアメンバーとは何か」ではなく「core_member とは何か」を尋ねることになる。
 */

import type { Role } from "./session";

/** 利用者向けのロール表示名。**画面はこの表だけを参照する。** */
export const ROLE_DISPLAY_NAMES: Record<Role, string> = {
  admin: "管理者",
  core_member: "コアメンバー",
  member: "街人",
  guest: "ゲスト",
  // 出資者・VIP。認可上は `member` と同等に扱う（2026-09-22 オーナー決定 ／ v13 §9 #66）。
  // 表示だけを分けるのは、バッジや呼称で区別する運用が正式仕様のためである。
  custom: "カスタム権限",
};

/** 表示順。プレビュー表（画面ID C11）や説明文の並びをここに一本化する。 */
export const ROLES_IN_DISPLAY_ORDER: readonly Role[] = [
  "admin",
  "core_member",
  "member",
  "guest",
  "custom",
];

/**
 * 表示名を引く。未ログイン（`null`）は「未ログイン」と出す。
 *
 * 値域外は例外にせず「不明な権限」を返す。ロールは DB の CHECK 制約で5値に閉じているため、
 * ここへ値域外が来るのは呼び出し側の誤りだが、**アクセス制限画面が例外で落ちると
 * 利用者には真っ白な画面しか出ない**（何が起きたのか分からないまま終わる）。
 */
export function roleDisplayName(role: Role | null): string {
  if (role === null) {
    return "未ログイン";
  }
  return ROLE_DISPLAY_NAMES[role] ?? "不明な権限";
}

/** 運営（admin ＋ core_member）を指す必要権限の文言。ガードの `requiredRoleLabel` に使う。 */
export const STAFF_REQUIRED_LABEL = `${ROLE_DISPLAY_NAMES.admin} または ${ROLE_DISPLAY_NAMES.core_member}`;

/** 管理者だけを指す必要権限の文言。 */
export const ADMIN_REQUIRED_LABEL = ROLE_DISPLAY_NAMES.admin;
