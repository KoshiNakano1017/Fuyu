// ビルド前に環境変数の欠落を検出する。`npm run build` の prebuild として自動で走る。
//
// ── なぜビルドを止める必要があるか ──────────────────────────────
// `NEXT_PUBLIC_*` は **ビルド時に文字列としてコードへ埋め込まれる**。
// 未設定のままビルドすると `undefined` が焼き込まれ、**ビルドは緑のまま通り、
// 実行時になって初めて壊れる**。しかも壊れる場所が middleware なので、
// Vercel は全経路へ `MIDDLEWARE_INVOCATION_FAILED`（500）を返す。
//
// 2026-09-21 に実際に起きた。CI の「ビルド」ジョブはダミー値を注入しているため緑、
// Vercel も「Ready」と表示したまま、本番サイトだけが全滅していた。
// 「デプロイが緑＝動く」を成立させるには、値が無いビルドをここで落とすしかない。
//
// ── 実行時のみ使う変数について ────────────────────────────────
// `SUPABASE_SERVICE_ROLE_KEY` は埋め込まれないので、ビルドには要らない。
// ただし本番で欠けると招待・初回ログイン結合が実行時に落ちる（`src/lib/supabase/admin.ts`）。
// 本番ビルド（`VERCEL_ENV=production`）でだけ必須にし、それ以外は警告に留める。
// CI は `VERCEL_ENV` を持たないため、CI を赤くしない。
//
// 使い方:
//   node scripts/check-env.mjs     （npm run build から自動で呼ばれる）

import fs from "node:fs";
import path from "node:path";

/** `.env` を読む。Next.js の `.env` 読み込みは `next build` の中で起きるため、
 *  prebuild の時点では `process.env` に載っていない。載せずに検査すると
 *  ローカルの `npm run build` が必ず落ちる。dotenv は足さない（seed-dev.mjs と同じ方針）。 */
function readDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) {
    return {};
  }
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const dotEnv = readDotEnv();

function read(name) {
  const value = process.env[name] ?? dotEnv[name];
  return value === undefined || value === "" ? null : value;
}

/** ダミー値のままの本番デプロイを弾く。CI のビルド通過用の値（ci.yml）がそのまま
 *  Vercel へ流れ込む事故は、キーの見た目では気づけないため名指しで拒否する。 */
function looksLikePlaceholder(value) {
  return /placeholder|example\.com|your[-_]?(project|key)|xxxx/i.test(value);
}

const isVercelProduction = process.env.VERCEL_ENV === "production";
const errors = [];
const warnings = [];

// ── ビルド時に埋め込まれる変数（欠けたらビルドを落とす）────────────
const url = read("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = read("NEXT_PUBLIC_SUPABASE_ANON_KEY");

if (url === null) {
  errors.push("NEXT_PUBLIC_SUPABASE_URL が未設定です");
} else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(url)) {
  // 形式まで見るのは、Vercel の統合が別名の変数（SUPABASE_URL 等）を作ったのに
  // 気づかず空文字や接続文字列を貼ってしまう取り違えが起きやすいため
  errors.push(
    `NEXT_PUBLIC_SUPABASE_URL の形式が想定外です（https://<プロジェクト参照>.supabase.co を期待）`,
  );
}

if (anonKey === null) {
  errors.push("NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です");
}

// ── 本番デプロイでのみ課す追加条件 ────────────────────────────
if (isVercelProduction) {
  if (read("SUPABASE_SERVICE_ROLE_KEY") === null) {
    errors.push(
      "SUPABASE_SERVICE_ROLE_KEY が未設定です（本番では招待・初回ログイン結合が実行時に落ちます）",
    );
  }
  for (const [name, value] of [
    ["NEXT_PUBLIC_SUPABASE_URL", url],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
  ]) {
    if (value !== null && looksLikePlaceholder(value)) {
      errors.push(`${name} がダミー値のままです`);
    }
  }
} else if (read("SUPABASE_SERVICE_ROLE_KEY") === null) {
  warnings.push(
    "SUPABASE_SERVICE_ROLE_KEY が未設定です。招待・初回ログイン結合を伴う経路は実行時に失敗します",
  );
}

for (const w of warnings) {
  console.warn(`⚠️  ${w}`);
}

if (errors.length > 0) {
  // 値そのものは絶対に出さない（CLAUDE.md §3.2・Vercel と Actions のログは残る）
  console.error("❌ 環境変数の事前チェックに失敗しました。ビルドを中止します。\n");
  for (const e of errors) {
    console.error(`   - ${e}`);
  }
  console.error(
    "\n   ローカル: .env.example をコピーして .env に実値を入れてください。" +
      "\n   Vercel  : Settings → Environment Variables に登録し、" +
      "**ビルドキャッシュを使わずに**再デプロイしてください" +
      "（NEXT_PUBLIC_* はビルド時に埋め込まれるため、追加しただけでは既存デプロイに反映されません）。",
  );
  process.exit(1);
}

console.log("✅ 環境変数の事前チェック OK");
