BEGIN;

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ApplicationStatusHistory" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "fromStatus" "ApplicationStatus" NOT NULL,
    "toStatus" "ApplicationStatus" NOT NULL,
    "applicationVersion" INTEGER NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationStatusHistory_applicationId_applicationVersion_key" ON "ApplicationStatusHistory"("applicationId", "applicationVersion");

-- AddForeignKey
ALTER TABLE "ApplicationStatusHistory" ADD CONSTRAINT "ApplicationStatusHistory_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "JobApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Foundation constraints; no synthetic history or data updates.
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_version_positive_check"
CHECK ("version" > 0);

ALTER TABLE "ApplicationStatusHistory" ADD CONSTRAINT "ApplicationStatusHistory_status_changed_check"
CHECK ("fromStatus" <> "toStatus");

ALTER TABLE "ApplicationStatusHistory" ADD CONSTRAINT "ApplicationStatusHistory_version_check"
CHECK ("applicationVersion" >= 2);

COMMIT;
