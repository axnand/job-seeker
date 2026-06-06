"use client";

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { AppSettingsData } from "@/lib/settings";

export default function SettingsPage() {
  const [s, setS]         = useState<AppSettingsData | null>(null);
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
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  if (!s) return (
    <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">Loading…</div>
  );

  const src = (v: Partial<typeof s.sources>)  => save({ ...s, sources:  { ...s.sources,  ...v } });
  const sch = (v: Partial<typeof s.search>)   => save({ ...s, search:   { ...s.search,   ...v } });
  const out = (v: Partial<typeof s.outreach>) => save({ ...s, outreach: { ...s.outreach, ...v } });
  const ai  = (v: Partial<typeof s.ai>)       => save({ ...s, ai:       { ...s.ai,       ...v } });

  const sliderVal = (raw: number | readonly number[], fallback: number) =>
    Array.isArray(raw) ? (raw[0] ?? fallback) : ((raw as number) ?? fallback);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Changes save instantly.</p>
      </div>

      <Tabs defaultValue="sources">
        <TabsList className="border-b w-full justify-start rounded-none h-auto p-0 bg-transparent gap-0">
          {["sources","search","outreach","ai"].map(t => (
            <TabsTrigger
              key={t} value={t}
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:text-foreground text-muted-foreground capitalize px-4 py-2.5 text-sm font-medium transition-none"
            >
              {t === "ai" ? "AI" : t.charAt(0).toUpperCase() + t.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── Sources ─────────────────────────────────────────────────── */}
        <TabsContent value="sources" className="mt-6 space-y-3">
          <div className="bg-white border border-border rounded-xl divide-y divide-border">
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
              <div key={key} className="flex items-center justify-between px-5 py-4">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
                <Switch checked={s.sources[key]} onCheckedChange={v => src({ [key]: v })} />
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── Search ──────────────────────────────────────────────────── */}
        <TabsContent value="search" className="mt-6 space-y-4">
          {/* Keywords */}
          <section className="bg-white border border-border rounded-xl p-5 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Keywords</p>
            <div className="flex flex-wrap gap-2">
              {s.search.keywords.map(k => (
                <Badge key={k} variant="secondary" className="gap-1 font-normal pr-1">
                  {k}
                  <button onClick={() => sch({ keywords: s.search.keywords.filter(x => x !== k) })} className="ml-1 hover:text-foreground">×</button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input value={kw} onChange={e => setKw(e.target.value)} placeholder="e.g. backend engineer" className="text-sm"
                onKeyDown={e => { if (e.key==="Enter"&&kw.trim()) { sch({ keywords:[...s.search.keywords,kw.trim()] }); setKw(""); } }} />
              <Button variant="outline" size="sm" onClick={() => { if(kw.trim()){ sch({ keywords:[...s.search.keywords,kw.trim()] }); setKw(""); } }}>Add</Button>
            </div>
          </section>

          {/* Filters */}
          <section className="bg-white border border-border rounded-xl p-5 space-y-5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filters</p>

            <div className="space-y-1.5">
              <Label className="text-sm">Location</Label>
              <Input defaultValue={s.search.location} className="text-sm" onBlur={e => sch({ location: e.target.value })} />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-sm">Relevance threshold</Label>
                <span className="text-sm font-semibold tabular-nums">{s.search.relevanceThreshold}</span>
              </div>
              <Slider min={0} max={100} step={5} value={[s.search.relevanceThreshold]}
                onValueChange={r => setS(prev => prev ? { ...prev, search: { ...prev.search, relevanceThreshold: sliderVal(r, 60) } } : prev)}
                onValueCommitted={r => sch({ relevanceThreshold: sliderVal(r, 60) })} />
              <p className="text-xs text-muted-foreground">Jobs below this score are auto-skipped.</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Min annual salary</Label>
              <div className="flex gap-2">
                <Input type="number" defaultValue={s.search.minSalaryAmount} className="text-sm"
                  onBlur={e => sch({ minSalaryAmount: Number(e.target.value) })} />
                <Input defaultValue={s.search.minSalaryCurrency} className="text-sm w-24" placeholder="INR"
                  onBlur={e => sch({ minSalaryCurrency: e.target.value.toUpperCase() })} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Strict salary filter</p>
                <p className="text-xs text-muted-foreground">Skip jobs where salary is unknown. Off = keep + flag.</p>
              </div>
              <Switch checked={s.search.strictSalary} onCheckedChange={v => sch({ strictSalary: v })} />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm">Company blacklist</Label>
              <div className="flex flex-wrap gap-2">
                {s.search.blacklistedCompanies.map(c => (
                  <Badge key={c} variant="destructive" className="gap-1 font-normal pr-1">
                    {c}
                    <button onClick={() => sch({ blacklistedCompanies: s.search.blacklistedCompanies.filter(x=>x!==c) })} className="ml-1">×</button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input value={co} onChange={e => setCo(e.target.value)} placeholder="Company name" className="text-sm"
                  onKeyDown={e => { if(e.key==="Enter"&&co.trim()){ sch({ blacklistedCompanies:[...s.search.blacklistedCompanies,co.trim()] }); setCo(""); } }} />
                <Button variant="outline" size="sm" onClick={() => { if(co.trim()){ sch({ blacklistedCompanies:[...s.search.blacklistedCompanies,co.trim()] }); setCo(""); } }}>Block</Button>
              </div>
            </div>
          </section>
        </TabsContent>

        {/* ── Outreach ────────────────────────────────────────────────── */}
        <TabsContent value="outreach" className="mt-6 space-y-4">
          {/* Kill switch */}
          <div className={`border rounded-xl px-5 py-4 flex items-center justify-between transition-colors ${s.outreach.globalPause ? "bg-red-50 border-red-200" : "bg-white border-border"}`}>
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${s.outreach.globalPause ? "bg-red-100" : "bg-muted"}`}>
                {s.outreach.globalPause ? "⏸" : "▶"}
              </div>
              <div>
                <p className={`text-sm font-semibold ${s.outreach.globalPause ? "text-red-800" : ""}`}>Pause all outreach</p>
                <p className={`text-xs ${s.outreach.globalPause ? "text-red-500" : "text-muted-foreground"}`}>
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

          {/* Rate limits + send window side by side */}
          <div className="grid grid-cols-2 gap-4">
            <section className="bg-white border border-border rounded-xl p-5 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                ◷ Rate Limits
              </p>
              {(
                [
                  { key: "dailyInviteCap"           as const, label: "Daily invite cap",    min:1, max:20  },
                  { key: "weeklyInviteCap"           as const, label: "Weekly invite cap",   min:1, max:100 },
                  { key: "dailyDmCap"                as const, label: "Daily DM cap",        min:1, max:10  },
                  { key: "maxReferralTargetsPerJob"  as const, label: "Max targets / job",   min:1, max:5   },
                  { key: "maxFollowups"              as const, label: "Max follow-ups",      min:0, max:3   },
                  { key: "recontactCooldownDays"     as const, label: "Recontact cooldown",  min:7, max:90  },
                ]
              ).map(({ key, label, min, max }) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-semibold tabular-nums">{s.outreach[key]}</span>
                  </div>
                  <Slider min={min} max={max} step={1} value={[s.outreach[key]]}
                    onValueChange={r => setS(prev => prev ? { ...prev, outreach: { ...prev.outreach, [key]: sliderVal(r, min) } } : prev)}
                    onValueCommitted={r => out({ [key]: sliderVal(r, min) })} />
                </div>
              ))}
            </section>

            <section className="bg-white border border-border rounded-xl p-5 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                ◷ Send Window (IST)
              </p>
              {(
                [
                  { key: "sendWindowStart"   as const, label: "Start Hour", fmt: (v: number) => `${v.toString().padStart(2,"0")}:00` },
                  { key: "sendWindowEnd"     as const, label: "End Hour",   fmt: (v: number) => `${v.toString().padStart(2,"0")}:00` },
                  { key: "followupAfterDays" as const, label: "Follow-up after N days", fmt: (v: number) => `${v}d` },
                ]
              ).map(({ key, label, fmt }) => (
                <div key={key} className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-semibold tabular-nums">{fmt(s.outreach[key])}</span>
                  </div>
                  <Slider min={key === "followupAfterDays" ? 1 : 0} max={key === "followupAfterDays" ? 14 : 23} step={1}
                    value={[s.outreach[key]]}
                    onValueChange={r => setS(prev => prev ? { ...prev, outreach: { ...prev.outreach, [key]: sliderVal(r, 9) } } : prev)}
                    onValueCommitted={r => out({ [key]: sliderVal(r, 9) })} />
                </div>
              ))}

              {/* Message templates — placeholder for Phase 2 */}
              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Message Templates</p>
              {["Invite Note", "First DM", "Follow-up"].map(t => (
                <div key={t} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <span className="text-sm">{t}</span>
                  <Badge variant="outline" className="text-[10px]">Phase 2</Badge>
                </div>
              ))}
            </section>
          </div>
        </TabsContent>

        {/* ── AI ──────────────────────────────────────────────────────── */}
        <TabsContent value="ai" className="mt-6 space-y-4">
          <section className="bg-white border border-border rounded-xl p-5 space-y-5">
            <div className="space-y-1.5">
              <Label className="text-sm">Default model</Label>
              <Input defaultValue={s.ai.defaultModel} className="text-sm font-mono" placeholder="gpt-4o-mini"
                onBlur={e => ai({ defaultModel: e.target.value })} />
              <p className="text-xs text-muted-foreground">Used for scoring + salary extraction on every job. Manage API keys via .env.</p>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Resume tailoring</p>
                <p className="text-xs text-muted-foreground">AI rewrites LaTeX sections per JD. <Badge variant="outline" className="text-[10px] ml-1">Phase 4</Badge></p>
              </div>
              <Switch checked={s.ai.enableResumeTailoring} onCheckedChange={v => ai({ enableResumeTailoring: v })} />
            </div>
          </section>
        </TabsContent>
      </Tabs>

      {/* Save toast */}
      {(saving || saved) && (
        <div className={`fixed bottom-6 right-6 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-all ${saved ? "bg-foreground text-background" : "bg-muted text-foreground"}`}>
          {saving ? "Saving…" : "✓ Saved"}
        </div>
      )}
    </div>
  );
}
