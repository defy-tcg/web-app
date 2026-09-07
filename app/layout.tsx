import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

const themeScript = `
  (function () {
    var theme = "light";
    try {
      var stored = window.localStorage.getItem("defy-theme:v1");
      if (stored === "light" || stored === "dark") {
        theme = stored;
      } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        theme = "dark";
      }
    } catch (_) {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        theme = "dark";
      }
    }
    document.documentElement.dataset.theme = theme;
  })();
`;

export const metadata: Metadata = {
  title: "Defy TCG Store OS",
  description:
    "Revenue, sales, expenses, events, inventory, and TCGplayer pricing for Defy TCG.",
  icons: {
    icon: "/defy-os-icon.png",
    apple: "/defy-os-app-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script
          id="defy-theme"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        {children}
      </body>
    </html>
  );
}