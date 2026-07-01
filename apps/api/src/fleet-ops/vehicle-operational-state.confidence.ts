import {
  MINIMUM_RESOLUTION_CONFIDENCE,
  VEHICLE_OPERATIONAL_SOURCE_BASE_SCORE
} from "./vehicle-operational-state.rules";
import {
  VehicleOperationalConfidenceBand,
  type VehicleOperationalStateConfidenceDetail,
  type VehicleOperationalStateSignal
} from "./vehicle-operational-state.types";

const RECENT_DAYS = 14;
const STALE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateVehicleOperationalStateConfidence({
  asOf,
  candidate,
  signals
}: {
  asOf: Date;
  candidate: VehicleOperationalStateSignal;
  signals: VehicleOperationalStateSignal[];
}): VehicleOperationalStateConfidenceDetail {
  const additions: string[] = [];
  const penalties: string[] = [];
  let score = VEHICLE_OPERATIONAL_SOURCE_BASE_SCORE[candidate.source];

  if (candidate.direct) {
    score += 10;
    additions.push("direct evidence");
  }

  if (candidate.priority >= 70) {
    score += 20;
    additions.push("high-priority operational signal +20");
  }

  const agreeingSignals = signals.filter((signal) => signal.state === candidate.state);
  const distinctAgreeingSources = new Set(agreeingSignals.map((signal) => signal.source));
  if (distinctAgreeingSources.size > 1) {
    const addition = Math.min(25, (distinctAgreeingSources.size - 1) * 10);
    score += addition;
    additions.push(`multiple source agreement +${addition}`);
  }

  const freshness = freshnessScore(candidate.freshnessDate, asOf);
  score += freshness.score;
  if (freshness.reason) {
    if (freshness.score >= 0) {
      additions.push(freshness.reason);
    } else {
      penalties.push(freshness.reason);
    }
  }

  const conflicts = signals.filter((signal) => signal.state !== candidate.state);
  if (conflicts.length === 0) {
    score += 10;
    additions.push("no conflicting signal");
  } else {
    const higherPriorityConflicts = conflicts.filter((signal) => signal.priority >= candidate.priority);
    if (higherPriorityConflicts.length > 0) {
      const penalty = 40;
      score -= penalty;
      penalties.push(`higher-or-equal priority conflicting signals -${penalty}`);
    } else {
      penalties.push("lower-priority conflicting signals tracked");
    }
  }

  return {
    additions,
    band: confidenceBand(score),
    penalties,
    score: clampScore(score)
  };
}

export function confidenceBand(score: number) {
  const clamped = clampScore(score);

  if (clamped >= 85) {
    return VehicleOperationalConfidenceBand.HIGH;
  }

  if (clamped >= 65) {
    return VehicleOperationalConfidenceBand.MEDIUM;
  }

  if (clamped >= MINIMUM_RESOLUTION_CONFIDENCE) {
    return VehicleOperationalConfidenceBand.LOW;
  }

  return VehicleOperationalConfidenceBand.UNKNOWN;
}

function freshnessScore(date: Date | null | undefined, asOf: Date) {
  if (!date) {
    return { reason: "missing freshness date -10", score: -10 };
  }

  const ageDays = Math.max(0, Math.floor((asOf.getTime() - date.getTime()) / MS_PER_DAY));
  if (ageDays <= RECENT_DAYS) {
    return { reason: "recent evidence +15", score: 15 };
  }

  if (ageDays > STALE_DAYS) {
    return { reason: "stale evidence -20", score: -20 };
  }

  return { reason: "freshness accepted +5", score: 5 };
}

function clampScore(score: number) {
  return Math.max(0, Math.min(100, Math.round(score)));
}
