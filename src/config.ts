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
    keywords: (process.env.SEARCH_KEYWORDS ?? [
      "software engineer",
      "backend engineer",
      "software development engineer",
      "java backend developer",
      "associate software engineer",
      "full stack engineer",
    ].join(",")).split(",").map(k => k.trim()),
    location: process.env.SEARCH_LOCATION ?? "India",
    dailyDigestHour: 8,         // 08:00 IST = 02:30 UTC
    relevanceThreshold: 65,
    minSalary: {
      // Hard floor: must beat the owner's current 14.5 LPA base.
      amount: Number(process.env.MIN_SALARY_AMOUNT ?? 1450000),
      currency: process.env.MIN_SALARY_CURRENCY ?? "INR",
      period: "year" as const,
    },
    baseCurrency: process.env.BASE_CURRENCY ?? "INR",
    strictSalary: false,
    blacklistedCompanies: [
      "ACI Worldwide",
    ] as string[],
    // Freshness — runs every 3h and only looks at jobs posted in the last day.
    // 1 = tightest the source APIs allow (they're day-granular); the overlap
    // across 3-hourly runs is a safety buffer and dedup prevents re-processing.
    recencyDays: Number(process.env.RECENCY_DAYS ?? 1),
    // LinkedIn jobs search filters (Unipile native filters)
    linkedinSeniority: ["entry", "associate"] as const,  // new-grad band only
    linkedinPresence: ["remote", "hybrid", "on_site"] as const,
    linkedinJobType: ["full_time"] as const,
  },

  sources: {
    linkedin: true,
    linkedinPosts: true,   // hiring posts ("we're hiring", "DM me your resume") via global keyword search
    linkedinFeed: false,   // hiring posts from a curated author watchlist (feedAuthors). Off until authors are added.
    adzuna: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
    atsWatchlist: true,
    remotive: true,
    remoteok: true,
    jsearch: !!(process.env.JSEARCH_RAPIDAPI_KEY),
  },

  // Feed watchlist — people whose posts you want monitored for hiring signals.
  // LinkedIn has no home-feed API, so we poll each author's posts directly.
  // publicId is the LinkedIn profile slug (the part after /in/). Enable via sources.linkedinFeed.
  feedAuthors: [] as Array<{ name: string; publicId: string }>,

  // ATS watchlist — highest-signal source. Add companies you want to work at.
  targetCompanies: [] as Array<{
    name: string;
    ats: "greenhouse" | "lever" | "ashby";
    boardToken: string;
  }>,

  resume: {
    masterTexPath: "resume/master.tex",
    targetRoles: ["software engineer", "backend engineer", "SDE / SDE-1", "java backend developer", "full stack engineer"],
    preferredIndustries: ["SaaS", "B2B", "fintech", "AI/ML", "product companies", "well-funded startups"],
    seniorityLevel: "entry-level / new grad (SDE-1, associate, junior — NOT senior/staff/lead)",
    // Hard constraints the scorer must enforce — see ai-scorer.ts rubric.
    constraints: {
      gradYear: 2026,
      yearsExperience: 1,
      currentBaseLPA: 14.5,
      // Only roles that beat the current base. Below this = a pay cut → reject.
      minBaseLPA: 14.5,
      acceptableSeniority: ["intern-converting", "new grad", "entry", "associate", "SDE-1", "junior", "software engineer I/II"],
      rejectSeniority: ["senior", "staff", "principal", "lead", "manager", "director", "architect", "5+ years", "8+ years"],
    },
    summary: `2026 B.Tech graduate (AI & Data Science, BPIT New Delhi), currently a Software Engineer at Salescode.ai with ~1 year of experience. Currently earning 14.5 LPA base.
Core stack: Java, Spring Boot, Spring WebFlux, Kafka, Node.js, TypeScript, Next.js, PostgreSQL, Docker, AWS.
Shipped high-throughput backend systems: 10,000+ candidate profiles/hour, 500,000+ record Kafka migrations, reactive microservices for enterprise clients (Coke Thailand/Sri Lanka).
Strong in LLM integration, microservices, distributed systems, full-stack dev. LeetCode peak 1710, 600+ DSA solved, hackathon winner.
Targeting: entry-level / SDE-1 / junior software engineering roles at strong product companies and well-funded startups that pay ABOVE 14.5 LPA base. NOT looking for senior/staff roles (insufficient YOE) or roles paying at/below 14.5 LPA (a lateral move or pay cut).`,
  },

  // Friend digest — friends get every scored job that clears THEIR salary
  // floor, including jobs the owner's pipeline skipped for pay alone
  // (skipCategory "salary"). Jobs skipped for seniority / location / role fit
  // are still excluded for everyone.
  // keywords (optional): only send jobs whose role/JD matches at least one
  // keyword — for friends whose stack differs from the owner's. Empty/absent
  // means no keyword filter.
  friendDigest: {
    recipients: [
      { email: "mmayank.connect@gmail.com",  minBaseLPA: 8 },
      { email: "rastogivani15@gmail.com",    minBaseLPA: 8 },
      { email: "mohdsamiullah149@gmail.com", minBaseLPA: 8 },
    ] as Array<{ email: string; minBaseLPA: number; keywords?: string[] }>,
  },

  outreach: {
    // maxReferralTargetsPerJob is the IN-FLIGHT batch size: how many connection
    // invites we keep pending at once for a job. The replenish loop refills this
    // pool as invites are accepted or time out — until connectTarget accepted
    // connections are reached, maxInvitesPerJob total is hit, or the company's
    // candidate pool is exhausted.
    maxReferralTargetsPerJob: 5, // in-flight invites kept pending per job (small,
                                 // so the round-robin claim spreads the daily cap
                                 // across many jobs; replenish refills on accept/timeout)
    connectTarget: 8,          // stop topping up once this many people accept
    maxInvitesPerJob: 20,      // hard ceiling on total invites ever sent per job
    replenishIntervalHours: 12, // min hours between people-search top-ups per job
    inviteTimeoutDays: 7,      // cancel an unaccepted invite after this, free the slot
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

  // Outreach message templates (editable from the dashboard).
  // Placeholders: {firstName} {name} {company} {role} {resumeLink} {ownerName} {jobId} {jobRef}
  templates: {
    connectionNote: "Hi {firstName}, I came across {company}'s {role} opening and noticed you're on the team. Would love to connect and learn more.",

    // {pitch} is the AI-tailored, role-specific blurb (Job.tailoredPitch). It
    // renders to nothing when no pitch exists — fill() drops the blank line — so
    // this template stays safe even for jobs that were never AI-scored.
    firstDm: [
      "Hi {firstName},",
      "",
      "I'm currently looking for {role} opportunities and recently came across an opening at {company} that caught my interest. I was hoping you might be able to help me with a referral.{jobRef}",
      "",
      "{pitch}",
      "",
      "I'm currently working as a Software Engineer at Salescode.ai, using Java, JavaScript, Spring Boot, and CI/CD tools.",
      "",
      "I'd really appreciate it if you could refer me. No pressure if it's not a fit.",
      "",
      "Attaching my resume for your reference.",
      "Thanks a lot for your time!",
    ].join("\n"),

    followup: [
      "Hi {firstName},",
      "",
      "Just following up in case my earlier message got buried. Still very interested in the {role} role at {company}.",
      "",
      "Totally fine if the timing isn't right. Thanks!",
    ].join("\n"),
  },

  staleness: {
    archiveAfterDays: 21,       // no outreach started → soft-close
    noNewOutreachAfterDays: 30, // posting too old → skip
  },

  ai: {
    defaultProvider: "openai" as string,
    // gpt-4.1 (not 4o-mini): far better world-knowledge of company pay bands, so
    // salary estimates for unstated-pay roles are calibrated instead of optimistic.
    defaultModel: "gpt-4.1" as string,
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
};

