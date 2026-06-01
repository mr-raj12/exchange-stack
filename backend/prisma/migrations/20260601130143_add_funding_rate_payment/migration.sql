-- CreateTable
CREATE TABLE "FundingRate" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "markPrice" DECIMAL(20,8) NOT NULL,
    "indexPrice" DECIMAL(20,8) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "positionSide" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "fundingRateId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundingRate_market_settledAt_idx" ON "FundingRate"("market", "settledAt");

-- CreateIndex
CREATE INDEX "FundingPayment_userId_market_idx" ON "FundingPayment"("userId", "market");

-- AddForeignKey
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_fundingRateId_fkey" FOREIGN KEY ("fundingRateId") REFERENCES "FundingRate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
