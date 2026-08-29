import { Injectable } from "@nestjs/common";

export type ClosureReceivableFact = Readonly<{
  billId: string;
  disposition:
    | "OPEN"
    | "PAID"
    | "MANUAL_PAYMENT_CONFIRMED"
    | "WAIVED"
    | "WRITTEN_OFF"
    | "DISPUTED"
    | "COLLECTION_PENDING"
    | "LEGAL_COLLECTION";
  ownerId: string | null;
  paidAmountCents?: bigint;
  remainingAmountCents: bigint;
}>;

export type DerivedClosureFinancialState = Readonly<{
  financialStatus:
    | "DRAFT"
    | "PARTIALLY_PAID"
    | "DISPUTED"
    | "COLLECTION_PENDING"
    | "LEGAL_COLLECTION"
    | "SETTLED"
    | "WRITTEN_OFF";
  openAmountCents: bigint;
  paidAmountCents: bigint;
  unresolvedOrphan?: boolean;
}>;

@Injectable()
export class SubscriptionClosureFinancialService {
  derive(facts: readonly ClosureReceivableFact[]) {
    return deriveClosureFinancialState(facts);
  }
}

export function deriveClosureFinancialState(
  facts: readonly ClosureReceivableFact[]
): DerivedClosureFinancialState {
  const openAmountCents = facts.reduce(
    (sum, fact) => sum + (fact.remainingAmountCents > 0n ? fact.remainingAmountCents : 0n),
    0n
  );
  const paidAmountCents = facts.reduce(
    (sum, fact) => sum + (fact.paidAmountCents && fact.paidAmountCents > 0n ? fact.paidAmountCents : 0n),
    0n
  );
  const unresolvedOrphan = facts.some(
    (fact) => fact.remainingAmountCents > 0n && fact.disposition === "OPEN" && !fact.ownerId
  );
  const dispositions = new Set(facts.map(({ disposition }) => disposition));
  const financialStatus =
    openAmountCents === 0n
      ? dispositions.has("WRITTEN_OFF")
        ? "WRITTEN_OFF"
        : "SETTLED"
      : dispositions.has("LEGAL_COLLECTION")
        ? "LEGAL_COLLECTION"
        : dispositions.has("DISPUTED")
          ? "DISPUTED"
          : dispositions.has("COLLECTION_PENDING")
            ? "COLLECTION_PENDING"
            : paidAmountCents > 0n
              ? "PARTIALLY_PAID"
              : "DRAFT";
  return Object.freeze({
    financialStatus,
    openAmountCents,
    paidAmountCents,
    ...(unresolvedOrphan ? { unresolvedOrphan: true } : {})
  });
}

export function mayCompleteOperations(
  financial: DerivedClosureFinancialState,
  operational: Readonly<{ inventoryReleased: boolean; physicalReceiptComplete: boolean }>
) {
  if (!operational.inventoryReleased || !operational.physicalReceiptComplete) return false;
  if (financial.unresolvedOrphan) return false;
  return (
    financial.openAmountCents === 0n ||
    ["DISPUTED", "COLLECTION_PENDING", "LEGAL_COLLECTION"].includes(financial.financialStatus)
  );
}
