import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AppSidebar } from "@/components/app-sidebar";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Job Seeker",
  description: "Personal job-search automation",
};

// Runs before first paint: applies the stored theme (or the OS preference when
// none is stored) to <html> so there's no light-mode flash on dark loads.
const themeScript = `(function(){try{var t=localStorage.getItem('js.theme');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("font-sans antialiased", geist.variable)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <div className="flex h-screen overflow-hidden">
          <AppSidebar />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
