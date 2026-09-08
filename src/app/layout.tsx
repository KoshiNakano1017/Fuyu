import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

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
      <body>{children}</body>
    </html>
  );
}
