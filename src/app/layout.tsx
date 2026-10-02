import type { Metadata } from "next";
import "./globals.css";
import LiveChatWidget from "@/components/LiveChatWidget";

export const metadata: Metadata = {
  title: "Mic - AI Video Generation",
  description:
    "Generate cinematic AI video with Kling or Wan. Text to video, image to video, native audio.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        {children}
        {/* Mounted once, site-wide, so it follows a visitor across every
            page — it hides itself on /admin. See the component doc comment
            for why it never creates a session on its own. */}
        <LiveChatWidget />
      </body>
    </html>
  );
}
