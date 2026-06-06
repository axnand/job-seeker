export const config = {
  owner: {
    name: process.env.OWNER_NAME ?? "Owner",
    email: process.env.OWNER_EMAIL ?? "",
    linkedinAccountId: process.env.OWNER_LINKEDIN_ACCOUNT_ID ?? "",
  },

  auth: {
    password: process.env.APP_PASSWORD ?? "changeme",
    secret: process.env.APP_SECRET ?? "changeme-secret-32chars-minimum!!",
    cronSecret: process.env.CRON_SECRET ?? "",
  },

  app: {
    baseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  },

  search: {
    keywords: (process.env.SEARCH_KEYWORDS ?? "software engineer,backend engineer,platform engineer").split(",").map(k => k.trim()),
    location: process.env.SEARCH_LOCATION ?? "Remote, India",
    dailyDigestHour: 8,         // 08:00 IST = 02:30 UTC
    relevanceThreshold: 60,
    minSalary: {
      amount: Number(process.env.MIN_SALARY_AMOUNT ?? 2500000),
      currency: process.env.MIN_SALARY_CURRENCY ?? "INR",
      period: "year" as const,
    },
    baseCurrency: process.env.BASE_CURRENCY ?? "INR",
    strictSalary: false,        // keep uncertain estimates rather than dropping
    blacklistedCompanies: [] as string[],
  },

  sources: {
    linkedin: true,
    adzuna: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    atsWatchlist: true,
    remotive: true,
    remoteok: true,
    jsearch: !!(process.env.JSEARCH_RAPIDAPI_KEY),
  },

  // ATS watchlist — highest-signal source. Add companies you want to work at.
  targetCompanies: [] as Array<{
    name: string;
    ats: "greenhouse" | "lever" | "ashby";
    boardToken: string;
  }>,

  resume: {
    masterTexPath: "resume/master.tex",
    targetRoles: ["backend", "infra", "platform engineering"],
    preferredIndustries: ["SaaS", "B2B", "fintech"],
    seniorityLevel: "mid to senior",
  },

  outreach: {
    maxReferralTargetsPerJob: 2,
    followupAfterDays: 4,
    maxFollowups: 1,
    recontactCooldownDays: 30,
    dailyInviteCap: 10,
    weeklyInviteCap: 60,
    dailyDmCap: 3,
    sendWindowStart: 9,   // 09:00 IST
    sendWindowEnd: 21,    // 21:00 IST
    globalPause: false,
  },

  staleness: {
    archiveAfterDays: 21,       // no outreach started → soft-close
    noNewOutreachAfterDays: 30, // posting too old → skip
  },

  ai: {
    defaultProvider: "openai" as string,
    defaultModel: "gpt-4o-mini" as string,
    fallbackApiKey: process.env.OPENAI_API_KEY ?? "",
    enableResumeTailoring: false,
  },

  email: {
    from: process.env.EMAIL_FROM ?? process.env.SMTP_USER ?? "",
    smtp: {
      host: process.env.SMTP_HOST ?? "",
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
    },
  },

  unipile: {
    dsn: process.env.UNIPILE_DSN ?? "",
    apiKey: process.env.UNIPILE_API_KEY ?? "",
    webhookSecret: process.env.UNIPILE_WEBHOOK_SECRET ?? "",
  },

  adzuna: {
    appId: process.env.ADZUNA_APP_ID ?? "",
    appKey: process.env.ADZUNA_APP_KEY ?? "",
  },

  jsearch: {
    rapidApiKey: process.env.JSEARCH_RAPIDAPI_KEY ?? "",
  },

  s3: {
    bucket: process.env.AWS_S3_BUCKET ?? "",
    region: process.env.AWS_S3_REGION ?? "ap-south-1",
  },
} as const;
