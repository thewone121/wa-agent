import "./globals.css";
import { Bricolage_Grotesque, Instrument_Sans, IBM_Plex_Mono } from "next/font/google";

/*
 * Three faces, each with one job. next/font self-hosts and subsets them, so
 * there is no request to Google from the owner's phone and no layout shift
 * when they arrive — both matter on a Nigerian mobile connection.
 *
 *   Bricolage Grotesque  page titles and the big numbers. Used sparingly.
 *   Instrument Sans      everything you read.
 *   IBM Plex Mono        order references and receipt figures, where the
 *                        digits have to line up and read like a ticket.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const ui = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "WhatsApp AI Agent",
  description: "AI sales assistant for WhatsApp-first businesses",
  // iOS ignores the web manifest for this; without it a home-screen launch
  // opens inside Safari chrome instead of full-screen.
  appleWebApp: { capable: true, title: "AI Agent", statusBarStyle: "default" as const },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0c120f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
