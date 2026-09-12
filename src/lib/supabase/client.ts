import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseAnonKey, readSupabaseUrl } from "./env";

/**
 * ブラウザ（クライアントコンポーネント）用の Supabase クライアントを作る。
 *
 * anon キーは公開情報であり、秘匿されている前提を置いてはならない。
 * 会員データを守っているのはキーの秘匿ではなく **RLS 1枚**である（WBS F-9）。
 * したがってこのクライアント経由の読み書きは、RLS が効いていることを前提に書き、
 * 「クライアント側で出し分けているから安全」という設計にしない（v13 §5.9）。
 */
export function createBrowserSupabaseClient(): SupabaseClient {
  return createBrowserClient(readSupabaseUrl(), readSupabaseAnonKey());
}
