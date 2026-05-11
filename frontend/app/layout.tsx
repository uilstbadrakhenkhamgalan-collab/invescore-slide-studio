import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InvesCore Slide Studio",
  description: "AI-generated, on-brand presentations for InvesCore Property",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" style={{ background: '#09090B' }}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body
        style={{
          fontFamily:
            "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: '#09090B',
          minHeight: '100vh',
          color: '#FAFAFA',
        }}
      >
        {children}
      </body>
    </html>
  );
}
