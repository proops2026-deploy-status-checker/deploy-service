import { createClient, type RedisClientType } from "redis";
import type { OverviewCache } from "./domain";

// IRD-001 §6.1: Redis is a cache only. Any failure or slow command (>500 ms) is treated as a miss,
// with no retry, so GET /overview falls back to PostgreSQL immediately (DOP-001 AC-06, NFR-5).

export const OVERVIEW_CACHE_KEY = "deploy-service:overview:v2"; // v2: response became snake_case { items }
export const OVERVIEW_CACHE_TTL_SECONDS = 30;
const COMMAND_TIMEOUT_MS = 500;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Redis command timeout")), COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RedisOverviewCache implements OverviewCache {
  private readonly client: RedisClientType;

  constructor(url: string) {
    this.client = createClient({ url, socket: { connectTimeout: COMMAND_TIMEOUT_MS, reconnectStrategy: false } });
    this.client.on("error", () => undefined); // failures surface as misses below, never as crashes
  }

  private async run<T>(command: (client: RedisClientType) => Promise<T>): Promise<T | null> {
    try {
      if (!this.client.isOpen) await withTimeout(this.client.connect());
      return await withTimeout(command(this.client));
    } catch {
      // Drop the connection so the next request starts from a clean connect attempt.
      if (this.client.isOpen) this.client.destroy();
      return null;
    }
  }

  async get(): Promise<string | null> {
    return this.run((client) => client.get(OVERVIEW_CACHE_KEY));
  }

  async set(value: string): Promise<void> {
    await this.run((client) => client.set(OVERVIEW_CACHE_KEY, value, { EX: OVERVIEW_CACHE_TTL_SECONDS }));
  }

  async invalidate(): Promise<void> {
    await this.run((client) => client.del(OVERVIEW_CACHE_KEY));
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit().catch(() => undefined);
  }
}

/** Used when REDIS_URL is not configured: every read is a miss. */
export class NoopOverviewCache implements OverviewCache {
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {}
  async invalidate(): Promise<void> {}
  async close(): Promise<void> {}
}
