import { PrismaClient } from "@prisma/client";
import { createApp } from "./app";
import { NoopOverviewCache, RedisOverviewCache } from "./cache";
import { PrismaDeployRepository } from "./repository";

// Process wiring only: build real dependencies, start HTTP, shut down cleanly.
// All request handling lives in app.ts so it can be tested without a database.
const port = Number(process.env.PORT ?? 3001);
const shutdownTimeoutMs = 10_000;

const prisma = new PrismaClient();
const cache = process.env.REDIS_URL ? new RedisOverviewCache(process.env.REDIS_URL) : new NoopOverviewCache();
const app = createApp({ repo: new PrismaDeployRepository(prisma), cache });

const server = app.listen(port, () => {
  console.log(`deploy-service listening on port ${port}`);
});

// Kubernetes sends SIGTERM before killing the Pod: stop accepting connections,
// let in-flight requests finish, close Redis/PostgreSQL, then exit (force-exit if they hang).
function shutdown(signal: NodeJS.Signals): void {
  console.log(`deploy-service received ${signal}, shutting down`);
  setTimeout(() => process.exit(1), shutdownTimeoutMs).unref();
  server.close(async () => {
    await cache.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
