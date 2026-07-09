import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings, type AppSettingsData } from "@/lib/settings";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(settings);
}

// The only top-level sections the patch may touch. Anything else in the body is
// dropped so a caller can't deep-merge arbitrary keys into the settings blob.
const SECTIONS: (keyof AppSettingsData)[] = [
  "sources", "search", "profile", "outreach", "staleness",
  "targetCompanies", "feedAuthors", "templates", "ai", "altIdentity", "ops",
];

// Per-section numeric fields that MUST be finite and >= 0 — a malformed rate cap,
// send-window hour, or salary floor (NaN, negative, a string) would silently
// break outreach/search. Coerced from numeric strings; rejected otherwise.
const NUMERIC_FIELDS: Partial<Record<keyof AppSettingsData, string[]>> = {
  outreach: [
    "maxReferralTargetsPerJob", "connectTarget", "maxInvitesPerJob",
    "replenishIntervalHours", "inviteTimeoutDays", "followupAfterDays",
    "maxFollowups", "recontactCooldownDays", "dailyInviteCap", "weeklyInviteCap",
    "dailyDmCap", "sendWindowStart", "sendWindowEnd",
  ],
  search:    ["recencyDays", "relevanceThreshold", "minSalaryAmount"],
  profile:   ["currentBaseLPA"],
  staleness: ["archiveAfterDays", "noNewOutreachAfterDays"],
};

// Per-section boolean fields that must be real booleans. globalPause is the
// outreach kill switch — a truthy string ("false") would wedge it on.
const BOOLEAN_FIELDS: Partial<Record<keyof AppSettingsData, string[]>> = {
  outreach: ["globalPause"],
  search:   ["strictSalary"],
  ai:       ["enableResumeTailoring", "truthfulTailoring"],
};

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be a settings object" }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  // Whitelist known top-level sections; silently drop everything else.
  const patch: Record<string, unknown> = {};
  for (const key of SECTIONS) {
    if (raw[key] !== undefined) patch[key] = raw[key];
  }

  // Validate/coerce numeric + boolean fields inside the object sections. Array
  // sections (targetCompanies/feedAuthors) and free-form strings pass through.
  const errors: string[] = [];
  for (const section of Object.keys(patch) as (keyof AppSettingsData)[]) {
    const nums = NUMERIC_FIELDS[section];
    const bools = BOOLEAN_FIELDS[section];
    if (!nums && !bools) continue;

    const val = patch[section];
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      errors.push(`${section} must be an object`);
      continue;
    }
    const obj = val as Record<string, unknown>;

    for (const f of nums ?? []) {
      if (obj[f] === undefined) continue;
      const n = typeof obj[f] === "string" ? Number(obj[f]) : obj[f];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        errors.push(`${section}.${f} must be a number >= 0`);
      } else {
        obj[f] = n; // coerced (e.g. numeric string → number)
      }
    }
    for (const f of bools ?? []) {
      if (obj[f] === undefined) continue;
      if (typeof obj[f] !== "boolean") errors.push(`${section}.${f} must be a boolean`);
    }
  }

  if (errors.length) {
    return NextResponse.json({ error: `invalid settings: ${errors.join("; ")}` }, { status: 400 });
  }

  const updated = await updateSettings(patch as Partial<AppSettingsData>);
  return NextResponse.json(updated);
}
