import express from "express";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";

const app = express();
const port = process.env.PORT ?? 3001;
const prisma = new PrismaClient();
const redis = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 500 } });
const overviewCacheKey = "deploy-service:overview:v1";
const overviewCacheTtlSeconds = 30;
redis.on("error", () => undefined);

app.use(express.json());

function isEnvironment(value: unknown): value is "dev" | "staging" | "prod" {
  return value === "dev" || value === "staging" || value === "prod";
}

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

  const deploy = await prisma.deploy.create({ data: { service, environment, version, ciRunId } });
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
