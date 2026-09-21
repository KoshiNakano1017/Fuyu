/**
 * 議事録の構造化 ＋ クエスト候補・ナレッジ候補の起案（WBS 4-2）。
 *
 * 根拠: v13 §5.1 ②（決定事項・共有事項・注意点を整理した議事録サマリー）、
 *       v13 §5.1 ③（**②と同一のAPI呼び出しで**クエスト候補JSONを同時出力）、
 *       v13 §5.7.4 ②（ナレッジ候補も**同じ1回の呼び出し**に相乗りさせる。
 *         別呼び出しにすると非機能 P3 の60秒を圧迫する）、
 *       v13 §9 #63（アプリは音声を扱わない。入力は投入済みのテキストのみ）。
 *
 * ## 呼び出しは必ず1回にする
 *
 * 「議事録」「クエスト候補」「ナレッジ候補」を別々に頼むと、
 * 同じ本文を3回モデルへ送ることになり、**費用も待ち時間も3倍**になる。
 * 非機能 P3 は「テキスト投入から60秒以内」（v13 §9 #63 により起点が
 * 「録音終了から」→「テキスト投入から」へ改まった）であり、3回呼ぶ余裕はない。
 *
 * ## 使うモデル
 *
 * 朝会だけは Gemini である（`CONSOLIDATED_DECISIONS.md`：メディア解析のエンジンを
 * Claude へ寄せた 2026-08-29 の決定でも「**朝会は Gemini のまま**」と明記されている）。
 * Gemini は `responseJsonSchema` によって**モデル側で**構造化出力を強制できるため、
 * プロンプトで JSON を頼む方式より壊れた出力が出にくい。
 *
 * ## 依存を引数で受け取る理由
 *
 * `TextAiClient` を内部で生成すると、テストが実際の API を叩いてしまう。
 * 呼び出し側（Server Action）が組み立てて渡す。
 */

import type { JsonSchema, StructuredTextRequest, TextAiClient } from "@/lib/ai/types";

/** 構造化議事録。v13 §5.1 ② の3区分そのまま。 */
export type StructuredMinutes = {
  decisions: string[];
  shares: string[];
  cautions: string[];
};

/** クエスト候補。v13 §5.1 ③ が挙げる4項目 ＋ 発言根拠。 */
export type QuestCandidate = {
  title: string;
  /** 想定人数。`quests.recruit_count` へ写す */
  headcount: number;
  /** 想定時間。**分**で持つ（`1.5` のような小数を避けるため） */
  estimatedMinutes: number;
  /** 担当候補。`quests` には担当の列が無いため候補のまま保持する */
  assigneeCandidates: string[];
  /** この候補の根拠になった発言。運営が「AIの作り話でないか」を確かめるために出す */
  sourceQuote: string;
};

/** ナレッジ候補（v13 §5.7.4 ②）。 */
export type KnowledgeCandidate = {
  title: string;
  body: string;
};

export type MorningMeetingStructuring = {
  minutes: StructuredMinutes;
  questCandidates: QuestCandidate[];
  knowledgeCandidates: KnowledgeCandidate[];
};

const STRING_ARRAY: JsonSchema = { type: "array", items: { type: "string" } };

/**
 * 出力スキーマ。Gemini はこれを `responseJsonSchema` としてモデルへ渡すため、
 * 「JSON で返して」と頼むのではなく**構造が保証された応答**が返る。
 */
const STRUCTURING_SCHEMA: JsonSchema = {
  type: "object",
  required: ["minutes", "questCandidates", "knowledgeCandidates"],
  properties: {
    minutes: {
      type: "object",
      required: ["decisions", "shares", "cautions"],
      properties: { decisions: STRING_ARRAY, shares: STRING_ARRAY, cautions: STRING_ARRAY },
    },
    questCandidates: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "headcount", "estimatedMinutes", "assigneeCandidates", "sourceQuote"],
        properties: {
          title: { type: "string" },
          headcount: { type: "integer", minimum: 1 },
          estimatedMinutes: { type: "integer", minimum: 1 },
          assigneeCandidates: STRING_ARRAY,
          sourceQuote: { type: "string" },
        },
      },
    },
    knowledgeCandidates: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "body"],
        properties: { title: { type: "string" }, body: { type: "string" } },
      },
    },
  },
};

/**
 * プロンプト。**本文をそのまま渡す**（要約・整形をこちらで行わない）。
 *
 * 話者ラベル・タイムスタンプが含まれるかは未確定のまま残っている
 * （`QUESTIONS.md`「[2026-09-05] 朝会文字起こしテキストの投入経路」論点③）。
 * **どちらでも動くように**、あれば手がかりとして使い、無ければ本文だけで処理するよう指示する。
 */
export function buildStructuringRequest(minutesBody: string): StructuredTextRequest {
  const instructions = [
    "あなたは浮遊街（通い型コミュニティ）の朝会の記録係である。",
    "以下は朝会の文字起こし全文である。ここから3つを同時に抽出する。",
    "",
    "1. 議事録: 決定事項（decisions）・共有事項（shares）・注意点（cautions）の3区分。",
    "   各項目は1文で簡潔に書く。発言の言い換えに留め、書かれていないことを足さない。",
    "2. クエスト候補（questCandidates）: 「誰かがやる必要がある作業」として語られたもの。",
    "   タスク名・想定人数・想定時間（分）・担当候補・根拠になった発言をそのまま引く。",
    "   作業の話が出ていなければ空配列でよい。無理に作らない。",
    "3. ナレッジ候補（knowledgeCandidates）: 「新しく決まったルール」「現場の注意点」。",
    "   後から参照される形（手順・判断基準）に整えて書く。",
    "",
    "話者ラベルやタイムスタンプが含まれる場合は区切りの手がかりとして使ってよい。",
    "含まれない場合は本文だけで処理する。どちらの形式でも同じ構造で出力すること。",
    "",
    "--- 朝会の文字起こし全文 ここから ---",
    minutesBody,
    "--- 朝会の文字起こし全文 ここまで ---",
  ].join("\n");

  return {
    prompt: instructions,
    schemaName: "MorningMeetingStructuring",
    jsonSchema: STRUCTURING_SCHEMA,
  };
}

/**
 * 構造化議事録を「コピー用テキスト」へ整形する（画面のコピーボタンが使う）。
 *
 * `morning_meetings.summary_text` へ保存するのもこの形である。
 * 保存形式を JSON ではなくテキストにしているのは、`summary_text` が
 * `0011` の時点で `text` 型で切られており、**人がそのまま読める形が求められている**ため。
 * 機械可読な候補（クエスト）は別列（`extracted_quest_candidates`）が持つ。
 */
export function formatMinutesText(params: { heldOn: string; minutes: StructuredMinutes }): string {
  const bullet = (lines: string[]) => (lines.length === 0 ? "・（なし）" : lines.map((line) => `・${line}`).join("\n"));

  return [
    `【${params.heldOn} 朝会議事録】`,
    "■決定事項",
    bullet(params.minutes.decisions),
    "■共有事項",
    bullet(params.minutes.shares),
    "■注意点",
    bullet(params.minutes.cautions),
  ].join("\n");
}

/**
 * 1回の呼び出しで議事録・クエスト候補・ナレッジ候補をまとめて生成する。
 *
 * 空文字を渡された場合はモデルを呼ばずに落とす。空の本文に対して
 * 60秒待ってから「何も抽出できませんでした」と返すのは、利用者の時間の無駄である。
 */
export async function structureMorningMeeting(params: {
  aiClient: TextAiClient;
  minutesBody: string;
}): Promise<MorningMeetingStructuring> {
  if (params.minutesBody.trim() === "") {
    throw new RangeError("朝会の本文が空である。構造化する対象が無い。");
  }

  return params.aiClient.generateStructured<MorningMeetingStructuring>(
    buildStructuringRequest(params.minutesBody),
  );
}
