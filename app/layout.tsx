import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Portfolio X-Ray — See what your portfolio actually holds",
  description: "Upload or paste your Indian mutual fund statement. Get a clear, plain-language breakdown of every holding, your true allocation, and what's worth noticing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
