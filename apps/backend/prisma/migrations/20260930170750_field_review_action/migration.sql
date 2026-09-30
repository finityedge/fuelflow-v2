-- CreateEnum
CREATE TYPE "FieldReviewAction" AS ENUM ('CORRECTED', 'ACCEPTED');

-- AlterTable
ALTER TABLE "ExtractedField" ADD COLUMN     "reviewAction" "FieldReviewAction";
