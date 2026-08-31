export function isSubscriptionReturnThreeStageEnabled(value: unknown) {
  return value === "true";
}

export function hasSubscriptionReturnThreeStageContinuation(
  input: Readonly<{
    businessExceptionApprovals?: unknown;
    chargeLines?: unknown;
    currentChecklistRevisionId?: unknown;
    currentDeltaRevisionId?: unknown;
    customerResponses?: unknown;
    evidenceLinks?: unknown;
    evidencePackages?: unknown;
    legalCases?: unknown;
    receivableDispositions?: unknown;
    returnManifestTasks?: unknown;
  }>
) {
  return (
    Boolean(input.currentChecklistRevisionId) ||
    Boolean(input.currentDeltaRevisionId) ||
    [
      input.businessExceptionApprovals,
      input.chargeLines,
      input.customerResponses,
      input.evidenceLinks,
      input.evidencePackages,
      input.legalCases,
      input.receivableDispositions,
      input.returnManifestTasks
    ].some(hasGovernedFact)
  );
}

function hasGovernedFact(value: unknown) {
  if (typeof value === "number") return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}
