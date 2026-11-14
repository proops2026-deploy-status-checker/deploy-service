// Domain types for the Deploy Service, independent of Prisma so the HTTP layer
// and its tests never need a generated client or a database.

export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DEPLOY_STATUSES = ["STARTED", "SUCCESS", "FAILED", "ROLLED_BACK"] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export interface DeployRecord {
  id: string;
  service: string;
  environment: Environment;
  version: string;
  status: DeployStatus;
  ciRunId: string;
  reason: string | null;
  commitSha: string | null;
  ciRunUrl: string | null;
  triggeredBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDeployInput {
  service: string;
  environment: Environment;
  version: string;
  ciRunId: string;
  commitSha?: string;
  ciRunUrl?: string;
  triggeredBy?: string;
}

export interface DeployFilter {
  service?: string;
  environment?: Environment;
  status?: DeployStatus;
  from?: Date; // inclusive
  to?: Date; // exclusive
}

// Keyset position: the last item of the previous page (ordering is created_at DESC, id DESC).
export interface DeployCursor {
  createdAt: Date;
  id: string;
}

export type TransitionResult =
  | { kind: "updated"; deploy: DeployRecord }
  | { kind: "not_found" }
  | { kind: "invalid_transition"; currentStatus: DeployStatus };

export interface DeployRepository {
  ping(): Promise<void>;
  /** Idempotent on ciRunId (DOP-001 AC-07): returns the existing record with created=false. */
  create(input: CreateDeployInput): Promise<{ deploy: DeployRecord; created: boolean }>;
  findById(id: string): Promise<DeployRecord | null>;
  /** Returns up to `limit` items after `cursor`, newest first, plus whether more exist. */
  list(filter: DeployFilter, cursor: DeployCursor | undefined, limit: number): Promise<{ items: DeployRecord[]; hasMore: boolean }>;
  count(filter: DeployFilter): Promise<number>;
  /** Atomic: only applies when the current status may move to `to` (IRD-001 §6). */
  transition(id: string, to: DeployStatus, reason: string | null): Promise<TransitionResult>;
  /** Latest deploy for every service/environment pair. */
  latestPerServiceEnvironment(): Promise<DeployRecord[]>;
}

/** Read-through cache for GET /overview. Implementations must never throw. */
export interface OverviewCache {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  invalidate(): Promise<void>;
  close(): Promise<void>;
}
