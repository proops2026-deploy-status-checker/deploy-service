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

// Day 26 drill: shipped intentionally WITHOUT a test to trip the coverage gate.
export function describeTransition(from: DeployStatus, to: DeployStatus): string {
  if (canTransition(from, to)) {
    return `Transition ${from} -> ${to} is allowed`;
  }
  return `Transition ${from} -> ${to} is NOT allowed`;
}
