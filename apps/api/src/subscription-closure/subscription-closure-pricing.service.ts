import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

export type PricingClause = Readonly<{
  clauseCode: string;
  pricingSnapshot: Readonly<Record<string, unknown>>;
  status: "EXECUTABLE" | "MANUAL_CLAUSE_REVIEW_REQUIRED";
}>;

export type PriceClosureChargeInput = Readonly<{
  chargeType: string;
  clause: PricingClause | null;
  evidenceIds: readonly string[];
  manualBasis?: string | null;
  priorBilledAmountCents?: bigint;
  priorBillIds?: readonly string[];
  quantity: number;
}>;

export type GovernedChargeDeltaFact = Readonly<{
  itemCode: string;
  quantityDifference: number;
  responsibility: string;
  wearClassification: string;
}>;

@Injectable()
export class SubscriptionClosurePricingService {
  price(input: PriceClosureChargeInput) {
    return priceClosureCharge(input);
  }
}

export function priceClosureCharge(input: PriceClosureChargeInput) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
    throw new Error("INVALID_CHARGE_QUANTITY");
  }
  if (!input.clause || input.clause.status !== "EXECUTABLE") {
    return result(
      input,
      "PRICING_EXCEPTION",
      0,
      0n,
      0n,
      "MATCHING_CONTRACT_CLAUSE_REQUIRED"
    );
  }
  if (input.evidenceIds.length === 0) throw new Error("GOVERNED_EVIDENCE_REQUIRED");
  const unitPriceCents = cents(input.clause.pricingSnapshot.unitPriceCents);
  const capCents = optionalCents(input.clause.pricingSnapshot.capCents);
  const includedQuantity = optionalQuantity(input.clause.pricingSnapshot.includedQuantity) ?? 0;
  const chargeableQuantity = Math.max(0, input.quantity - includedQuantity);
  const gross = unitPriceCents * BigInt(chargeableQuantity);
  const priorBilledAmountCents = input.priorBilledAmountCents ?? 0n;
  if (priorBilledAmountCents < 0n) throw new Error("INVALID_PRIOR_BILLED_AMOUNT");
  const trueUpGross = gross > priorBilledAmountCents ? gross - priorBilledAmountCents : 0n;
  const amountCents =
    capCents === null ? trueUpGross : trueUpGross > capCents ? capCents : trueUpGross;
  return result(input, "FINAL", chargeableQuantity, unitPriceCents, amountCents, null);
}

export function governedChargeFactsForDeltaItem(item: GovernedChargeDeltaFact) {
  if (item.responsibility !== "CUSTOMER") {
    throw new Error("CUSTOMER_CHARGE_RESPONSIBILITY_REQUIRED");
  }
  if (!Number.isSafeInteger(item.quantityDifference)) {
    throw new Error("INVALID_DELTA_QUANTITY");
  }
  if (item.itemCode === "MILEAGE") {
    return Object.freeze({
      chargeType: "OVER_MILEAGE",
      quantity: Math.max(0, item.quantityDifference)
    });
  }
  if (item.wearClassification === "NEW_DAMAGE") {
    return Object.freeze({ chargeType: `DAMAGE_${item.itemCode}`, quantity: 1 });
  }
  if (item.wearClassification === "MISSING") {
    return Object.freeze({
      chargeType: `MISSING_${item.itemCode}`,
      quantity: Math.max(1, Math.abs(item.quantityDifference))
    });
  }
  throw new Error("CUSTOMER_CHARGE_DELTA_NOT_BILLABLE");
}

export function acceptedDisputeRepricingDeltaItemIds(
  pricingDeltaItemIds: readonly string[],
  acceptedDisputeDeltaItemIds: readonly string[]
) {
  const accepted = new Set(acceptedDisputeDeltaItemIds);
  return [...new Set(pricingDeltaItemIds.filter((id) => accepted.has(id)))].sort();
}

function result(
  input: PriceClosureChargeInput,
  status: "FINAL" | "PRICING_EXCEPTION",
  chargeableQuantity: number,
  unitPriceCents: bigint,
  amountCents: bigint,
  exceptionCode: string | null
) {
  const calculationSnapshot = {
    amountCents: amountCents.toString(),
    capCents: input.clause?.pricingSnapshot.capCents ?? null,
    chargeableQuantity,
    chargeType: input.chargeType,
    clauseCode: input.clause?.clauseCode ?? null,
    evidenceIds: [...input.evidenceIds].sort(),
    exceptionCode,
    manualBasis: input.manualBasis?.trim() || null,
    priorBilledAmountCents: (input.priorBilledAmountCents ?? 0n).toString(),
    priorBillIds: [...(input.priorBillIds ?? [])].sort(),
    quantity: input.quantity,
    unitPriceCents: unitPriceCents.toString()
  };
  return Object.freeze({
    amountCents,
    calculationHash: createHash("sha256")
      .update(JSON.stringify(calculationSnapshot))
      .digest("hex"),
    calculationSnapshot,
    status,
    unitPriceCents
  });
}

function optionalQuantity(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  throw new Error("INVALID_CONTRACT_INCLUDED_QUANTITY");
}

function cents(value: unknown) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new Error("INVALID_CONTRACT_PRICE");
}

function optionalCents(value: unknown) {
  return value === null || value === undefined ? null : cents(value);
}
