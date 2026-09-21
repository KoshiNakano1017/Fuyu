import { readConciergeAdminUrl } from "@/lib/concierge/admin-link";

/**
 * 別タブで開くリンクに必ず付ける。`noopener` は遷移先から `window.opener` を触らせないため、
 * `noreferrer` は遷移先へ参照元 URL を渡さないため（`noopener` 非対応ブラウザの保険も兼ねる）。
 */
const EXTERNAL_LINK_REL = "noopener noreferrer";

/**
 * 浮遊街コンシェルジュ（line-rag-bot）管理画面への導線ボタン（B9 ／ `画面設計.md` §4）。
 *
 * ボタン1つだけの外部リンクである。ナレッジ登録フォーム・エスカレーション一覧・API 連携は
 * アプリ本体に持たず、line-rag-bot 側で完結する（v13 §9 #31 ／ §5.7.5 注記）。
 * システム間の認証連携も無く、遷移先は自身のログイン機構で認証する（`画面設計.md` §4 B9）。
 *
 * **URL が未設定・開けない値なら何も描画しない。** 押しても何も起きない導線を置かないため
 * （v13 §5.9.5 空振りの禁止）。
 */
export function ConciergeAdminLink() {
  const adminUrl = readConciergeAdminUrl();
  if (!adminUrl) {
    return null;
  }

  return (
    <a
      href={adminUrl}
      target="_blank"
      rel={EXTERNAL_LINK_REL}
      className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-5 py-3 text-base font-medium text-white"
    >
      浮遊街コンシェルジュ管理画面を開く
    </a>
  );
}
