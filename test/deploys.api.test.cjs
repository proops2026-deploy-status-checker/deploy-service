// HTTP contract tests for the Deploy Service (IRD-001 §7) — no database needed.
const assert = require("node:assert/strict");
const { describe, test, beforeEach, afterEach } = require("node:test");
const { createApp } = require("../dist/app.js");
const { InMemoryDeployRepository, MemoryCache, FailingCache, startApp, jsonRequest } = require("./helpers.cjs");

const validDeploy = { service: "api-gateway", environment: "prod", version: "1.4.0", ci_run_id: "run-1001" };
const DEPLOY_KEYS = [
  "ci_run_id",
  "ci_run_url",
  "commit_sha",
  "created_at",
  "environment",
  "id",
  "reason",
  "service",
  "status",
  "triggered_by",
  "updated_at",
  "version"
];

let repo;
let cache;
let server;

async function call(path, init) {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  repo = new InMemoryDeployRepository();
  cache = new MemoryCache();
  server = await startApp(createApp({ repo, cache }));
});

afterEach(() => server.close());

describe("DSC-01 contract: snake_case, validation, JSON errors", () => {
  test("POST /deploys returns a snake_case deploy with exactly the documented keys", async () => {
    const res = await call("/deploys", jsonRequest("POST", validDeploy));
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), DEPLOY_KEYS);
    assert.equal(res.body.ci_run_id, "run-1001");
    assert.equal(res.body.status, "STARTED");
    assert.match(res.body.created_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("AC-07: a duplicate ci_run_id returns 200 with the same id and stores one record", async () => {
    const first = await call("/deploys", jsonRequest("POST", validDeploy));
    const second = await call("/deploys", jsonRequest("POST", validDeploy));
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(repo.deploys.length, 1);
  });

  for (const [name, body] of [
    ["empty service", { ...validDeploy, service: "" }],
    ["whitespace version", { ...validDeploy, version: "   " }],
    ["unknown environment", { ...validDeploy, environment: "production" }],
    ["service with spaces", { ...validDeploy, service: "api gateway" }],
    ["ci_run_id over 200 chars", { ...validDeploy, ci_run_id: "x".repeat(201) }],
    ["non-hex commit_sha", { ...validDeploy, commit_sha: "not-a-sha" }],
    ["non-http ci_run_url", { ...validDeploy, ci_run_url: "ftp://ci.example.com/1" }],
    ["missing body", undefined]
  ]) {
    test(`POST /deploys rejects ${name} with VALIDATION_ERROR`, async () => {
      const init = body === undefined ? { method: "POST" } : jsonRequest("POST", body);
      const res = await call("/deploys", init);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.ok(Array.isArray(res.body.error.details));
      assert.equal(repo.deploys.length, 0);
    });
  }

  test("malformed JSON returns 400 INVALID_JSON as JSON, not HTML", async () => {
    const response = await fetch(`${server.baseUrl}/deploys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal((await response.json()).error.code, "INVALID_JSON");
  });

  test("unknown route returns 404 NOT_FOUND JSON", async () => {
    const res = await call("/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  test("a repository failure returns 500 INTERNAL without leaking the error", async (t) => {
    t.mock.method(console, "error", () => undefined);
    repo.failWith = new Error("connection refused: secret-db-host:5432");
    const res = await call("/deploys", jsonRequest("POST", validDeploy));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: "INTERNAL", message: "Internal server error" } });
  });

  test("x-request-id is echoed when valid and generated otherwise", async () => {
    const kept = await fetch(`${server.baseUrl}/health`, { headers: { "x-request-id": "req-abc_123" } });
    assert.equal(kept.headers.get("x-request-id"), "req-abc_123");
    const replaced = await fetch(`${server.baseUrl}/health`, { headers: { "x-request-id": "bad id with spaces" } });
    assert.match(replaced.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  });

  test("/health returns 503 when the database is unreachable", async () => {
    repo.failWith = new Error("down");
    const res = await call("/health");
    assert.equal(res.status, 503);
  });
});

describe("DSC-02 history: GET /deploys and GET /deploys/:id", () => {
  async function seed() {
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    const rows = [
      ["api-gateway", "prod", 0],
      ["api-gateway", "dev", 1],
      ["log-service", "prod", 2],
      ["deploy-service", "staging", 3],
      ["api-gateway", "prod", 4]
    ];
    for (const [i, [service, environment, offsetHours]] of rows.entries()) {
      await repo.create(
        { service, environment, version: `1.0.${i}`, ciRunId: `seed-${i}` },
        new Date(base + offsetHours * 3_600_000)
      );
    }
  }

  test("returns { items, next_cursor, total_count } newest first", async () => {
    await seed();
    const res = await call("/deploys");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ["items", "next_cursor", "total_count"]);
    assert.equal(res.body.total_count, 5);
    assert.equal(res.body.next_cursor, null);
    assert.deepEqual(
      res.body.items.map((d) => d.ci_run_id),
      ["seed-4", "seed-3", "seed-2", "seed-1", "seed-0"]
    );
  });

  test("filters narrow items and total_count", async () => {
    await seed();
    await repo.transition(repo.deploys[2].id, "FAILED", "health check failed");

    const byService = await call("/deploys?service=api-gateway");
    assert.equal(byService.body.total_count, 3);
    const byEnv = await call("/deploys?service=api-gateway&environment=prod");
    assert.deepEqual(byEnv.body.items.map((d) => d.ci_run_id), ["seed-4", "seed-0"]);
    const byStatus = await call("/deploys?status=FAILED");
    assert.deepEqual(byStatus.body.items.map((d) => d.ci_run_id), ["seed-2"]);
    const byRange = await call(
      `/deploys?from=${encodeURIComponent("2026-11-01T01:00:00.000Z")}&to=${encodeURIComponent("2026-11-01T03:00:00.000Z")}`
    );
    assert.deepEqual(byRange.body.items.map((d) => d.ci_run_id), ["seed-2", "seed-1"], "from inclusive, to exclusive");
  });

  test("limit defaults to 20 and pages are linked by next_cursor", async () => {
    for (let i = 0; i < 25; i += 1) {
      await repo.create({ service: "svc", environment: "dev", version: "1", ciRunId: `bulk-${i}` }, new Date(1_800_000_000_000 + i));
    }
    const first = await call("/deploys");
    assert.equal(first.body.items.length, 20);
    assert.ok(first.body.next_cursor);
    const second = await call(`/deploys?cursor=${first.body.next_cursor}`);
    assert.equal(second.body.items.length, 5);
    assert.equal(second.body.next_cursor, null);
    const ids = new Set([...first.body.items, ...second.body.items].map((d) => d.id));
    assert.equal(ids.size, 25);
  });

  for (const query of ["limit=0", "limit=101", "limit=abc", "cursor=garbage", "environment=qa", "status=DONE", "from=yesterday"]) {
    test(`GET /deploys?${query} returns 400`, async () => {
      const res = await call(`/deploys?${query}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  }

  test("from must be earlier than to", async () => {
    const res = await call("/deploys?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z");
    assert.equal(res.status, 400);
  });

  test("GET /deploys/:id returns the deploy, 404 when missing, 400 when not a UUID", async () => {
    const created = await call("/deploys", jsonRequest("POST", validDeploy));
    const found = await call(`/deploys/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, created.body.id);

    const missing = await call("/deploys/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    assert.equal((await call("/deploys/deploy-42")).status, 400);
  });
});

describe("DSC-03 transitions, overview, metadata", () => {
  async function createDeploy(overrides = {}) {
    return (await call("/deploys", jsonRequest("POST", { ...validDeploy, ...overrides }))).body;
  }

  test("valid transition returns the updated deploy; reason required for FAILED/ROLLED_BACK", async () => {
    const deploy = await createDeploy();
    const noReason = await call(`/deploys/${deploy.id}`, jsonRequest("PATCH", { status: "FAILED" }));
    assert.equal(noReason.status, 400);

    const failed = await call(`/deploys/${deploy.id}`, jsonRequest("PATCH", { status: "FAILED", reason: "probe timeout" }));
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "FAILED");
    assert.equal(failed.body.reason, "probe timeout");

    const rolledBack = await call(`/deploys/${deploy.id}`, jsonRequest("PATCH", { status: "ROLLED_BACK", reason: "reverted to 1.3.9" }));
    assert.equal(rolledBack.body.status, "ROLLED_BACK");
  });

  test("invalid transition returns 409 with current_status", async () => {
    const deploy = await createDeploy();
    await call(`/deploys/${deploy.id}`, jsonRequest("PATCH", { status: "SUCCESS" }));
    const res = await call(`/deploys/${deploy.id}`, jsonRequest("PATCH", { status: "FAILED", reason: "late" }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INVALID_TRANSITION");
    assert.equal(res.body.error.current_status, "SUCCESS");
  });

  test("PATCH on a missing deploy returns 404", async () => {
    const res = await call("/deploys/00000000-0000-4000-8000-000000000000", jsonRequest("PATCH", { status: "SUCCESS" }));
    assert.equal(res.status, 404);
  });

  test("metadata fields are stored and returned; commit_sha is normalised to lower case", async () => {
    const deploy = await createDeploy({
      commit_sha: "3770D7D0ABCDEF",
      ci_run_url: "https://github.com/org/repo/actions/runs/1",
      triggered_by: "tert62"
    });
    assert.equal(deploy.commit_sha, "3770d7d0abcdef");
    assert.equal(deploy.ci_run_url, "https://github.com/org/repo/actions/runs/1");
    assert.equal(deploy.triggered_by, "tert62");
  });

  test("GET /overview returns { items } with the latest deploy per service/environment", async () => {
    await repo.create({ service: "api-gateway", environment: "prod", version: "1.0.0", ciRunId: "a" }, new Date(1000));
    await repo.create({ service: "api-gateway", environment: "prod", version: "1.1.0", ciRunId: "b" }, new Date(2000));
    await repo.create({ service: "api-gateway", environment: "dev", version: "2.0.0", ciRunId: "c" }, new Date(1500));
    const res = await call("/overview");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((d) => `${d.service}/${d.environment}@${d.version}`),
      ["api-gateway/dev@2.0.0", "api-gateway/prod@1.1.0"]
    );
  });

  test("overview is served from cache and invalidated by writes", async () => {
    await createDeploy();
    await call("/overview");
    assert.ok(cache.value, "first read fills the cache");
    const cachedBody = cache.value;
    assert.equal(await (await fetch(`${server.baseUrl}/overview`)).text(), cachedBody);

    await createDeploy({ ci_run_id: "run-2002", environment: "dev" });
    assert.equal(cache.value, null, "create invalidates");
    const after = await call("/overview");
    assert.equal(after.body.items.length, 2);
  });

  test("AC-06: with Redis failing, /overview and writes still succeed from the repository", async () => {
    await server.close();
    server = await startApp(createApp({ repo, cache: new FailingCache() }));
    const created = await call("/deploys", jsonRequest("POST", validDeploy));
    assert.equal(created.status, 201);
    const overview = await call("/overview");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.items[0].id, created.body.id);
    const patched = await call(`/deploys/${created.body.id}`, jsonRequest("PATCH", { status: "SUCCESS" }));
    assert.equal(patched.status, 200);
  });
});
