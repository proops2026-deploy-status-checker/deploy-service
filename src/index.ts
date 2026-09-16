import express from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import { allowedTransitions, isEnvironment } from "./state-machine";

const app = express();
const port = process.env.PORT ?? 3001;
const prisma = new PrismaClient();
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { connectTimeout: 500, reconnectStrategy: false }
});
const overviewCacheKey = "deploy-service:overview:v1";
const overviewCacheTtlSeconds = 30;
redis.on("error", () => undefined);

app.use(express.json());

async function availableRedis() {
  try {
    if (!redis.isOpen) await redis.connect();
    return redis;
  } catch {
    return null;
  }
}

async function redisCommand<T>(command: Promise<T>): Promise<T> {
  return Promise.race([
    command,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Redis timeout")), 500))
  ]);
}

function markRedisUnavailable() {
  if (redis.isOpen) redis.disconnect();
}

// TIE-10: readiness depends on the only required persistent dependency.
// Deploy API and state-machine logic are implemented in TIE-11 and TIE-12.
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.post("/deploys", async (req, res) => {
  const { service, environment, version, ci_run_id: ciRunId } = req.body ?? {};
  if (typeof service !== "string" || !isEnvironment(environment) || typeof version !== "string" || typeof ciRunId !== "string") {
    res.status(400).json({ error: "service, environment, version, and ci_run_id are required" });
    return;
  }

  const existing = await prisma.deploy.findFirst({ where: { ciRunId } });
  if (existing) {
    res.status(200).json(existing);
    return;
  }

  let deploy;
  try {
    deploy = await prisma.deploy.create({ data: { service, environment, version, ciRunId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await prisma.deploy.findUnique({ where: { ciRunId } });
      if (duplicate) {
        res.status(200).json(duplicate);
        return;
      }
    }
    throw error;
  }
  const client = await availableRedis();
  if (client) {
    try {
      await redisCommand(client.del(overviewCacheKey));
    } catch {
      markRedisUnavailable();
    }
  }
  res.status(201).json(deploy);
});

app.patch("/deploys/:id", async (req, res) => {
  const { status, reason } = req.body ?? {};
  if (!Object.hasOwn(allowedTransitions, status)) {
    res.status(400).json({ error: "status must be STARTED, SUCCESS, FAILED, or ROLLED_BACK" });
    return;
  }
  if ((status === "FAILED" || status === "ROLLED_BACK") && typeof reason !== "string") {
    res.status(400).json({ error: "reason is required for FAILED and ROLLED_BACK" });
    return;
  }

  const deploy = await prisma.deploy.findUnique({ where: { id: req.params.id } });
  if (!deploy) {
    res.status(404).json({ error: "Deploy not found" });
    return;
  }
  if (!allowedTransitions[deploy.status].includes(status)) {
    res.status(409).json({ error: "Invalid deploy status transition" });
    return;
  }

  const updated = await prisma.deploy.update({
    where: { id: deploy.id },
    data: { status, reason: typeof reason === "string" ? reason : null }
  });
  const client = await availableRedis();
  if (client) {
    try { await redisCommand(client.del(overviewCacheKey)); } catch { markRedisUnavailable(); }
  }
  res.json(updated);
});

app.get("/overview", async (_req, res) => {
  let client = await availableRedis();
  if (client) {
    try {
      const cached = await redisCommand(client.get(overviewCacheKey));
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }
    } catch {
      markRedisUnavailable();
      client = null;
    }
  }

  const deploys = await prisma.deploy.findMany({ orderBy: { createdAt: "desc" } });
  const latest = Array.from(new Map(deploys.map((deploy) => [`${deploy.service}:${deploy.environment}`, deploy])).values());
  if (client) {
    try {
      await redisCommand(client.set(overviewCacheKey, JSON.stringify(latest), { EX: overviewCacheTtlSeconds }));
    } catch {
      markRedisUnavailable();
    }
  }
  res.json(latest);
});

app.listen(port, () => {
  console.log(`deploy-service listening on port ${port}`);
});

async function shutdown() {
  if (redis.isOpen) await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
