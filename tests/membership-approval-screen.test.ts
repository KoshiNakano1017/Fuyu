// 街人登録 申請一覧（C7）の画面まわりの受入テスト（WBS 12-2 ／ v13 §5.10.4・§5.10.7・§6）。
//
// 固定する完了条件:
//  1 画面は admin 限定である（§6「申請一覧は admin」。`core_member` には開けない）
//  2 現金の申込にQR発行を出さない（§5.10.7 の二重受領防止）
//  3 決済の記録が無い申込に承認を出さない（§5.10.4「受領記録・入金確認が承認の前提」）
//  4 却下は理由必須
//  5 承認は**RPC 1本**で行う（アプリ側で4回に分けない ／ 二重付与の余地を作らない）
//  6 `service_role` を使うのは承認だけである
//  7 ナビへタブを足さない（§5.9.5「管理者に12タブを平置きしない」）
//
// なぜソースを文字列として読むのか:
//   「出していない」「分けていない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AREAS } from "@/lib/auth/navigation";

import { SRC_DIR } from "./helpers/ai-sources";

const PAGE = join(SRC_DIR, "app", "admin", "membership", "page.tsx");
const ACTIONS = join(SRC_DIR, "app", "admin", "membership", "actions.ts");
const BOARD = join(SRC_DIR, "components", "membership", "ApplicationBoard.tsx");
const STORE = join(SRC_DIR, "lib", "membership", "approval-store.ts");
const DASHBOARD = join(SRC_DIR, "app", "admin", "page.tsx");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** コメントを落としたソース。説明として名前を挙げたコメントで誤検知しないため。 */
function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("申請一覧は admin 限定（v13 §6）", () => {
  test("画面が requireAdmin() を通る（requireStaff ではない）", () => {
    const page = readCode(PAGE);
    expect(page).toContain("requireAdmin()");
    expect(page).not.toContain("requireStaff");
  });

  test("Server Action も admin だけを通す", () => {
    const actions = readCode(ACTIONS);
    expect(actions).toContain('viewer.role !== "admin"');
    // 伝票まわり（7-2）と違い core_member を含めない
    expect(actions).not.toContain('viewer.role === "core_member"');
  });
});

describe("押せる操作だけを出す（v13 §5.10.4・§5.10.7）", () => {
  const board = readCode(BOARD);

  test("★ 現金の申込にはQR発行フォームを出さない", () => {
    expect(board).toContain('application.paymentMethod === "cash"');
    expect(board).toContain("現金を選んだ申込にはQRを発行できません");
  });

  test("★ 決済の記録が無い申込には承認ボタンを出さない", () => {
    expect(board).toContain("hasPaymentRecord");
    expect(board).toContain("受領を記録すると");
  });

  test("承認済み・却下の行には操作を出さない", () => {
    expect(board).toContain("isTerminal");
  });

  test("却下の理由入力が必須である", () => {
    const rejectForm = board.slice(board.indexOf("submitReject"));
    expect(rejectForm).toContain("required");
  });

  test("状態ごとに分けて並べる（何をすべき行かを読み直さない）", () => {
    for (const status of ["申込中", "QR送付済み", "保留", "承認済み", "却下"]) {
      expect(board).toContain(`"${status}"`);
    }
  });
});

describe("★ 承認は RPC 1本で行う（二重付与の余地を作らない）", () => {
  const actions = readCode(ACTIONS);
  const store = readCode(STORE);

  test("Server Action は承認処理を自分で組み立てない", () => {
    // 昇格・宿泊券付与・キャッシュバック起票をアプリ側で書くと、
    // 途中で落ちたときに「権限は上がったが宿泊券が無い」が残る。
    // テーブルを直接触っていないことを見る（`membership` は `members` を部分文字列に含むため、
    // 素朴な部分一致ではなく `from("…")` の形で確かめる）。
    for (const table of ["members", "stay_ticket_transactions", "eumo_grants", "membership_plans"]) {
      expect(actions).not.toContain(`from("${table}")`);
    }
  });

  test("store は RPC を呼ぶ", () => {
    expect(store).toContain('rpc("approve_membership_application"');
  });

  test("承認以外の操作は RPC を使わない（RLS で足りる）", () => {
    const beforeApprove = store.slice(0, store.indexOf("approveApplication"));
    expect(beforeApprove).not.toContain("rpc(");
  });
});

describe("★ service_role を使うのは承認だけである", () => {
  const store = readCode(STORE);

  test("一覧・QR発行・受領記録・却下は anon キー ＋ RLS で行う", () => {
    // `createServerSupabaseClient` の呼び出しが複数あり、`createAdminSupabaseClient` は1つだけ。
    const serverCalls = (store.match(/createServerSupabaseClient\(\)/g) ?? []).length;
    const adminCalls = (store.match(/createAdminSupabaseClient\(\)/g) ?? []).length;
    expect(serverCalls).toBeGreaterThanOrEqual(5);
    expect(adminCalls).toBe(1);
  });

  test("admin クライアントを使うのは承認の関数の中だけである", () => {
    const approveBody = store.slice(store.indexOf("export async function approveApplication"));
    expect(approveBody).toContain("createAdminSupabaseClient()");
  });
});

describe("DB のエラー文をそのまま画面へ出さない（CLAUDE.md §3.2）", () => {
  test("store は例外メッセージを返さない", () => {
    const store = readCode(STORE);
    expect(store).not.toContain("error.message");
  });
});

describe("ナビへタブを足さない（v13 §5.9.5）", () => {
  test("`AREAS` に /admin/membership を足していない", () => {
    expect(AREAS.map((area) => area.path)).not.toContain("/admin/membership");
  });

  test("管理ダッシュボードから到達できる（空振りを作らない）", () => {
    expect(read(DASHBOARD)).toContain('href="/admin/membership"');
  });
});
