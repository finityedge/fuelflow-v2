-- CreateTable
CREATE TABLE "AttendantAlias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "attendantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendantAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendantAlias_stationId_slug_key" ON "AttendantAlias"("stationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AttendantAlias_attendantId_slug_key" ON "AttendantAlias"("attendantId", "slug");

-- AddForeignKey
ALTER TABLE "AttendantAlias" ADD CONSTRAINT "AttendantAlias_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendantAlias" ADD CONSTRAINT "AttendantAlias_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendantAlias" ADD CONSTRAINT "AttendantAlias_attendantId_fkey" FOREIGN KEY ("attendantId") REFERENCES "Attendant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
