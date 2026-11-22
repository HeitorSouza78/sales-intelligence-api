-- Fase 1: Autenticação multi-tenant real + preparação para Tiering de IA.
-- Migração aditiva: não remove nem altera dados existentes.

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('BASIC', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'BASIC',
ADD COLUMN     "refreshTokenHash" TEXT;
