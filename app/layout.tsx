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
      <body className="min-h-screen bg-[#f5f5f5]">
        <header className="sticky top-0 z-40 h-12 bg-white border-b border-border flex items-center px-6">
          <span className="font-bold text-sm tracking-tight mr-8">Job Seeker</span>
          <nav className="flex items-center gap-1">
            {[
              { href: "/",        label: "Board"    },
              { href: "/add",     label: "Add Job"  },
              { href: "/settings",label: "Settings" },
            ].map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="px-3 py-1 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
              >
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
