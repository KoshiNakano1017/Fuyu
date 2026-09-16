import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

import { RoleNav } from "@/components/nav/RoleNav";

import "./globals.css";

export const metadata: Metadata = {
  title: "浮遊街アプリ",
  description:
    "1,000人限定の通い型自給自足コミュニティ「浮遊街」の運営支援アプリ",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="ja">
      {/* 既定の面色と文字色。プロトタイプ（docs/design/prototype_v15.html）の body に合わせる */}
      <body className="min-h-screen bg-sand-50 text-wood-800">
        {/*
          ロール別ナビ（v13 §5.9.1・§5.9.2）。Server Component なので、
          ロール判定が終わるまで何も描画されない＝権限外の項目が一瞬見えることがない。
          未ログインなら null を返すため、ログイン画面では出ない。
        */}
        <RoleNav />
        {children}
      </body>
    </html>
  );
}
