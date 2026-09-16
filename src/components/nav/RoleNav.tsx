import Link from "next/link";

import { readViewer } from "@/lib/auth/session";
import { visibleAreasFor } from "@/lib/auth/navigation";

/**
 * ロール別ナビゲーション（v13 §5.9.1・§5.9.2）。
 *
 * ## DOM ごと描画しない
 *
 * `visibleAreasFor()` が `hidden` を配列から外すため、**権限外の項目は
 * そもそも JSX に現れない**。CSS で隠すと要素は DOM に残り、
 * 開発者ツールから経路が読める（§5.9.2「DOM ごと描画しない」）。
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

  const areas = visibleAreasFor(viewer.role);

  return (
    <nav aria-label="メインナビゲーション" className="flex flex-wrap gap-3 border-b p-3 text-sm">
      {areas.map((area) => (
        <Link key={area.key} href={area.path} className="underline-offset-4 hover:underline">
          {area.label}
        </Link>
      ))}
    </nav>
  );
}
