BEGIN;

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3);

COMMIT;
