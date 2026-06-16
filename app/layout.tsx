import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "MITAoE PYQ Analytics",
  description:
    "Ask questions about MITAoE previous-year question papers: real frequency analytics and semantic search with citations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
