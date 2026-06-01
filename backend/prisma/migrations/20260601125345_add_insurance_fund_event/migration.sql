-- CreateTable
CREATE TABLE "InsuranceFundEvent" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsuranceFundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsuranceFundEvent_market_createdAt_idx" ON "InsuranceFundEvent"("market", "createdAt");
