import express from "express";
import type { DeployRepository, OverviewCache } from "./domain";
import { encodeCursor } from "./cursor";
import { toDeployDto } from "./dto";
import { HttpError, errorHandler, notFound, requestId } from "./http";
import { createDeployBody, deployIdParams, listDeploysQuery, patchDeployBody } from "./validation";

export interface AppDependencies {
  repo: DeployRepository;
  cache: OverviewCache;
}

// Cache calls are best-effort: a cache bug must never fail a request (NFR-5).
async function safely<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

export function createApp({ repo, cache }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestId);
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await repo.ping();
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  // CI reports a deploy (US-DS-01). Idempotent on ci_run_id (AC-07): 201 new, 200 existing.
  app.post("/deploys", async (req, res) => {
    const input = createDeployBody.parse(req.body);
    const { deploy, created } = await repo.create(input);
    if (created) await safely(() => cache.invalidate(), undefined);
    res.status(created ? 201 : 200).json(toDeployDto(deploy));
  });

  // Deploy history with filters + keyset pagination, newest first (US-DS-03).
  app.get("/deploys", async (req, res) => {
    const { limit, cursor, ...filter } = listDeploysQuery.parse(req.query);
    const [page, totalCount] = await Promise.all([repo.list(filter, cursor, limit), repo.count(filter)]);
    const last = page.items.at(-1);
    res.json({
      items: page.items.map(toDeployDto),
      next_cursor: page.hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      total_count: totalCount
    });
  });

  app.get("/deploys/:id", async (req, res) => {
    const { id } = deployIdParams.parse(req.params);
    const deploy = await repo.findById(id);
    if (!deploy) throw new HttpError(404, "NOT_FOUND", "Deploy not found");
    res.json(toDeployDto(deploy));
  });

  // Release-flow transition (IRD-001 §6), enforced atomically by the repository.
  app.patch("/deploys/:id", async (req, res) => {
    const { id } = deployIdParams.parse(req.params);
    const { status, reason } = patchDeployBody.parse(req.body);
    const result = await repo.transition(id, status, reason ?? null);

    if (result.kind === "not_found") throw new HttpError(404, "NOT_FOUND", "Deploy not found");
    if (result.kind === "invalid_transition") {
      throw new HttpError(409, "INVALID_TRANSITION", `Cannot move a ${result.currentStatus} deploy to ${status}`, {
        current_status: result.currentStatus
      });
    }

    await safely(() => cache.invalidate(), undefined);
    res.json(toDeployDto(result.deploy));
  });

  // Latest deploy per service/environment (US-DS-04). Redis first, PostgreSQL on miss/failure (AC-06).
  app.get("/overview", async (_req, res) => {
    const cached = await safely(() => cache.get(), null);
    if (cached) {
      res.type("application/json").send(cached);
      return;
    }

    const latest = await repo.latestPerServiceEnvironment();
    const body = JSON.stringify({ items: latest.map(toDeployDto) });
    await safely(() => cache.set(body), undefined);
    res.type("application/json").send(body);
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
