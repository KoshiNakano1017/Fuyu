import type { ReactElement } from "react";

import { Money } from "@/components/ui/Money";

export default function HomePage(): ReactElement {
  return (
    <main>
      <h1>浮遊街アプリ</h1>
      <p>Phase 1 開発中です。機能は順次追加します。</p>
      {/* 通貨表示コンポーネントの表示例（v13 §5.5: Uii主・円副の併記） */}
      <p>
        表示例: <Money priceYen={3000} />
      </p>
    </main>
  );
}
