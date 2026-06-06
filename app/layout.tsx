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
      <body className="min-h-screen bg-background">
        {/* Top nav */}
        <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
            <a href="/" className="font-bold text-base tracking-tight flex items-center gap-2">
              <span className="text-primary">◈</span>
              Job Seeker
            </a>
            <nav className="flex items-center gap-1">
              {[
                { href: "/",        label: "Board"    },
                { href: "/add",     label: "Add Job"  },
                { href: "/settings",label: "Settings" },
              ].map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </header>

        {/* Page content */}
        <main className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
