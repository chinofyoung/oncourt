import type { Metadata } from "next";
import { Inter, Inter_Tight, Spline_Sans_Mono } from "next/font/google";
import { BRAND_NAME } from "@/components/site/wordmark";
import "./globals.css";

// design/branding.md, Typography: "Inter Tight" (display: headlines, card
// titles, buttons), "Inter" (body), "Spline Sans Mono" (mono: times, prices,
// data, eyebrows/kickers). Weight subsets match that doc's Google Fonts
// import line exactly. Wired to Tailwind's font-sans/font-mono utilities
// (and a font-display utility) via the @theme block in globals.css — no
// task previously owned this file, so it still loaded Geist/Geist Mono
// (the create-next-app default) instead.
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  weight: ["500", "600", "700", "800"],
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const splineSansMono = Spline_Sans_Mono({
  variable: "--font-spline-sans-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${BRAND_NAME} — book a pickleball court`,
  description:
    "Find and book pickleball courts across the Philippines. Game on.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${inter.variable} ${splineSansMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
