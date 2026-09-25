// 名寄せ 運営承認キューの画面まわりの受入テスト（WBS 10-2 ／ v13 §5.8.3 ①）。
//
// 固定する完了条件:
//  1 画面は staff 限定（`member_identifiers` と同じ幅。照合キー＝PII-A を出す画面である）
//  2 候補は選択肢から選ぶ（会員IDを手打ちさせない＝引き継ぎ事故を防ぐ）
//  3 結合済み・本登録済みの候補は選べない（名寄せを奪取の経路にしない）
//  4 承認は RPC 1本（結合・監査・キューの決着を分けない）
//  5 却下は理由必須
//  6 引き継ぎの重さを画面に明記する（宿泊券・Uii残高・XP が移る）
//  7 ナビへタブを足さない（§5.9.5）
//
// なぜソースを文字列として読むのか:
//   「手打ちさせていない」「分けていない」は**書かれていないこと**を固定する条件であり、
//   実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AREAS } from "@/lib/auth/navigation";

import { SRC_DIR } from "./helpers/ai-sources";

const PAGE = join(SRC_DIR, "app", "admin", "members", "link-requests", "page.tsx");
const ACTIONS = join(SRC_DIR, "app", "admin", "members", "link-requests", "actions.ts");
const QUEUE = join(SRC_DIR, "components", "members", "LinkRequestQueue.tsx");
const DASHBOARD = join(SRC_DIR, "app", "admin", "page.tsx");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("キューは staff 限定（照合キー＝PII-A を出す画面 ／ §6-1）", () => {
  test("画面が requireStaff() を通る", () => {
    expect(readCode(PAGE)).toContain("requireStaff()");
  });

  test("Server Action も staff だけを通す", () => {
    const actions = readCode(ACTIONS);
    expect(actions).toContain('viewer.role !== "admin" && viewer.role !== "core_member"');
  });
});

describe("★ 候補は選択肢から選ぶ（会員IDを手打ちさせない）", () => {
  const queue = readCode(QUEUE);

  test("`select` で候補を出す", () => {
    expect(queue).toContain('<select');
    expect(queue).toContain('name="memberId"');
    // テキスト入力で会員IDを受け取る形にしない
    expect(queue).not.toContain('type="text"\n          name="memberId"');
  });

  test("★ 結合済み・本登録済みの候補は選べない", () => {
    expect(queue).toContain("!candidate.isBound");
    expect(queue).toContain('candidate.accountStatus === "pre_registered"');
  });

  test("選べる候補が無いときは却下へ誘導する", () => {
    expect(queue).toContain("いま選べる候補がありません");
  });

  test("サーバ側でも候補に含まれるかを確かめる", () => {
    // 画面の選択肢を書き換えて送られても、決着の直前に弾く。
    expect(readCode(ACTIONS)).toContain("not_candidate");
  });
});

describe("★ 承認は RPC 1本で行う（結合・監査・キューの決着を分けない）", () => {
  const actions = readCode(ACTIONS);

  test("Action は members / member_link_requests を直接更新しない", () => {
    for (const table of ["members", "member_link_events"]) {
      expect(actions).not.toContain(`from("${table}")`);
    }
  });

  test("成立は `linkMemberByMatching()` に通し、申請IDを渡す", () => {
    expect(actions).toContain("linkMemberByMatching({");
    expect(actions).toContain("requestId,");
  });

  test("根拠（誰がどの候補から選んだか）を渡す", () => {
    expect(actions).toContain("approvalMatchBasis({");
    expect(actions).toContain("decidedBy: viewer.memberId");
  });
});

describe("却下は理由必須（§5.8.3 ③ の監査の一部）", () => {
  test("画面の入力が必須である", () => {
    const queue = readCode(QUEUE);
    const rejectForm = queue.slice(queue.indexOf("submitReject"));
    expect(rejectForm).toContain("required");
  });

  test("Action も空の理由を弾く", () => {
    expect(readCode(ACTIONS)).toContain('reason.trim() === ""');
  });
});

describe("★ 引き継ぎの重さを画面に明記する（§5.8.3 の [!warning]）", () => {
  const page = read(PAGE);

  test("宿泊券・Uii残高・XP が移ることを書いている", () => {
    expect(page).toContain("宿泊券・Uii残高・XP");
  });

  test("候補が複数なら自動連携しないことを書いている", () => {
    expect(page).toContain("自動で連携せず");
  });

  test("判断が監査ログに残ることを書いている", () => {
    expect(page).toContain("監査ログ");
  });
});

describe("ナビへタブを足さない（v13 §5.9.5）", () => {
  test("`AREAS` に /admin/members/link-requests を足していない", () => {
    expect(AREAS.map((area) => area.path)).not.toContain("/admin/members/link-requests");
  });

  test("管理ダッシュボードから到達できる（空振りを作らない）", () => {
    expect(read(DASHBOARD)).toContain('href="/admin/members/link-requests"');
  });
});
