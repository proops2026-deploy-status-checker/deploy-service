-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('dev', 'staging', 'prod');

-- CreateEnum
CREATE TYPE "DeployStatus" AS ENUM ('STARTED', 'SUCCESS', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "deploys" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "version" TEXT NOT NULL,
    "status" "DeployStatus" NOT NULL DEFAULT 'STARTED',
    "ci_run_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deploys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deploys_ci_run_id_key" ON "deploys"("ci_run_id");

