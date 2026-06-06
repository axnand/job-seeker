"use client";

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { AppSettingsData } from "@/lib/settings";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [keyword,  setKeyword]  = useState("");
  const [company,  setCompany]  = useState("");

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(setSettings).catch(console.error);
  }, []);

  // Always sends the full merged object — no partial nested shapes
  const save = useCallback(async (next: AppSettingsData) => {
    setSettings(next);
    setSaving(true); setSaved(false);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  if (!settings) return (
    <div className="max-w-3xl mx-auto py-12 text-center text-muted-foreground text-sm">Loading…</div>
  );

  const { sources, search, outreach, ai } = settings;

  // Typed helpers so every call site is one-liner
  const setSources  = (v: Partial<typeof sources>)  => save({ ...settings, sources:  { ...sources,  ...v } });
  const setSearch   = (v: Partial<typeof search>)   => save({ ...settings, search:   { ...search,   ...v } });
  const setOutreach = (v: Partial<typeof outreach>) => save({ ...settings, outreach: { ...outreach, ...v } });
  const setAi       = (v: Partial<typeof ai>)       => save({ ...settings, ai:       { ...ai,       ...v } });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header + global kill switch */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">Changes save instantly.</p>
        </div>
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
          <div>
            <p className="text-sm font-semibold text-red-800">Pause all outreach</p>
            <p className="text-xs text-red-500">Kill switch — no messages send</p>
          </div>
          <Switch
            checked={outreach.globalPause}
            onCheckedChange={v => setOutreach({ globalPause: v })}
            className="data-[state=checked]:bg-red-500"
          />
        </div>
      </div>

      <Tabs defaultValue="sources">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="outreach">Outreach</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
        </TabsList>

        {/* ── Sources ─────────────────────────────────────────────────── */}
        <TabsContent value="sources" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Job sources</CardTitle>
              <CardDescription>Toggle which sources run during the daily cron.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-4">
              {(
                [
                  { key: "linkedin"     as const, label: "LinkedIn",      desc: "Job board + hiring posts via Unipile"          },
                  { key: "adzuna"       as const, label: "Adzuna",        desc: "India aggregator — free API"                   },
                  { key: "atsWatchlist" as const, label: "ATS Watchlist", desc: "Greenhouse / Lever / Ashby company boards"     },
                  { key: "remotive"     as const, label: "Remotive",      desc: "Curated remote tech roles"                     },
                  { key: "remoteok"     as const, label: "RemoteOK",      desc: "Remote-only job board"                         },
                  { key: "jsearch"      as const, label: "JSearch",       desc: "Google for Jobs aggregator (RapidAPI — paid)"  },
                ]
              ).map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{label}</Label>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                  <Switch
                    checked={sources[key]}
                    onCheckedChange={v => setSources({ [key]: v })}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Search ──────────────────────────────────────────────────── */}
        <TabsContent value="search" className="space-y-4 mt-4">
          {/* Keywords */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Keywords</CardTitle>
              <CardDescription>Each keyword runs as a separate search query.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-3">
              <div className="flex flex-wrap gap-2">
                {search.keywords.map(kw => (
                  <Badge key={kw} variant="secondary" className="gap-1 pr-1">
                    {kw}
                    <button
                      onClick={() => setSearch({ keywords: search.keywords.filter(k => k !== kw) })}
                      className="ml-1 text-muted-foreground hover:text-foreground"
                    >×</button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  placeholder="e.g. backend engineer"
                  className="text-sm"
                  onKeyDown={e => {
                    if (e.key === "Enter" && keyword.trim()) {
                      setSearch({ keywords: [...search.keywords, keyword.trim()] });
                      setKeyword("");
                    }
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => {
                  if (keyword.trim()) { setSearch({ keywords: [...search.keywords, keyword.trim()] }); setKeyword(""); }
                }}>Add</Button>
              </div>
            </CardContent>
          </Card>

          {/* Filters */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Filters</CardTitle></CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-5">
              {/* Location */}
              <div className="space-y-1.5">
                <Label className="text-sm">Location</Label>
                <Input
                  defaultValue={search.location}
                  className="text-sm"
                  onBlur={e => setSearch({ location: e.target.value })}
                />
              </div>

              {/* Relevance threshold */}
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-sm">Relevance threshold</Label>
                  <span className="text-sm font-semibold">{search.relevanceThreshold}</span>
                </div>
                <Slider
                  min={0} max={100} step={5}
                  value={[search.relevanceThreshold]}
                  onValueChange={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? 60) : (raw ?? 60); setSettings(s => s ? { ...s, search: { ...s.search, relevanceThreshold: v } } : s); }}
                  onValueCommitted={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? 60) : (raw ?? 60); setSearch({ relevanceThreshold: v }); }}
                />
                <p className="text-xs text-muted-foreground">Jobs below this score are auto-skipped.</p>
              </div>

              {/* Min salary */}
              <div className="space-y-1.5">
                <Label className="text-sm">Min annual salary</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    defaultValue={search.minSalaryAmount}
                    className="text-sm"
                    onBlur={e => setSearch({ minSalaryAmount: Number(e.target.value) })}
                  />
                  <Input
                    defaultValue={search.minSalaryCurrency}
                    className="text-sm w-24"
                    placeholder="INR"
                    onBlur={e => setSearch({ minSalaryCurrency: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>

              {/* Strict salary */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Strict salary filter</Label>
                  <p className="text-xs text-muted-foreground">Skip jobs where salary is unknown or uncertain.</p>
                </div>
                <Switch checked={search.strictSalary} onCheckedChange={v => setSearch({ strictSalary: v })} />
              </div>

              {/* Blacklist */}
              <div className="space-y-2">
                <Label className="text-sm">Company blacklist</Label>
                <div className="flex flex-wrap gap-2">
                  {search.blacklistedCompanies.map(c => (
                    <Badge key={c} variant="destructive" className="gap-1 pr-1">
                      {c}
                      <button
                        onClick={() => setSearch({ blacklistedCompanies: search.blacklistedCompanies.filter(x => x !== c) })}
                        className="ml-1 hover:text-white/80"
                      >×</button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={company}
                    onChange={e => setCompany(e.target.value)}
                    placeholder="Company name"
                    className="text-sm"
                    onKeyDown={e => {
                      if (e.key === "Enter" && company.trim()) {
                        setSearch({ blacklistedCompanies: [...search.blacklistedCompanies, company.trim()] });
                        setCompany("");
                      }
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={() => {
                    if (company.trim()) { setSearch({ blacklistedCompanies: [...search.blacklistedCompanies, company.trim()] }); setCompany(""); }
                  }}>Block</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Outreach ────────────────────────────────────────────────── */}
        <TabsContent value="outreach" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Rate limits</CardTitle>
              <CardDescription>Stay under LinkedIn's limits to protect your account.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-5">
              {(
                [
                  { key: "dailyInviteCap"           as const, label: "Daily invite cap",           min: 1, max: 20  },
                  { key: "weeklyInviteCap"           as const, label: "Weekly invite cap",          min: 1, max: 100 },
                  { key: "dailyDmCap"                as const, label: "Daily DM cap",               min: 1, max: 10  },
                  { key: "maxReferralTargetsPerJob"  as const, label: "Max targets per job",        min: 1, max: 5   },
                  { key: "followupAfterDays"         as const, label: "Follow-up after (days)",     min: 1, max: 14  },
                  { key: "maxFollowups"              as const, label: "Max follow-ups",             min: 0, max: 3   },
                  { key: "recontactCooldownDays"     as const, label: "Recontact cooldown (days)",  min: 7, max: 90  },
                ]
              ).map(({ key, label, min, max }) => (
                <div key={key} className="space-y-2">
                  <div className="flex justify-between">
                    <Label className="text-sm">{label}</Label>
                    <span className="text-sm font-semibold">{outreach[key]}</span>
                  </div>
                  <Slider
                    min={min} max={max} step={1}
                    value={[outreach[key]]}
                    onValueChange={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? min) : (raw ?? min); setSettings(s => s ? { ...s, outreach: { ...s.outreach, [key]: v } } : s); }}
                    onValueCommitted={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? min) : (raw ?? min); setOutreach({ [key]: v }); }}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Send window (IST hour)</CardTitle>
              <CardDescription>Messages only go out within this window.</CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-5">
              {(
                [
                  { key: "sendWindowStart" as const, label: "Start hour (IST)" },
                  { key: "sendWindowEnd"   as const, label: "End hour (IST)"   },
                ]
              ).map(({ key, label }) => (
                <div key={key} className="space-y-2">
                  <div className="flex justify-between">
                    <Label className="text-sm">{label}</Label>
                    <span className="text-sm font-semibold">{outreach[key]}:00</span>
                  </div>
                  <Slider
                    min={0} max={23} step={1}
                    value={[outreach[key]]}
                    onValueChange={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? 9) : (raw ?? 9); setSettings(s => s ? { ...s, outreach: { ...s.outreach, [key]: v } } : s); }}
                    onValueCommitted={(raw) => { const v = Array.isArray(raw) ? (raw[0] ?? 9) : (raw ?? 9); setOutreach({ [key]: v }); }}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── AI ──────────────────────────────────────────────────────── */}
        <TabsContent value="ai" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">AI model</CardTitle></CardHeader>
            <Separator />
            <CardContent className="pt-4 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Default model</Label>
                <Input
                  defaultValue={ai.defaultModel}
                  className="text-sm font-mono"
                  placeholder="gpt-4o-mini"
                  onBlur={e => setAi({ defaultModel: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Used for scoring + salary. API key set via .env or AI Providers (Phase 3).</p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Resume tailoring</Label>
                  <p className="text-xs text-muted-foreground">AI rewrites LaTeX resume per job (Phase 4). Extra cost.</p>
                </div>
                <Switch checked={ai.enableResumeTailoring} onCheckedChange={v => setAi({ enableResumeTailoring: v })} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Toast */}
      {(saving || saved) && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-all ${saved ? "bg-emerald-600 text-white" : "bg-primary text-primary-foreground"}`}>
          {saving ? "Saving…" : "Saved ✓"}
        </div>
      )}
    </div>
  );
}
