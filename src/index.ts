import express from "express";
import { PrismaClient } from "@prisma/client";

const app = express();
const port = process.env.PORT ?? 3001;
const prisma = new PrismaClient();

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

app.listen(port, () => {
  console.log(`deploy-service listening on port ${port}`);
});

async function shutdown() {
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
