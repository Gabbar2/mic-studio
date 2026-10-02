import type { Metadata } from "next";
import "./globals.css";

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
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
