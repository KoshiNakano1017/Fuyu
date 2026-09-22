/**
 * 入手先URL（`shopping_list_items.shop_url`）を、別タブで開ける形だけに絞る。
 *
 * この列は街人が自由に入力でき、値は一覧で**全閲覧者（ゲストを含む）**にリンクとして出る。
 * 検証せずに `<a href>` へ渡すと、登録者1人の入力で他人の画面が壊れる:
 * `javascript:` は React が描画ごと落とすため `/shopping` が全員に対して開かなくなり、
 * React が止めないスキーム（`data:` 等）はクリックした会員のセッション上で開かれる。
 * 画面側の `type="url"` は検証にならない（Server Action を直接叩けば任意の文字列が入る
 * ／ v13 §5.9.3 の二重防御）。
 *
 * 同じ判定を `src/lib/concierge/admin-link.ts` が環境変数に対して行っている。
 * 違いは値の出どころ（設定 vs 利用者入力）だけで、通してよいスキームは同じである。
 */

/** 別タブで開ける（＝ページ遷移として成立する）スキームだけを通す。 */
const OPENABLE_PROTOCOLS = ["http:", "https:"];

/**
 * 別タブで開いてよい URL か。空文字・相対パス・`javascript:` 等はすべて `false`。
 *
 * **例外を投げない。** 呼び出し側は「リンクにしない」「保存を断る」のどちらかへ倒せばよく、
 * 1件の入力で画面全体を落とす理由がない（`admin-link.ts` と同じ扱い）。
 */
export function isOpenableShopUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  return OPENABLE_PROTOCOLS.includes(parsed.protocol);
}

/**
 * 保存してよい入手先URLを返す。未入力は `null`、開けない値は `undefined`。
 *
 * 「未入力」と「開けない値」を区別するのは、前者はそのまま保存してよく、
 * 後者は**黙って捨てずに入力し直してもらう**必要があるためである。
 * 黙って `null` にすると、利用者は貼ったはずのURLが消えた理由を知る手立てがない。
 */
export function readShopUrlInput(value: string | null | undefined): string | null | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return isOpenableShopUrl(trimmed) ? trimmed : undefined;
}
