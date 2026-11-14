import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Atkinson_Hyperlegible } from "next/font/google";
import "./globals.css";

// Chakra Petch: angular, HUD-like, still legible at heading and number sizes. Atkinson Hyperlegible: body text built for readability.
const display = Chakra_Petch({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display", display: "swap" });
const body = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Account CRM: live book, power, first moves, risks, gaps",
  description: "A live CRM for two customer accounts. Every number cites the record it came from.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
