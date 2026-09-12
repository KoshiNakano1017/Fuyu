/**
 * Supabase の接続情報を環境変数から取り出す。
 *
 * `NEXT_PUBLIC_` 接頭辞の変数は Next.js がビルド時に文字列へ埋め込む。埋め込みは
 * `process.env.NEXT_PUBLIC_X` という**リテラル参照**にのみ働くため、`process.env[name]`
 * のような動的アクセスに書き換えてはならない（undefined になり、原因が追いにくい）。
 *
 * 値をモジュールのトップレベル定数にせず関数にしているのは、未設定のときの失敗を
 * import 時ではなく利用時に起こし、エラーの発生箇所を呼び出し元に寄せるため。
 */

function requireEnvValue(value: string | undefined, variableName: string): string {
  if (value === undefined || value === "") {
    throw new Error(
      `環境変数 ${variableName} が未設定です。.env.example を参照して .env を用意してください。` +
        "Supabase プロジェクトそのものの作成は WBS 1-1（未着手）です。",
    );
  }
  return value;
}

export function readSupabaseUrl(): string {
  return requireEnvValue(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    "NEXT_PUBLIC_SUPABASE_URL",
  );
}

export function readSupabaseAnonKey(): string {
  return requireEnvValue(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );
}
