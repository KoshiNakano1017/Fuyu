import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseUrl } from "./env";

/**
 * RLS を迂回する service_role クライアント。**用途を限定して使う。**
 *
 * `server.ts` は「とりあえず service_role で通す」実装を誘発しないよう、
 * このクライアントを意図的に置いていない。ここを別モジュールに切ったのは、
 * **import している場所を grep 一発で数えられるようにする**ためである。
 * 増やすときは、なぜ RLS 越しでは足りないのかを PR に書くこと。
 *
 * 現在の利用箇所は2つだけ（いずれも WBS 2-1b）。
 *
 * | 用途 | なぜ RLS 越しでは書けないか |
 * | --- | --- |
 * | 初回ログインの `auth_user_id` 結合 | 結合前の本人は `auth.uid()` から自分の行を引けない（`auth_user_id` が NULL のため）。つまり本人ポリシーが成立しない |
 * | 招待の送信と台帳記録 | `member_invitations` のポリシーは WBS 2-2 で置く。それまでは全拒否 |
 *
 * ⚠️ **ブラウザへ絶対に渡さない。** service_role キーは RLS も GRANT も迂回する
 * （`DB物理設計.md` §6-6b）。CLAUDE.md §3.2 のとおりサーバサイド専用である。
 * `NEXT_PUBLIC_` 接頭辞を付けないことが唯一の防壁なので、環境変数名を変えないこと。
 */
export function createAdminSupabaseClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (serviceRoleKey === undefined || serviceRoleKey === "") {
    throw new Error(
      "環境変数 SUPABASE_SERVICE_ROLE_KEY が未設定です。" +
        "Supabase ダッシュボード → Project Settings → API から service_role キーを取得し、" +
        ".env に設定してください（.env.example を参照）。",
    );
  }

  return createClient(readSupabaseUrl(), serviceRoleKey, {
    auth: {
      // service_role クライアントはセッションを持たない。
      // 持たせると、あるリクエストの認証状態が別のリクエストへ漏れる。
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
