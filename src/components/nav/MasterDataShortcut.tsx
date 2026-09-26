import Link from "next/link";

import { AREAS, visibilityFor } from "@/lib/auth/navigation";
import type { Role } from "@/lib/auth/session";

/**
 * 価格を表示している画面から「マスタ管理」へ直接飛ぶ近道（v13 §5.9.5「入口の重複を許す」）。
 *
 * ## なぜ入口を重複させるのか
 *
 * 2026-08-25 のプロトタイプ確認では「**カフェメニューを管理画面から登録できない**」
 * 「**宿泊料金マスタを管理者権限で触れない**」と指摘された（§9 #54）。
 * 実装はあり、到達できていなかった。§5.9.5 は「⚙️ 管理」メニューに加えて
 * **価格を表示している画面から直接飛べる導線**を要件にしている。
 * 「この値段を直したい」と思った場所がそのまま入口になる形が、いちばん短い。
 *
 * ## 誰に出すかは `AREAS` から引く（二重管理しない）
 *
 * 可視性を自前に書かず `masterData` 行の `visibility` を読む。
 * §5.9.1 の表を唯一の出所にする原則（§5.9.5「空振りの禁止」）に従う。
 *
 * ## これは防壁ではない
 *
 * 出さないことと入れないことは別である（§5.9.3）。
 * `/admin/master` 側の `requireAdmin()` が本体の守りである。
 */
export function MasterDataShortcut({ role, label }: { role: Role; label: string }) {
  const masterData = AREAS.find((area) => area.key === "masterData");
  if (!masterData || visibilityFor(masterData, role) !== "visible") {
    return null;
  }

  return (
    <Link
      href={masterData.path}
      className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
    >
      {label}
    </Link>
  );
}
