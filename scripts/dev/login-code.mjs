// 開発環境でメールOTPの6桁コードを、メールを飛ばさずに取り出す。WBS 1-1d／1-1e の迂回路。
//
// なぜ要るか:
//   `/login` は `signInWithOtp` → `verifyOtp` の2段で、コードはメールで届く前提である。
//   dev のメール設定（1-1e：テンプレートへの `{{ .Token }}` 追加・Resend への切替）が
//   済むまでコードが届かないため、開発中はここから取り出して手で貼る。
//
//   GoTrue の admin `generate_link` は **メールを送信せず**、OTP だけを返す。
//   つまり SMTP が未設定でも開発は進められる。
//
// ⚠️ 本番では使わない。service_role キーを使うため、実行できる時点で何でもできる。
// ⚠️ 実在の会員のメールアドレスを引数に渡さない（CLAUDE.md §7.1）。
//    渡してよいのは `@example.invalid` の開発用アカウントだけである。
//
// 使い方:
//   npm run dev:login-code -- dev-admin@example.invalid

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const email = process.argv[2];
if (!email) {
  console.error("使い方: npm run dev:login-code -- <メールアドレス>");
  process.exit(1);
}
if (!email.endsWith("@example.invalid")) {
  console.error(
    "拒否: 開発用アドレス（@example.invalid）以外は受け付けない（CLAUDE.md §7.1）。",
  );
  process.exit(1);
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (error) {
  console.error("失敗:", error.message);
  process.exit(1);
}

console.log("\n  6桁コード:", data.properties.email_otp);
console.log("  有効期限までに http://localhost:3000/login で");
console.log("  ①アドレスを入れて「確認コードを送る」（送信は失敗してよい）→ ②このコードを貼る\n");
