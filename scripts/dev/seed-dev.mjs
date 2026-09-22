// 開発環境（dev Supabase）へロール別のテストユーザーとシードデータを投入する。WBS 1-1d。
//
// 🚫 実在の会員データを一切使わない（CLAUDE.md §3.2・§7.1）。
//    氏名は架空、メールは `@example.invalid`（DB物理設計 §6-8④ の指定）。
//    `tests/db/helpers/fixtures.ts` と同じ値域・同じ命名規則を意図的に踏襲している。
//
// ⚠️ **本番 Supabase に対して絶対に流さない。** 実行前に接続先ホストを表示し、
//    `SUPABASE_URL` が dev プロジェクトであることを目視で確認できるようにしてある。
//    CI からは呼ばない（CLAUDE.md §6.2 と同じ理由＝実名370名のデータへ書き込む事故を防ぐ）。
//
// 冪等。何度流しても同じ状態に落ち着く。
//
// 使い方:
//   npm run seed:dev
//
// 関連: WBS 1-1c（マイグレーション適用）が先に済んでいること。
//       ログイン用の6桁コードは `npm run dev:login-code -- <メール>` で取り出す（1-1e の迂回路）。

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// ── .env の読み込み（dotenv を足さない。キー=値 の素朴な形式しか置かない規約のため）──
function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) {
    throw new Error(".env が見つからない。.env.example をコピーして実値を入れること");
  }
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
}

console.log(`接続先: ${SUPABASE_URL}`);
console.log("（dev プロジェクトであることを確認すること。本番なら今すぐ Ctrl+C）\n");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ── 投入するロール別アカウント ───────────────────────────────
// member_id は固定値。再実行時に「作り直すべき行」を特定できるようにするため。
// `fixtures.ts` の a1/a2/... とは別空間（`c1`〜）にしてあり、DB テストのフィクスチャと衝突しない。
const SEED_MEMBERS = [
  {
    key: "admin",
    email: "dev-admin@example.invalid",
    memberId: "00000000-0000-0000-0000-0000000000c1",
    nickname: "開発用アドミン",
    fullName: "開発 管理者",
    memberType: "親方",
    role: "admin",
  },
  {
    key: "core",
    email: "dev-core@example.invalid",
    memberId: "00000000-0000-0000-0000-0000000000c2",
    nickname: "開発用コア",
    fullName: "開発 コア",
    // ⚠️ member_type はあえて一般のまま。staff 判定が role だけで決まることを画面でも確認できる
    memberType: "街人（一般）",
    role: "core_member",
  },
  {
    key: "member",
    email: "dev-member@example.invalid",
    memberId: "00000000-0000-0000-0000-0000000000c3",
    nickname: "開発用街人",
    fullName: "開発 街人",
    memberType: "街人（一般）",
    role: "member",
  },
  {
    key: "guest",
    email: "dev-guest@example.invalid",
    memberId: "00000000-0000-0000-0000-0000000000c4",
    nickname: "開発用ゲスト",
    fullName: "開発 ゲスト",
    memberType: "ゲスト",
    role: "guest",
  },
];

// ── 1. Auth ユーザー（無ければ作る）────────────────────────────
async function ensureAuthUser(email) {
  // listUsers はページングするため、素直に全ページ走査する（dev の件数なら十分速い）
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return { id: hit.id, created: false };
    if (data.users.length < 200) break;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    // 開発環境ではメール確認を挟まない。1-1e（実メール配信）が済むまでの迂回路。
    email_confirm: true,
  });
  if (error) throw error;
  return { id: data.user.id, created: true };
}

const authIds = {};
for (const m of SEED_MEMBERS) {
  const r = await ensureAuthUser(m.email);
  authIds[m.key] = r.id;
  console.log(`auth.users ${r.created ? "作成" : "既存"}: ${m.email}`);
}

// ── 2. members（upsert）────────────────────────────
// ⚠️ **DELETE を使わない。** `0101_revoke_service_role_excess_privileges.sql` が
//    service_role から DELETE を剥いている（DB物理設計 §1「物理削除の原則禁止」）。
//    シードの都合でその原則に穴を開けないので、upsert で冪等性を作る。
//
// ⚠️ 0003 の BEFORE UPDATE ガードは、**権限列（role / auth_user_id /
//    account_status / member_type）が1つも変わらなければ素通りする**。
//    再実行時は同じ値を書くので発火しない。
//    逆に、このスクリプトで role を書き換えたくなったら、**それはガードが正しく拒む**。
//    その場合は member_id を新しく採るか、運営画面の手順を使うこと。
{
  const { error } = await admin.from("members").upsert(
    SEED_MEMBERS.map((m) => ({
      member_id: m.memberId,
      auth_user_id: authIds[m.key],
      nickname: m.nickname,
      member_type: m.memberType,
      role: m.role,
      account_status: "active",
    })),
    { onConflict: "member_id" },
  );
  if (error) throw error;
}
{
  const { error } = await admin
    .from("member_profiles_private")
    .upsert(
      SEED_MEMBERS.map((m) => ({ member_id: m.memberId, full_name: m.fullName })),
      { onConflict: "member_id" },
    );
  if (error) throw error;
}
console.log(`members: ${SEED_MEMBERS.length}件を upsert（個人情報は架空値のみ）`);

// ── 3. クエスト（ボードの表示確認用）─────────────────────────
// guest_allowed を持つ行と持たない行の両方を置く。0008 の v_quest_board が
// ゲストへ description を返さないことを、画面上で確認できるようにするため（v13 §5.10.6）。
const SEED_QUESTS = [
  {
    quest_id: "00000000-0000-0000-0000-0000000000d1",
    title: "【開発用】朝の共用部清掃",
    description: "開発確認用のダミー。ゲストにも開放したクエスト。",
    recruit_count: 2,
    guest_allowed: true,
    reward_uii: 800,
    status: "open",
    created_by: SEED_MEMBERS[0].memberId,
  },
  {
    quest_id: "00000000-0000-0000-0000-0000000000d2",
    title: "【開発用】薪割りと火の管理",
    description: "開発確認用のダミー。ゲストには開放していないクエスト。",
    recruit_count: 1,
    guest_allowed: false,
    reward_uii: 1200,
    status: "open",
    created_by: SEED_MEMBERS[0].memberId,
  },
];
{
  const { error } = await admin.from("quests").upsert(SEED_QUESTS, { onConflict: "quest_id" });
  if (error) throw error;
}
console.log(`quests: ${SEED_QUESTS.length}件を upsert`);

console.log("\n完了。ログイン用の6桁コードは次で取り出す:");
for (const m of SEED_MEMBERS) {
  console.log(`  npm run dev:login-code -- ${m.email}   （${m.role}）`);
}
