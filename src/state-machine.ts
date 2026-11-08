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

// Day 26 drill: shipped intentionally WITHOUT any test to trip the coverage gate.
export function describeTransition(from: DeployStatus, to: DeployStatus): string {
  if (canTransition(from, to)) {
    return `Transition ${from} -> ${to} is allowed`;
  }
  return `Transition ${from} -> ${to} is NOT allowed`;
}

export function statusLabel(status: DeployStatus): string {
  switch (status) {
    case "STARTED":
      return "Deployment started";
    case "SUCCESS":
      return "Deployment succeeded";
    case "FAILED":
      return "Deployment failed";
    case "ROLLED_BACK":
      return "Deployment rolled back";
    default:
      return "Unknown status";
  }
}

export function isTerminal(status: DeployStatus): boolean {
  if (status === "ROLLED_BACK") {
    return true;
  }
  if (allowedTransitions[status].length === 0) {
    return true;
  }
  return false;
}

export function nextStatuses(status: DeployStatus): string[] {
  const result: string[] = [];
  for (const next of allowedTransitions[status]) {
    result.push(statusLabel(next));
  }
  if (result.length === 0) {
    result.push("(no further transitions)");
  }
  return result;
}
