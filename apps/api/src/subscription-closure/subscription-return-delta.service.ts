import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

export type ConditionFact = Readonly<{
  itemCode: string;
  quantity: number;
  state: string;
}>;

export type ConditionDeltaItem = Readonly<{
  decisionReason: string;
  deliveryState: string;
  itemCode: string;
  quantityDifference: number;
  responsibility: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR" | "UNDETERMINED";
  returnState: string;
  wearClassification:
    | "NORMAL_WEAR"
    | "NEW_DAMAGE"
    | "MISSING"
    | "IMPROVED"
    | "UNCHANGED"
    | "MANUAL_REVIEW";
}>;

@Injectable()
export class SubscriptionReturnDeltaService {
  build(input: { delivery: readonly ConditionFact[]; return: readonly ConditionFact[] }) {
    return buildConditionDelta(input);
  }
}

export function buildConditionDelta(input: {
  delivery: readonly ConditionFact[];
  return: readonly ConditionFact[];
}) {
  const delivery = uniqueFacts(input.delivery, "delivery");
  const returned = uniqueFacts(input.return, "return");
  const codes = [...new Set([...delivery.keys(), ...returned.keys()])].sort(bytewise);
  const items = codes.map((itemCode): ConditionDeltaItem => {
    const before = delivery.get(itemCode);
    const after = returned.get(itemCode);
    const quantityDifference = (after?.quantity ?? 0) - (before?.quantity ?? 0);
    if (itemCode === "MILEAGE" && quantityDifference > 0) {
      return Object.freeze({
        decisionReason: "Return mileage exceeds the signed delivery baseline.",
        deliveryState: before?.state ?? "NOT_RECORDED",
        itemCode,
        quantityDifference,
        responsibility: "CUSTOMER",
        returnState: after?.state ?? "NORMAL",
        wearClassification: "MANUAL_REVIEW"
      });
    }
    if (!after || after.state === "MISSING" || quantityDifference < 0) {
      return Object.freeze({
        decisionReason: "Returned quantity/state is below the signed delivery baseline.",
        deliveryState: before?.state ?? "NOT_RECORDED",
        itemCode,
        quantityDifference,
        responsibility: "CUSTOMER",
        returnState: after?.state ?? "MISSING",
        wearClassification: "MISSING"
      });
    }
    if (after.state === "DAMAGED" && before?.state !== "DAMAGED") {
      return Object.freeze({
        decisionReason: "Return inspection records damage not present at delivery.",
        deliveryState: before?.state ?? "NOT_RECORDED",
        itemCode,
        quantityDifference,
        responsibility: "UNDETERMINED",
        returnState: after.state,
        wearClassification: "NEW_DAMAGE"
      });
    }
    return Object.freeze({
      decisionReason: "Delivery and return facts match.",
      deliveryState: before?.state ?? "NOT_RECORDED",
      itemCode,
      quantityDifference,
      responsibility: "NORMAL_WEAR",
      returnState: after.state,
      wearClassification: "UNCHANGED"
    });
  });
  return Object.freeze({ items, resultHash: sha256(canonical(items)) });
}

export function applyConditionDeltaDecisions(
  baseItems: readonly ConditionDeltaItem[],
  decisions: readonly Readonly<{
    decisionReason: string;
    itemCode: string;
    responsibility: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR";
  }>[]
) {
  const decisionByCode = new Map<
    string,
    Readonly<{
      decisionReason: string;
      itemCode: string;
      responsibility: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR";
    }>
  >();
  const baseByCode = new Map(baseItems.map((item) => [item.itemCode, item]));
  for (const decision of decisions) {
    const itemCode = decision.itemCode.trim().toUpperCase();
    const reason = decision.decisionReason.trim();
    const base = baseByCode.get(itemCode);
    if (!base || base.responsibility !== "UNDETERMINED") {
      throw new Error("RETURN_DELTA_DECISION_ITEM_MISMATCH");
    }
    if (!reason || decisionByCode.has(itemCode)) {
      throw new Error("RETURN_DELTA_INVALID_DECISION");
    }
    decisionByCode.set(itemCode, Object.freeze({ ...decision, decisionReason: reason, itemCode }));
  }
  const unresolvedCodes = baseItems
    .filter((item) => item.responsibility === "UNDETERMINED" && !decisionByCode.has(item.itemCode))
    .map(({ itemCode }) => itemCode);
  if (unresolvedCodes.length > 0) {
    throw new Error("RETURN_DELTA_UNRESOLVED_RESPONSIBILITY");
  }
  const items = baseItems
    .map((item): ConditionDeltaItem => {
      const decision = decisionByCode.get(item.itemCode);
      return Object.freeze(
        decision
          ? {
              ...item,
              decisionReason: decision.decisionReason,
              responsibility: decision.responsibility
            }
          : { ...item }
      );
    })
    .sort((left, right) => bytewise(left.itemCode, right.itemCode));
  return Object.freeze({ items, resultHash: sha256(canonical(items)) });
}

function uniqueFacts(facts: readonly ConditionFact[], side: string) {
  const result = new Map<string, ConditionFact>();
  for (const fact of facts) {
    const itemCode = fact.itemCode.trim().toUpperCase();
    if (!itemCode || result.has(itemCode) || !Number.isInteger(fact.quantity) || fact.quantity < 0) {
      throw new Error(`INVALID_${side.toUpperCase()}_CONDITION_FACT`);
    }
    result.set(itemCode, Object.freeze({ ...fact, itemCode }));
  }
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => bytewise(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function bytewise(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}
