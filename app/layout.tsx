import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Job Seeker",
  description: "Personal job-search automation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans antialiased", geist.variable)}>
      <body className="min-h-screen bg-zinc-100">
        <header className="sticky top-0 z-40 h-11 bg-white border-b border-zinc-200 flex items-center px-6 gap-8">
          <span className="font-bold text-sm">Job Seeker</span>
          <nav className="flex items-center gap-0.5">
            {[
              { href: "/",         label: "Board"    },
              { href: "/add",      label: "Add Job"  },
              { href: "/settings", label: "Settings" },
            ].map(({ href, label }) => (
              <a key={href} href={href}
                className="px-3 py-1 text-sm text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 transition-colors">
                {label}
              </a>
            ))}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
