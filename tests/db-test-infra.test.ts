// DB テスト基盤の存在を固定する（完了条件22）。
//
// 根拠: DB物理設計 §6-8①③④（テスト3層と、ローカル／CI での用意の仕方）、CLAUDE.md §6.2。
//
// なぜ「テストのためのテスト」が要るか:
//   `tests/db/**` は接続先（`SUPABASE_DB_URL`）が無い環境では自分を skip する。
//   skip は緑として表示されるため、**CI で1本も走っていなくても誰も気づけない。**
//   トリガーは認可の最後の関門であり（DB物理設計 §6-6b）、
//   「気づけない未検証」を残すことがこのタスクで最も高くつく失敗になる。
//   そこで、接続先が CI で必ず与えられることを別の層で固定する。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(__dirname, "..");
const SUPABASE_CONFIG_PATH = join(REPOSITORY_ROOT, "supabase/config.toml");
const CI_WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github/workflows/ci.yml");
const PACKAGE_JSON_PATH = join(REPOSITORY_ROOT, "package.json");

/** `tests/db/helpers/psql.ts` が読む環境変数。CI 側と名前が一致していなければ全件 skip になる。 */
const DB_URL_ENV_NAME = "SUPABASE_DB_URL";

describe("DB テスト基盤（完了条件22）", () => {
  test("ローカルの Supabase スタック設定 supabase/config.toml が存在する", () => {
    // `supabase start` でローカルスタック（auth スキーマを含む）を起動できること。
    // auth.users が無いと members.auth_user_id の FK すら張れない（DB物理設計 §6-8④）
    expect(existsSync(SUPABASE_CONFIG_PATH)).toBe(true);
  });

  test("CI のワークフローが DB テストの接続先 SUPABASE_DB_URL を与えている", () => {
    const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    expect(workflow).toContain(DB_URL_ENV_NAME);
  });

  test("CI のワークフローまたは npm スクリプトが tests/db を実行対象にしている", () => {
    const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    const packageJson = readFileSync(PACKAGE_JSON_PATH, "utf8");
    expect(`${workflow}\n${packageJson}`).toContain("tests/db");
  });

  test("CI のワークフローが DB テストの接続先に本番の環境変数を使っていない", () => {
    // 本番を指すと実名370名の会員データに対してテストが走る（CLAUDE.md §3.1・§6.2 の warning）
    const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    const dbUrlAssignments = workflow
      .split("\n")
      .filter((line) => line.includes(DB_URL_ENV_NAME))
      .join("\n");
    expect(dbUrlAssignments).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});
