import Link from "next/link";

import { readViewer } from "@/lib/auth/session";
import {
  ADMIN_MENU_LABEL,
  adminMenuAreasFor,
  dailyAreasFor,
  type Area,
} from "@/lib/auth/navigation";

/**
 * ロール別ナビゲーション（v13 §5.9.1・§5.9.2・§5.9.5）。
 *
 * ## DOM ごと描画しない
 *
 * `dailyAreasFor()` / `adminMenuAreasFor()` が `hidden` を配列から外すため、
 * **権限外の項目はそもそも JSX に現れない**。CSS で隠すと要素は DOM に残り、
 * 開発者ツールから経路が読める（§5.9.2「DOM ごと描画しない」）。
 *
 * ## 二階層にする理由（§5.9.5 ／ §9 #54）
 *
 * 管理者の権限対象は15領域ある。これを1列に平置きすると、
 * 2026-08-25 のプロトタイプと同じ「**横スクロールの先に押し出されて到達できない**」
 * 状態になる。第1階層は毎日使う7項目だけに絞り、運営専用は「⚙️ 管理」へ束ねる。
 *
 * ## 横スクロールを到達手段にしない
 *
 * `flex-wrap` で**折り返す**。`overflow-x-auto` や `whitespace-nowrap` を使わない。
 * 画面幅に収まらない項目があることが視覚的に分からないのが #54 の原因だった。
 *
 * ## Server Component である理由
 *
 * ロール判定が終わるまで何も描画しないため、**権限外の項目が一瞬見える
 * フラッシュが起きない**。クライアントで `useEffect` を使って隠す実装だと、
 * 最初の描画で出てから消える。
 *
 * ## これは防壁ではない
 *
 * ナビに出さないことと、その URL へ入れないことは別である（§5.9.3）。
 * 各ページ側に `requireStaff()` 等を必ず置くこと。
 */
export async function RoleNav() {
  const viewer = await readViewer();
  if (!viewer.signedIn) {
    return null;
  }

  const daily = dailyAreasFor(viewer.role);
  const managed = adminMenuAreasFor(viewer.role);

  return (
    <nav
      aria-label="メインナビゲーション"
      className="flex flex-wrap items-center gap-3 border-b p-3 text-sm"
    >
      {daily.map((area) => (
        <AreaLink key={area.key} area={area} />
      ))}

      {managed.length > 0 ? <AdminMenu areas={managed} /> : null}
    </nav>
  );
}

function AreaLink({ area }: { area: Area }) {
  return (
    <Link href={area.path} className="underline-offset-4 hover:underline">
      {area.label}
    </Link>
  );
}

/**
 * 運営専用画面をまとめる「⚙️ 管理」メニュー。
 *
 * `<details>` を使うのは、**JavaScript が動かなくても開ける**ためである。
 * ここが開かないと管理者はマスタ管理へ到達できず、#54 の再発になる。
 */
function AdminMenu({ areas }: { areas: readonly Area[] }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded border border-neutral-300 px-2 py-1">
        {ADMIN_MENU_LABEL}
      </summary>
      <ul className="absolute right-0 z-10 mt-1 flex w-56 flex-col gap-1 rounded border border-neutral-200 bg-white p-2 shadow-lg">
        {areas.map((area) => (
          <li key={area.key}>
            <Link href={area.path} className="block rounded px-2 py-1 hover:bg-neutral-100">
              {area.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
