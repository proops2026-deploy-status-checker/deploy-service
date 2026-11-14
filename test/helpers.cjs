// Test doubles for the HTTP layer: an in-memory DeployRepository with the same semantics as
// PrismaDeployRepository (ordering, keyset cursor, idempotent create, conditional transition),
// and OverviewCache variants (working, failing). Real-database behaviour is covered separately
// in deploys.pg.test.cjs.
const { randomUUID } = require("node:crypto");
const { sourcesFor } = require("../dist/state-machine.js");

function compareNewestFirst(a, b) {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function matches(deploy, filter) {
  return (
    (!filter.service || deploy.service === filter.service) &&
    (!filter.environment || deploy.environment === filter.environment) &&
    (!filter.status || deploy.status === filter.status) &&
    (!filter.from || deploy.createdAt >= filter.from) &&
    (!filter.to || deploy.createdAt < filter.to)
  );
}

class InMemoryDeployRepository {
  constructor() {
    this.deploys = [];
    this.failWith = null;
  }

  guard() {
    if (this.failWith) throw this.failWith;
  }

  async ping() {
    this.guard();
  }

  async create(input, createdAt = new Date()) {
    this.guard();
    const existing = this.deploys.find((d) => d.ciRunId === input.ciRunId);
    if (existing) return { deploy: existing, created: false };
    const deploy = {
      id: randomUUID(),
      service: input.service,
      environment: input.environment,
      version: input.version,
      status: "STARTED",
      ciRunId: input.ciRunId,
      reason: null,
      commitSha: input.commitSha ?? null,
      ciRunUrl: input.ciRunUrl ?? null,
      triggeredBy: input.triggeredBy ?? null,
      createdAt,
      updatedAt: createdAt
    };
    this.deploys.push(deploy);
    return { deploy, created: true };
  }

  async findById(id) {
    this.guard();
    return this.deploys.find((d) => d.id === id) ?? null;
  }

  async list(filter, cursor, limit) {
    this.guard();
    const rows = this.deploys
      .filter((d) => matches(d, filter))
      .filter((d) => !cursor || compareNewestFirst(d, cursor) > 0)
      .sort(compareNewestFirst);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async count(filter) {
    this.guard();
    return this.deploys.filter((d) => matches(d, filter)).length;
  }

  async transition(id, to, reason) {
    this.guard();
    const deploy = this.deploys.find((d) => d.id === id);
    if (!deploy) return { kind: "not_found" };
    if (!sourcesFor(to).includes(deploy.status)) return { kind: "invalid_transition", currentStatus: deploy.status };
    Object.assign(deploy, { status: to, reason, updatedAt: new Date() });
    return { kind: "updated", deploy };
  }

  async latestPerServiceEnvironment() {
    this.guard();
    const latest = new Map();
    for (const deploy of [...this.deploys].sort(compareNewestFirst)) {
      const key = `${deploy.service}:${deploy.environment}`;
      if (!latest.has(key)) latest.set(key, deploy);
    }
    return [...latest.values()].sort((a, b) =>
      a.service === b.service ? a.environment.localeCompare(b.environment) : a.service.localeCompare(b.service)
    );
  }
}

class MemoryCache {
  constructor() {
    this.value = null;
    this.gets = 0;
  }
  async get() {
    this.gets += 1;
    return this.value;
  }
  async set(value) {
    this.value = value;
  }
  async invalidate() {
    this.value = null;
  }
  async close() {}
}

// Simulates Redis being down: every call rejects (AC-06). The app must still answer from the repository.
class FailingCache {
  async get() {
    throw new Error("ECONNREFUSED");
  }
  async set() {
    throw new Error("ECONNREFUSED");
  }
  async invalidate() {
    throw new Error("ECONNREFUSED");
  }
  async close() {}
}

async function startApp(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

function jsonRequest(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

module.exports = { InMemoryDeployRepository, MemoryCache, FailingCache, startApp, jsonRequest };
