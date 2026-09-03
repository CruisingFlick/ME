import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RepLink",
  description:
    "After-hours product requests, straight to your rep. Paste a link, snap a photo, or share from any app.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "RepLink" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#b8410e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
