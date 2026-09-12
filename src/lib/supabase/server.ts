import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { readSupabaseAnonKey, readSupabaseUrl } from "./env";

/**
 * サーバ（Server Component / Route Handler / Server Action）用の Supabase クライアントを作る。
 *
 * **リクエストごとに必ず作り直す。** 使い回すと別の利用者のセッションが混ざる
 * （`@supabase/ssr` が明示している制約）。モジュール変数へキャッシュしないこと。
 *
 * anon キー＋RLS の経路のみを用意し、RLS を迂回する service_role クライアントは
 * ここに置かない。置くと「とりあえず service_role で通す」実装を誘発し、
 * 唯一の防壁である RLS が無効化されるため（WBS F-9・CLAUDE.md §3.2）。
 * 必要になった時点で、用途を限定した別モジュールとして起票してから追加する。
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(readSupabaseUrl(), readSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からは Cookie を書けない（Next.js の制約）。
          // セッション更新は middleware 側で行う前提のため、ここでの失敗は無視してよい。
          // `@supabase/ssr` が推奨している扱い。
        }
      },
    },
  });
}
