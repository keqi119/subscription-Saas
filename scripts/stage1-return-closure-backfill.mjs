import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  executeStage1ReturnClosureBackfill,
  financialAuthorityFingerprint,
  parseStage1ReturnClosureBackfillArgs
} from "./stage1-return-closure-backfill-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let prisma;

export async function runStage1ReturnClosureBackfill({
  args,
  client,
  env = process.env,
  outputWriter = writeReport,
  stdout = process.stdout
}) {
  const { mode, output } = parseStage1ReturnClosureBackfillArgs(args);
  if (mode === "apply" && env.STAGE1_RETURN_CLOSURE_BACKFILL_APPLY !== "1") {
    throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_APPLY_CONFIRMATION_REQUIRED");
  }
  const result = await executeStage1ReturnClosureBackfill({
    apply: (classification) => applyClassification(client, classification),
    load: () =>
      client.$transaction((tx) => loadSnapshot(tx), {
        isolationLevel: "RepeatableRead",
        timeout: 120_000
      }),
    mode
  });
  const body = `${JSON.stringify(result.report, null, 2)}\n`;
  stdout.write(body);
  if (output) await outputWriter(output, body);
  return result.exitCode;
}

export async function loadSnapshot(client) {
  const [
    closures,
    deliveries,
    damages,
    contracts,
    audits,
    clauses,
    links,
    bills,
    dispositions,
    settlements,
    files,
    paymentRecords,
    paymentWriteOffs
  ] = await Promise.all([
    client.subscriptionClosureCase.findMany({
      orderBy: { id: "asc" },
      select: {
        contractId: true,
        currentChecklistRevisionId: true,
        currentDeltaRevisionId: true,
        currentSettlementRevisionId: true,
        financialStatus: true,
        id: true,
        orderId: true,
        retiredAt: true,
        version: true
      }
    }),
    client.vehicleDeliveryHandover.findMany({
      orderBy: { id: "asc" },
      select: {
        archivedAt: true,
        archiveStatus: true,
        id: true,
        orderId: true,
        signedDocumentFileId: true,
        signedPdfHash: true,
        status: true
      }
    }),
    client.vehicleReturnDamage.findMany({
      orderBy: { id: "asc" },
      select: { deletedAt: true, id: true, orderId: true, photoUrls: true }
    }),
    client.contract.findMany({
      orderBy: { id: "asc" },
      select: {
        archivedAt: true,
        contractSnapshot: true,
        fileId: true,
        id: true,
        signedAt: true,
        status: true
      }
    }),
    client.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        action: true,
        afterSnapshot: true,
        createdAt: true,
        entityId: true,
        entityType: true,
        id: true
      },
      where: { entityType: "contract" }
    }),
    client.contractChargeClauseSnapshot.findMany({
      orderBy: { id: "asc" },
      select: { clauseCode: true, clauseVersion: true, compilationHash: true, contractId: true }
    }),
    client.vehicleReturnEvidenceLink.findMany({
      orderBy: { id: "asc" },
      select: { sourceKey: true }
    }),
    client.receivableBill.findMany({
      orderBy: { id: "asc" },
      select: {
        deletedAt: true,
        id: true,
        orderId: true,
        paidAmount: true,
        remainingAmount: true
      }
    }),
    client.subscriptionClosureReceivableDisposition.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        billId: true,
        closureCaseId: true,
        createdAt: true,
        disposition: true,
        id: true,
        supersedesDispositionId: true
      }
    }),
    client.subscriptionClosureSettlementRevision.findMany({
      orderBy: [{ closureCaseId: "asc" }, { revisionNumber: "asc" }],
      select: {
        amountDueCents: true,
        closureCaseId: true,
        id: true,
        publicationSnapshot: true,
        publishedAt: true,
        revisionNumber: true,
        stage: true
      }
    }),
    client.fileObject.findMany({
      orderBy: { id: "asc" },
      select: { contentSha256: true, id: true }
    }),
    client.paymentRecord.findMany({
      orderBy: { id: "asc" },
      select: {
        deletedAt: true,
        id: true,
        orderId: true,
        paymentAmount: true,
        paymentStatus: true,
        receivedAt: true,
        updatedAt: true
      }
    }),
    client.paymentWriteOff.findMany({
      orderBy: { id: "asc" },
      select: {
        billId: true,
        deletedAt: true,
        id: true,
        orderId: true,
        paymentId: true,
        writeOffAmount: true,
        writeOffAt: true
      }
    })
  ]);
  return {
    audits,
    bills,
    clauses,
    closures,
    contracts,
    damages,
    deliveries,
    dispositions,
    files,
    links,
    paymentRecords,
    paymentWriteOffs,
    settlements
  };
}

export async function applyClassification(client, classification) {
  if (classification.publicationValidationReady === true) {
    const rows = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS "missingCount"
         FROM "subscription_closure_settlement_revision"
        WHERE "stage" = 'FINALIZED'
          AND ("published_at" IS NULL OR "publication_snapshot" IS NULL)`
    );
    const missingCount = Number(rows?.[0]?.missingCount ?? 0);
    if (!Number.isSafeInteger(missingCount) || missingCount !== 0) {
      throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_PUBLICATION_PREFLIGHT_FAILED");
    }
  }
  const operations = [
    ...(classification.fileAuthorityUpdates ?? [])
      .filter((item) => item.disposition === "UPDATE")
      .map((item) => ({ kind: "fileAuthority", value: item })),
    ...classification.legacyEvidenceLinks
      .filter((item) => item.disposition === "CREATE")
      .map((item) => ({ kind: "link", value: item })),
    ...classification.clauseSnapshots
      .filter((item) => item.disposition === "CREATE")
      .map((item) => ({ kind: "clause", value: item })),
    ...classification.financialUpdates
      .filter((item) => item.disposition === "UPDATE")
      .map((item) => ({ kind: "financial", value: item }))
  ];
  const counts = { clauses: 0, fileAuthorities: 0, financial: 0, legacyLinks: 0 };
  for (let offset = 0; offset < operations.length; offset += 100) {
    const batch = operations.slice(offset, offset + 100);
    await client.$transaction(
      async (tx) => {
        for (const operation of batch) {
          if (operation.kind === "link") {
            const item = operation.value;
            const existing = await tx.vehicleReturnEvidenceLink.findUnique({
              where: {
                sourceType_sourceId_sourceKey: {
                  sourceId: item.sourceId,
                  sourceKey: item.sourceKey,
                  sourceType: item.sourceType
                }
              }
            });
            if (existing) {
              const hasSameFacts =
                existing.closureCaseId === item.closureCaseId &&
                existing.damageId === item.damageId &&
                existing.evidencePurpose === item.evidencePurpose &&
                existing.legacyExternalReference === item.legacyExternalReference &&
                existing.visibility === item.visibility;
              if (!hasSameFacts) {
                throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_EVIDENCE_LINK_CONFLICT");
              }
            } else {
              await tx.vehicleReturnEvidenceLink.create({
                data: {
                  closureCaseId: item.closureCaseId,
                  damageId: item.damageId,
                  evidencePurpose: item.evidencePurpose,
                  legacyExternalReference: item.legacyExternalReference,
                  sourceId: item.sourceId,
                  sourceKey: item.sourceKey,
                  sourceType: item.sourceType,
                  visibility: item.visibility
                }
              });
              counts.legacyLinks += 1;
            }
          } else if (operation.kind === "clause") {
            const { disposition: _disposition, ...item } = operation.value;
            const existing = await tx.contractChargeClauseSnapshot.findUnique({
              where: {
                contractId_clauseCode_clauseVersion: {
                  clauseCode: item.clauseCode,
                  clauseVersion: item.clauseVersion,
                  contractId: item.contractId
                }
              }
            });
            if (existing) {
              if (existing.compilationHash !== item.compilationHash) {
                throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_CLAUSE_CONFLICT");
              }
            } else {
              await tx.contractChargeClauseSnapshot.create({
                data: { ...item, createdBy: null }
              });
              counts.clauses += 1;
            }
          } else if (operation.kind === "financial") {
            const item = operation.value;
            const liveClosure = await tx.subscriptionClosureCase.findUnique({
              select: { orderId: true, version: true },
              where: { id: item.closureCaseId }
            });
            const [liveBills, liveDispositions] = await Promise.all([
              tx.receivableBill.findMany({
                orderBy: { id: "asc" },
                select: {
                  deletedAt: true,
                  id: true,
                  orderId: true,
                  paidAmount: true,
                  remainingAmount: true
                },
                where: { orderId: item.orderId }
              }),
              tx.subscriptionClosureReceivableDisposition.findMany({
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                  billId: true,
                  closureCaseId: true,
                  createdAt: true,
                  disposition: true,
                  id: true,
                  supersedesDispositionId: true
                },
                where: { closureCaseId: item.closureCaseId }
              })
            ]);
            if (
              !liveClosure ||
              liveClosure.orderId !== item.orderId ||
              liveClosure.version !== item.expectedVersion ||
              financialAuthorityFingerprint(liveBills, liveDispositions) !==
                item.authorityFingerprint
            ) {
              throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_FINANCIAL_CHANGE");
            }
            const updated = await tx.subscriptionClosureCase.updateMany({
              data: { financialStatus: item.to, version: { increment: 1 } },
              where: {
                financialStatus: item.from,
                id: item.closureCaseId,
                version: item.expectedVersion
              }
            });
            if (updated.count !== 1) {
              throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_CHANGE");
            }
            counts.financial += 1;
          } else {
            const item = operation.value;
            const current = await tx.fileObject.findUnique({
              select: { contentSha256: true, id: true },
              where: { id: item.fileId }
            });
            if (!current) {
              throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONTRACT_FILE_MISSING");
            }
            if (
              current.contentSha256 !== item.expectedContentSha256 &&
              current.contentSha256 !== item.toContentSha256
            ) {
              throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_FILE_AUTHORITY_CHANGE");
            }
            if (current.contentSha256 === item.toContentSha256) continue;
            const updated = await tx.fileObject.updateMany({
              data: { contentSha256: item.toContentSha256 },
              where: { contentSha256: item.expectedContentSha256, id: item.fileId }
            });
            if (updated.count !== 1) {
              throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_CONCURRENT_FILE_AUTHORITY_CHANGE");
            }
            counts.fileAuthorities += 1;
          }
        }
      },
      { isolationLevel: "RepeatableRead", timeout: 120_000 }
    );
  }
  return { batchSize: 100, ...counts };
}

async function createClient() {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_DATABASE_URL_REQUIRED");
  const url = new URL(databaseUrl);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return new PrismaClient({ adapter: new PrismaPg(url.toString()) });
}

async function loadEnvironment() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
}

async function writeReport(path, contents) {
  const absolute = resolve(process.cwd(), path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function main() {
  await loadEnvironment();
  prisma = await createClient();
  return runStage1ReturnClosureBackfill({ args: process.argv.slice(2), client: prisma });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : "BACKFILL_FAILED" })}\n`
      );
      process.exitCode = 1;
    })
    .finally(() => prisma?.$disconnect());
}
