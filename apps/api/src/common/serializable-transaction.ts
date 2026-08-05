import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export async function runSerializableTransaction<T>(
  prisma: Pick<PrismaService, "$transaction">,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionConflict(error) || attempt === maxAttempts) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
  throw lastError;
}

function isRetryableTransactionConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: unknown };
  if (candidate.code === "P2034") return true;
  if (candidate.code !== "P2010") return false;
  const detail = JSON.stringify(candidate.meta ?? {});
  return (
    detail.includes("40001") ||
    detail.includes("40P01") ||
    detail.includes("TransactionWriteConflict")
  );
}
