/**
 * Job detail page — opened from digest email Approve/Skip links and from board cards.
 * Server component with inline action form for appStage transitions.
 */

import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

const SALARY_PERIOD_LABEL: Record<string, string> = {
  YEAR: "/yr", MONTH: "/mo", HOUR: "/hr",
};

async function updateStage(formData: FormData) {
  "use server";
  const jobId = formData.get("jobId") as string;
  const action = formData.get("action") as string;
  const note = (formData.get("note") as string) || null;

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
      (SALARY_PERIOD_LABEL[job.salaryPeriod ?? "YEAR"] ?? "/yr") +
      (job.salaryBasis === "ESTIMATED" ? ` (est. ${job.salaryConfidence?.toLowerCase() ?? ""})` : " (stated)")
    : null;

  const actionPrompt = action === "approve"
    ? "Review the outreach message below, then confirm to queue it."
    : action === "skip"
    ? "Confirm to skip this job."
    : null;

  return (
    <div className="max-w-3xl mx-auto">
      <a href="/" className="text-sm text-blue-600 hover:underline mb-4 inline-block">← Back to board</a>

      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{job.company}</h1>
            <p className="text-lg text-gray-600">{job.role}</p>
          </div>
          {job.aiScore !== null && (
            <span className="text-xl font-bold text-blue-600 bg-blue-50 rounded-lg px-3 py-1">
              {job.aiScore}/100
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded">{job.source.replace(/_/g, " ")}</span>
          <span className="bg-purple-50 text-purple-700 px-2 py-1 rounded">{job.applyType.replace(/_/g, " ")}</span>
          <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded">{job.appStage}</span>
          {job.outreachState !== "NONE" && (
            <span className="bg-amber-50 text-amber-700 px-2 py-1 rounded">{job.outreachState.replace(/_/g, " ")}</span>
          )}
        </div>

        {job.aiReason && (
          <p className="text-gray-700 mb-3 text-sm">{job.aiReason}</p>
        )}

        {salary && (
          <p className="text-emerald-700 font-medium mb-3">{salary}</p>
        )}
        {job.salaryFlagReason && (
          <p className="text-amber-600 text-sm mb-3">⚠️ {job.salaryFlagReason.replace(/_/g, " ")}</p>
        )}

        {job.tailoredPitch && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 mb-4">
            <p className="text-xs font-semibold text-blue-600 mb-1">AI Pitch</p>
            <p className="text-sm text-blue-900 whitespace-pre-line">{job.tailoredPitch}</p>
          </div>
        )}

        {job.applyUrl && (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-sm"
          >
            Apply URL →
          </a>
        )}
      </div>

      {/* Action banner from email link */}
      {actionPrompt && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          {actionPrompt}
        </div>
      )}

      {/* Stage controls */}
      {job.appStage === "NEW" && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3">Take action</h2>
          <form action={updateStage} className="flex gap-3 items-end flex-wrap">
            <input type="hidden" name="jobId" value={job.id} />
            <input
              type="text"
              name="note"
              placeholder="Optional note"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-48"
            />
            <button
              type="submit"
              name="action"
              value="approve"
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              ✓ Approve & queue outreach
            </button>
            <button
              type="submit"
              name="action"
              value="skip"
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm"
            >
              ✗ Skip
            </button>
          </form>
        </div>
      )}

      {["APPROVED", "APPLIED"].includes(job.appStage) && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3">Update stage</h2>
          <form action={updateStage} className="flex gap-3 flex-wrap">
            <input type="hidden" name="jobId" value={job.id} />
            {["applied", "interviewing", "offer", "closed"].map(a => (
              <button
                key={a}
                type="submit"
                name="action"
                value={a}
                className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-sm capitalize"
              >
                {a}
              </button>
            ))}
          </form>
        </div>
      )}

      {/* Outreach history */}
      {job.outreaches.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-4">
          <h2 className="font-semibold text-gray-900 mb-3">Outreach</h2>
          {job.outreaches.map(o => (
            <div key={o.id} className="border-l-2 border-gray-200 pl-3 mb-3 text-sm">
              <p className="font-medium text-gray-900">{o.contact.name}</p>
              <p className="text-gray-500">{o.contact.title} · {o.role}</p>
              <a
                href={o.contact.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-xs"
              >
                LinkedIn →
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Full JD */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-semibold text-gray-900 mb-3">Job Description</h2>
        <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
          {job.jdText}
        </pre>
      </div>
    </div>
  );
}
