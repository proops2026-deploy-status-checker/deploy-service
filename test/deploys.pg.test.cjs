// Integration tests against a real PostgreSQL (the behaviour a fake repository can't prove:
// UNIQUE-based idempotency, keyset pagination with tied timestamps, the conditional UPDATE under
// concurrency, DISTINCT ON). Skipped unless TEST_DATABASE_URL points at a migrated, disposable database.
//   TEST_DATABASE_URL=postgresql://... npm test
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PrismaDeployRepository against PostgreSQL", { skip: !databaseUrl && "TEST_DATABASE_URL not set" }, () => {
  let prisma;
  let repo;

  before(() => {
    const { PrismaClient } = require("@prisma/client");
    const { PrismaDeployRepository } = require("../dist/repository.js");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    repo = new PrismaDeployRepository(prisma);
  });

  after(() => prisma.$disconnect());

  beforeEach(() => prisma.$executeRawUnsafe('TRUNCATE TABLE "deploys"'));

  const input = (ciRunId, extra = {}) => ({ service: "api-gateway", environment: "prod", version: "1.0.0", ciRunId, ...extra });

  test("AC-07: 10 concurrent creates with one ci_run_id store exactly one row", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => repo.create(input("same-run"))));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.deploy.id)).size, 1);
    assert.equal(await prisma.deploy.count(), 1);
  });

  test("DSC-02: walking cursors returns every row exactly once even with identical created_at", async () => {
    const tied = new Date("2026-11-10T10:00:00.000Z");
    for (let i = 0; i < 7; i += 1) {
      await prisma.deploy.create({ data: { ...input(`tied-${i}`), createdAt: tied } });
    }
    await prisma.deploy.create({ data: { ...input("older"), createdAt: new Date("2026-11-09T00:00:00.000Z") } });
    await prisma.deploy.create({ data: { ...input("other-env", { environment: "dev" }), createdAt: tied } });

    const seen = [];
    let cursor;
    do {
      const page = await repo.list({ environment: "prod" }, cursor, 3);
      seen.push(...page.items);
      const last = page.items.at(-1);
      cursor = page.hasMore ? { createdAt: last.createdAt, id: last.id } : undefined;
    } while (cursor);

    assert.equal(seen.length, 8);
    assert.equal(new Set(seen.map((d) => d.id)).size, 8);
    assert.equal(seen.at(-1).ciRunId, "older");
    assert.equal(await repo.count({ environment: "prod" }), 8);
  });

  test("DSC-03: 10 concurrent SUCCESS/FAILED transitions — exactly one wins", async () => {
    const { deploy } = await repo.create(input("race"));
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 ? repo.transition(deploy.id, "SUCCESS", null) : repo.transition(deploy.id, "FAILED", "probe failed")
      )
    );
    assert.equal(results.filter((r) => r.kind === "updated").length, 1);
    assert.equal(results.filter((r) => r.kind === "invalid_transition").length, 9);
    const winner = results.find((r) => r.kind === "updated").deploy;
    assert.equal((await repo.findById(deploy.id)).status, winner.status);
  });

  test("DSC-03: transition on a missing id is not_found; STARTED target is never valid", async () => {
    assert.deepEqual(await repo.transition("00000000-0000-4000-8000-000000000000", "SUCCESS", null), { kind: "not_found" });
    const { deploy } = await repo.create(input("restart"));
    assert.deepEqual(await repo.transition(deploy.id, "STARTED", null), { kind: "invalid_transition", currentStatus: "STARTED" });
  });

  test("DSC-03: latestPerServiceEnvironment uses DISTINCT ON and maps snake_case rows", async () => {
    await prisma.deploy.create({ data: { ...input("p1", { version: "1.0.0" }), createdAt: new Date(1_000) } });
    await prisma.deploy.create({ data: { ...input("p2", { version: "1.1.0", commitSha: "abc1234" }), createdAt: new Date(2_000) } });
    await prisma.deploy.create({ data: { ...input("d1", { environment: "dev", version: "2.0.0" }), createdAt: new Date(1_500) } });
    const latest = await repo.latestPerServiceEnvironment();
    assert.deepEqual(latest.map((d) => `${d.environment}@${d.version}`), ["dev@2.0.0", "prod@1.1.0"]);
    assert.equal(latest[1].commitSha, "abc1234");
    assert.ok(latest[1].createdAt instanceof Date);
  });

  test("DSC-02/03: the migration created both indexes", async () => {
    const rows = await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE tablename = 'deploys' ORDER BY indexname`;
    const names = rows.map((r) => r.indexname);
    assert.ok(names.includes("deploys_created_at_id_idx"));
    assert.ok(names.includes("deploys_service_environment_created_at_idx"));
    assert.ok(names.includes("deploys_ci_run_id_key"));
  });
});
