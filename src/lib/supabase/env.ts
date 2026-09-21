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

/** 接続情報の組。`readOptionalSupabaseConnection()` の戻り値。 */
export type SupabaseConnection = { url: string; anonKey: string };

/**
 * 未設定なら **throw せずに** `null` を返す。**middleware 専用**である。
 *
 * ## 通常は throw する側（`readSupabaseUrl()` 等）を使うこと
 *
 * 設定ミスは早く大きく失敗させたい。この関数はその原則の**唯一の例外**で、
 * 理由は middleware だけが「失敗の巻き添え範囲」が異常に広いことにある。
 *
 * middleware の matcher は静的アセットを除く全経路であり、ここで例外が出ると
 * Vercel は `MIDDLEWARE_INVOCATION_FAILED` を返して**全リクエストが 500 になる**。
 * 死活監視の `/api/health` すら通らないため、外形監視では「アプリが落ちた」としか
 * 分からず、原因が環境変数1つであることに辿り着けない。
 * （2026-09-21 に実際に発生。Vercel へ NEXT_PUBLIC_* を入れる前のビルドが本番に出て、
 *   サイト全体が 500 になった）
 *
 * ## 素通りさせても認可は緩まない
 *
 * middleware がやるのはセッション Cookie の付け替えだけで、認可判定はしていない
 * （`src/middleware.ts` の冒頭コメント）。したがってここを素通りしても
 * 権限が緩むことはない。各ページ・各 Route Handler は `readViewer()` 経由で
 * throw する側を呼ぶため、**画面は従来どおり失敗する**（安全側）。
 * 生き残るのは Supabase を使わない `/api/health` だけである。
 */
export function readOptionalSupabaseConnection(): SupabaseConnection | null {
  // ⚠️ ここも動的アセスにしないこと（このファイル冒頭の注記のとおり、
  //    `NEXT_PUBLIC_` の埋め込みはリテラル参照にしか働かない）
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url === undefined || url === "" || anonKey === undefined || anonKey === "") {
    return null;
  }
  return { url, anonKey };
}
