// 買い物リスト（v13 §5.12 ／ Issue #147・WBS `5-8` 買い物リスト（ほしいものリスト））の
// DB 受入テストが共有するフィクスチャとヘルパ。
//
// 🚫 実在の会員データを一切参照しない（CLAUDE.md §3.2・§7.1）。会員も品目も手で作った架空値である。
//
// 列名の扱い:
//   正本 v13 §7「★ 買い物リスト（新規／§5.12）」は列を**日本語の項目名**で並べており、
//   英語の列名までは固定していない。そこで「§7 の項目が列として在るか」は
//   `resolveColumn()` で候補から解決して確かめる（名前を1つに決め打つと、仕様が要求していない
//   命名までテストが固定してしまう）。
//   例外は、承認済みの完了条件が名前ごと指定している `requesters`（完了条件15〜18）・
//   `quest_id`（完了条件7）・`advance_*` / `receipt_media_id`（完了条件6）と、
//   既存の DB テストが既に使っている `item_id` / `item_name` / `registered_by` / `status`
//   （`tests/db/shopping-list-items.test.ts`）。

import {
  authUserInsertSql,
  FIXTURE_SQL,
  loginAsSql,
  memberInsertSql,
  TEST_AUTH_USERS,
  TEST_MEMBERS,
} from "./fixtures";
import { query, queryRows } from "./psql";

export const SHOPPING_TABLE = "public.shopping_list_items";

/** 受入テストが共通で使う品目1件。登録者は街人（`self`）。 */
export const ITEM = {
  itemId: "00000000-0000-0000-0000-0000000000f1",
  itemName: "食器用洗剤",
  registeredBy: TEST_MEMBERS.self.memberId,
};

/**
 * ゲスト役。共通フィクスチャに居ないため、買い物リストの試験の中だけで作る。
 * 「ゲストは登録・相乗りができず、閲覧だけできる」（完了条件13・14・17）は
 * **反証役が居ないと検証そのものが成立しない**（v13 §5.12.1・§6 ／ §9 #65②）。
 */
export const GUEST_AUTH = {
  id: "00000000-0000-0000-0000-0000000000fb",
  email: "fuyu-shopping-guest@example.invalid",
};

export const GUEST_MEMBER = {
  memberId: "00000000-0000-0000-0000-0000000000fa",
  authUserId: GUEST_AUTH.id,
  nickname: "テストゲスト",
  memberType: "ゲスト",
  role: "guest",
  accountStatus: "active",
};

/** 会員フィクスチャ ＋ ゲスト役 ＋ 品目1件。各試験の冒頭で流す。 */
export const SHOPPING_FIXTURE_SQL = [
  FIXTURE_SQL,
  authUserInsertSql(GUEST_AUTH),
  memberInsertSql(GUEST_MEMBER),
  `INSERT INTO ${SHOPPING_TABLE} (item_id, item_name, registered_by)`,
  `VALUES ('${ITEM.itemId}', '${ITEM.itemName}', '${ITEM.registeredBy}');`,
].join("\n");

/** フィクスチャを投入し、`authUserId` でログインした状態にする。 */
export function loggedInAs(authUserId: string): string {
  return `${SHOPPING_FIXTURE_SQL}\n${loginAsSql(authUserId)}\nSET ROLE authenticated;`;
}

export const AS_ADMIN = loggedInAs(TEST_AUTH_USERS.admin.id);
export const AS_CORE = loggedInAs(TEST_AUTH_USERS.core.id);
/** 品目の登録者本人（`role = 'member'`）。 */
export const AS_OWNER = loggedInAs(TEST_AUTH_USERS.self.id);
/**
 * 登録者ではない街人。`member_type = '親方'` だが `role = 'member'` であり、
 * **認可が `role` で決まり `member_type` では決まらない**ことの反証役（CLAUDE.md §4.1）。
 */
export const AS_OTHER_MEMBER = loggedInAs(TEST_AUTH_USERS.oyakata.id);
export const AS_GUEST = loggedInAs(GUEST_AUTH.id);

/**
 * 拒否のされ方（例外か 0 行か）を問わずに、操作したあとの状態を見るための包み。
 *
 * 完了条件が求めているのは「**変わらないこと**」であり、SQLSTATE で落ちるか
 * RLS の USING に弾かれて 0 行で終わるかは実装の選び方に属する。
 * ここで例外を握り潰しておくと、どちらの実装でも同じ受入基準で判定できる。
 */
export function swallowing(statement: string): string {
  return ["DO $attempt$ BEGIN", statement.trim(), "EXCEPTION WHEN OTHERS THEN NULL;", "END $attempt$;"].join("\n");
}

/** 操作を試みたあとの1値を読む。操作が拒否されても検査まで進む。 */
export function valueAfterAttempt(prelude: string, statement: string, selectExpr: string): string {
  return query(`
    ${prelude}
    ${swallowing(statement)}
    RESET ROLE;
    SELECT ${selectExpr} FROM ${SHOPPING_TABLE} WHERE item_id = '${ITEM.itemId}';
  `);
}

/** 操作を試みたあとに、対象の品目が何行残っているかを読む（論理削除・物理削除の検査用）。 */
export function rowCountAfterAttempt(prelude: string, statement: string): string {
  return query(`
    ${prelude}
    ${swallowing(statement)}
    RESET ROLE;
    SELECT count(*) FROM ${SHOPPING_TABLE} WHERE item_id = '${ITEM.itemId}';
  `);
}

let cachedColumns: string[] | null = null;

/** `shopping_list_items` の列名一覧。並びは照合順序に依存しないよう `COLLATE "C"` で固定する。 */
export function shoppingListColumns(): string[] {
  if (cachedColumns === null) {
    cachedColumns = queryRows(`
      SELECT a.attname
      FROM   pg_attribute a
      WHERE  a.attrelid = '${SHOPPING_TABLE}'::regclass
        AND  a.attnum > 0
        AND  NOT a.attisdropped
      ORDER  BY a.attname COLLATE "C";
    `);
  }
  return cachedColumns;
}

/**
 * 正本 v13 §7「★ 買い物リスト」が列挙する項目 → 実装が採り得る列名の候補。
 *
 * ⚠️ 「承認者ID」と「見送り者ID」の候補には共通の `decided_by` を入れてある。
 *    §7 は2項目として並べているが、**判断者を1列で持ち状態で区別する**のも
 *    §7 の項目を持つことに変わりはないため、どちらの設計でも通るようにしている。
 */
export const SECTION7_COLUMN_CANDIDATES: Record<string, string[]> = {
  品目ID: ["item_id", "shopping_item_id", "id"],
  品名: ["item_name", "name", "title"],
  数量: ["quantity", "qty", "amount"],
  単位: ["unit", "quantity_unit"],
  希望期限: ["desired_by", "desired_by_on", "desired_deadline", "wanted_by", "needed_by", "due_on", "deadline"],
  "用途・理由": ["purpose", "reason", "usage", "purpose_note", "note"],
  入手先候補の店名: ["shop_name", "store_name", "source_shop", "source_name", "vendor", "shop"],
  入手先候補のURL: ["shop_url", "store_url", "source_url", "product_url", "reference_url", "url"],
  参考価格: ["reference_price_jpy", "reference_price", "price_jpy", "estimated_price_jpy"],
  優先度: ["priority"],
  写真のメディアID: ["photo_media_id", "media_id", "image_media_id", "media_asset_id"],
  ステータス: ["status"],
  登録者ID: ["registered_by", "registrant_id", "requested_by", "created_by"],
  登録日時: ["registered_at", "created_at"],
  "相乗り者ID配列（requesters[]）": ["requesters", "requester_ids"],
  承認者ID: ["decided_by", "approved_by", "decider_id"],
  承認日時: ["decided_at", "approved_at"],
  見送り理由: ["skip_reason", "skipped_reason", "skip_note"],
  見送り者ID: ["skipped_by", "skip_by", "decided_by", "skipper_id"],
  紐づくクエストID: ["quest_id"],
  購入日時: ["purchased_at", "bought_at"],
  購入者ID: ["purchased_by", "buyer_id", "bought_by"],
  取下げフラグ: ["withdrawn_at", "withdrawn", "is_withdrawn", "withdrawn_flag"],
  取下げ理由: ["withdrawal_reason", "withdraw_reason", "withdrawn_reason", "withdrawal_note"],
};

/** §7 の項目名に対応する実際の列名を返す。見つからなければ、その時点で完了条件1を満たしていない。 */
export function resolveColumn(concept: string): string {
  const candidates = SECTION7_COLUMN_CANDIDATES[concept];
  if (candidates === undefined) {
    throw new Error(`§7 の項目「${concept}」の候補が未定義（このヘルパへ追記すること）`);
  }
  const found = shoppingListColumns().find((column) => candidates.includes(column));
  if (found === undefined) {
    throw new Error(`v13 §7 の「${concept}」に相当する列が無い（候補: ${candidates.join(" / ")}）`);
  }
  return found;
}

/** 列の型名。取下げフラグが真偽値か日時かで書き方が変わるため、実物に合わせる。 */
function columnType(column: string): string {
  return query(`
    SELECT format_type(a.atttypid, a.atttypmod)
    FROM   pg_attribute a
    WHERE  a.attrelid = '${SHOPPING_TABLE}'::regclass AND a.attname = '${column}';
  `);
}

/** 取下げフラグへ「取り下げた」を書く代入式。真偽値でも日時でも同じ意味になるように組み立てる。 */
export function withdrawAssignment(): string {
  const column = resolveColumn("取下げフラグ");
  return columnType(column).startsWith("boolean") ? `${column} = true` : `${column} = now()`;
}

/** 取下げフラグが立っているか（真偽値でも日時でも `t` / `f` で返る式）。 */
export function withdrawnPredicate(): string {
  const column = resolveColumn("取下げフラグ");
  return columnType(column).startsWith("boolean") ? `coalesce(${column}, false)` : `(${column} IS NOT NULL)`;
}
