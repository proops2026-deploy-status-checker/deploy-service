import { DeployStatus } from "@prisma/client";

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

export function isEnvironment(value: unknown): value is "dev" | "staging" | "prod" {
  return value === "dev" || value === "staging" || value === "prod";
}
