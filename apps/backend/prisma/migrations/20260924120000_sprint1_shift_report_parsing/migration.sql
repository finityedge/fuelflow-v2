-- Sprint 1: deterministic Petronite shift-report parsing.
--
-- Two things drive the shape of this migration:
--   1. A field carries its own review state, so extraction is per-field rather than
--      pass/fail for the whole report.
--   2. The uploaded PDF and the reason for a failure are both first-class, so a
--      manager looking at a failed report can see what was uploaded and why.

-- CreateEnum
CREATE TYPE "FieldConfidence" AS ENUM ('HIGH', 'LOW');

-- CreateEnum
CREATE TYPE "ExtractedFieldGroup" AS ENUM ('CASH_PAYMENTS', 'CREDIT_SALES', 'ATTENDANT_RECONCILIATION', 'TANK_READINGS');

-- AlterTable: ShiftReport
-- reportDate becomes nullable: it is read out of the report during parsing, so it is
-- unknown at upload time. A guessed date is worse than a blank one.
ALTER TABLE "ShiftReport" ALTER COLUMN "reportDate" DROP NOT NULL;
ALTER TABLE "ShiftReport" RENAME COLUMN "rawPdfUrl" TO "pdfFileUrl";
ALTER TABLE "ShiftReport"
  ADD COLUMN "pdfFileName"   TEXT,
  ADD COLUMN "uploadedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "failureReason" TEXT;

CREATE INDEX "ShiftReport_tenantId_uploadedAt_idx" ON "ShiftReport"("tenantId", "uploadedAt");

-- AlterTable: ExtractedField
ALTER TABLE "ExtractedField" RENAME COLUMN "normalizedValue" TO "parsedValue";

-- `confidence` moves from a free float to a two-value enum: the parser either read the
-- figure from the label's own line (HIGH) or inferred it (LOW). Existing rows hold
-- arbitrary floats; anything at/above 0.8 maps to HIGH, everything else to LOW.
ALTER TABLE "ExtractedField" ADD COLUMN "confidence_new" "FieldConfidence";
UPDATE "ExtractedField"
   SET "confidence_new" = CASE
     WHEN "confidence" IS NULL THEN 'LOW'::"FieldConfidence"
     WHEN "confidence" >= 0.8 THEN 'HIGH'::"FieldConfidence"
     ELSE 'LOW'::"FieldConfidence"
   END;
ALTER TABLE "ExtractedField" ALTER COLUMN "confidence_new" SET NOT NULL;
ALTER TABLE "ExtractedField" DROP COLUMN "confidence";
ALTER TABLE "ExtractedField" RENAME COLUMN "confidence_new" TO "confidence";

-- `label` and `group` are NOT NULL and have no sensible default, so they are added with
-- a placeholder default that is then dropped. Existing rows predate the parser and only
-- exist in development; they land in CASH_PAYMENTS keyed by their field name.
ALTER TABLE "ExtractedField"
  ADD COLUMN "label"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN "group"       "ExtractedFieldGroup" NOT NULL DEFAULT 'CASH_PAYMENTS',
  ADD COLUMN "amount"      DOUBLE PRECISION,
  ADD COLUMN "reviewNote"  TEXT,
  ADD COLUMN "regionText"  TEXT,
  ADD COLUMN "correctedAt" TIMESTAMP(3),
  ADD COLUMN "correctedBy" TEXT;

UPDATE "ExtractedField" SET "label" = "fieldName" WHERE "label" = '';
ALTER TABLE "ExtractedField" ALTER COLUMN "label" DROP DEFAULT;
ALTER TABLE "ExtractedField" ALTER COLUMN "group" DROP DEFAULT;

CREATE INDEX "ExtractedField_shiftReportId_group_idx" ON "ExtractedField"("shiftReportId", "group");
