import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

const PERIOD_LABEL: Record<string, string> = {
  YEAR: "/yr", MONTH: "/mo", HOUR: "/hr",
};

const APP_STAGE_COLORS: Record<string, string> = {
  NEW:          "bg-slate-100 text-slate-700",
  APPROVED:     "bg-blue-100 text-blue-700",
  SKIPPED:      "bg-slate-100 text-slate-500",
  APPLIED:      "bg-violet-100 text-violet-700",
  INTERVIEWING: "bg-amber-100 text-amber-700",
  OFFER:        "bg-emerald-100 text-emerald-700",
  CLOSED:       "bg-red-100 text-red-700",
};

async function updateStage(formData: FormData) {
  "use server";
  const jobId  = formData.get("jobId")  as string;
  const action = formData.get("action") as string;
  const note   = (formData.get("note") as string) || null;
  if (!jobId || !action) return;
  await fetch(
    `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/api/jobs/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, action, note }),
    }
  );
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ action?: string }>;
}) {
  const { jobId } = await params;
  const { action } = await searchParams;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { outreaches: { include: { contact: true } } },
  });
  if (!job) notFound();

  const salary = job.salaryAnnualBase
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: job.salaryCurrency ?? "INR",
        maximumFractionDigits: 0,
      }).format(job.salaryAnnualBase) +
      (PERIOD_LABEL[job.salaryPeriod ?? "YEAR"] ?? "/yr") +
      (job.salaryBasis === "ESTIMATED"
        ? ` (est. ${job.salaryConfidence?.toLowerCase() ?? ""})`
        : " (stated)")
    : null;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Back */}
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1">
        ← Board
      </a>

      {/* Hero card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">{job.company}</CardTitle>
              <p className="text-muted-foreground mt-1">{job.role}</p>
            </div>
            {job.aiScore !== null && (
              <div className="text-right shrink-0">
                <div className="text-3xl font-bold text-primary">{job.aiScore}</div>
                <div className="text-xs text-muted-foreground">/ 100</div>
              </div>
            )}
          </div>

          {/* Badges row */}
          <div className="flex flex-wrap gap-2 mt-3">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${APP_STAGE_COLORS[job.appStage] ?? ""}`}>
              {job.appStage}
            </span>
            <Badge variant="outline" className="text-xs">{job.source.replace(/_/g, " ")}</Badge>
            <Badge variant="outline" className="text-xs text-violet-600 border-violet-200">
              {job.applyType.replace(/_/g, " ")}
            </Badge>
            {job.outreachState !== "NONE" && (
              <Badge variant="secondary" className="text-xs">{job.outreachState.replace(/_/g, " ")}</Badge>
            )}
          </div>
        </CardHeader>

        <Separator />

        <CardContent className="pt-4 space-y-3">
          {/* AI reason */}
          {job.aiReason && (
            <p className="text-sm text-muted-foreground leading-relaxed">{job.aiReason}</p>
          )}

          {/* Salary */}
          {salary && (
            <p className="text-sm font-semibold text-emerald-700">{salary}</p>
          )}
          {job.salaryFlagReason && (
            <p className="text-xs text-amber-600">⚠ {job.salaryFlagReason.replace(/_/g, " ")}</p>
          )}

          {/* Tailored pitch */}
          {job.tailoredPitch && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
              <p className="text-xs font-semibold text-blue-500 mb-1 uppercase tracking-wide">AI Pitch</p>
              <p className="text-sm text-blue-900 whitespace-pre-line leading-relaxed">{job.tailoredPitch}</p>
            </div>
          )}

          {/* Apply URL */}
          {job.applyUrl && (
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              Open application →
            </a>
          )}
        </CardContent>
      </Card>

      {/* Action banner from email link */}
      {action && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {action === "approve"
            ? "Review the job and outreach message above, then confirm to queue outreach."
            : "Confirm below to skip this job."}
        </div>
      )}

      {/* Stage actions */}
      {job.appStage === "NEW" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Take action</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={updateStage} className="flex flex-wrap gap-3 items-end">
              <input type="hidden" name="jobId" value={job.id} />
              <input
                type="text"
                name="note"
                placeholder="Optional note…"
                className="border border-input rounded-md px-3 py-2 text-sm flex-1 min-w-48 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Button type="submit" name="action" value="approve" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                ✓ Approve & queue outreach
              </Button>
              <Button type="submit" name="action" value="skip" variant="outline">
                ✗ Skip
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {["APPROVED", "APPLIED"].includes(job.appStage) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Update stage</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={updateStage} className="flex flex-wrap gap-2">
              <input type="hidden" name="jobId" value={job.id} />
              {["applied", "interviewing", "offer", "closed"].map(a => (
                <Button key={a} type="submit" name="action" value={a} variant="secondary" size="sm" className="capitalize">
                  {a}
                </Button>
              ))}
            </form>
          </CardContent>
        </Card>
      )}

      {/* Outreach history */}
      {job.outreaches.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Outreach</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {job.outreaches.map(o => (
              <div key={o.id} className="flex items-start gap-3">
                <div className="mt-0.5 w-2 h-2 rounded-full bg-primary shrink-0" />
                <div>
                  <p className="text-sm font-medium">{o.contact.name}</p>
                  <p className="text-xs text-muted-foreground">{o.contact.title} · {o.role}</p>
                  <a
                    href={o.contact.linkedinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline"
                  >
                    LinkedIn →
                  </a>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Full JD */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Job Description</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <ScrollArea className="h-[500px]">
            <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed pr-4">
              {job.jdText}
            </pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
