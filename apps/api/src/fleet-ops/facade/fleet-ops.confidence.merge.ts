import type { FleetOpsConfidenceBand } from "../fleet-ops.shared-contracts";
import type { FleetOpsConfidenceMergeInput, FleetOpsConfidenceMergeResult } from "./fleet-ops.snapshot.types";

const CONFLICT_PENALTY = 5;
const FALLBACK_PENALTY = 4;
const MISSING_DATA_PENALTY = 8;

export function mergeFleetOpsConfidence(input: FleetOpsConfidenceMergeInput): FleetOpsConfidenceMergeResult {
  const validInputs = input.inputs.filter((item) => typeof item.score === "number" && Number.isFinite(item.score));
  const validWeight = validInputs.reduce((total, item) => total + item.weight, 0);
  const baseScore =
    validWeight === 0
      ? 0
      : validInputs.reduce((total, item) => total + clampScore(item.score ?? 0) * item.weight, 0) / validWeight;
  const conflictCount = input.conflictCount ?? 0;
  const missingDataCount = input.missingDataCount ?? 0;
  const fallbackPenaltyCount = input.fallbackPenaltyCount ?? 0;
  const score = clampScore(
    baseScore -
      conflictCount * CONFLICT_PENALTY -
      missingDataCount * MISSING_DATA_PENALTY -
      fallbackPenaltyCount * FALLBACK_PENALTY
  );
  const reasons = [
    `Weighted ${validInputs.length} confidence source(s).`,
    ...(conflictCount > 0 ? [`Applied conflict penalty for ${conflictCount} conflict(s).`] : []),
    ...(missingDataCount > 0 ? [`Applied missing data penalty for ${missingDataCount} missing source(s).`] : []),
    ...(fallbackPenaltyCount > 0 ? [`Applied fallback evidence penalty for ${fallbackPenaltyCount} projected day(s).`] : [])
  ];

  return {
    band: confidenceBand(score, validInputs.length),
    reasons,
    score
  };
}

function confidenceBand(score: number, validSourceCount: number): FleetOpsConfidenceBand {
  if (validSourceCount === 0) {
    return "UNKNOWN";
  }

  if (score >= 80) {
    return "HIGH";
  }

  if (score >= 55) {
    return "MEDIUM";
  }

  return "LOW";
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
