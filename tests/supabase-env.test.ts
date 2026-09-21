import {
  readOptionalSupabaseConnection,
  readSupabaseAnonKey,
  readSupabaseUrl,
} from "@/lib/supabase/env";

// 各テストで process.env を書き換えるため、実行後に必ず元へ戻す。
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("readSupabaseUrl", () => {
  test("環境変数が設定されていればその値を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    expect(readSupabaseUrl()).toBe("https://example.supabase.co");
  });

  test("環境変数が未設定なら変数名を含む例外を投げる", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => readSupabaseUrl()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
  });

  test("環境変数が空文字なら未設定として扱い例外を投げる", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    expect(() => readSupabaseUrl()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
  });
});

describe("readSupabaseAnonKey", () => {
  test("環境変数が設定されていればその値を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-test";
    expect(readSupabaseAnonKey()).toBe("anon-key-for-test");
  });

  test("環境変数が未設定なら変数名を含む例外を投げる", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => readSupabaseAnonKey()).toThrow("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});

// middleware は matcher が全経路のため、例外を投げると `/api/health` を含む
// すべてのリクエストが 500 になる（2026-09-21 の本番障害）。
// 「未設定でも throw しない」ことがこの関数の存在理由なので、そこを固定する。
describe("readOptionalSupabaseConnection（middleware 用・throw しない）", () => {
  test("両方そろっていれば接続情報を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-test";
    expect(readOptionalSupabaseConnection()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key-for-test",
    });
  });

  test("URL が未設定なら例外ではなく null を返す", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-test";
    expect(readOptionalSupabaseConnection()).toBeNull();
  });

  test("anon キーが未設定なら例外ではなく null を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(readOptionalSupabaseConnection()).toBeNull();
  });

  test("空文字は未設定として扱い null を返す", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    expect(readOptionalSupabaseConnection()).toBeNull();
  });
});
