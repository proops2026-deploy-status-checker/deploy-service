-- AlterTable
ALTER TABLE "deploys" ADD COLUMN     "ci_run_url" TEXT,
ADD COLUMN     "commit_sha" TEXT,
ADD COLUMN     "triggered_by" TEXT;

-- CreateIndex
CREATE INDEX "deploys_created_at_id_idx" ON "deploys"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "deploys_service_environment_created_at_idx" ON "deploys"("service", "environment", "created_at" DESC);
