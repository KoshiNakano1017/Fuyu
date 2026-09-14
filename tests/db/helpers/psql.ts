// DB テスト（WBS 2-1）を psql 越しに実行するための薄いヘルパ。
//
// なぜ psql を直接叩くか:
//   検証対象は PostgREST 越しの見え方ではなく **DDL と BEFORE UPDATE トリガー**であり、
//   SQLSTATE（`42501` / `23514` / `22023`）が期待値そのものになる（DB物理設計 §6-6b③）。
//   `\set VERBOSITY verbose` を付けると psql がエラー行の先頭に SQLSTATE を出すため、
//   追加の DB ドライバを依存に加えずに「どの SQLSTATE で落ちたか」を一意に判定できる。

import { execFileSync } from "node:child_process";

/**
 * DB テストの接続先。
 * ローカルは `supabase start`、CI は DB テストジョブが与える（DB物理設計 §6-8④）。
 */
export const DB_URL = process.env.SUPABASE_DB_URL ?? "";

/**
 * 接続先が無い環境では DB テストを飛ばす。
 *
 * 飛ばしてよいのは、**CI で必ず接続先が与えられること**を
 * `tests/db-test-infra.test.ts` が別途固定しているため（完了条件22）。
 * これが無いと「全部 skip で緑」という最悪の状態に気づけない。
 */
export const describeDb = DB_URL === "" ? describe.skip : describe;

export type SqlResult = {
  /** エラーなく最後まで流れたか */
  ok: boolean;
  /** 標準出力（`-t -A` のため値だけが改行区切りで並ぶ） */
  stdout: string;
  /** 失敗時の SQLSTATE。成功時は null */
  sqlstate: string | null;
  stderr: string;
};

/**
 * SQL をトランザクション内で実行する。
 *
 * 本体を `BEGIN` 〜 `ROLLBACK` で挟むため、フィクスチャは毎回捨てられる。
 * `set_config(..., true)`（トランザクションローカル）もここで閉じるので、
 * ある試験の申告値が次の試験へ漏れない（DB物理設計 §6-8③ と同じ作法）。
 */
export function runSql(body: string): SqlResult {
  const script = ["\\set VERBOSITY verbose", "BEGIN;", body, "ROLLBACK;", ""].join("\n");
  const args = [DB_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-f", "-"];

  try {
    const stdout = execFileSync("psql", args, { input: script, encoding: "utf8" });
    return { ok: true, stdout: stdout.trim(), sqlstate: null, stderr: "" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const stderr = failure.stderr ?? "";
    const matched = /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr);
    if (matched === null) {
      // psql そのものが起動できなかった等。SQLSTATE を偽らず、そのまま落とす
      throw new Error(`psql を実行できなかった（SQLSTATE を特定できない）:\n${stderr}`);
    }
    return { ok: false, stdout: (failure.stdout ?? "").trim(), sqlstate: matched[1], stderr };
  }
}

/** 失敗した SQLSTATE を返す。成功した場合は null（＝「拒否されるはず」の試験が通ってしまったことが分かる）。 */
export function sqlstateOf(body: string): string | null {
  return runSql(body).sqlstate;
}

/**
 * psql のコマンド状態行（`INSERT 0 1` 等）。
 * `-q` で抑止されるはずだが、抑止されなかった場合に検査値へ混ざると原因が分かりにくい。
 * フィクスチャ投入と検査クエリを1本のスクリプトで流す以上、ここで落としておく。
 */
const COMMAND_TAG =
  /^(BEGIN|COMMIT|ROLLBACK|SET|DO|GRANT|REVOKE|INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|CREATE [A-Z ]+|ALTER [A-Z ]+)$/;

/** 成功を前提に実行し、検査対象の出力だけを返す。失敗したら SQLSTATE 付きで落とす。 */
export function query(body: string): string {
  const result = runSql(body);
  if (!result.ok) {
    throw new Error(`SQL が失敗した（SQLSTATE ${result.sqlstate}）:\n${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => !COMMAND_TAG.test(line.trim()))
    .join("\n")
    .trim();
}

/** 1列のクエリ結果を行の配列で返す。0行なら空配列。 */
export function queryRows(body: string): string[] {
  const stdout = query(body);
  return stdout === "" ? [] : stdout.split("\n").map((line) => line.trim());
}
