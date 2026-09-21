import type { ReactElement } from "react";

/**
 * まだ実装できない画面の説明（ナビから 404 を踏ませないための最小の面）。
 *
 * ## なぜ 404 のままにしないのか
 *
 * `AREAS`（`src/lib/auth/navigation.ts`）にある領域はナビにリンクが出る。
 * リンクを踏んで 404 が返るのは、v13 §5.9.1 の表示マトリクスと実装の食い違いであり、
 * WBS `2-6`（管理系メニューの到達性（ナビ情報設計））が塞ごうとしている穴そのものである。
 *
 * ## なぜ「準備中」とだけ書かないのか
 *
 * **何待ちかを書く。** 運営が「いつ使えるのか」を運営同士で聞き合うことになるのを避け、
 * 開発側も「この画面は忘れられている」のか「待ちがある」のかを区別できるようにする。
 *
 * ⚠️ この面は**機能の代替ではない**。ここに暫定の入力欄を置かないこと。
 * 保存先が無いまま入力させると、入れたつもりのデータが消える。
 */
export function NotYetAvailable({
  title,
  blockedBy,
}: {
  title: string;
  /** 何を待っているか。WBS のパッケージ番号と一言の概要をセットで書く（CLAUDE.md §7.2）。 */
  blockedBy: readonly string[];
}): ReactElement {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-sm text-neutral-600">
        この画面はまだ使えません。下記が済むと利用できるようになります。
      </p>
      <ul className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-4 text-sm">
        {blockedBy.map((item) => (
          <li key={item}>・{item}</li>
        ))}
      </ul>
    </main>
  );
}
