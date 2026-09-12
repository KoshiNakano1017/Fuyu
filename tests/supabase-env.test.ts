import { readSupabaseAnonKey, readSupabaseUrl } from "@/lib/supabase/env";

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
