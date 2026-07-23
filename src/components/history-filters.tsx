"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const STAGE_OPTIONS = [
  { value: "ALL", label: "All (incl. Skipped)" },
  { value: "NEW", label: "New" },
  { value: "APPROVED", label: "Approved" },
  { value: "OUTREACH", label: "Outreach" },
  { value: "REPLIED", label: "Replied" },
  { value: "APPLIED", label: "Applied" },
  { value: "INTERVIEWING", label: "Interviewing" },
  { value: "OFFER", label: "Offer" },
  { value: "SKIPPED", label: "Skipped" },
];

const SOURCE_OPTIONS = [
  { value: "ALL", label: "All sources" },
  { value: "LINKEDIN_JOB", label: "LinkedIn" },
  { value: "LINKEDIN_POST", label: "LI Post" },
  { value: "ADZUNA", label: "Adzuna" },
  { value: "ATS_WATCHLIST", label: "Watchlist" },
  { value: "REMOTIVE", label: "Remotive" },
  { value: "REMOTEOK", label: "RemoteOK" },
  { value: "JSEARCH", label: "JSearch" },
  { value: "MANUAL", label: "Manual" },
];

const SKIP_SOURCE_OPTIONS = [
  { value: "ALL", label: "Any skip reason" },
  { value: "MANUAL", label: "Manual" },
  { value: "AI_TRIAGE", label: "AI triage" },
  { value: "AI_SCORE", label: "AI score" },
  { value: "STALE", label: "Stale" },
  { value: "BLACKLIST", label: "Blacklist" },
];

const SORT_OPTIONS = [
  { value: "discoveredAt", label: "Discovered" },
  { value: "aiScore", label: "Score" },
  { value: "salaryAnnualBase", label: "Salary" },
  { value: "company", label: "Company" },
  { value: "appStage", label: "Stage" },
];

export function HistoryFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // Text/number/date fields are debounced to blur/Enter (not every keystroke)
  // before they hit the URL; everything else (Select/Switch/sort) commits
  // immediately since those are one-shot clicks, not typing.
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [salaryMin, setSalaryMin] = useState(sp.get("salaryMin") ?? "");
  const [salaryMax, setSalaryMax] = useState(sp.get("salaryMax") ?? "");
  const [dateFrom, setDateFrom] = useState(sp.get("dateFrom") ?? "");
  const [dateTo, setDateTo] = useState(sp.get("dateTo") ?? "");

  // Keep local input state in sync when the URL changes from elsewhere
  // (Clear all, pagination links).
  useEffect(() => {
    setQ(sp.get("q") ?? "");
    setSalaryMin(sp.get("salaryMin") ?? "");
    setSalaryMax(sp.get("salaryMax") ?? "");
    setDateFrom(sp.get("dateFrom") ?? "");
    setDateTo(sp.get("dateTo") ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.toString()]);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      next.delete("page"); // any filter/sort change restarts pagination
      router.push(`${pathname}?${next.toString()}`);
    },
    [router, pathname, sp]
  );

  const appStage = sp.get("appStage") ?? "ALL";
  const source = sp.get("source") ?? "ALL";
  const skipSource = sp.get("skipSource") ?? "ALL";
  const pinned = sp.get("pinned") === "1";
  const sort = sp.get("sort") ?? "discoveredAt";
  const dir = sp.get("dir") ?? "desc";

  const hasFilters = !!(
    (appStage !== "ALL") || (source !== "ALL") || (skipSource !== "ALL") ||
    pinned || sp.get("q") || sp.get("salaryMin") || sp.get("salaryMax") ||
    sp.get("dateFrom") || sp.get("dateTo")
  );

  const clearAll = () => router.push(pathname);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && update({ q: q || null })}
            onBlur={() => update({ q: q || null })}
            placeholder="Search company or role…"
            className="h-8 pl-8 pr-7 text-xs bg-card border-border shadow-sm rounded-lg"
          />
          {q && (
            <button
              onClick={() => { setQ(""); update({ q: null }); }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <Select value={appStage} onValueChange={(v: string | null) => update({ appStage: v === "ALL" ? null : v })}>
          <SelectTrigger className="h-8 text-xs text-muted-foreground shadow-sm">
            {`Stage: ${STAGE_OPTIONS.find((o) => o.value === appStage)?.label ?? "All"}`}
          </SelectTrigger>
          <SelectContent>
            {STAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={source} onValueChange={(v: string | null) => update({ source: v === "ALL" ? null : v })}>
          <SelectTrigger className="h-8 text-xs text-muted-foreground shadow-sm">
            {`Source: ${SOURCE_OPTIONS.find((o) => o.value === source)?.label ?? "All"}`}
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={skipSource}
          onValueChange={(v: string | null) => update({ skipSource: v === "ALL" ? null : v })}
        >
          <SelectTrigger
            className="h-8 text-xs text-muted-foreground shadow-sm disabled:opacity-40"
            disabled={appStage !== "SKIPPED"}
          >
            {`Skip reason: ${SKIP_SOURCE_OPTIONS.find((o) => o.value === skipSource)?.label ?? "Any"}`}
          </SelectTrigger>
          <SelectContent>
            {SKIP_SOURCE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground pl-1">
          <Switch checked={pinned} onCheckedChange={(v: boolean) => update({ pinned: v ? "1" : null })} size="sm" />
          Pinned only
        </label>

        {hasFilters && (
          <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors">
            Clear all
          </button>
        )}

        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <span className="mr-1 font-medium">Sort</span>
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => update({ sort: o.value })}
              className={`px-2.5 py-1.5 rounded-lg transition-all ${sort === o.value ? "bg-card text-foreground shadow-sm font-medium ring-1 ring-border" : "hover:bg-card hover:text-foreground hover:shadow-sm"}`}
            >
              {o.label}
            </button>
          ))}
          <button
            onClick={() => update({ dir: dir === "asc" ? "desc" : "asc" })}
            className="px-2 py-1.5 rounded-lg hover:bg-card hover:text-foreground hover:shadow-sm transition-all"
            aria-label="Toggle sort direction"
          >
            {dir === "asc" ? "↑" : "↓"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          value={salaryMin}
          onChange={(e) => setSalaryMin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && update({ salaryMin: salaryMin || null })}
          onBlur={() => update({ salaryMin: salaryMin || null })}
          placeholder="Min salary (annual)"
          className="h-8 w-40 text-xs bg-card border-border shadow-sm rounded-lg"
        />
        <Input
          type="number"
          inputMode="numeric"
          value={salaryMax}
          onChange={(e) => setSalaryMax(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && update({ salaryMax: salaryMax || null })}
          onBlur={() => update({ salaryMax: salaryMax || null })}
          placeholder="Max salary (annual)"
          className="h-8 w-40 text-xs bg-card border-border shadow-sm rounded-lg"
        />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          onBlur={() => update({ dateFrom: dateFrom || null })}
          className="h-8 rounded-lg border border-border bg-card px-2 text-xs shadow-sm text-foreground"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          onBlur={() => update({ dateTo: dateTo || null })}
          className="h-8 rounded-lg border border-border bg-card px-2 text-xs shadow-sm text-foreground"
        />
      </div>
    </div>
  );
}
