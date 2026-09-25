// 名寄せの初回アクセス導線（WBS 10-2 の決定 B ／ ログイン画面）の受入テスト。
//
// 固定する完了条件（v13 §5.8.3 STEP 2）:
//  1 事前登録済みの会員は、招待が無くてもログインのコードを受け取れる（＝名寄せへ入れる）
//  2 招待台帳を先に見て、無い相手だけ名寄せへ回す
//  3 候補件数・候補の有無を利用者向けの文言に出さない（他人の登録状況が漏れる）
//  4 名寄せが成立しなかったらサインアウトする（半端に入った状態で回遊させない）
//  5 `service_role` を使うのは名寄せの DB 層だけである
//
// なぜソースを文字列として読むのか:
//   「漏らしていない」「service_role を持ち込んでいない」は**書かれていないこと**を固定する
//   条件であり、実行時の振る舞いでは捕まえにくい（CLAUDE.md §4.4）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SRC_DIR } from "./helpers/ai-sources";

const LOGIN_ACTIONS = join(SRC_DIR, "app", "login", "actions.ts");
const MATCHING = join(SRC_DIR, "lib", "members", "matching.ts");
const MATCHING_STORE = join(SRC_DIR, "lib", "members", "matching-store.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function readCode(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("事前登録済みの会員がログインできる（v13 §5.8.3 STEP 2）", () => {
  const actions = readCode(LOGIN_ACTIONS);

  test("★ コード送信のゲートが招待と名寄せ候補の両方を許す", () => {
    // ここが招待だけだと、移行370名の大半が初回ログインできない。
    expect(actions).toContain("hasUsableInvitation(email)");
    expect(actions).toContain("hasMatchableIdentifier(email)");
    expect(actions).toContain("shouldCreateUser: invited || matchable");
  });

  test("招待台帳を先に見て、無い相手だけ名寄せへ回す", () => {
    expect(actions).toContain("bindAuthUserToMember(data.user.id, email)");
    expect(actions).toContain('bound.reason !== "no_member_for_email"');
    expect(actions).toContain("linkByMatching(data.user.id, email)");
  });

  test("OTP を通ったことを本人確認として渡す（§5.8.3 ②）", () => {
    expect(actions).toContain("isActorVerified: true");
  });
});

describe("★ 候補の有無・件数を利用者へ漏らさない（§5.8.3 の [!warning]）", () => {
  const actions = read(LOGIN_ACTIONS);

  test("利用者向けの文言に候補件数が出ない", () => {
    // 「2件見つかりました」と返すと、同姓同名・家族の連絡先共有が推測できる。
    const messages = [...actions.matchAll(/message:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const message of messages) {
      expect(message).not.toMatch(/\d+件/);
      expect(message).not.toContain("候補");
    }
  });

  test("名寄せの関数は理由を区別せず null を返す", () => {
    const code = readCode(LOGIN_ACTIONS);
    const fn = code.slice(code.indexOf("async function linkByMatching"));
    // `queue` でも `none` でも同じ `null` を返す＝呼び出し側は文言を分けられない。
    expect(fn).toContain("return null;");
    // 件数を返り値や文言に載せない（運営向けのキューへ渡すだけ）。
    expect(fn).not.toContain("message");
    const countUses = [...fn.matchAll(/candidateCount/g)].length;
    const enqueueBlock = fn.slice(fn.indexOf("enqueueLinkRequest"), fn.indexOf("return null;", fn.indexOf("enqueueLinkRequest")));
    expect(enqueueBlock).toContain("candidateCount: decision.candidateCount");
    // 使っているのは enqueue の1箇所だけ
    expect(countUses).toBe(2);
  });
});

describe("名寄せが成立しなければサインアウトする", () => {
  test("半端に入った状態で回遊させない", () => {
    const actions = readCode(LOGIN_ACTIONS);
    const failure = actions.slice(actions.indexOf("memberId === null"));
    expect(failure).toContain("supabase.auth.signOut()");
  });
});

describe("★ service_role を使うのは名寄せの DB 層だけである", () => {
  test("ログインの Action は service_role を直接触らない", () => {
    expect(readCode(LOGIN_ACTIONS)).not.toContain("createAdminSupabaseClient");
  });

  test("判定の純関数は DB にも Supabase にも依存しない", () => {
    const matching = readCode(MATCHING);
    expect(matching).not.toContain("supabase");
    expect(matching).not.toContain("createAdminSupabaseClient");
  });

  test("DB 層だけが service_role を使い、理由がコメントで説明されている", () => {
    expect(readCode(MATCHING_STORE)).toContain("createAdminSupabaseClient");
    expect(read(MATCHING_STORE)).toContain("まだ `members` へ結合されていない");
  });
});

describe("名寄せの成立は監査とセットで行う（§5.8.3 ③）", () => {
  test("DB 層は RPC を呼ぶ（アプリ側で結合と監査を分けない）", () => {
    expect(readCode(MATCHING_STORE)).toContain('rpc("link_member_by_matching"');
  });

  test("根拠を必ず渡す", () => {
    expect(readCode(MATCHING_STORE)).toContain("p_match_basis: params.matchBasis");
  });
});
