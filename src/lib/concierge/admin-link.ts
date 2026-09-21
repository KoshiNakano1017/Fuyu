/**
 * 浮遊街コンシェルジュ（line-rag-bot）の Streamlit 管理画面 URL を解決する。
 *
 * Phase 1 のアプリ本体と line-rag-bot の結合点は、この外部リンク1つだけである
 * （v13 §9 #31 ／ §5.7.5 の 2026-08-16 再確定注記 ／ `外部連携設計.md` §2-2）。
 * URL は秘匿値ではない（リンク先は自身のログイン機構で認証する ／ `画面設計.md` §4 B9）ため
 * `NEXT_PUBLIC_` で供給してよいが、環境ごとに変わるのでコードには直書きしない（CLAUDE.md §3.2）。
 */

/**
 * ⚠️ 添字アクセス（`process.env[name]`）にしない。
 * Next.js は `NEXT_PUBLIC_` 付きの参照を `next build` 時に静的置換するため、
 * 変数名を組み立てて読むとクライアント側で値が入らない。
 */
function rawAdminUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_CONCIERGE_ADMIN_URL;
}

/** 別タブで開ける（＝ページ遷移として成立する）スキームだけを通す。 */
const OPENABLE_PROTOCOLS = ["http:", "https:"];

/**
 * 管理画面 URL。未設定・空・開けない値のときは `null` を返す。
 *
 * **例外を投げない。** URL 未設定は「導線を出さない」だけで済ませる（v13 §5.9.5 空振りの禁止）。
 * 店員タブレットの他の機能まで巻き込んで落とす理由がないため
 * （逆方向リンクの `PARENT_APP_URL` も同じ扱い ／ `RAG基盤_line-rag-bot概要.md` §2-1）。
 *
 * `javascript:` 等を弾くのは、設定ミス1つで別タブ遷移がスクリプト実行の口に変わるため。
 */
export function readConciergeAdminUrl(): string | null {
  const configured = rawAdminUrl()?.trim();
  if (!configured) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  return OPENABLE_PROTOCOLS.includes(parsed.protocol) ? configured : null;
}
