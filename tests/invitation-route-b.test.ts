/**
 * 経路B（運営が個別に案内を送る ／ v13 §5.2.6）の単体テスト。
 *
 * WBS `2-1d`（2026-09-22 ／ v13 §9 #67・決定ログ §22-1）で送達手段が
 * **リンク → ログイン画面の案内**へ変わった。ここで固定したいのは次の4点である。
 *
 *   1. **`inviteUserByEmail()` を呼ばない**（リンクが1本も生えない）
 *   2. **本文にログインできる URL・コードを載せない**（載せてよいのはログイン画面の URL だけ）
 *   3. **台帳を先に書く**（送ったのに記録が無い＝追跡できない誤送信を作らない）
 *   4. **`active` な会員へは送れない**（v13 §5.2.6 danger 第4項の乗っ取り経路）
 *
 * CLAUDE.md §4.4 は「認可・個人情報の取り扱いに関わるロジックは必ずテストを書く」と
 * 定めている。招待は**会員番号とメールアドレスの紐付け**そのものなので該当する。
 */

type MemberRow = { member_id: string; account_status: string } | null;

type FakeState = {
  member: MemberRow;
  insertError: { message: string } | null;
  mailResult: { ok: true } | { ok: false; reason: "not_configured" | "send_failed" };
  insertedRows: Record<string, unknown>[];
  sentMails: { to: string; subject: string; body: string }[];
  /** モックに存在しないメソッドを実装が呼んだら記録する（リンク方式への逆戻り検知）。 */
  forbiddenCalls: string[];
};

const state: FakeState = {
  member: null,
  insertError: null,
  mailResult: { ok: true },
  insertedRows: [],
  sentMails: [],
  forbiddenCalls: [],
};

jest.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === "members") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.member, error: null }) }),
          }),
        };
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          state.insertedRows.push(row);
          return { error: state.insertError };
        },
      };
    },
    auth: {
      admin: {
        // ★ 廃止したメソッド。呼ばれたら記録する（例外にすると原因が読みにくい）。
        inviteUserByEmail: async () => {
          state.forbiddenCalls.push("inviteUserByEmail");
          return { error: null };
        },
        createUser: async () => {
          state.forbiddenCalls.push("createUser");
          return { error: null };
        },
      },
    },
  }),
}));

jest.mock("@/lib/mail/resend", () => ({
  sendPlainTextEmail: async (params: { to: string; subject: string; body: string }) => {
    state.sentMails.push(params);
    return state.mailResult;
  },
}));

jest.mock("@/lib/app-url", () => ({
  readAppUrl: () => "https://example.invalid",
  readLoginUrl: () => "https://example.invalid/login",
}));

import { sendInvitation } from "@/lib/auth/invitations";

const PRE_REGISTERED = {
  member_id: "00000000-0000-0000-0000-0000000000d1",
  account_status: "pre_registered",
};

/** 架空の宛先。実在のアドレスを書かない（CLAUDE.md §3.2・§7.1）。 */
const TARGET_EMAIL = "fuyu-invited@example.invalid";
const SENDER_MEMBER_ID = "00000000-0000-0000-0000-0000000000d9";

function invite() {
  return sendInvitation({
    memberId: PRE_REGISTERED.member_id,
    email: TARGET_EMAIL,
    sentByMemberId: SENDER_MEMBER_ID,
  });
}

beforeEach(() => {
  state.member = PRE_REGISTERED;
  state.insertError = null;
  state.mailResult = { ok: true };
  state.insertedRows = [];
  state.sentMails = [];
  state.forbiddenCalls = [];
});

describe("sendInvitation（WBS 2-1d ／ リンクを送らない）", () => {
  test("★ Supabase の招待リンク（inviteUserByEmail）を呼ばない", async () => {
    await invite();
    expect(state.forbiddenCalls).toEqual([]);
  });

  test("案内メールを1通だけ送る", async () => {
    expect(await invite()).toEqual({ ok: true });
    expect(state.sentMails).toHaveLength(1);
    expect(state.sentMails[0].to).toBe(TARGET_EMAIL);
  });

  test("★ 本文に載る URL はログイン画面だけ（トークン付き URL を載せない）", async () => {
    await invite();
    const body = state.sentMails[0].body;

    const urls = body.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(["https://example.invalid/login"]);
    // Supabase のリンク方式が復活すると、この種のクエリが本文へ混ざる。
    expect(body).not.toMatch(/token|access_token|type=(magiclink|invite)/i);
  });

  test("本文にログインの手順と期限が書かれている（運営が口頭で補わなくても届く）", async () => {
    await invite();
    const body = state.sentMails[0].body;
    expect(body).toContain("6桁");
    expect(body).toContain("24時間");
  });

  test("台帳を先に書く（誰へ・どのアドレスへ・期限）", async () => {
    await invite();
    expect(state.insertedRows).toHaveLength(1);
    expect(state.insertedRows[0]).toMatchObject({
      member_id: PRE_REGISTERED.member_id,
      sent_to_email: TARGET_EMAIL,
      sent_by: SENDER_MEMBER_ID,
    });
    expect(typeof state.insertedRows[0].expires_at).toBe("string");
  });

  test("★ active な会員へは送らない（v13 §5.2.6 danger 第4項）", async () => {
    state.member = { member_id: PRE_REGISTERED.member_id, account_status: "active" };

    expect(await invite()).toEqual({ ok: false, reason: "already_active" });
    // 台帳もメールも動かない。ここで漏れると「送ってから拒否」になる。
    expect(state.insertedRows).toHaveLength(0);
    expect(state.sentMails).toHaveLength(0);
  });

  test("存在しない会員には送らない", async () => {
    state.member = null;
    expect(await invite()).toEqual({ ok: false, reason: "member_not_found" });
    expect(state.sentMails).toHaveLength(0);
  });

  test("台帳に書けなければメールを送らない（記録の無い送信を作らない）", async () => {
    state.insertError = { message: "insert failed" };
    expect(await invite()).toEqual({ ok: false, reason: "failed" });
    expect(state.sentMails).toHaveLength(0);
  });

  test("メール未設定は専用の理由を返す（運営が自力で直せる失敗だから）", async () => {
    state.mailResult = { ok: false, reason: "not_configured" };
    expect(await invite()).toEqual({ ok: false, reason: "mail_not_configured" });
    // 台帳の行は残す。招待の窓は開いており、会員が自分でログインを始めれば成立する。
    expect(state.insertedRows).toHaveLength(1);
  });

  test("送信失敗は failed を返す（台帳の行は残す）", async () => {
    state.mailResult = { ok: false, reason: "send_failed" };
    expect(await invite()).toEqual({ ok: false, reason: "failed" });
    expect(state.insertedRows).toHaveLength(1);
  });
});
