"use client";

import { useEffect, useState, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pause, Play, Clock, Lock } from "lucide-react";
import type { AppSettingsData } from "@/lib/settings";

type Tab = "sources" | "search" | "outreach" | "ai";
const TABS: { key: Tab; label: string }[] = [
  { key: "sources",  label: "Sources"  },
  { key: "search",   label: "Search"   },
  { key: "outreach", label: "Outreach" },
  { key: "ai",       label: "AI"       },
];

export default function SettingsPage() {
  const [s, setS]           = useState<AppSettingsData | null>(null);
  const [tab, setTab]       = useState<Tab>("sources");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [kw, setKw]         = useState("");
  const [co, setCo]         = useState("");

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setS).catch(console.error);
  }, []);

  const save = useCallback(async (next: AppSettingsData) => {
    setS(next); setSaving(true); setSaved(false);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  if (!s) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-6 h-6 rounded-full border-2 border-zinc-200 border-t-zinc-800 animate-spin" />
    </div>
  );

  const src = (v: Partial<typeof s.sources>)  => save({ ...s, sources:  { ...s.sources,  ...v } });
  const sch = (v: Partial<typeof s.search>)   => save({ ...s, search:   { ...s.search,   ...v } });
  const out = (v: Partial<typeof s.outreach>) => save({ ...s, outreach: { ...s.outreach, ...v } });
  const ai  = (v: Partial<typeof s.ai>)       => save({ ...s, ai:       { ...s.ai,       ...v } });

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">

      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-zinc-900">Settings</h1>
        <p className="text-sm text-zinc-400 mt-0.5">Changes save instantly.</p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 border-b border-zinc-200">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-400 hover:text-zinc-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Sources ─────────────────────────────────────────────────── */}
      {tab === "sources" && (
        <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100 overflow-hidden">
          {(
            [
              { key: "linkedin"     as const, label: "LinkedIn",      desc: "Job board + hiring posts via Unipile" },
              { key: "adzuna"       as const, label: "Adzuna",        desc: "India aggregator — free API" },
              { key: "atsWatchlist" as const, label: "ATS Watchlist", desc: "Greenhouse / Lever / Ashby company boards" },
              { key: "remotive"     as const, label: "Remotive",      desc: "Curated remote tech roles" },
              { key: "remoteok"     as const, label: "RemoteOK",      desc: "Remote-only job board" },
              { key: "jsearch"      as const, label: "JSearch",       desc: "Google for Jobs aggregator (RapidAPI — paid)" },
            ]
          ).map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between px-5 py-4 bg-white">
              <div>
                <p className="text-sm font-medium text-zinc-900">{label}</p>
                <p className="text-xs text-zinc-400 mt-0.5">{desc}</p>
              </div>
              <Switch checked={s.sources[key]} onCheckedChange={v => src({ [key]: v })} />
            </div>
          ))}
        </div>
      )}

      {/* ── Search ──────────────────────────────────────────────────── */}
      {tab === "search" && (
        <div className="space-y-4">
          <Section title="Keywords" desc="Each keyword runs as a separate search query.">
            <div className="flex flex-wrap gap-2 mb-3">
              {s.search.keywords.map(k => (
                <span key={k} className="inline-flex items-center gap-1 text-xs bg-zinc-100 text-zinc-700 rounded-lg px-2.5 py-1.5 font-medium">
                  {k}
                  <button onClick={() => sch({ keywords: s.search.keywords.filter(x => x !== k) })}
                    className="text-zinc-400 hover:text-zinc-700 ml-0.5">×</button>
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
              <Field label="Location">
                <Input defaultValue={s.search.location} className="text-sm"
                  onBlur={e => sch({ location: e.target.value })} />
              </Field>

              <SliderField
                label="Relevance threshold" value={s.search.relevanceThreshold}
                min={0} max={100} step={5}
                hint="Jobs below this score are auto-skipped."
                displayValue={`${s.search.relevanceThreshold}%`}
                onChange={v => setS(prev => prev ? { ...prev, search: { ...prev.search, relevanceThreshold: v } } : prev)}
                onCommit={v => sch({ relevanceThreshold: v })}
              />

              <Field label="Min annual salary">
                <div className="flex gap-2">
                  <Input type="number" defaultValue={s.search.minSalaryAmount} className="text-sm"
                    onBlur={e => sch({ minSalaryAmount: Number(e.target.value) })} />
                  <Input defaultValue={s.search.minSalaryCurrency} className="text-sm w-24" placeholder="INR"
                    onBlur={e => sch({ minSalaryCurrency: e.target.value.toUpperCase() })} />
                </div>
              </Field>

              <ToggleField
                label="Strict salary filter"
                desc="Skip jobs where salary is completely unknown. Off = keep but flag."
                checked={s.search.strictSalary}
                onChange={v => sch({ strictSalary: v })}
              />

              <div className="pt-4 border-t border-zinc-100">
                <Label className="text-sm font-medium text-zinc-700 block mb-3">Company blacklist</Label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {s.search.blacklistedCompanies.map(c => (
                    <span key={c} className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg px-2.5 py-1.5">
                      {c}
                      <button onClick={() => sch({ blacklistedCompanies: s.search.blacklistedCompanies.filter(x=>x!==c) })}
                        className="text-red-400 hover:text-red-700 ml-0.5">×</button>
                    </span>
                  ))}
                  {s.search.blacklistedCompanies.length === 0 && <p className="text-xs text-zinc-400">No companies blocked</p>}
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

      {/* ── Outreach ────────────────────────────────────────────────── */}
      {tab === "outreach" && (
        <div className="space-y-4">
          {/* Kill switch */}
          <div className={`rounded-xl border px-5 py-4 flex items-center justify-between transition-colors ${s.outreach.globalPause ? "bg-red-50 border-red-200" : "bg-white border-zinc-200"}`}>
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${s.outreach.globalPause ? "bg-red-100" : "bg-zinc-100"}`}>
                {s.outreach.globalPause
                  ? <Pause className="w-4 h-4 text-red-500" />
                  : <Play className="w-4 h-4 text-zinc-500" />
                }
              </div>
              <div>
                <p className={`text-sm font-semibold ${s.outreach.globalPause ? "text-red-900" : "text-zinc-900"}`}>
                  Pause all outreach
                </p>
                <p className={`text-xs mt-0.5 ${s.outreach.globalPause ? "text-red-400" : "text-zinc-400"}`}>
                  No messages will be sent across any source while active.
                </p>
              </div>
            </div>
            <Switch
              checked={s.outreach.globalPause}
              onCheckedChange={v => out({ globalPause: v })}
              className="data-[state=checked]:bg-red-500"
            />
          </div>

          {/* Rate limits + Send window side by side */}
          <div className="grid grid-cols-2 gap-4 items-start">
            <Section title="Rate Limits">
              <div className="space-y-5">
                {([
                  { key: "dailyInviteCap"          as const, label: "Daily invite cap",   min: 1,  max: 20,  fmt: (v: number) => String(v) },
                  { key: "weeklyInviteCap"          as const, label: "Weekly invite cap",  min: 1,  max: 100, fmt: (v: number) => String(v) },
                  { key: "dailyDmCap"               as const, label: "Daily DM cap",       min: 1,  max: 10,  fmt: (v: number) => String(v) },
                  { key: "maxReferralTargetsPerJob" as const, label: "Max targets / job",  min: 1,  max: 5,   fmt: (v: number) => String(v) },
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

            <div className="space-y-4">
              <Section title="Send Window (IST)" icon={<Clock className="w-3.5 h-3.5 text-zinc-400" />}>
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

              <Section title="Message Templates" icon={<Lock className="w-3.5 h-3.5 text-zinc-400" />}>
                <div className="space-y-1">
                  {["Invite Note", "First DM", "Follow-up"].map(t => (
                    <div key={t} className="flex items-center justify-between py-2.5 border-b border-zinc-100 last:border-0">
                      <span className="text-sm text-zinc-600">{t}</span>
                      <Badge variant="secondary" className="text-[10px] text-zinc-400 bg-zinc-100 border-0">Phase 2</Badge>
                    </div>
                  ))}
                </div>
              </Section>
            </div>
          </div>
        </div>
      )}

      {/* ── AI ──────────────────────────────────────────────────────── */}
      {tab === "ai" && (
        <Section title="Model">
          <div className="space-y-5">
            <Field label="Default model" hint="Used for scoring + salary extraction on every job.">
              <Input defaultValue={s.ai.defaultModel} className="text-sm font-mono" placeholder="gpt-4o-mini"
                onBlur={e => ai({ defaultModel: e.target.value })} />
            </Field>
            <div className="border-t border-zinc-100 pt-4">
              <ToggleField
                label="Resume tailoring"
                desc={<>AI rewrites LaTeX resume sections per JD. <Badge variant="outline" className="text-[10px] ml-1 align-middle">Phase 4</Badge></>}
                checked={s.ai.enableResumeTailoring}
                onChange={v => ai({ enableResumeTailoring: v })}
              />
            </div>
          </div>
        </Section>
      )}

      {/* Save toast */}
      {(saving || saved) && (
        <div className={`fixed bottom-6 right-6 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium shadow-lg z-50 transition-all ${saved ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600"}`}>
          {saving
            ? <><div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-300 border-t-zinc-600 animate-spin" /> Saving…</>
            : "✓ Saved"
          }
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, desc, icon, children }: {
  title: string; desc?: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-5">
      <div className="flex items-center gap-1.5 mb-4">
        {icon}
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
        {desc && <p className="text-xs text-zinc-400 mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-zinc-700">{label}</Label>
      {children}
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

function ToggleField({ label, desc, checked, onChange }: {
  label: string; desc: React.ReactNode; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
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
        <span className="text-xs text-zinc-500">{label}</span>
        <span className="text-sm font-bold text-zinc-900 tabular-nums min-w-[2.5rem] text-right">
          {displayValue ?? value}
        </span>
      </div>
      <Slider
        min={min} max={max} step={step} value={[value]}
        onValueChange={r => { const v = Array.isArray(r) ? (r[0] ?? min) : (r ?? min); onChange(v); }}
        onValueCommitted={r => { const v = Array.isArray(r) ? (r[0] ?? min) : (r ?? min); onCommit(v); }}
        className="[&_.slider-track]:h-1.5 [&_.slider-thumb]:h-4 [&_.slider-thumb]:w-4"
      />
      {hint && <p className="text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}
