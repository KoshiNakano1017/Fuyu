// AI テキストクライアント基盤（WBS 1-5 ／ Issue #55）の受入テスト。
//
// 完了条件1（キーをサーバサイドからのみ読み出す）
// 完了条件3（呼び出しが1モジュールに集約され、呼び出し側が SDK へ直接依存しない）
// 完了条件4（Gemini はテキスト入力のみ。音声・GCS URI の口を持たない）
// 完了条件5（1回の呼び出しで構造化された複数出力を受け取れる）
// 完了条件6（エラー・ログに API キーが出ない）
// 完了条件7（実 API キー無しで通る＝外部呼び出しはモック）
//
// 根拠: v13 §9 #45（AI呼び出しは抽象化して差し替え可能にしておけばよい）、
//       v13 §9 #63（アプリは音声を扱わない。入力は文字起こし済みテキスト）、
//       v13 §5.1 ③・§5.7.4 ②（議事録サマリー・クエスト候補・ナレッジ候補を**同一の1回の呼び出し**で出す。
//       別呼び出しにすると §8 の 60秒要件を圧迫するため）、CLAUDE.md §3.2・§4.4。

import { readFileSync } from "node:fs";

import { createClaudeTextClient } from "@/lib/ai/claude";
import { createGeminiTextClient } from "@/lib/ai/gemini";
import type { StructuredTextRequest, TextAiClient } from "@/lib/ai/types";

import {
  findAiLayerFilesImporting,
  findAiSdkImportsOutsideAiLayer,
  readAiLayerSource,
  readAiLayerSources,
} from "./helpers/ai-sources";

// jest.mock はファイル先頭へ巻き上げられる。ファクトリ内から参照できるのは
// `mock` で始まる名前だけなので、その命名に合わせている。
const mockAnthropicConstructor = jest.fn();
const mockAnthropicCreate = jest.fn();
const mockGeminiConstructor = jest.fn();
const mockGeminiGenerateContent = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: class MockAnthropic {
    messages = { create: mockAnthropicCreate };
    constructor(options: unknown) {
      mockAnthropicConstructor(options);
    }
  },
}));

jest.mock("@google/genai", () => ({
  __esModule: true,
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGeminiGenerateContent };
    constructor(options: unknown) {
      mockGeminiConstructor(options);
    }
  },
}));

/** 実在しないことが一目で分かる値にする。実キーはテストに持ち込まない（完了条件7）。 */
const DUMMY_ANTHROPIC_API_KEY = "sk-ant-dummy-not-a-real-key";
const DUMMY_GEMINI_API_KEY = "gemini-dummy-not-a-real-key";

/**
 * 朝会パイプラインが1回の呼び出しで受け取る構造化出力（v13 §5.1 ③・§5.7.4 ②）。
 * 中身は架空。実データは一切参照しない（CLAUDE.md §7.1）。
 */
type MorningMeetingStructuredOutput = {
  summary: string;
  questCandidates: {
    title: string;
    headcount: number;
    estimatedMinutes: number;
    assigneeCandidates: string[];
  }[];
  knowledgeCandidates: { title: string; body: string }[];
};

const MORNING_MEETING_OUTPUT: MorningMeetingStructuredOutput = {
  summary: "決定事項: 水やり当番を朝7時に統一する。注意点: north 畑の水栓が固い。",
  questCandidates: [
    { title: "北の畑の草刈り", headcount: 2, estimatedMinutes: 60, assigneeCandidates: ["テスト街人A"] },
  ],
  knowledgeCandidates: [{ title: "水やり当番の時刻", body: "朝7時に統一（2026-09-19 朝会）" }],
};

const MORNING_MEETING_REQUEST: StructuredTextRequest = {
  prompt: "以下の文字起こし済みテキストから、議事録サマリー・クエスト候補・ナレッジ候補を抽出してください。",
  schemaName: "morningMeetingStructuredOutput",
  jsonSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      questCandidates: { type: "array" },
      knowledgeCandidates: { type: "array" },
    },
    required: ["summary", "questCandidates", "knowledgeCandidates"],
  },
};

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ANTHROPIC_API_KEY = DUMMY_ANTHROPIC_API_KEY;
  process.env.GEMINI_API_KEY = DUMMY_GEMINI_API_KEY;

  mockAnthropicConstructor.mockClear();
  mockGeminiConstructor.mockClear();
  mockAnthropicCreate.mockReset();
  mockGeminiGenerateContent.mockReset();
  mockAnthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(MORNING_MEETING_OUTPUT) }],
  });
  mockGeminiGenerateContent.mockResolvedValue({ text: JSON.stringify(MORNING_MEETING_OUTPUT) });
});

afterAll(() => {
  process.env = originalEnv;
});

describe("Claude テキストクライアント（完了条件5）", () => {
  test("1回の呼び出しで議事録サマリー・クエスト候補・ナレッジ候補を含む構造化出力を返す", async () => {
    const client = createClaudeTextClient();
    await expect(
      client.generateStructured<MorningMeetingStructuredOutput>(MORNING_MEETING_REQUEST),
    ).resolves.toEqual(MORNING_MEETING_OUTPUT);
  });

  test("構造化出力1件を得るために SDK を呼ぶ回数が1回だけである", async () => {
    // 別呼び出しに割ると §8 の「60秒以内」を圧迫する（v13 §5.7.4 ② の注記）。
    await createClaudeTextClient().generateStructured(MORNING_MEETING_REQUEST);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini テキストクライアント（完了条件5）", () => {
  test("1回の呼び出しで議事録サマリー・クエスト候補・ナレッジ候補を含む構造化出力を返す", async () => {
    const client = createGeminiTextClient();
    await expect(
      client.generateStructured<MorningMeetingStructuredOutput>(MORNING_MEETING_REQUEST),
    ).resolves.toEqual(MORNING_MEETING_OUTPUT);
  });
});

describe("キーの受け渡し（完了条件1）", () => {
  test("Claude クライアントが ANTHROPIC_API_KEY の値を明示的に SDK へ渡す", async () => {
    // 生成が遅延評価でも成り立つよう、1回呼び出したあとに確認する。
    await createClaudeTextClient().generateStructured(MORNING_MEETING_REQUEST);
    expect(mockAnthropicConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: DUMMY_ANTHROPIC_API_KEY }),
    );
  });

  test("Gemini クライアントが GEMINI_API_KEY の値を明示的に SDK へ渡す", async () => {
    // @google/genai は GEMINI_API_KEY と GOOGLE_API_KEY の両方を暗黙に読み、
    // 両方あれば GOOGLE_API_KEY を優先する。どちらのキーで喋っているか分からない状態を作らないため、
    // 環境変数の暗黙読みに任せず明示的に渡す。
    await createGeminiTextClient().generateStructured(MORNING_MEETING_REQUEST);
    expect(mockGeminiConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: DUMMY_GEMINI_API_KEY }),
    );
  });

  test("AI クライアント層が dangerouslyAllowBrowser を設定しない", () => {
    // Anthropic SDK はブラウザ実行を既定で無効にしている。これを外すとキーが利用者へ露出する。
    // 「設定しない」という趣旨のコメントまで拾わないよう、プロパティの形だけを照合する。
    expect(readAiLayerSources()).not.toMatch(/dangerouslyAllowBrowser\s*:/);
  });
});

/** 音声・ファイル入力を思わせるキー。1つでも口があれば §9 #63 に反する。 */
type AudioLikeKey =
  | "audio"
  | "audioGcsUri"
  | "audioUrl"
  | "gcsUri"
  | "fileUri"
  | "fileData"
  | "inlineData"
  | "media";

/** Gemini クライアントが実際に受け取るリクエスト型。 */
type GeminiRequest = Parameters<ReturnType<typeof createGeminiTextClient>["generateStructured"]>[0];

/** 音声の口を1つでも持つと `false` になり、下の `= true` の代入が型エラーになる。 */
type GeminiAcceptsTextOnly = Extract<keyof GeminiRequest, AudioLikeKey> extends never ? true : false;

describe("音声を扱わない（完了条件4 ／ v13 §9 #63）", () => {
  test("Gemini クライアントの入力型が音声・GCS URI を渡す口を持たない", () => {
    // 実質の検証は `tsc --noEmit`（CLAUDE.md §6.2）が行う。
    // 型が音声入力を受け付けた瞬間、この代入がコンパイルを通らなくなる。
    const acceptsTextOnly: GeminiAcceptsTextOnly = true;
    expect(acceptsTextOnly).toBe(true);
  });

  test("Gemini クライアントのソースが GCS URI・音声入力の口を1つも参照しない", () => {
    // v13 §5.1 ② の「GCS URI を Gemini へ直接渡す」設計は §9 #63 で失効している。
    const source = readAiLayerSource("gemini.ts");
    const audioReferences = ["gs://", "audio/", "inlineData", "fileUri", "fileData"].filter((token) =>
      source.includes(token),
    );
    expect(audioReferences).toEqual([]);
  });
});

describe("抽象化と差し替え可能性（完了条件3 ／ v13 §9 #45）", () => {
  test("AI クライアント層の外側に AI の SDK を import しているモジュールが1つも無い", () => {
    expect(findAiSdkImportsOutsideAiLayer()).toEqual([]);
  });

  test("Anthropic SDK を import するファイルが AI クライアント層に1つだけである", () => {
    expect(findAiLayerFilesImporting("@anthropic-ai/sdk")).toEqual(["claude.ts"]);
  });

  test("Gemini SDK を import するファイルが AI クライアント層に1つだけである", () => {
    expect(findAiLayerFilesImporting("@google/genai")).toEqual(["gemini.ts"]);
  });

  test("共通インタフェース types.ts が AI の SDK を1つも import しない", () => {
    // ここが SDK に依存した瞬間、インタフェースが実装の形に引きずられ差し替えられなくなる。
    const source = readAiLayerSource("types.ts");
    expect(["@anthropic-ai/", "@google/"].filter((pkg) => source.includes(pkg))).toEqual([]);
  });

  test("TextAiClient のスタブを渡せば呼び出し側のコードを変えずに応答を差し替えられる", async () => {
    // `4-2` 以降の呼び出し側を模した関数。依存先は TextAiClient だけで SDK ではない。
    const summarizeMorningMeeting = (client: TextAiClient) =>
      client.generateStructured<MorningMeetingStructuredOutput>(MORNING_MEETING_REQUEST);

    const stub: TextAiClient = {
      generateStructured: async <T,>() => MORNING_MEETING_OUTPUT as unknown as T,
    };

    await expect(summarizeMorningMeeting(stub)).resolves.toEqual(MORNING_MEETING_OUTPUT);
  });
});

describe("キーをログ・エラーへ出さない（完了条件6 ／ CLAUDE.md §3.2）", () => {
  test("SDK が送出したエラーに API キーが載っていても、再送出されるエラーには含まれない", async () => {
    // SDK やプロキシが返すエラー文へキーが混ざる事故を想定する。
    // public リポジトリでは Actions のログも公開されるため、ここで必ず落とす（CLAUDE.md §6.4）。
    mockAnthropicCreate.mockRejectedValue(
      new Error(`401 authentication_error: x-api-key ${DUMMY_ANTHROPIC_API_KEY} is invalid`),
    );

    const thrown = await createClaudeTextClient()
      .generateStructured(MORNING_MEETING_REQUEST)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(String(thrown)).not.toContain(DUMMY_ANTHROPIC_API_KEY);
  });

  test("AI クライアント層がデバッグログ出力を有効にしない", () => {
    // Anthropic SDK の logLevel: 'debug' はリクエスト／レスポンスのボディごと出力し、
    // 「ボディ内の機密は見えうる」と公式が明記している。ANTHROPIC_LOG でも同じ状態になる。
    const source = readAiLayerSources();
    const debugSwitches = [/logLevel\s*:\s*["']debug["']/, /ANTHROPIC_LOG["'\]]?\s*=[^=]/].filter((pattern) =>
      pattern.test(source),
    );
    expect(debugSwitches).toEqual([]);
  });
});

describe("実 API キー無しで通る（完了条件7 ／ CLAUDE.md §4.4・§6.1）", () => {
  test("このテストが両方の AI SDK をモックしており実 API を呼ばない", () => {
    const source = readFileSync(__filename, "utf8");
    const unmocked = ["@anthropic-ai/sdk", "@google/genai"].filter(
      (packageName) => !source.includes(`jest.mock("${packageName}"`),
    );
    expect(unmocked).toEqual([]);
  });

  test("環境に実キーがあってもテストはダミーへ上書きしてから実行される", () => {
    // next/jest は `.env` を process.env へ読み込む。開発者の手元では実キーが入りうるため、
    // 実キーが assertion やログに混ざらないよう beforeEach で必ず上書きしている。
    expect(process.env.ANTHROPIC_API_KEY).toBe(DUMMY_ANTHROPIC_API_KEY);
  });
});
