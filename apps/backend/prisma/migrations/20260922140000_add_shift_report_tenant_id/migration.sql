-- Add missing tenantId column to ShiftReport so it matches the Prisma schema
-- and can be scoped by the tenant middleware.

-- AlterTable
ALTER TABLE "ShiftReport" ADD COLUMN "tenantId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "ShiftReport" ADD CONSTRAINT "ShiftReport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
