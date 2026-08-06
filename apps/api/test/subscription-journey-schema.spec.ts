import * as PrismaClient from "@prisma/client";
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const JOURNEY_MODELS = [
  "SubscriptionJourney",
  "SubscriptionJourneyStep",
  "SubscriptionJourneyJob",
  "SubscriptionJourneyManualTask",
  "SubscriptionJourneyEvent",
  "SubscriptionJourneyException",
  "SubscriptionJourneyOutbox"
];
const schemaSource = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

describe("subscription journey persistence contract", () => {
  it("publishes the seven persistent journey models", () => {
    const modelNames = Prisma.dmmf.datamodel.models.map((candidate) => candidate.name);

    expect(modelNames).toEqual(expect.arrayContaining(JOURNEY_MODELS));
  });

  it("publishes the approved journey enum values without abbreviations", () => {
    expect(enumValues("SubscriptionJourneyStatus")).toEqual([
      "RUNNING",
      "WAITING_CUSTOMER",
      "WAITING_MANUAL",
      "RETRY_SCHEDULED",
      "PAUSED",
      "EXCEPTION",
      "COMPLETED",
      "CANCELLED"
    ]);
    expect(enumValues("SubscriptionJourneyStepCode")).toEqual([
      "APPLICATION_VALIDATION",
      "FINAL_PLAN_DECISION",
      "CUSTOMER_PLAN_CONFIRMATION",
      "FINAL_VEHICLE_ALLOCATION",
      "ORDER_AND_CONTRACT_CREATION",
      "FADADA_SIGNING_AND_ARCHIVE",
      "INITIAL_BILLING",
      "CUSTOMER_JSAPI_PAYMENT",
      "HANDOVER_AND_STAGE2_CREATION",
      "DELIVERY_EVIDENCE_DECISION",
      "AUTHORITATIVE_ACTIVATION"
    ]);
    expect(enumValues("SubscriptionJourneyManualTaskType")).toEqual([
      "FINAL_PLAN_DECISION",
      "FINAL_VEHICLE_ALLOCATION",
      "DELIVERY_EVIDENCE_DECISION"
    ]);
  });

  it("stores exact-plan revisions on the application", () => {
    expect(field("Application", "finalPlanRevision")).toMatchObject({
      isRequired: true,
      type: "Int"
    });
    expect(field("Application", "customerConfirmedPlanRevision")).toMatchObject({
      isRequired: false,
      type: "Int"
    });
  });

  it("links the journey to one application, an optional order, and its durable children", () => {
    expect(field("Application", "subscriptionJourney")).toMatchObject({
      isList: false,
      isRequired: false,
      type: "SubscriptionJourney"
    });
    expect(field("SubscriptionOrder", "subscriptionJourney")).toMatchObject({
      isList: false,
      isRequired: false,
      type: "SubscriptionJourney"
    });

    const expectedFields: Record<string, string[]> = {
      SubscriptionJourney: [
        "applicationId",
        "orderId",
        "status",
        "currentStepCode",
        "currentStepStatus",
        "pausedFromStatus",
        "version",
        "startedAt",
        "completedAt",
        "cancelledAt",
        "steps",
        "jobs",
        "manualTasks",
        "events",
        "exceptions",
        "outboxRows"
      ],
      SubscriptionJourneyStep: [
        "journeyId",
        "code",
        "status",
        "attemptCount",
        "startedAt",
        "waitingAt",
        "completedAt",
        "lastErrorCode"
      ],
      SubscriptionJourneyJob: [
        "journeyId",
        "stepId",
        "jobType",
        "status",
        "sourceKey",
        "payload",
        "attemptCount",
        "maxAttempts",
        "availableAt",
        "leaseToken",
        "leaseExpiresAt",
        "lastErrorCode",
        "lastErrorMessage",
        "completedAt"
      ],
      SubscriptionJourneyManualTask: [
        "journeyId",
        "stepId",
        "taskType",
        "status",
        "decision",
        "inputSnapshot",
        "decidedBy",
        "decisionNotes",
        "decidedAt",
        "version"
      ],
      SubscriptionJourneyEvent: [
        "journeyId",
        "sequence",
        "eventKey",
        "eventType",
        "actorType",
        "actorId",
        "payload",
        "createdAt"
      ],
      SubscriptionJourneyException: [
        "journeyId",
        "stepId",
        "jobId",
        "status",
        "code",
        "message",
        "retryable",
        "occurrenceCount",
        "firstOccurredAt",
        "lastOccurredAt",
        "acknowledgedBy",
        "acknowledgedAt",
        "resolvedBy",
        "resolvedAt",
        "resolutionNotes"
      ],
      SubscriptionJourneyOutbox: [
        "journeyId",
        "aggregateType",
        "aggregateId",
        "eventType",
        "eventKey",
        "payload",
        "status",
        "attemptCount",
        "availableAt",
        "leaseToken",
        "leaseExpiresAt",
        "lastErrorCode",
        "lastErrorMessage",
        "deliveredAt"
      ]
    };

    for (const [modelName, fieldNames] of Object.entries(expectedFields)) {
      for (const fieldName of fieldNames) {
        expect(field(modelName, fieldName)).toBeDefined();
      }
    }
  });

  it("enforces idempotency, open-task, and worker lease database contracts", () => {
    const sql = migrationSql();

    for (const indexName of [
      "subscription_journey_application_id_key",
      "subscription_journey_order_id_key",
      "subscription_journey_step_code_key",
      "subscription_journey_open_manual_task_key",
      "subscription_journey_event_event_key_key",
      "subscription_journey_outbox_event_key_key",
      "subscription_journey_job_claim_idx",
      "subscription_journey_outbox_claim_idx"
    ]) {
      expect(sql).toContain(`"${indexName}"`);
    }
    expect(sql).toContain('WHERE "order_id" IS NOT NULL');
    expect(sql).toContain('WHERE "status" = \'OPEN\'');
  });
});

function field(modelName: string, fieldName: string) {
  const source = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
  expect(source, `Prisma model ${modelName} is missing`).toBeDefined();
  const value = source?.fields.find((candidate) => candidate.name === fieldName);
  expect(value, `Prisma field ${modelName}.${fieldName} is missing`).toBeDefined();
  const modelSource = schemaSource.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )?.[1];
  const typeToken = modelSource?.match(
    new RegExp(`^\\s*${fieldName}\\s+([^\\s]+)`, "m")
  )?.[1];

  expect(typeToken, `Prisma schema field ${modelName}.${fieldName} is missing`).toBeDefined();
  return {
    ...value!,
    isList: typeToken?.endsWith("[]") ?? false,
    isRequired: !typeToken?.endsWith("?")
  };
}

function enumValues(name: string) {
  const value = (PrismaClient as Record<string, unknown>)[name];
  expect(value, `Prisma enum ${name} is missing`).toBeDefined();
  return Object.values(value as Record<string, string>);
}

function migrationSql() {
  return readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260806120000_stage1_subscription_journey/migration.sql"
    ),
    "utf8"
  );
}
