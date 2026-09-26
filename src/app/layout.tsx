import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "開発ニキ",
  description: "Discordで開発を宣言し、GitHubのコミットで活動を確認するBot",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
