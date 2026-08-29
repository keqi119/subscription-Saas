import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export type CompiledContractChargeClause = Readonly<{
  chargeType: string;
  clauseCode: string;
  clauseVersion: number;
  compilationHash: string;
  evidenceRequirementSnapshot: Readonly<Record<string, unknown>>;
  exemptionSnapshot: Readonly<Record<string, unknown>>;
  pricingSnapshot: Readonly<Record<string, unknown>>;
  sourceTextHash: string;
  sourceTextLocator: string;
  status: "EXECUTABLE" | "MANUAL_CLAUSE_REVIEW_REQUIRED";
  unit: string;
}>;

export function compileContractChargeClauses(snapshot: unknown): CompiledContractChargeClause[] {
  const root = record(snapshot);
  const order = record(root.order);
  const quote = record(root.quoteSnapshot);
  const mileageLimitKm = exactNonnegativeInteger(
    firstDefined(order.mileageLimitKm, quote.mileageLimitKm)
  );
  const unitPriceCents = exactNonnegativeInteger(
    firstDefined(order.overMileageFeeAmount, quote.overMileageFeeAmount)
  );
  const periodMonths = exactPositiveInteger(
    firstDefined(order.periodMonths, quote.periodMonths)
  );
  const contentTemplate = typeof root.contentTemplate === "string" ? root.contentTemplate : "";
  const clauses: CompiledContractChargeClause[] = [];
  if (mileageLimitKm !== null && unitPriceCents !== null && unitPriceCents > 0) {
    clauses.push(
      finalize({
        chargeType: "OVER_MILEAGE",
        clauseCode: "OVER_MILEAGE",
        clauseVersion: 1,
        evidenceRequirementSnapshot: { required: ["DELIVERY_MILEAGE", "RETURN_MILEAGE"] },
        exemptionSnapshot: { normalWearApplies: false },
        pricingSnapshot: {
          includedQuantity: mileageLimitKm * (periodMonths ?? 1),
          monthlyIncludedQuantity: mileageLimitKm,
          periodMonths: periodMonths ?? 1,
          unitPriceCents
        },
        sourceTextHash: sha256(contentTemplate),
        sourceTextLocator: "contractSnapshot.order.overMileageFeeAmount",
        status: "EXECUTABLE",
        unit: "KILOMETER"
      })
    );
  } else {
    clauses.push(manualClause("OVER_MILEAGE", contentTemplate));
  }
  for (const itemCode of [
    "ACCESSORIES",
    "BATTERY",
    "CHARGING_EQUIPMENT",
    "KEY",
    "REGISTRATION_CERTIFICATE",
    "VEHICLE_EXTERIOR",
    "VEHICLE_INTERIOR"
  ]) {
    clauses.push(manualClause(`MISSING_${itemCode}`, contentTemplate));
    clauses.push(manualClause(`DAMAGE_${itemCode}`, contentTemplate));
  }
  return clauses;
}

function manualClause(chargeType: string, contentTemplate: string) {
  return finalize({
    chargeType,
    clauseCode: chargeType,
    clauseVersion: 1,
    evidenceRequirementSnapshot: { required: ["RETURN_ITEM_EVIDENCE"] },
    exemptionSnapshot: { manualReviewRequired: true },
    pricingSnapshot: {},
    sourceTextHash: sha256(contentTemplate),
    sourceTextLocator: "contractSnapshot",
    status: "MANUAL_CLAUSE_REVIEW_REQUIRED",
    unit: "ITEM"
  });
}

export async function persistContractChargeClausesInTransaction(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    actorId: string | null;
    contractId: string;
    contractSnapshot: unknown;
  }>
) {
  const clauses = compileContractChargeClauses(input.contractSnapshot);
  await tx.contractChargeClauseSnapshot.createMany({
    data: clauses.map((clause) => ({
      chargeType: clause.chargeType,
      clauseCode: clause.clauseCode,
      clauseVersion: clause.clauseVersion,
      compilationHash: clause.compilationHash,
      contractId: input.contractId,
      createdBy: input.actorId,
      evidenceRequirementSnapshot: clause.evidenceRequirementSnapshot as Prisma.InputJsonValue,
      exemptionSnapshot: clause.exemptionSnapshot as Prisma.InputJsonValue,
      pricingSnapshot: clause.pricingSnapshot as Prisma.InputJsonValue,
      sourceTextHash: clause.sourceTextHash,
      sourceTextLocator: clause.sourceTextLocator,
      status: clause.status,
      unit: clause.unit
    })),
    skipDuplicates: true
  });
  return clauses;
}

function finalize(
  clause: Omit<CompiledContractChargeClause, "compilationHash">
): CompiledContractChargeClause {
  return Object.freeze({ ...clause, compilationHash: sha256(canonical(clause)) });
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== null && value !== undefined);
}

function exactNonnegativeInteger(value: unknown) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactPositiveInteger(value: unknown) {
  const parsed = exactNonnegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const source = record(value);
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
    .join(",")}}`;
}
