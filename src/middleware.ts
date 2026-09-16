import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { readSupabaseAnonKey, readSupabaseUrl } from "@/lib/supabase/env";

/**
 * セッションの更新（v13 §5.2.6「セッションとロールガード」）。
 *
 * `src/lib/supabase/server.ts` は「セッション更新は middleware 側で行う前提」と
 * 書かれており、Server Component からは Cookie を書けない。ここが唯一の更新点である。
 *
 * ## ここで認可はしない
 *
 * **やるのはセッション Cookie の付け替えだけ。** ロール判定は各ページ／各 Route Handler が
 * `readViewer()` を使ってサーバ側で行う（`src/lib/auth/guard.ts`）。
 *
 * middleware で認可まで済ませると、**middleware を通らない経路**（Server Action の
 * 直接呼び出しなど）が素通りになる。v13 §5.9.3 が求めるのは
 * 「画面上の非表示とサーバサイド認可を必ず併置する」ことなので、
 * 判定は**守りたい処理のすぐ隣**に置く。
 *
 * ## `getUser()` を呼ぶ理由
 *
 * `@supabase/ssr` は `getUser()` の呼び出しによってトークンの更新を行う。
 * 呼ばないとセッションが延長されず、利用者が突然ログアウトする。
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(readSupabaseUrl(), readSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // 戻り値は使わない。トークン更新の副作用のために呼ぶ。
  await supabase.auth.getUser();

  return response;
}

export const config = {
  /**
   * 静的アセットを除く全経路。画像やフォントでセッション更新を走らせても
   * 無駄なだけなので外す。
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
