// middleware が環境変数の欠落でサイト全体を落とさないことを固定する。
//
// 2026-09-21 の本番障害の再発検査。Vercel へ NEXT_PUBLIC_* を入れる前のビルドが
// 本番に出た結果、middleware が起動時に throw し、Vercel が全経路へ
// `MIDDLEWARE_INVOCATION_FAILED`（500）を返した。matcher が静的アセット以外の
// 全経路であるため、死活監視の `/api/health` まで巻き添えで落ち、
// 外形監視からは原因が環境変数1つであることが分からなかった。
//
// ここで確かめるのは「素通りすること」だけで、**認可の話ではない**。
// middleware はセッション Cookie を付け替えるだけであり、認可は各ページ・各
// Route Handler が `readViewer()` を使って別途行う（`src/middleware.ts` 冒頭）。

import { NextRequest } from "next/server";

import { middleware } from "@/middleware";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("環境変数が欠けているとき", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // 欠落時の console.error は意図した動作。テスト出力を汚さないよう黙らせる
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("例外を投げずに応答を返す", async () => {
    const response = await middleware(new NextRequest("https://example.test/api/health"));
    expect(response.status).toBe(200);
  });

  test("原因を追えるよう変数名をログに出す", async () => {
    await middleware(new NextRequest("https://example.test/"));
    expect(jest.mocked(console.error).mock.calls[0]?.[0]).toContain(
      "NEXT_PUBLIC_SUPABASE_URL",
    );
  });

  test("値そのものはログに出さない（CLAUDE.md §3.2）", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://secret-project.supabase.co";
    await middleware(new NextRequest("https://example.test/"));
    expect(jest.mocked(console.error).mock.calls[0]?.[0]).not.toContain("secret-project");
  });
});
