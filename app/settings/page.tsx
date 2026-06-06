import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

const sections = [
  { title: "Search", items: ["Keywords", "Location", "Relevance threshold", "Min salary + currency", "Digest time (timezone-aware)", "Company blacklist"] },
  { title: "Sources", items: ["LinkedIn on/off", "Adzuna on/off", "ATS watchlist (add companies)", "Remotive / RemoteOK on/off", "JSearch (optional, paid)"] },
  { title: "Outreach", items: ["Message templates (invite, DM, follow-up)", "Follow-up delay", "Max targets/job", "Recontact cooldown", "Daily/weekly caps", "Send window", "Global pause (kill switch)"] },
  { title: "AI Providers", items: ["Add/edit providers", "Set default for scoring", "Set provider for tailoring", "Test connection"] },
  { title: "Account", items: ["Owner name + email", "Unipile account ID", "SMTP settings", "App password"] },
];

export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Phase 3 — UI coming soon.</p>
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="pt-4">
          <p className="text-sm text-amber-800">
            For now, edit{" "}
            <code className="bg-amber-100 px-1.5 py-0.5 rounded text-xs font-mono">src/config.ts</code> and{" "}
            <code className="bg-amber-100 px-1.5 py-0.5 rounded text-xs font-mono">.env</code> directly.
            The settings UI is planned for Phase 3.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {sections.map(s => (
          <Card key={s.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{s.title}</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-3">
              <div className="flex flex-wrap gap-2">
                {s.items.map(item => (
                  <Badge key={item} variant="secondary" className="text-xs font-normal">
                    {item}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
