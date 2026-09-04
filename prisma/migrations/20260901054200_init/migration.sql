-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OdooConnection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "odooUrl" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OdooConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncMapping" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "odooModel" TEXT NOT NULL,
    "odooId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooConnection_shop_key" ON "OdooConnection"("shop");

-- CreateIndex
CREATE INDEX "SyncMapping_shop_resourceType_idx" ON "SyncMapping"("shop", "resourceType");

-- CreateIndex
CREATE UNIQUE INDEX "SyncMapping_shop_resourceType_shopifyId_key" ON "SyncMapping"("shop", "resourceType", "shopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncEvent_webhookId_key" ON "SyncEvent"("webhookId");

-- CreateIndex
CREATE INDEX "SyncEvent_shop_createdAt_idx" ON "SyncEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "SyncEvent_shop_status_idx" ON "SyncEvent"("shop", "status");
