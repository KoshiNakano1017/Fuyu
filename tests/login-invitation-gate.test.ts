/**
 * ログインのコード送信が `auth.users` の新規作成を許す条件（WBS `2-1d`）。
 *
 * コード方式化（決定ログ §22-1）で、招待メールからリンクもコードも消えた。
 * 会員は案内を読んでログイン画面へ来るため、**初回は `auth.users` がまだ無い**
 * （v13 §5.2.6 手順3・4）。したがって `shouldCreateUser` を固定値にできない。
 *
 * ここで固定するのは「**台帳に未消費・期限内の招待があるアドレスだけが
 * 作成を許される**」ことと、「**判定結果が画面の応答に漏れない**」ことである。
 * 後者が漏れると、応答の差から**どのアドレスが招待済みかを総当たりで特定できる**。
 */

type FakeState = {
  invited: boolean;
  otpCalls: { email: string; options?: { shouldCreateUser?: boolean } }[];
  otpError: { message: string } | null;
};

const state: FakeState = { invited: false, otpCalls: [], otpError: null };

jest.mock("@/lib/auth/invitations", () => ({
  hasUsableInvitation: async () => state.invited,
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
  state.otpCalls = [];
  state.otpError = null;
});

describe("requestLoginCode（招待済みだけ auth.users を作れる ／ WBS 2-1d）", () => {
  test("★ 招待台帳に有効な行があるアドレスは shouldCreateUser: true で送る", async () => {
    state.invited = true;
    await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(state.otpCalls).toEqual([{ email: EMAIL, options: { shouldCreateUser: true } }]);
  });

  test("★ 招待が無いアドレスは shouldCreateUser: false（勝手に利用者を生やさない）", async () => {
    state.invited = false;
    await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    expect(state.otpCalls).toEqual([{ email: EMAIL, options: { shouldCreateUser: false } }]);
  });

  test("★ 招待の有無で応答が変わらない（アドレスの存在を漏らさない）", async () => {
    state.invited = true;
    const invitedResult = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));
    state.invited = false;
    const notInvitedResult = await requestLoginCode({ status: "idle" }, formDataOf(EMAIL));

    expect(invitedResult).toEqual(notInvitedResult);
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
