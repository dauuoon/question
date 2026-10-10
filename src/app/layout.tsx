import type { Metadata } from "next";
import "./app.css";
import "./globals.css";
import { ToastProvider } from "./toast";

export const metadata: Metadata = {
  title: "WHY BOX",
  description: "디자이너의 성찰적 사고를 돕는 연구 도구",
  icons: { icon: "/images/icon.png", apple: "/images/icon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
