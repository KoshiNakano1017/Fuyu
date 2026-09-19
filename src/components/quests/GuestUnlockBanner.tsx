import type { ReactElement } from "react";

import type { GuestUnlockBanner as GuestUnlockBannerData } from "@/lib/quests/board";

type GuestUnlockBannerProps = {
  banner: GuestUnlockBannerData;
};

/**
 * クエスト一覧上部の常設バナー（v13 §5.10.6）。
 *
 * 「登録すると何ができるようになるか」を件数で示すことが導線の価値であるため、
 * 折りたためない常設表示にする。文言と件数の算出は `lib/quests` 側が持ち、
 * ここは受け取った値を描くだけにする（画面ごとに数え方が分かれないようにするため）。
 */
export function GuestUnlockBanner({ banner }: GuestUnlockBannerProps): ReactElement {
  return (
    <p className="rounded-md bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
      {banner.text}
    </p>
  );
}
