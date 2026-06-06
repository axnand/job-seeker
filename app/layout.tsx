import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Seeker",
  description: "Personal job-search automation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="border-b border-gray-200 bg-white px-6 py-3 flex items-center justify-between">
          <a href="/" className="font-semibold text-gray-900 text-lg">Job Seeker</a>
          <div className="flex gap-4 text-sm">
            <a href="/" className="text-gray-600 hover:text-gray-900">Board</a>
            <a href="/add" className="text-gray-600 hover:text-gray-900">Add Job</a>
            <a href="/settings" className="text-gray-600 hover:text-gray-900">Settings</a>
          </div>
        </nav>
        <main className="px-6 py-6 max-w-7xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
