import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyFinalPlanOrderReconciliation,
  summarizeFinalPlanOrderReconciliation
} from "./stage1-journey-final-plan-order-reconcile-core.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
let prisma;

async function main() {
  const mode = parseMode(process.argv.slice(2));
  prisma = await createPrismaClient();
  const rows = (await readAffectedJourneys(prisma)).map(toReconciliationRow);
  const report = summarizeFinalPlanOrderReconciliation(rows);
  const applied = [];
  if (mode === "apply") {
    for (const row of rows) {
      const classification = classifyFinalPlanOrderReconciliation(row);
      if (!["RETURN_TO_VEHICLE_ALLOCATION", "ADVANCE_WITHOUT_RECONFIRMATION"].includes(classification.action)) {
        continue;
      }
      applied.push(await applyCandidate(prisma, row, classification.action));
    }
  }
  process.stdout.write(`${JSON.stringify({ applied, mode, report }, null, 2)}\n`);
}

export function parseMode(args) {
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("Specify exactly one of --dry-run or --apply.");
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
  if (!databaseUrl) throw new Error("STAGE1_JOURNEY_PLAN_ORDER_DATABASE_URL_REQUIRED");
  return new PrismaClient({ adapter: new PrismaPg(normalizeLocalhost(databaseUrl)) });
}

function readAffectedJourneys(client) {
  return client.subscriptionJourney.findMany({
    include: {
      application: {
        select: {
          customerConfirmedPlanRevision: true,
          finalPlanCommercialHash: true,
          finalPlanRevision: true,
          finalVehicleId: true,
          softReservedVehicleId: true
        }
      },
      events: {
        orderBy: { sequence: "desc" },
        select: { payload: true },
        take: 50,
        where: { eventType: "DOMAIN_FACT_OBSERVED" }
      },
      steps: { select: { code: true, status: true } }
    },
    orderBy: { id: "asc" },
    where: {
      currentStepCode: { in: ["CUSTOMER_PLAN_CONFIRMATION", "FINAL_VEHICLE_ALLOCATION"] },
      status: { notIn: ["CANCELLED", "COMPLETED"] }
    }
  });
}

function toReconciliationRow(journey) {
  return {
    applicationId: journey.applicationId,
    currentStepCode: journey.currentStepCode,
    currentStepStatus: journey.currentStepStatus,
    customerConfirmationCommercialHash: findCustomerConfirmationHash(journey.events),
    customerConfirmedPlanRevision: journey.application.customerConfirmedPlanRevision,
    finalPlanCommercialHash: journey.application.finalPlanCommercialHash,
    finalPlanRevision: journey.application.finalPlanRevision,
    finalVehicleId: journey.application.finalVehicleId,
    journeyId: journey.id,
    journeyStatus: journey.status,
    softReservedVehicleId: journey.application.softReservedVehicleId,
    steps: Object.fromEntries(journey.steps.map((step) => [step.code, step.status])),
    version: journey.version
  };
}

function findCustomerConfirmationHash(events) {
  for (const event of events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.signalType !== "CUSTOMER_PLAN_CONFIRMED") continue;
    const hash = payload.commercialHash ?? payload.finalPlanCommercialHash;
    if (typeof hash === "string") return hash;
  }
  return null;
}

async function applyCandidate(client, plannedRow, plannedAction) {
  return client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "subscription_journey" WHERE "id" = $1 FOR UPDATE',
      plannedRow.journeyId
    );
    const currentRecord = await readOneJourney(tx, plannedRow.journeyId);
    if (!currentRecord) return { action: "SKIPPED", journeyId: plannedRow.journeyId };
    const current = toReconciliationRow(currentRecord);
    const classification = classifyFinalPlanOrderReconciliation(current);
    if (classification.action !== plannedAction || current.version !== plannedRow.version) {
      return { action: "SKIPPED", journeyId: plannedRow.journeyId };
    }
    if (plannedAction === "RETURN_TO_VEHICLE_ALLOCATION") {
      await returnToVehicleAllocation(tx, current);
    } else {
      await advanceWithoutReconfirmation(tx, current);
    }
    return { action: plannedAction, journeyId: plannedRow.journeyId };
  }, { isolationLevel: "Serializable" });
}

function readOneJourney(tx, journeyId) {
  return tx.subscriptionJourney.findUnique({
    include: {
      application: {
        select: {
          customerConfirmedPlanRevision: true,
          finalPlanCommercialHash: true,
          finalPlanRevision: true,
          finalVehicleId: true,
          softReservedVehicleId: true
        }
      },
      events: {
        orderBy: { sequence: "desc" },
        select: { payload: true },
        take: 50,
        where: { eventType: "DOMAIN_FACT_OBSERVED" }
      },
      steps: { select: { code: true, id: true, status: true } }
    },
    where: { id: journeyId }
  });
}

async function returnToVehicleAllocation(tx, row) {
  const eventKey = `journey:${row.journeyId}:reconcile:final-plan-order:version:${row.version}`;
  const vehicleStep = await tx.subscriptionJourneyStep.update({
    data: { completedAt: null, status: "WAITING_MANUAL", waitingAt: new Date() },
    where: { journeyId_code: { code: "FINAL_VEHICLE_ALLOCATION", journeyId: row.journeyId } }
  });
  await tx.subscriptionJourneyStep.update({
    data: { completedAt: null, status: "PENDING", waitingAt: null },
    where: { journeyId_code: { code: "CUSTOMER_PLAN_CONFIRMATION", journeyId: row.journeyId } }
  });
  const existingTask = await tx.subscriptionJourneyManualTask.findFirst({
    where: { journeyId: row.journeyId, status: "OPEN", taskType: "FINAL_VEHICLE_ALLOCATION" }
  });
  if (!existingTask) {
    await tx.subscriptionJourneyManualTask.create({
      data: {
        inputSnapshot: {
          applicationId: row.applicationId,
          finalPlanCommercialHash: row.finalPlanCommercialHash,
          finalPlanRevision: row.finalPlanRevision,
          reconciliation: true
        },
        journeyId: row.journeyId,
        stepId: vehicleStep.id,
        taskType: "FINAL_VEHICLE_ALLOCATION"
      }
    });
  }
  await persistTransition(tx, row, eventKey, "STEP_WAITING_MANUAL", {
    currentStepCode: "FINAL_VEHICLE_ALLOCATION",
    currentStepStatus: "WAITING_MANUAL",
    status: "WAITING_MANUAL"
  });
}

async function advanceWithoutReconfirmation(tx, row) {
  const eventKey = `journey:${row.journeyId}:reconcile:final-plan-order:version:${row.version}`;
  await tx.subscriptionJourneyStep.update({
    data: { completedAt: new Date(), status: "COMPLETED" },
    where: { journeyId_code: { code: "FINAL_VEHICLE_ALLOCATION", journeyId: row.journeyId } }
  });
  await tx.subscriptionJourneyStep.upsert({
    create: { code: "ORDER_AND_CONTRACT_CREATION", journeyId: row.journeyId },
    update: {},
    where: { journeyId_code: { code: "ORDER_AND_CONTRACT_CREATION", journeyId: row.journeyId } }
  });
  await tx.subscriptionJourneyManualTask.updateMany({
    data: { status: "CANCELLED" },
    where: { journeyId: row.journeyId, status: "OPEN", taskType: "FINAL_VEHICLE_ALLOCATION" }
  });
  await persistTransition(tx, row, eventKey, "STEP_COMPLETED", {
    currentStepCode: "ORDER_AND_CONTRACT_CREATION",
    currentStepStatus: "PENDING",
    status: "RUNNING"
  });
}

async function persistTransition(tx, row, eventKey, eventType, state) {
  const updated = await tx.subscriptionJourney.updateMany({
    data: { ...state, version: { increment: 1 } },
    where: { id: row.journeyId, version: row.version }
  });
  if (updated.count !== 1) throw new Error("STAGE1_JOURNEY_PLAN_ORDER_OPTIMISTIC_CONFLICT");
  const payload = {
    operation: "RECONCILE_FINAL_PLAN_ORDER",
    previousStepCode: row.currentStepCode,
    targetStepCode: state.currentStepCode
  };
  await tx.subscriptionJourneyEvent.create({
    data: { eventKey, eventType, journeyId: row.journeyId, payload, sequence: row.version + 1 }
  });
  await tx.subscriptionJourneyOutbox.create({
    data: {
      aggregateId: row.journeyId,
      aggregateType: "SUBSCRIPTION_JOURNEY",
      eventKey: `${eventKey}:outbox`,
      eventType,
      journeyId: row.journeyId,
      payload
    }
  });
}

function normalizeLocalhost(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main()
  .catch(() => {
    process.stderr.write('{"error":"STAGE1_JOURNEY_PLAN_ORDER_RECONCILIATION_FAILED"}\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
