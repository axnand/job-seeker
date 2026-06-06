import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { scoreJob } from "@/scoring/ai-scorer";
import { normalizeSalary } from "@/salary/normalize";
import { dedupeKey } from "@/sources/normalize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SalaryBasis, SalaryConfidence, SalaryPeriod } from "@prisma/client";

async function addJob(formData: FormData) {
  "use server";
  const input = (formData.get("input") as string ?? "").trim();
  if (!input) return;

  let jdText = "";
  let applyUrl = "";
  const company = "Unknown";
  const role = "Unknown";

  const isUrl = input.startsWith("http");
  if (isUrl) {
    applyUrl = input;
    try {
      const r = await fetch(`https://r.jina.ai/${encodeURIComponent(input)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) jdText = await r.text();
    } catch { /* ignore */ }
    if (!jdText) jdText = `[JD fetch failed — URL: ${input}]`;
  } else {
    jdText = input;
  }

  const result = await scoreJob({ jdText, company, role }).catch(() => null);
  if (!result) redirect("/");

  const normalized = await normalizeSalary(result.salary).catch(() => null);

  const job = await prisma.job.create({
    data: {
      source: "MANUAL",
      company, role, jdText, applyUrl,
      dedupeKey: dedupeKey(company, role, undefined),
      applyType: "MANUAL_NOTIFY",
      aiScore: result.score,
      aiReason: result.reason,
      tailoredPitch: result.tailoredPitch,
      appStage: result.skipReason ? "SKIPPED" : "NEW",
      salaryMin: result.salary.min ?? null,
      salaryMax: result.salary.max ?? null,
      salaryCurrency: result.salary.currency ?? null,
      salaryPeriod: result.salary.period ? (result.salary.period.toUpperCase() as SalaryPeriod) : null,
      salaryBasis: result.salary.basis ? (result.salary.basis.toUpperCase() as SalaryBasis) : null,
      salaryConfidence: result.salary.confidence ? (result.salary.confidence.toUpperCase() as SalaryConfidence) : null,
      salaryAnnualBase: normalized?.annualBase ?? null,
      salaryFlagReason: result.salaryFlagReason ?? null,
    },
  });

  redirect(`/jobs/${job.id}`);
}

export default function AddJobPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Add a Job</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Paste a job URL or raw JD text. The system scores it, extracts salary, and creates a record.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Job URL or JD text</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addJob} className="space-y-4">
            <Textarea
              name="input"
              rows={12}
              placeholder={`https://boards.greenhouse.io/company/jobs/12345\n\n— or —\n\nPaste the full job description here...`}
              className="font-mono text-sm resize-y"
              required
            />
            <p className="text-xs text-muted-foreground">
              URLs are fetched automatically (Jina reader). Greenhouse, Lever, and Ashby URLs work best.
              If fetch fails, paste the JD text directly.
            </p>
            <Button type="submit" className="w-full">
              Score & add →
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
