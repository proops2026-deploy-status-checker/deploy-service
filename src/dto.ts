import type { DeployRecord } from "./domain";

// Public response shape (snake_case, IRD-001 §8). Never return Prisma objects directly:
// the API contract must not change when the database model does.
export interface DeployDto {
  id: string;
  service: string;
  environment: string;
  version: string;
  status: string;
  ci_run_id: string;
  reason: string | null;
  commit_sha: string | null;
  ci_run_url: string | null;
  triggered_by: string | null;
  created_at: string;
  updated_at: string;
}

export function toDeployDto(deploy: DeployRecord): DeployDto {
  return {
    id: deploy.id,
    service: deploy.service,
    environment: deploy.environment,
    version: deploy.version,
    status: deploy.status,
    ci_run_id: deploy.ciRunId,
    reason: deploy.reason,
    commit_sha: deploy.commitSha,
    ci_run_url: deploy.ciRunUrl,
    triggered_by: deploy.triggeredBy,
    created_at: deploy.createdAt.toISOString(),
    updated_at: deploy.updatedAt.toISOString()
  };
}
