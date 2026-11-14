import { DEPLOY_STATUSES, ENVIRONMENTS, type DeployStatus, type Environment } from "./domain";

// IRD-001 §6 release flow: STARTED -> SUCCESS/FAILED -> ROLLED_BACK.
export const allowedTransitions: Record<DeployStatus, readonly DeployStatus[]> = {
  STARTED: ["SUCCESS", "FAILED"],
  SUCCESS: ["ROLLED_BACK"],
  FAILED: ["ROLLED_BACK"],
  ROLLED_BACK: [],
};

export function canTransition(from: DeployStatus, to: DeployStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/** Statuses a deploy may currently be in for a move to `to` to be valid (drives the conditional UPDATE). */
export function sourcesFor(to: DeployStatus): DeployStatus[] {
  return DEPLOY_STATUSES.filter((from) => canTransition(from, to));
}

/** FAILED and ROLLED_BACK must explain why, for on-call visibility (IRD-001 §7). */
export function requiresReason(status: DeployStatus): boolean {
  return status === "FAILED" || status === "ROLLED_BACK";
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && (ENVIRONMENTS as readonly string[]).includes(value);
}
