import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LEGACY_APPLICATION_BUSINESS_WAIT_CODES,
  classifyBusinessWaitReconciliation,
  summarizeBusinessWaitReconciliation
} from "./stage1-journey-business-wait-reconcile-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const TRANSACTION_OPTIONS = { isolationLevel: "Serializable" };
let prisma;

export function parseMode(args) {
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("Specify exactly one of --dry-run or --apply.");
}

export async function executeBusinessWaitReconciliation(client, mode) {
  if (!["dry-run", "apply"].includes(mode)) {
    throw new Error("STAGE1_JOURNEY_BUSINESS_WAIT_MODE_INVALID");
  }
  const rows = (await readAffectedJourneys(client)).map(toReconciliationRow);
  const report = summarizeBusinessWaitReconciliation(rows);
  const applied = [];
  if (mode === "apply") {
    for (const row of rows) {
      if (classifyBusinessWaitReconciliation(row).action !== "REVALIDATE_APPLICATION") {
        continue;
      }
      applied.push(await applyCandidate(client, row));
    }
  }
  return {
    applied,
    mode,
    report: {
      ...report,
      untouchedExceptions: report.results.filter(({ action }) => action === "REPORT_ONLY")
    }
  };
}

export function toReconciliationRow(journey) {
  const openExceptions = journey.exceptions.filter(({ status }) => status === "OPEN");
  return {
    applicationId: journey.applicationId,
    applicationStatus: journey.application.status,
    creditReviewStatus: journey.application.creditReviewStatus,
    currentFactVersion: journey.application.journeyFactVersion,
    currentStepCode: journey.currentStepCode,
    currentStepStatus: journey.currentStepStatus,
    depositStatus: journey.application.depositStatus,
    exceptionCodes: openExceptions.map(({ code }) => code),
    exceptionStatus: openExceptions.length > 0 ? "OPEN" : null,
    finalDepositAmountPresent: journey.application.finalDepositAmount !== null,
    journeyId: journey.id,
    journeyStatus: journey.status,
    materialReviewStatus: journey.application.materialReviewStatus,
    stepId: journey.steps.find(({ code }) => code === "APPLICATION_VALIDATION")?.id ?? null,
    version: journey.version
  };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  prisma = await createPrismaClient();
  const result = await executeBusinessWaitReconciliation(prisma, mode);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function readAffectedJourneys(client) {
  return client.subscriptionJourney.findMany({
    include: journeyReconciliationInclude(),
    orderBy: { id: "asc" },
    where: {
      currentStepCode: "APPLICATION_VALIDATION",
      currentStepStatus: "EXCEPTION",
      exceptions: { some: { status: "OPEN" } },
      status: "EXCEPTION"
    }
  });
}

async function applyCandidate(client, plannedRow) {
  return client.$transaction(
    (tx) => applyBusinessWaitCandidateInTransaction(tx, plannedRow),
    TRANSACTION_OPTIONS
  );
}

export async function applyBusinessWaitCandidateInTransaction(tx, plannedRow) {
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_journey" WHERE "id" = $1 FOR UPDATE',
    plannedRow.journeyId
  );
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_journey_step" WHERE "journey_id" = $1 AND "code" = \'APPLICATION_VALIDATION\' FOR UPDATE',
    plannedRow.journeyId
  );
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_journey_exception" WHERE "journey_id" = $1 AND "status" = \'OPEN\' FOR UPDATE',
    plannedRow.journeyId
  );

  const currentRecord = await tx.subscriptionJourney.findUnique({
    include: journeyReconciliationInclude(),
    where: { id: plannedRow.journeyId }
  });
  if (!currentRecord) {
    return { action: "SKIPPED", journeyId: plannedRow.journeyId };
  }
  const current = toReconciliationRow(currentRecord);
  if (
    current.version !== plannedRow.version ||
    classifyBusinessWaitReconciliation(current).action !== "REVALIDATE_APPLICATION" ||
    !current.stepId
  ) {
    return { action: "SKIPPED", journeyId: plannedRow.journeyId };
  }

  const legacyCodes = [...LEGACY_APPLICATION_BUSINESS_WAIT_CODES];
  const now = new Date();
  const resolved = await tx.subscriptionJourneyException.updateMany({
    data: {
      resolutionNotes: "Recovered by stage1 application-validation business-wait reconciliation.",
      resolvedAt: now,
      resolvedBy: null,
      status: "RESOLVED"
    },
    where: {
      code: { in: legacyCodes },
      journeyId: current.journeyId,
      status: "OPEN"
    }
  });
  if (resolved.count < 1) {
    throw new Error("STAGE1_JOURNEY_BUSINESS_WAIT_EXCEPTION_CONFLICT");
  }

  await tx.subscriptionJourneyStep.update({
    data: {
      completedAt: null,
      lastErrorCode: null,
      status: "PENDING",
      waitingAt: null,
      waitingReasonSnapshot: null
    },
    where: {
      journeyId_code: {
        code: "APPLICATION_VALIDATION",
        journeyId: current.journeyId
      }
    }
  });
  const journeyUpdate = await tx.subscriptionJourney.updateMany({
    data: {
      currentStepStatus: "PENDING",
      pausedFromStatus: null,
      status: "RUNNING",
      version: { increment: 1 }
    },
    where: { id: current.journeyId, version: current.version }
  });
  if (journeyUpdate.count !== 1) {
    throw new Error("STAGE1_JOURNEY_BUSINESS_WAIT_OPTIMISTIC_CONFLICT");
  }

  const classification = classifyBusinessWaitReconciliation(current);
  const eventKey =
    `journey:${current.journeyId}:reconcile:application-validation:` + `version:${current.version}`;
  const payload = {
    factVersion: current.currentFactVersion,
    journeyVersion: current.version + 1,
    oldErrorCodes: current.exceptionCodes,
    operation: "RECONCILE_APPLICATION_VALIDATION",
    proposedOutcome: classification.proposedOutcome,
    targetStepCode: "APPLICATION_VALIDATION"
  };
  await tx.subscriptionJourneyEvent.create({
    data: {
      actorType: "SYSTEM",
      eventKey,
      eventType: "EXCEPTION_RESOLVED",
      journeyId: current.journeyId,
      payload,
      sequence: current.version + 1
    }
  });
  await tx.subscriptionJourneyOutbox.create({
    data: {
      aggregateId: current.journeyId,
      aggregateType: "SUBSCRIPTION_JOURNEY",
      eventKey: `${eventKey}:outbox`,
      eventType: "EXCEPTION_RESOLVED",
      journeyId: current.journeyId,
      payload
    }
  });
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: {
        currentFactVersion: current.currentFactVersion,
        currentStepStatus: "PENDING",
        journeyId: current.journeyId,
        operation: "RECONCILE_APPLICATION_VALIDATION",
        proposedOutcome: classification.proposedOutcome,
        status: "RUNNING",
        version: current.version + 1
      },
      beforeSnapshot: {
        currentStepStatus: current.currentStepStatus,
        oldErrorCodes: current.exceptionCodes,
        status: current.journeyStatus,
        version: current.version
      },
      entityId: current.applicationId,
      entityType: "subscription_journey",
      module: "subscription_journey",
      operatorId: null,
      userAgent: "stage1-journey-business-wait-reconcile"
    }
  });
  return {
    action: "REVALIDATE_APPLICATION",
    journeyId: current.journeyId
  };
}

function journeyReconciliationInclude() {
  return {
    application: {
      select: {
        creditReviewStatus: true,
        depositStatus: true,
        finalDepositAmount: true,
        journeyFactVersion: true,
        materialReviewStatus: true,
        status: true
      }
    },
    exceptions: {
      select: { code: true, id: true, status: true },
      where: { status: "OPEN" }
    },
    steps: {
      select: { code: true, id: true, status: true },
      where: { code: "APPLICATION_VALIDATION" }
    }
  };
}

async function createPrismaClient() {
  const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
    import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
  ]);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("STAGE1_JOURNEY_BUSINESS_WAIT_DATABASE_URL_REQUIRED");
  }
  return new PrismaClient({ adapter: new PrismaPg(normalizeLocalhost(databaseUrl)) });
}

function normalizeLocalhost(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === entryUrl) {
  main()
    .catch(() => {
      process.stderr.write('{"error":"STAGE1_JOURNEY_BUSINESS_WAIT_RECONCILIATION_FAILED"}\n');
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma?.$disconnect();
    });
}
