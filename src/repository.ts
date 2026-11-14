import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  CreateDeployInput,
  DeployCursor,
  DeployFilter,
  DeployRecord,
  DeployRepository,
  DeployStatus,
  Environment,
  TransitionResult
} from "./domain";
import { sourcesFor } from "./state-machine";

// Row shape returned by raw SQL (column names as stored, see prisma/schema.prisma @map).
interface DeployRow {
  id: string;
  service: string;
  environment: Environment;
  version: string;
  status: DeployStatus;
  ci_run_id: string;
  reason: string | null;
  commit_sha: string | null;
  ci_run_url: string | null;
  triggered_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: DeployRow): DeployRecord {
  return {
    id: row.id,
    service: row.service,
    environment: row.environment,
    version: row.version,
    status: row.status,
    ciRunId: row.ci_run_id,
    reason: row.reason,
    commitSha: row.commit_sha,
    ciRunUrl: row.ci_run_url,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toWhere(filter: DeployFilter): Prisma.DeployWhereInput {
  return {
    service: filter.service,
    environment: filter.environment,
    status: filter.status,
    createdAt: filter.from || filter.to ? { gte: filter.from, lt: filter.to } : undefined
  };
}

export class PrismaDeployRepository implements DeployRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async create(input: CreateDeployInput): Promise<{ deploy: DeployRecord; created: boolean }> {
    const existing = await this.prisma.deploy.findUnique({ where: { ciRunId: input.ciRunId } });
    if (existing) return { deploy: existing, created: false };

    try {
      const deploy = await this.prisma.deploy.create({ data: input });
      return { deploy, created: true };
    } catch (error) {
      // Concurrent CI retry won the race: the UNIQUE(ci_run_id) constraint is the real guard (AC-07).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.deploy.findUnique({ where: { ciRunId: input.ciRunId } });
        if (winner) return { deploy: winner, created: false };
      }
      throw error;
    }
  }

  findById(id: string): Promise<DeployRecord | null> {
    return this.prisma.deploy.findUnique({ where: { id } });
  }

  async list(filter: DeployFilter, cursor: DeployCursor | undefined, limit: number) {
    const where: Prisma.DeployWhereInput = cursor
      ? {
          AND: [
            toWhere(filter),
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            }
          ]
        }
      : toWhere(filter);

    const rows = await this.prisma.deploy.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1
    });
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  count(filter: DeployFilter): Promise<number> {
    return this.prisma.deploy.count({ where: toWhere(filter) });
  }

  async transition(id: string, to: DeployStatus, reason: string | null): Promise<TransitionResult> {
    // One conditional UPDATE: the database, not application code, decides whether the move is
    // valid, so two concurrent CI calls can never both win (IRD-001 Decision #2).
    const rows = await this.prisma.$queryRaw<DeployRow[]>`
      UPDATE deploys
         SET status = ${to}::"DeployStatus", reason = ${reason}, updated_at = NOW()
       WHERE id = ${id}
         AND status::text = ANY(${sourcesFor(to)})
      RETURNING *`;
    if (rows.length === 1) return { kind: "updated", deploy: fromRow(rows[0]) };

    const current = await this.findById(id);
    return current ? { kind: "invalid_transition", currentStatus: current.status } : { kind: "not_found" };
  }

  async latestPerServiceEnvironment(): Promise<DeployRecord[]> {
    // DISTINCT ON runs in PostgreSQL (backed by the (service, environment, created_at DESC) index).
    // Prisma's `distinct` option would fetch every row and dedupe in memory.
    const rows = await this.prisma.$queryRaw<DeployRow[]>`
      SELECT DISTINCT ON (service, environment) *
        FROM deploys
       ORDER BY service, environment, created_at DESC, id DESC`;
    return rows.map(fromRow);
  }
}
