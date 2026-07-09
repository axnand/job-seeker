"use client";

import { useEffect, useState, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import {
  Pause, Play, Clock, Lock, SlidersHorizontal, Check, X, CircleX,
  Rss, Search as SearchIcon, User, Send, MessageSquare, Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { AppSettingsData } from "@/lib/settings";

type Section = "sources" | "search" | "profile" | "outreach" | "templates" | "ai";
const NAV: { key: Section; label: string; icon: LucideIcon; desc: string }[] = [
  { key: "sources",   label: "Sources",   icon: Rss,          desc: "Where jobs are discovered from." },
  { key: "search",    label: "Search",    icon: SearchIcon,   desc: "Keywords, filters, and the relevance bar." },
  { key: "profile",   label: "Profile",   icon: User,         desc: "The candidate profile the AI scores against." },
  { key: "outreach",  label: "Outreach",  icon: Send,         desc: "Rate limits, send window, and the kill switch." },
  { key: "templates", label: "Templates", icon: MessageSquare, desc: "The messages every draft is built from." },
  { key: "ai",        label: "AI",        icon: Sparkles,     desc: "Models for scoring and triage." },
];

export default function SettingsPage() {
  const [s, setS]           = useState<AppSettingsData | null>(null);
  const [section, setSection] = useState<Section>("sources");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [kw, setKw]         = useState("");
  const [co, setCo]         = useState("");
  const [tcForm, setTcForm] = useState<{ name: string; ats: "greenhouse" | "lever" | "ashby"; boardToken: string }>({ name: "", ats: "greenhouse", boardToken: "" });
  const [faForm, setFaForm] = useState<{ name: string; publicId: string }>({ name: "", publicId: "" });

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setS).catch(console.error);
  }, []);

  const save = useCallback(async (next: AppSettingsData) => {
    setS(next); setSaving(true); setSaved(false); setSaveError(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 4000);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!s) return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-border border-t-primary animate-spin" />
    </div>
  );

  const src  = (v: Partial<typeof s.sources>)   => save({ ...s, sources:  { ...s.sources,  ...v } });
  const sch  = (v: Partial<typeof s.search>)    => save({ ...s, search:   { ...s.search,   ...v } });
  const prof = (v: Partial<typeof s.profile>)   => save({ ...s, profile:  { ...s.profile,  ...v } });
  const out  = (v: Partial<typeof s.outreach>)  => save({ ...s, outreach: { ...s.outreach, ...v } });
  const ai   = (v: Partial<typeof s.ai>)        => save({ ...s, ai:       { ...s.ai,       ...v } });
  const tc   = (v: typeof s.targetCompanies)    => save({ ...s, targetCompanies: v });
  const fa   = (v: typeof s.feedAuthors)        => save({ ...s, feedAuthors: v });
  const tpl  = (v: Partial<typeof s.templates>) => save({ ...s, templates: { ...s.templates, ...v } });

  const active = NAV.find(n => n.key === section)!;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <PageHeader title="Settings" subtitle="Changes save instantly" icon={<SlidersHorizontal className="size-4" />} />

      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Section nav ──────────────────────────────────────────────── */}
        <nav className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3 sm:flex scrollbar-slim">
          {NAV.map(({ key, label, icon: Icon }) => {
            const on = section === key;
            return (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={cn(
                  "group relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  on
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {on && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />}
                <Icon className={cn("size-4 shrink-0", on && "text-primary")} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* ── Content pane ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto scrollbar-slim">
          <div className="mx-auto max-w-4xl px-6 py-8 sm:px-10">

            {/* Section header */}
            <div className="mb-6">
              {/* Mobile section picker (nav is hidden on small screens) */}
              <div className="mb-4 flex gap-1.5 overflow-x-auto sm:hidden scrollbar-slim">
                {NAV.map(({ key, label }) => (
                  <button key={key} onClick={() => setSection(key)}
                    className={cn("shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      section === key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {label}
                  </button>
                ))}
              </div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">{active.label}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{active.desc}</p>
            </div>

            {/* ── Sources ─────────────────────────────────────────────── */}
            {section === "sources" && (
              <div className="space-y-6">
                <div className="overflow-hidden rounded-xl border border-border divide-y divide-border">
                  {(
                    [
                      { key: "linkedin"     as const, label: "LinkedIn Jobs",  desc: "LinkedIn job board via Unipile" },
                      { key: "linkedinPosts" as const, label: "LinkedIn Posts", desc: "Hiring posts (\"we're hiring\" / \"DM me\") via global keyword search — AI-extracted" },
                      { key: "linkedinFeed"  as const, label: "LinkedIn Feed",  desc: "Hiring posts from a curated author watchlist (set below)" },
                      { key: "adzuna"       as const, label: "Adzuna",        desc: "India aggregator — free API" },
                      { key: "atsWatchlist" as const, label: "ATS Watchlist", desc: "Greenhouse / Lever / Ashby company boards" },
                      { key: "remotive"     as const, label: "Remotive",      desc: "Curated remote tech roles" },
                      { key: "remoteok"     as const, label: "RemoteOK",      desc: "Remote-only job board" },
                      { key: "jsearch"      as const, label: "JSearch",       desc: "Google for Jobs aggregator (RapidAPI — paid)" },
                    ]
                  ).map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between gap-4 bg-card px-5 py-4">
                      <div>
                        <p className="text-sm font-medium text-foreground">{label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                      </div>
                      <Switch checked={s.sources[key]} onCheckedChange={v => src({ [key]: v })} />
                    </div>
                  ))}
                </div>

                <Section title="ATS Watchlist" desc="Companies polled directly on their Greenhouse / Lever / Ashby boards — the highest-signal source.">
                  <div className="mb-4 space-y-2">
                    {s.targetCompanies.length === 0 && (
                      <p className="text-xs text-muted-foreground">No companies yet. Add a few you&apos;d love to work at.</p>
                    )}
                    {s.targetCompanies.map((c, i) => (
                      <div key={`${c.ats}:${c.boardToken}:${i}`} className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{c.ats}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{c.boardToken}</span>
                        <button onClick={() => tc(s.targetCompanies.filter((_, j) => j !== i))} aria-label="Remove"
                          className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-red-600 dark:hover:text-red-400"><X className="size-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input value={tcForm.name} onChange={e => setTcForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Company" className="flex-1 text-sm" />
                    <Select value={tcForm.ats} onValueChange={(v: string | null) => { if (v) setTcForm(f => ({ ...f, ats: v as typeof f.ats })); }}>
                      <SelectTrigger className="text-sm capitalize">{tcForm.ats}</SelectTrigger>
                      <SelectContent>
                        <SelectItem value="greenhouse">Greenhouse</SelectItem>
                        <SelectItem value="lever">Lever</SelectItem>
                        <SelectItem value="ashby">Ashby</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input value={tcForm.boardToken} onChange={e => setTcForm(f => ({ ...f, boardToken: e.target.value }))}
                      placeholder="board token" className="w-32 font-mono text-sm" />
                    <Button variant="outline" size="sm"
                      onClick={() => {
                        if (!tcForm.name.trim() || !tcForm.boardToken.trim()) return;
                        tc([...s.targetCompanies, { name: tcForm.name.trim(), ats: tcForm.ats, boardToken: tcForm.boardToken.trim() }]);
                        setTcForm({ name: "", ats: "greenhouse", boardToken: "" });
                      }}>
                      Add
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">Board token = the company slug in their careers URL (e.g. <span className="font-mono">stripe</span> for greenhouse.io/stripe). Requires the ATS Watchlist source above to be on.</p>
                </Section>

                <Section title="Feed Watchlist" desc="People whose posts are monitored for hiring signals. LinkedIn has no home-feed API, so we poll each author directly — the author becomes your warm referral contact.">
                  <div className="mb-4 space-y-2">
                    {s.feedAuthors.length === 0 && (
                      <p className="text-xs text-muted-foreground">No authors yet. Add recruiters or people who post roles you&apos;d want a referral for.</p>
                    )}
                    {s.feedAuthors.map((a, i) => (
                      <div key={`${a.publicId}:${i}`} className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                        <span className="font-medium text-foreground">{a.name}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">linkedin.com/in/{a.publicId}</span>
                        <button onClick={() => fa(s.feedAuthors.filter((_, j) => j !== i))} aria-label="Remove"
                          className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-red-600 dark:hover:text-red-400"><X className="size-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input value={faForm.name} onChange={e => setFaForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Name" className="flex-1 text-sm" />
                    <Input value={faForm.publicId} onChange={e => setFaForm(f => ({ ...f, publicId: e.target.value }))}
                      placeholder="profile slug" className="flex-1 font-mono text-sm" />
                    <Button variant="outline" size="sm"
                      onClick={() => {
                        const publicId = normalizeSlug(faForm.publicId);
                        if (!faForm.name.trim() || !publicId) return;
                        fa([...s.feedAuthors, { name: faForm.name.trim(), publicId }]);
                        setFaForm({ name: "", publicId: "" });
                      }}>
                      Add
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">Profile slug = the part after <span className="font-mono">/in/</span> in their profile URL (e.g. <span className="font-mono">jane-doe</span> for linkedin.com/in/jane-doe). You can paste the full URL — we&apos;ll extract the slug. Requires the LinkedIn Feed source above to be on.</p>
                </Section>
              </div>
            )}

            {/* ── Search ──────────────────────────────────────────────── */}
            {section === "search" && (
              <div className="space-y-6">
                <Section title="Keywords" desc="Each keyword runs as a separate search query.">
                  <div className="mb-3 flex flex-wrap gap-2">
                    {s.search.keywords.map(k => (
                      <span key={k} className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground">
                        {k}
                        <button onClick={() => sch({ keywords: s.search.keywords.filter(x => x !== k) })} aria-label="Remove"
                          className="ml-0.5 inline-flex text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input value={kw} onChange={e => setKw(e.target.value)} placeholder="e.g. backend engineer" className="text-sm"
                      onKeyDown={e => { if (e.key==="Enter"&&kw.trim()) { sch({ keywords:[...s.search.keywords,kw.trim()] }); setKw(""); } }} />
                    <Button variant="outline" size="sm" onClick={() => { if(kw.trim()) { sch({ keywords:[...s.search.keywords,kw.trim()] }); setKw(""); } }}>
                      Add
                    </Button>
                  </div>
                </Section>

                <Section title="Filters">
                  <div className="space-y-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Location">
                        <Input defaultValue={s.search.location} className="text-sm"
                          onBlur={e => sch({ location: e.target.value })} />
                      </Field>
                      <Field label="Min annual salary">
                        <div className="flex gap-2">
                          <Input type="number" defaultValue={s.search.minSalaryAmount} className="text-sm"
                            onBlur={e => sch({ minSalaryAmount: Number(e.target.value) })} />
                          <Input defaultValue={s.search.minSalaryCurrency} className="w-24 text-sm" placeholder="INR"
                            onBlur={e => sch({ minSalaryCurrency: e.target.value.toUpperCase() })} />
                        </div>
                      </Field>
                    </div>

                    <SliderField
                      label="Relevance threshold" value={s.search.relevanceThreshold}
                      min={0} max={100} step={5}
                      hint="Jobs below this score are auto-skipped."
                      displayValue={`${s.search.relevanceThreshold}%`}
                      onChange={v => setS(prev => prev ? { ...prev, search: { ...prev.search, relevanceThreshold: v } } : prev)}
                      onCommit={v => sch({ relevanceThreshold: v })}
                    />

                    <ToggleField
                      label="Strict salary filter"
                      desc="Skip jobs where salary is completely unknown. Off = keep but flag."
                      checked={s.search.strictSalary}
                      onChange={v => sch({ strictSalary: v })}
                    />

                    <div className="border-t border-border pt-4">
                      <Label className="mb-3 block text-sm font-medium text-foreground">Company blacklist</Label>
                      <div className="mb-3 flex flex-wrap gap-2">
                        {s.search.blacklistedCompanies.map(c => (
                          <span key={c} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                            {c}
                            <button onClick={() => sch({ blacklistedCompanies: s.search.blacklistedCompanies.filter(x=>x!==c) })} aria-label="Remove"
                              className="ml-0.5 inline-flex text-red-400 hover:text-red-700 dark:hover:text-red-200"><X className="size-3" /></button>
                          </span>
                        ))}
                        {s.search.blacklistedCompanies.length === 0 && <p className="text-xs text-muted-foreground">No companies blocked</p>}
                      </div>
                      <div className="flex gap-2">
                        <Input value={co} onChange={e => setCo(e.target.value)} placeholder="Company name" className="text-sm"
                          onKeyDown={e => { if(e.key==="Enter"&&co.trim()) { sch({ blacklistedCompanies:[...s.search.blacklistedCompanies,co.trim()] }); setCo(""); } }} />
                        <Button variant="outline" size="sm" onClick={() => { if(co.trim()) { sch({ blacklistedCompanies:[...s.search.blacklistedCompanies,co.trim()] }); setCo(""); } }}>
                          Block
                        </Button>
                      </div>
                    </div>
                  </div>
                </Section>
              </div>
            )}

            {/* ── Profile ─────────────────────────────────────────────── */}
            {section === "profile" && (
              <div className="space-y-6">
                <Section title="Candidate summary" desc="A short paragraph the AI uses to judge fit on every job.">
                  <textarea
                    defaultValue={s.profile.summary}
                    rows={5}
                    placeholder="e.g. Backend engineer with 6 years building payments infra at scale…"
                    onBlur={e => { if (e.target.value !== s.profile.summary) prof({ summary: e.target.value }); }}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/50"
                  />
                </Section>

                <Section title="Targeting" desc="The roles, industries, and level you want to be matched to.">
                  <div className="space-y-5">
                    <TagField label="Target roles" values={s.profile.targetRoles}
                      placeholder="e.g. Staff Backend Engineer"
                      onChange={v => prof({ targetRoles: v })} />
                    <TagField label="Preferred industries" values={s.profile.preferredIndustries}
                      placeholder="e.g. Fintech"
                      onChange={v => prof({ preferredIndustries: v })} />
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Seniority level" hint="Your current level (free text).">
                        <Input defaultValue={s.profile.seniorityLevel} className="text-sm"
                          onBlur={e => { if (e.target.value !== s.profile.seniorityLevel) prof({ seniorityLevel: e.target.value }); }} />
                      </Field>
                      <Field label="Current base (LPA)" hint="Drives the salary-floor scoring.">
                        <Input type="number" defaultValue={s.profile.currentBaseLPA} className="text-sm"
                          onBlur={e => { const n = Number(e.target.value); if (n !== s.profile.currentBaseLPA) prof({ currentBaseLPA: n }); }} />
                      </Field>
                    </div>
                  </div>
                </Section>

                <Section title="Seniority rules" desc="Levels the AI should accept or hard-reject during triage.">
                  <div className="space-y-5">
                    <TagField label="Acceptable seniority" values={s.profile.acceptableSeniority}
                      placeholder="e.g. senior"
                      onChange={v => prof({ acceptableSeniority: v })} />
                    <TagField label="Reject seniority" values={s.profile.rejectSeniority}
                      placeholder="e.g. intern"
                      onChange={v => prof({ rejectSeniority: v })} />
                  </div>
                </Section>
              </div>
            )}

            {/* ── Outreach ────────────────────────────────────────────── */}
            {section === "outreach" && (
              <div className="space-y-6">
                {/* Kill switch — entire card is clickable */}
                <button
                  type="button"
                  onClick={() => out({ globalPause: !s.outreach.globalPause })}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between rounded-xl border px-5 py-4 text-left transition-colors",
                    s.outreach.globalPause
                      ? "border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:hover:bg-red-500/15"
                      : "border-border bg-card hover:bg-accent/50"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full",
                      s.outreach.globalPause ? "bg-red-100 dark:bg-red-500/20" : "bg-muted")}>
                      {s.outreach.globalPause
                        ? <Pause className="size-4 text-red-500 dark:text-red-400" />
                        : <Play className="size-4 text-muted-foreground" />}
                    </div>
                    <div>
                      <p className={cn("text-sm font-semibold", s.outreach.globalPause ? "text-red-900 dark:text-red-200" : "text-foreground")}>
                        {s.outreach.globalPause ? "Outreach paused — click to resume" : "Pause all outreach"}
                      </p>
                      <p className={cn("mt-0.5 text-xs", s.outreach.globalPause ? "text-red-500/80 dark:text-red-400/80" : "text-muted-foreground")}>
                        No messages will be sent across any source while active.
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={s.outreach.globalPause}
                    onCheckedChange={v => out({ globalPause: v })}
                    className="pointer-events-none data-[state=checked]:bg-red-500"
                  />
                </button>

                <div className="grid items-start gap-6 lg:grid-cols-2">
                  <Section title="Rate Limits">
                    <div className="space-y-5">
                      {([
                        { key: "dailyInviteCap"          as const, label: "Daily invite cap",   min: 1,  max: 20,  fmt: (v: number) => String(v) },
                        { key: "weeklyInviteCap"          as const, label: "Weekly invite cap",  min: 1,  max: 100, fmt: (v: number) => String(v) },
                        { key: "dailyDmCap"               as const, label: "Daily DM cap",       min: 1,  max: 10,  fmt: (v: number) => String(v) },
                        { key: "maxReferralTargetsPerJob" as const, label: "Max targets / job",  min: 1,  max: 25,   fmt: (v: number) => String(v) },
                        { key: "maxFollowups"             as const, label: "Max follow-ups",     min: 0,  max: 3,   fmt: (v: number) => String(v) },
                        { key: "recontactCooldownDays"    as const, label: "Recontact cooldown", min: 7,  max: 90,  fmt: (v: number) => `${v}d` },
                      ]).map(({ key, label, min, max, fmt }) => (
                        <SliderField key={key} label={label} value={s.outreach[key]} min={min} max={max} step={1}
                          displayValue={fmt(s.outreach[key])}
                          onChange={v => setS(prev => prev ? { ...prev, outreach: { ...prev.outreach, [key]: v } } : prev)}
                          onCommit={v => out({ [key]: v })}
                        />
                      ))}
                    </div>
                  </Section>

                  <div className="space-y-6">
                    <Section title="Send Window (IST)" icon={<Clock className="size-3.5 text-muted-foreground" />}>
                      <div className="space-y-5">
                        {([
                          { key: "sendWindowStart"   as const, label: "Start hour",     fmt: (v: number) => `${String(v).padStart(2, "0")}:00` },
                          { key: "sendWindowEnd"     as const, label: "End hour",       fmt: (v: number) => `${String(v).padStart(2, "0")}:00` },
                          { key: "followupAfterDays" as const, label: "Follow-up after", fmt: (v: number) => `${v}d` },
                        ]).map(({ key, label, fmt }) => (
                          <SliderField key={key} label={label} value={s.outreach[key]}
                            min={key === "followupAfterDays" ? 1 : 0}
                            max={key === "followupAfterDays" ? 14 : 23}
                            step={1}
                            displayValue={fmt(s.outreach[key])}
                            onChange={v => setS(prev => prev ? { ...prev, outreach: { ...prev.outreach, [key]: v } } : prev)}
                            onCommit={v => out({ [key]: v })}
                          />
                        ))}
                      </div>
                    </Section>

                    <Section title="Pipeline" desc="Replenishment targets per job.">
                      <div className="space-y-5">
                        {([
                          { key: "connectTarget"         as const, label: "Accept target / job",  min: 1,  max: 15, fmt: (v: number) => String(v),  hint: "Top up until this many people accept the invite." },
                          { key: "maxInvitesPerJob"       as const, label: "Max invites / job",    min: 5,  max: 50, fmt: (v: number) => String(v),  hint: "Hard ceiling on total invites ever sent per job." },
                          { key: "inviteTimeoutDays"      as const, label: "Invite timeout",       min: 3,  max: 21, fmt: (v: number) => `${v}d`,   hint: "Cancel unaccepted invite after this — frees a slot." },
                          { key: "replenishIntervalHours" as const, label: "Replenish check every", min: 1, max: 48, fmt: (v: number) => `${v}h`,   hint: "Min time between people-search top-ups per job." },
                        ]).map(({ key, label, min, max, fmt, hint }) => (
                          <SliderField key={key} label={label} value={s.outreach[key]} min={min} max={max} step={1}
                            displayValue={fmt(s.outreach[key])} hint={hint}
                            onChange={v => setS(prev => prev ? { ...prev, outreach: { ...prev.outreach, [key]: v } } : prev)}
                            onCommit={v => out({ [key]: v })}
                          />
                        ))}
                      </div>
                    </Section>
                  </div>
                </div>
              </div>
            )}

            {/* ── Templates ───────────────────────────────────────────── */}
            {section === "templates" && (
              <Section title="Message Templates" icon={<Lock className="size-3.5 text-muted-foreground" />}
                desc="Drafted per job from these, then you review & edit each one in the job drawer before it sends.">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {["{firstName}", "{name}", "{company}", "{role}", "{pitch}", "{ownerName}", "{jobId}", "{jobRef}"].map(v => (
                    <code key={v} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{v}</code>
                  ))}
                  <span className="ml-1 self-center text-[11px] text-muted-foreground">— filled in automatically per job</span>
                </div>
                <div className="space-y-4">
                  <TemplateField
                    label="Connection note" hint="Sent WITH the invite · ≤300 chars · keep it short, no hard ask"
                    defaultValue={s.templates.connectionNote} maxLength={300}
                    onCommit={v => tpl({ connectionNote: v })}
                  />
                  <TemplateField
                    label="First DM" hint="Sent after they accept the connection"
                    defaultValue={s.templates.firstDm}
                    onCommit={v => tpl({ firstDm: v })}
                  />
                  <TemplateField
                    label="Follow-up" hint="Sent once if there's no reply after the follow-up delay"
                    defaultValue={s.templates.followup}
                    onCommit={v => tpl({ followup: v })}
                  />
                </div>
              </Section>
            )}

            {/* ── AI ──────────────────────────────────────────────────── */}
            {section === "ai" && (
              <Section title="Model">
                <div className="space-y-5">
                  <Field label="Default model" hint="Used for scoring + salary extraction on every job. Ignored if a default AI provider is configured in the database (AiProvider table) — that provider's model wins.">
                    <ModelPicker value={s.ai.defaultModel} onChange={v => ai({ defaultModel: v })} />
                  </Field>
                  <Field label="Triage model" hint="Cheap pre-filter that rejects obvious mismatches (seniority/role/location — never pay) before the expensive scoring call. Most jobs are rejects, so this is where the cost savings live.">
                    <ModelPicker value={s.ai.triageModel} onChange={v => ai({ triageModel: v })} />
                  </Field>
                  <div className="border-t pt-5">
                    <ToggleField
                      label="Truthful resume tailoring"
                      desc={
                        s.ai.truthfulTailoring
                          ? "ON (recommended): auto-tailoring may only reorder / rephrase / emphasize skills already in your master resume. The validator rejects any invented skill, tool, or metric."
                          : "OFF (relaxed): tailoring MAY add adjacent, JD-relevant skills your master lacks — to widen matches on roles you could grow into. Employers, titles, degrees and dates always stay real. Use with care: you should be ready to back-fill any added skill on the job."
                      }
                      checked={s.ai.truthfulTailoring}
                      onChange={v => ai({ truthfulTailoring: v })}
                    />
                  </div>
                </div>
              </Section>
            )}

          </div>
        </div>
      </div>

      {/* Save toast */}
      {(saving || saved || saveError) && (
        <div className={cn(
          "fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium shadow-lg transition-all",
          saveError ? "bg-red-600 text-white"
          : saved ? "bg-zinc-900 text-white dark:bg-zinc-800 dark:ring-1 dark:ring-white/10"
          : "bg-muted text-muted-foreground"
        )}>
          {saving
            ? <><div className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" /> Saving…</>
            : saveError ? <><CircleX className="size-4" /> Save failed — check your connection</>
            : <><Check className="size-4" /> Saved</>
          }
        </div>
      )}
    </div>
  );
}

/** Accept a full LinkedIn profile URL or a bare slug; return the /in/ slug. */
function normalizeSlug(input: string): string {
  const v = input.trim();
  const m = v.match(/\/in\/([^/?#]+)/);
  return (m ? m[1] : v).replace(/\/+$/, "");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Curated OpenAI-compatible models for the scoring pipeline. gpt-4.1 is the
// recommended default: its world-knowledge of company pay bands keeps salary
// estimates calibrated (see config.ts). "Custom…" allows any model id.
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "gpt-4.1",      label: "gpt-4.1 — best salary calibration (recommended)" },
  { value: "gpt-4.1-mini", label: "gpt-4.1-mini — cheaper, weaker pay-band knowledge" },
  { value: "gpt-4.1-nano", label: "gpt-4.1-nano — cheapest, triage-grade only" },
  { value: "gpt-4o",       label: "gpt-4o" },
  { value: "gpt-4o-mini",  label: "gpt-4o-mini — cheapest, optimistic salary guesses" },
  { value: "o4-mini",      label: "o4-mini — reasoning model, slower" },
];

function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = MODEL_OPTIONS.some(o => o.value === value);
  const [custom, setCustom] = useState(!isPreset);

  const currentLabel = custom
    ? "Custom…"
    : (MODEL_OPTIONS.find(o => o.value === value)?.label ?? value);

  return (
    <div className="space-y-2">
      <Select
        value={custom ? "__custom__" : value}
        onValueChange={(v: string | null) => {
          if (!v) return;
          if (v === "__custom__") { setCustom(true); return; }
          setCustom(false);
          onChange(v);
        }}
      >
        <SelectTrigger className="h-9 w-full text-sm">
          <span className="truncate">{currentLabel}</span>
        </SelectTrigger>
        <SelectContent>
          {MODEL_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          <SelectItem value="__custom__">Custom…</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <Input
          defaultValue={isPreset ? "" : value}
          className="font-mono text-sm"
          placeholder="any OpenAI-compatible model id"
          onBlur={e => { const v = e.target.value.trim(); if (v) onChange(v); }}
        />
      )}
    </div>
  );
}

function Section({ title, desc, icon, children }: {
  title: string; desc?: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <div className="flex items-center gap-1.5">
          {icon}
          <p className="text-sm font-semibold text-foreground">{title}</p>
        </div>
        {desc && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function TemplateField({ label, hint, defaultValue, maxLength, onCommit }: {
  label: string; hint: string; defaultValue: string; maxLength?: number; onCommit: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-sm font-medium text-foreground">{label}</Label>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <textarea
        defaultValue={defaultValue}
        maxLength={maxLength}
        rows={label === "Connection note" ? 3 : 5}
        onBlur={e => { if (e.target.value !== defaultValue) onCommit(e.target.value); }}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/50"
      />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleField({ label, desc, checked, onChange }: {
  label: string; desc: React.ReactNode; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// Tag list editor for string[] profile fields — add on Enter or the Add button.
function TagField({ label, hint, values, placeholder, onChange }: {
  label: string; hint?: string; values: string[]; placeholder?: string; onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      <div className="mb-1 flex flex-wrap gap-2">
        {values.map(v => (
          <span key={v} className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground">
            {v}
            <button onClick={() => onChange(values.filter(x => x !== v))} aria-label={`Remove ${v}`}
              className="ml-0.5 inline-flex text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
          </span>
        ))}
        {values.length === 0 && <p className="text-xs text-muted-foreground">None yet</p>}
      </div>
      <div className="flex gap-2">
        <Input value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder} className="text-sm"
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <Button variant="outline" size="sm" onClick={add}>Add</Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SliderField({ label, value, min, max, step, hint, displayValue, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step: number;
  hint?: string; displayValue?: string;
  onChange: (v: number) => void; onCommit: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="min-w-[2.5rem] text-right text-sm font-bold tabular-nums text-foreground">
          {displayValue ?? value}
        </span>
      </div>
      <Slider
        min={min} max={max} step={step} value={[value]}
        onValueChange={r => { const v = Array.isArray(r) ? (r[0] ?? min) : (r ?? min); onChange(v); }}
        onValueCommitted={r => { const v = Array.isArray(r) ? (r[0] ?? min) : (r ?? min); onCommit(v); }}
        className="[&_.slider-track]:h-1.5 [&_.slider-thumb]:h-4 [&_.slider-thumb]:w-4"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
