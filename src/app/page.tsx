import type { ReactElement } from "react";

import { Money } from "@/components/ui/Money";

export default function HomePage(): ReactElement {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold text-sage-700">浮遊街アプリ</h1>
      <p className="mt-2">Phase 1 開発中です。機能は順次追加します。</p>
      {/* 通貨表示コンポーネントの表示例（v13 §5.5: Uii主・円副の併記） */}
      <p>
        表示例: <Money priceYen={3000} />
      </p>
    </main>
  );
}
