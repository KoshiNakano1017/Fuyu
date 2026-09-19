// AI基盤の APIキー読み出し（WBS 1-5 ／ Issue #55）の受入テスト。
//
// 完了条件1（サーバサイド専用・NEXT_PUBLIC_ 接頭辞を持たない）
// 完了条件2（未設定は import 時ではなく利用時に、変数名を含むエラー）
// 完了条件8（.env.example の GEMINI_API_KEY 説明が音声・マルチモーダルを前提としない）
//
// 根拠: CLAUDE.md §3.2（キーは環境変数経由・ログに出さない）、
//       `src/lib/supabase/env.ts` の既存の作法（CLAUDE.md §4.3）、
//       v13 §9 #63（2026-09-05 決定：アプリは音声を扱わない）。

import { readAnthropicApiKey, readGeminiApiKey } from "@/lib/ai/env";

import { readAiLayerSources, readEnvExampleComment } from "./helpers/ai-sources";

// 各テストで process.env を書き換えるため、実行後に必ず元へ戻す
// （`tests/supabase-env.test.ts` と同じ手当て）。
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("readAnthropicApiKey（完了条件2）", () => {
  test("ANTHROPIC_API_KEY が設定されていればその値を返す", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-for-test";
    expect(readAnthropicApiKey()).toBe("sk-ant-dummy-for-test");
  });

  test("ANTHROPIC_API_KEY が未設定なら変数名を含む例外を投げる", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => readAnthropicApiKey()).toThrow("ANTHROPIC_API_KEY");
  });

  test("ANTHROPIC_API_KEY が空文字なら未設定として扱い例外を投げる", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => readAnthropicApiKey()).toThrow("ANTHROPIC_API_KEY");
  });
});

describe("readGeminiApiKey（完了条件2）", () => {
  test("GEMINI_API_KEY が設定されていればその値を返す", () => {
    process.env.GEMINI_API_KEY = "gemini-dummy-for-test";
    expect(readGeminiApiKey()).toBe("gemini-dummy-for-test");
  });

  test("GEMINI_API_KEY が未設定なら変数名を含む例外を投げる", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => readGeminiApiKey()).toThrow("GEMINI_API_KEY");
  });

  test("GEMINI_API_KEY が空文字なら未設定として扱い例外を投げる", () => {
    process.env.GEMINI_API_KEY = "";
    expect(() => readGeminiApiKey()).toThrow("GEMINI_API_KEY");
  });
});

describe("失敗する時点（完了条件2）", () => {
  test("両キーが未設定でも env モジュールの読み込み自体は例外を投げない", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;

    expect(() =>
      jest.isolateModules(() => {
        // モジュールキャッシュを外して「import そのもの」を再実行するため require を使う。
        // 静的 import ではファイル先頭で1度評価されるだけで、この条件を検証できない。
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@/lib/ai/env");
      }),
    ).not.toThrow();
  });
});

describe("キーの露出（完了条件1）", () => {
  test("AI クライアント層が NEXT_PUBLIC_ 接頭辞の環境変数を1つも読まない", () => {
    // NEXT_PUBLIC_ を付けた時点でブラウザのバンドルに値が焼き込まれ、public リポジトリ以前に
    // 利用者から抽出できてしまう（CLAUDE.md §3.2、.env.example L47 の注記と同じ理由）。
    // 地の文の言及まで拾わないよう、環境変数の読み出しの形だけを照合する。
    expect(readAiLayerSources()).not.toMatch(/process\.env\s*[.[]\s*"?'?NEXT_PUBLIC_/);
  });
});

describe(".env.example の追随（完了条件8）", () => {
  test("GEMINI_API_KEY の説明に「音声」「マルチモーダル」が含まれない", () => {
    // v13 §9 #63（2026-09-05 オーナー決定）でアプリは音声を扱わないと確定している。
    const comment = readEnvExampleComment("GEMINI_API_KEY");
    const outdatedWords = ["音声", "マルチモーダル"].filter((word) => comment.includes(word));
    expect(outdatedWords).toEqual([]);
  });
});
