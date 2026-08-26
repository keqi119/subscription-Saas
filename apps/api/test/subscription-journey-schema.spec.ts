import * as PrismaClient from "@prisma/client";
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Cardinality = "list" | "optional" | "required";
type FieldContract = {
  cardinality: Cardinality;
  defaultValue?: string;
  name: string;
  relation?: string;
  type: string;
};

const schemaSource = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
const f = (
  name: string,
  type: string,
  cardinality: Cardinality = "required",
  defaultValue?: string,
  relation?: string
): FieldContract => ({
  cardinality,
  ...(defaultValue === undefined ? {} : { defaultValue }),
  name,
  ...(relation === undefined ? {} : { relation }),
  type
});

const JOURNEY_FIELDS: Record<string, FieldContract[]> = {
  SubscriptionJourney: [
    f("id", "String", "required", "cuid()"),
    f("applicationId", "String"),
    f("application", "Application", "required", undefined, "applicationId->id"),
    f("orderId", "String", "optional"),
    f("order", "SubscriptionOrder", "optional", undefined, "orderId->id"),
    f("status", "SubscriptionJourneyStatus", "required", "RUNNING"),
    f("currentStepCode", "SubscriptionJourneyStepCode"),
    f("currentStepStatus", "SubscriptionJourneyStepStatus", "required", "PENDING"),
    f("pausedFromStatus", "SubscriptionJourneyStatus", "optional"),
    f("lastApplicationFactVersion", "Int", "required", "0"),
    f("version", "Int", "required", "0"),
    f("startedAt", "DateTime", "required", "now()"),
    f("completedAt", "DateTime", "optional"),
    f("cancelledAt", "DateTime", "optional"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime"),
    f("steps", "SubscriptionJourneyStep", "list", undefined, "implicit"),
    f("jobs", "SubscriptionJourneyJob", "list", undefined, "implicit"),
    f("manualTasks", "SubscriptionJourneyManualTask", "list", undefined, "implicit"),
    f("events", "SubscriptionJourneyEvent", "list", undefined, "implicit"),
    f("exceptions", "SubscriptionJourneyException", "list", undefined, "implicit"),
    f("outboxRows", "SubscriptionJourneyOutbox", "list", undefined, "implicit")
  ],
  SubscriptionJourneyStep: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String"),
    f("journey", "SubscriptionJourney", "required", undefined, "journeyId->id"),
    f("code", "SubscriptionJourneyStepCode"),
    f("status", "SubscriptionJourneyStepStatus", "required", "PENDING"),
    f("attemptCount", "Int", "required", "0"),
    f("startedAt", "DateTime", "optional"),
    f("waitingAt", "DateTime", "optional"),
    f("waitingReasonSnapshot", "Json", "optional"),
    f("completedAt", "DateTime", "optional"),
    f("lastErrorCode", "String", "optional"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime"),
    f("jobs", "SubscriptionJourneyJob", "list", undefined, "implicit"),
    f("manualTasks", "SubscriptionJourneyManualTask", "list", undefined, "implicit"),
    f("exceptions", "SubscriptionJourneyException", "list", undefined, "implicit")
  ],
  SubscriptionJourneyJob: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String"),
    f("journey", "SubscriptionJourney", "required", undefined, "journeyId->id"),
    f("stepId", "String"),
    f("step", "SubscriptionJourneyStep", "required", undefined, "stepId,journeyId->id,journeyId"),
    f("jobType", "SubscriptionJourneyJobType"),
    f("status", "SubscriptionJourneyJobStatus", "required", "PENDING"),
    f("sourceKey", "String"),
    f("payload", "Json", "optional"),
    f("attemptCount", "Int", "required", "0"),
    f("maxAttempts", "Int", "required", "5"),
    f("availableAt", "DateTime", "required", "now()"),
    f("leaseToken", "String", "optional"),
    f("leaseExpiresAt", "DateTime", "optional"),
    f("lastErrorCode", "String", "optional"),
    f("lastErrorMessage", "String", "optional"),
    f("completedAt", "DateTime", "optional"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime"),
    f("exceptions", "SubscriptionJourneyException", "list", undefined, "implicit")
  ],
  SubscriptionJourneyManualTask: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String"),
    f("journey", "SubscriptionJourney", "required", undefined, "journeyId->id"),
    f("stepId", "String"),
    f("step", "SubscriptionJourneyStep", "required", undefined, "stepId,journeyId->id,journeyId"),
    f("taskType", "SubscriptionJourneyManualTaskType"),
    f("status", "SubscriptionJourneyManualTaskStatus", "required", "OPEN"),
    f("decision", "SubscriptionJourneyManualDecision", "optional"),
    f("inputSnapshot", "Json"),
    f("decidedBy", "String", "optional"),
    f("decisionNotes", "String", "optional"),
    f("decidedAt", "DateTime", "optional"),
    f("version", "Int", "required", "0"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime")
  ],
  SubscriptionJourneyEvent: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String"),
    f("journey", "SubscriptionJourney", "required", undefined, "journeyId->id"),
    f("sequence", "Int"),
    f("eventKey", "String"),
    f("eventType", "SubscriptionJourneyEventType"),
    f("actorType", "String", "optional"),
    f("actorId", "String", "optional"),
    f("payload", "Json"),
    f("createdAt", "DateTime", "required", "now()")
  ],
  SubscriptionJourneyException: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String"),
    f("journey", "SubscriptionJourney", "required", undefined, "journeyId->id"),
    f("stepId", "String"),
    f("step", "SubscriptionJourneyStep", "required", undefined, "stepId,journeyId->id,journeyId"),
    f("jobId", "String", "optional"),
    f(
      "job",
      "SubscriptionJourneyJob",
      "optional",
      undefined,
      "jobId,stepId,journeyId->id,stepId,journeyId"
    ),
    f("status", "SubscriptionJourneyExceptionStatus", "required", "OPEN"),
    f("code", "String"),
    f("message", "String"),
    f("retryable", "Boolean", "required", "false"),
    f("occurrenceCount", "Int", "required", "1"),
    f("firstOccurredAt", "DateTime", "required", "now()"),
    f("lastOccurredAt", "DateTime", "required", "now()"),
    f("acknowledgedBy", "String", "optional"),
    f("acknowledgedAt", "DateTime", "optional"),
    f("resolvedBy", "String", "optional"),
    f("resolvedAt", "DateTime", "optional"),
    f("resolutionNotes", "String", "optional"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime")
  ],
  SubscriptionJourneyOutbox: [
    f("id", "String", "required", "cuid()"),
    f("journeyId", "String", "optional"),
    f("journey", "SubscriptionJourney", "optional", undefined, "journeyId->id"),
    f("aggregateType", "String"),
    f("aggregateId", "String"),
    f("eventType", "String"),
    f("eventKey", "String"),
    f("payload", "Json"),
    f("status", "SubscriptionJourneyOutboxStatus", "required", "PENDING"),
    f("attemptCount", "Int", "required", "0"),
    f("availableAt", "DateTime", "required", "now()"),
    f("leaseToken", "String", "optional"),
    f("leaseExpiresAt", "DateTime", "optional"),
    f("lastErrorCode", "String", "optional"),
    f("lastErrorMessage", "String", "optional"),
    f("deliveredAt", "DateTime", "optional"),
    f("createdAt", "DateTime", "required", "now()"),
    f("updatedAt", "DateTime")
  ]
};

const JOURNEY_ENUMS: Record<string, string[]> = {
  SubscriptionJourneyStatus: [
    "RUNNING",
    "WAITING_CUSTOMER",
    "WAITING_MANUAL",
    "RETRY_SCHEDULED",
    "PAUSED",
    "EXCEPTION",
    "COMPLETED",
    "CANCELLED"
  ],
  SubscriptionJourneyStepCode: [
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
  ],
  SubscriptionJourneyStepStatus: [
    "PENDING",
    "RUNNING",
    "WAITING_CUSTOMER",
    "WAITING_MANUAL",
    "RETRY_SCHEDULED",
    "EXCEPTION",
    "COMPLETED",
    "SKIPPED",
    "CANCELLED"
  ],
  SubscriptionJourneyManualTaskType: [
    "FINAL_PLAN_DECISION",
    "FINAL_VEHICLE_ALLOCATION",
    "DELIVERY_EVIDENCE_DECISION"
  ],
  SubscriptionJourneyManualTaskStatus: ["OPEN", "COMPLETED", "CANCELLED"],
  SubscriptionJourneyManualDecision: ["APPROVED", "REJECTED"],
  SubscriptionJourneyJobType: [
    "VALIDATE_APPLICATION",
    "CREATE_ORDER_AND_CONTRACT",
    "START_FADADA_SIGNING",
    "RECONCILE_FADADA_SIGNING",
    "GENERATE_INITIAL_BILLS",
    "EVALUATE_PAYMENT_SETTLEMENT",
    "CREATE_HANDOVER",
    "ACTIVATE_SUBSCRIPTION",
    "DISPATCH_NOTIFICATION"
  ],
  SubscriptionJourneyJobStatus: [
    "PENDING",
    "PROCESSING",
    "RETRY_SCHEDULED",
    "COMPLETED",
    "DEAD_LETTER",
    "CANCELLED"
  ],
  SubscriptionJourneyEventType: [
    "JOURNEY_STARTED",
    "STEP_STARTED",
    "STEP_WAITING_CUSTOMER",
    "STEP_WAITING_MANUAL",
    "STEP_COMPLETED",
    "STEP_RETRY_SCHEDULED",
    "STEP_EXCEPTION",
    "MANUAL_TASK_DECIDED",
    "DOMAIN_FACT_OBSERVED",
    "JOURNEY_PAUSED",
    "JOURNEY_RESUMED",
    "JOURNEY_CANCELLED",
    "JOURNEY_COMPLETED",
    "EXCEPTION_RESOLVED"
  ],
  SubscriptionJourneyExceptionStatus: ["OPEN", "ACKNOWLEDGED", "RESOLVED"],
  SubscriptionJourneyOutboxStatus: [
    "PENDING",
    "PROCESSING",
    "DELIVERED",
    "DEAD_LETTER",
    "CANCELLED"
  ]
};

describe("subscription journey persistence contract", () => {
  it("publishes every approved journey enum exactly", () => {
    for (const [name, values] of Object.entries(JOURNEY_ENUMS)) {
      expect(enumValues(name), name).toEqual(values);
    }
  });

  it("publishes every journey field with its exact type, cardinality, default, and relation", () => {
    for (const [modelName, contracts] of Object.entries(JOURNEY_FIELDS)) {
      expect(modelFields(modelName).map((field) => field.name), `${modelName} fields`).toEqual(
        contracts.map((contract) => contract.name)
      );

      for (const contract of contracts) {
        expect(schemaField(modelName, contract.name), `${modelName}.${contract.name}`).toEqual(
          contract
        );
      }
    }
  });

  it("stores exact-plan revisions and one-to-one journey relations on existing models", () => {
    expect(schemaField("Application", "finalPlanRevision")).toMatchObject(
      f("finalPlanRevision", "Int", "required", "0")
    );
    expect(schemaField("Application", "customerConfirmedPlanRevision")).toMatchObject(
      f("customerConfirmedPlanRevision", "Int", "optional")
    );
    expect(schemaField("Application", "journeyFactVersion")).toMatchObject(
      f("journeyFactVersion", "Int", "required", "0")
    );
    expect(schemaField("Application", "finalPlanCommercialHash")).toMatchObject(
      f("finalPlanCommercialHash", "String", "optional")
    );
    expect(schemaAttributes("Application", "finalPlanCommercialHash")).toContain(
      "@db.VarChar(71)"
    );
    expect(schemaField("Application", "subscriptionJourney")).toMatchObject(
      f("subscriptionJourney", "SubscriptionJourney", "optional", undefined, "implicit")
    );
    expect(schemaField("SubscriptionOrder", "subscriptionJourney")).toMatchObject(
      f("subscriptionJourney", "SubscriptionJourney", "optional", undefined, "implicit")
    );
  });

  it("uses CUID ids and required creation/update timestamp semantics", () => {
    for (const [modelName, contracts] of Object.entries(JOURNEY_FIELDS)) {
      expect(schemaAttributes(modelName, "id")).toContain("@id");
      expect(schemaField(modelName, "id").defaultValue).toBe("cuid()");
      expect(schemaField(modelName, "createdAt")).toMatchObject({
        cardinality: "required",
        defaultValue: "now()",
        type: "DateTime"
      });
      expect(schemaAttributes(modelName, "createdAt")).toContain("@db.Timestamptz(6)");

      if (contracts.some((contract) => contract.name === "updatedAt")) {
        expect(schemaAttributes(modelName, "updatedAt")).toContain("@updatedAt");
        expect(schemaAttributes(modelName, "updatedAt")).toContain("@db.Timestamptz(6)");
      }
    }
  });

  it("declares composite journey identity relations in the Prisma schema", () => {
    expect(modelSource("SubscriptionJourneyStep")).toContain(
      '@@unique([id, journeyId], map: "subscription_journey_step_id_journey_id_key")'
    );
    expect(modelSource("SubscriptionJourneyJob")).toContain(
      '@@unique([id, stepId, journeyId], map: "subscription_journey_job_identity_key")'
    );
    expect(schemaField("SubscriptionJourneyJob", "step").relation).toBe(
      "stepId,journeyId->id,journeyId"
    );
    expect(schemaField("SubscriptionJourneyManualTask", "step").relation).toBe(
      "stepId,journeyId->id,journeyId"
    );
    expect(schemaField("SubscriptionJourneyException", "step").relation).toBe(
      "stepId,journeyId->id,journeyId"
    );
    expect(schemaField("SubscriptionJourneyException", "job").relation).toBe(
      "jobId,stepId,journeyId->id,stepId,journeyId"
    );
  });

  it("ships the stage1 business-wait migration with bounded versions and hash checks", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260826010000_stage1_journey_business_wait/migration.sql"
      ),
      "utf8"
    );

    expect(migration).toContain("application_journey_fact_version_nonnegative");
    expect(migration).toContain("application_final_plan_commercial_hash_format");
    expect(migration).toContain("subscription_journey_last_application_fact_version_nonnegative");
    expect(migration).toContain("jsonb_typeof(\"final_plan_snapshot\") = 'object'");
  });
});

function enumValues(name: string) {
  const value = (PrismaClient as Record<string, unknown>)[name];
  expect(value, `Prisma enum ${name} is missing`).toBeDefined();
  return Object.values(value as Record<string, string>);
}

function modelFields(modelName: string) {
  const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
  expect(model, `Prisma model ${modelName} is missing`).toBeDefined();
  return model?.fields ?? [];
}

function modelSource(modelName: string) {
  const source = schemaSource.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )?.[1];
  expect(source, `Prisma model ${modelName} is missing from schema`).toBeDefined();
  return source ?? "";
}

function schemaAttributes(modelName: string, fieldName: string) {
  const line = modelSource(modelName).match(
    new RegExp(`^\\s*${fieldName}\\s+[^\\s]+(.*)$`, "m")
  )?.[1];
  expect(line, `Prisma field ${modelName}.${fieldName} is missing from schema`).toBeDefined();
  return line?.trim() ?? "";
}

function schemaField(modelName: string, fieldName: string): FieldContract {
  const dmmfField = modelFields(modelName).find((candidate) => candidate.name === fieldName);
  expect(dmmfField, `Prisma field ${modelName}.${fieldName} is missing`).toBeDefined();
  const typeToken = modelSource(modelName).match(
    new RegExp(`^\\s*${fieldName}\\s+([^\\s]+)`, "m")
  )?.[1];
  expect(typeToken, `Prisma schema field ${modelName}.${fieldName} is missing`).toBeDefined();
  const cardinality: Cardinality = typeToken?.endsWith("[]")
    ? "list"
    : typeToken?.endsWith("?")
      ? "optional"
      : "required";
  const relation = relationContract(dmmfField?.kind, schemaAttributes(modelName, fieldName));
  const defaultValue = attributeArgument(schemaAttributes(modelName, fieldName), "@default");

  return {
    cardinality,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    name: fieldName,
    ...(relation === undefined ? {} : { relation }),
    type: dmmfField?.type ?? typeToken?.replace(/\[\]|\?$/g, "") ?? ""
  };
}

function relationContract(kind: string | undefined, attributes: string) {
  if (kind !== "object") return undefined;
  const fields = attributeList(attributes, "fields");
  const references = attributeList(attributes, "references");
  if (fields.length === 0 && references.length === 0) return "implicit";
  return `${fields.join(",")}->${references.join(",")}`;
}

function attributeList(attributes: string, attribute: string) {
  const value = attributes.match(new RegExp(`${attribute}:\\s*\\[([^\\]]*)\\]`))?.[1];
  return value?.split(",").map((item) => item.trim()) ?? [];
}

function attributeArgument(attributes: string, attribute: string) {
  const start = attributes.indexOf(`${attribute}(`);
  if (start < 0) return undefined;
  let depth = 0;
  const valueStart = start + attribute.length + 1;
  for (let index = valueStart; index < attributes.length; index += 1) {
    if (attributes[index] === "(") depth += 1;
    if (attributes[index] === ")") {
      if (depth === 0) return attributes.slice(valueStart, index);
      depth -= 1;
    }
  }
  throw new Error(`Unclosed ${attribute} attribute: ${attributes}`);
}
