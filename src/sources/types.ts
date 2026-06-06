import type { ApplyType, JobSource } from "@prisma/client";
import type { RawSalary } from "@/salary/normalize";

/** Canonical shape every source adapter must produce. */
export interface RawJob {
  source: JobSource;
  company: string;
  role: string;
  jdText: string;
  applyUrl: string;
  location?: string;
  jobProviderId?: string;    // source-native id for dedup
  sourcePostUrl?: string;
  applyType: ApplyType;
  postedAt?: Date;

  // Post-specific
  sourcePostAuthorUrl?: string;
  sourcePostAuthorName?: string;

  // Pre-extracted salary from source (higher-trust than LLM estimate)
  sourceSalary?: RawSalary;
}
