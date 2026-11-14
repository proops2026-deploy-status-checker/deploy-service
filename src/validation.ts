import { z } from "zod";
import { decodeCursor } from "./cursor";
import { DEPLOY_STATUSES, ENVIRONMENTS } from "./domain";
import { requiresReason } from "./state-machine";

// Request schemas — the single place that defines what the API accepts (IRD-001 §7).

const serviceName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "may only contain letters, digits, '.', '_' and '-'");

export const deployIdParams = z.object({
  id: z.string().uuid("must be a deploy id (UUID)")
});

export const createDeployBody = z
  .object({
    service: serviceName,
    environment: z.enum(ENVIRONMENTS),
    version: z.string().trim().min(1).max(100),
    ci_run_id: z.string().trim().min(1).max(200),
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i, "must be a 7-40 character hex commit SHA")
      .transform((sha) => sha.toLowerCase())
      .optional(),
    ci_run_url: z
      .string()
      .max(2048)
      .url()
      .refine((url) => /^https?:\/\//i.test(url), "must be an http(s) URL")
      .optional(),
    triggered_by: z.string().trim().min(1).max(100).optional()
  })
  .transform((body) => ({
    service: body.service,
    environment: body.environment,
    version: body.version,
    ciRunId: body.ci_run_id,
    commitSha: body.commit_sha,
    ciRunUrl: body.ci_run_url,
    triggeredBy: body.triggered_by
  }));

export const patchDeployBody = z
  .object({
    status: z.enum(DEPLOY_STATUSES),
    reason: z.string().trim().min(1).max(2000).optional()
  })
  .refine((body) => !requiresReason(body.status) || body.reason !== undefined, {
    message: "reason is required for FAILED and ROLLED_BACK",
    path: ["reason"]
  });

const isoTimestamp = z
  .string()
  .datetime({ offset: true, message: "must be an ISO 8601 timestamp" })
  .transform((value) => new Date(value));

export const listDeploysQuery = z
  .object({
    service: serviceName.optional(),
    environment: z.enum(ENVIRONMENTS).optional(),
    status: z.enum(DEPLOY_STATUSES).optional(),
    from: isoTimestamp.optional(),
    to: isoTimestamp.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .max(200)
      .transform((value, ctx) => {
        const cursor = decodeCursor(value);
        if (!cursor) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid cursor" });
          return z.NEVER;
        }
        return cursor;
      })
      .optional()
  })
  .refine((query) => !query.from || !query.to || query.from < query.to, {
    message: "from must be earlier than to",
    path: ["from"]
  });
