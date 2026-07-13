import "./globals.css";

export const metadata = {
  title: "Streaming JSON Viewer",
  description: "Stream a huge JSON payload from the server and view it live in an editor",
};

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
