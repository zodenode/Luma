import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Luma — AI Health Coaching",
  description:
    "Continuous AI-led health coaching that sits on top of telehealth consultations and pharmacy fulfilment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-luma-bg text-luma-text antialiased">
        {children}
      </body>
    </html>
  );
}
