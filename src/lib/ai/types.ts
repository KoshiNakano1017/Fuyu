/**
 * AI へテキストを渡して構造化された応答を1回で受け取る、呼び出し側の唯一の依存先。
 *
 * ここに SDK の型を1つも持ち込まないのは、正本 v13 §9 #45 が
 * 「AI呼び出しは抽象化して差し替え可能にしておけばよい」と定めているため。
 * インタフェースが実装の形（各ベンダの SDK）に引きずられると、差し替えが
 * 呼び出し側の書き換えを伴い、この要件が成立しなくなる。
 */

/** JSON Schema をそのまま持つ。ベンダ固有のスキーマ型へ寄せない（上記の理由）。 */
export type JsonSchema = Record<string, unknown>;

/**
 * 構造化出力を1回の呼び出しで得るための入力。
 *
 * **テキストのみを受け取る。** 音声ファイルや GCS の URI を渡す口を意図的に持たない
 * （v13 §9 #63: アプリは音声を扱わず、入力は文字起こし済みテキスト）。
 */
export type StructuredTextRequest = {
  /** モデルへ渡す指示と本文。文字起こし済みテキストはここに含める */
  prompt: string;
  /** 出力スキーマの名前。プロンプト／スキーマ宣言に埋めてモデルへ伝える */
  schemaName: string;
  /** 期待する出力の JSON Schema */
  jsonSchema: JsonSchema;
};

export interface TextAiClient {
  /**
   * `request` を**1回**の API 呼び出しで処理し、`jsonSchema` に沿った値を返す。
   *
   * 議事録サマリー・クエスト候補・ナレッジ候補を別呼び出しへ割らないのは、
   * §8 の「60秒以内」を圧迫するため（v13 §5.1 ③・§5.7.4 ②）。
   */
  generateStructured<T>(request: StructuredTextRequest): Promise<T>;
}
