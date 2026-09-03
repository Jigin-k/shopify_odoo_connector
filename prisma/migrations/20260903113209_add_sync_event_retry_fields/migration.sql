-- AlterTable
ALTER TABLE "SyncEvent" ADD COLUMN     "lastRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;
