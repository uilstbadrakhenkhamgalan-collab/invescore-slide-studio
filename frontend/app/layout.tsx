import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InvesCore Slide Studio",
  description: "Generate branded InvesCore Property presentations with AI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" style={{ background: '#0C0F1A' }}>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ fontFamily: "'Montserrat', sans-serif", background: '#0C0F1A', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  );
}
