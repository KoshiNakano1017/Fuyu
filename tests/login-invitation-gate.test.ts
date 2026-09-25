/**
 * ログインのコード送信が `auth.users` の新規作成を許す条件（WBS `2-1d` ＋ `10-2`）。
 *
 * コード方式化（決定ログ §22-1）で、招待メールからリンクもコードも消えた。
 * 会員は案内を読んでログイン画面へ来るため、**初回は `auth.users` がまだ無い**
 * （v13 §5.2.6 手順3・4）。したがって `shouldCreateUser` を固定値にできない。
 *
 * ここで固定するのは「**既知の会員のアドレスだけが作成を許される**」ことと、
 * 「**判定結果が画面の応答に漏れない**」ことである。
 * 後者が漏れると、応答の差から**どのアドレスが登録済みかを総当たりで特定できる**。
 *
 * ## 2026-09-25（WBS 10-2）：許可の条件が2つになった
 *
 * 招待台帳（経路B）に加えて、**名寄せの候補があるアドレス**も作成を許す
 * （v13 §5.8.3 の初回アクセス導線。招待だけだと移行370名の大半がログインできない）。
 * どちらも「その連絡先が既知の会員のものである」ことを確かめた上での許可であり、
 * 見知らぬ相手に `auth.users` を作らせない趣旨は変わらない。
 */

type FakeState = {
  invited: boolean;
  /** 名寄せの候補があるアドレスか（WBS 10-2） */
  matchable: boolean;
  otpCalls: { email: string; options?: { shouldCreateUser?: boolean } }[];
  otpError: { message: string } | null;
};

const state: FakeState = { invited: false, matchable: false, otpCalls: [], otpError: null };

jest.mock("@/lib/auth/invitations", () => ({
  hasUsableInvitation: async () => state.invited,
}));

// 名寄せの照会は `service_role` を使うため、ここでは差し替える
// （実キーが無い環境＝CI で `createAdminSupabaseClient()` が例外になる）。
jest.mock("@/lib/members/matching-store", () => ({
  hasMatchableIdentifier: async () => state.matchable,
}));

jest.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: {
      signInWithOtp: async (params: {
        email: string;
        options?: { shouldCreateUser?: boolean };
      }) => {
        state.otpCalls.push(params);
        return { error: state.otpError };
      },
    },
  }),
}));

import { requestLoginCode } from "@/app/login/actions";

const EMAIL = "fuyu-invited@example.invalid";

function formDataOf(email: string): FormData {
  const form = new FormData();
  form.set("email", email);
  return form;
}

beforeEach(() => {
  state.invited = false;
  state.matchable = false;
  state.otpCalls = [];
  state.otpError = null;
});

describe("requestLoginCode（招待済みだけ auth.users を作れる ／ WBS 2-1d）", () => {
  test("★ 招待台帳に有効な行があるアドレスは shouldCreateUser: true で送る", async () => {
    state.invited = true;
    await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(state.otpCalls).toEqual([{ email: EMAIL, options: { shouldCreateUser: true } }]);
  });

  test("★ 招待も名寄せ候補も無いアドレスは shouldCreateUser: false（勝手に利用者を生やさない）", async () => {
    state.invited = false;
    state.matchable = false;
    await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(state.otpCalls).toEqual([{ email: EMAIL, options: { shouldCreateUser: false } }]);
  });

  test("★ 名寄せの候補があるアドレスは招待が無くても送れる（WBS 10-2 ／ v13 §5.8.3）", async () => {
    // これが false のままだと、移行370名の大半が初回ログインできない
    // （招待は経路B専用であり、事前登録済みの会員には配られていない）。
    state.invited = false;
    state.matchable = true;
    await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(state.otpCalls).toEqual([{ email: EMAIL, options: { shouldCreateUser: true } }]);
  });

  test("★ 招待・名寄せ候補の有無で応答が変わらない（アドレスの存在を漏らさない）", async () => {
    state.invited = true;
    const invitedResult = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    state.invited = false;
    state.matchable = true;
    const matchableResult = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    state.matchable = false;
    const unknownResult = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));

    expect(invitedResult).toEqual(unknownResult);
    expect(matchableResult).toEqual(unknownResult);
    expect(invitedResult.status).toBe("code_sent");
  });

  test("Supabase 側が失敗しても同じ応答を返す（理由を漏らさない）", async () => {
    state.otpError = { message: "user not found" };
    const result = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(result).toEqual({ status: "code_sent" });
  });

  test("アドレス未入力は送信せずに入力を促す", async () => {
    const result = await requestLoginCode({ status: "idle" }, formDataOf(""));
    expect(result.status).toBe("error");
    expect(state.otpCalls).toHaveLength(0);
  });
});
