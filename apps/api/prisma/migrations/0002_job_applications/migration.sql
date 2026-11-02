BEGIN;

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SAVED', 'APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "company" VARCHAR(160) NOT NULL,
    "jobTitle" VARCHAR(200) NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SAVED',
    "applicationDate" DATE,
    "location" VARCHAR(200),
    "jobUrl" VARCHAR(2048),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobApplication_userId_createdAt_id_idx" ON "JobApplication"("userId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Require a date after leaving SAVED.
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_applicationDate_required_check"
CHECK ("status" = 'SAVED' OR "applicationDate" IS NOT NULL);

COMMIT;
