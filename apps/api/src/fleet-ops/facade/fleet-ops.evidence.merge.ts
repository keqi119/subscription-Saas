import type { FleetOpsSnapshotEvidence } from "./fleet-ops.snapshot.types";

export function mergeFleetOpsEvidence(evidenceGroups: FleetOpsSnapshotEvidence[][]): FleetOpsSnapshotEvidence[] {
  const merged = new Map<string, FleetOpsSnapshotEvidence>();

  for (const evidence of evidenceGroups.flat()) {
    const key = evidenceKey(evidence);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...evidence,
        fields: evidence.fields ? { ...evidence.fields } : undefined,
        layers: uniqueSorted(evidence.layers)
      });
      continue;
    }

    merged.set(key, {
      ...existing,
      fields: {
        ...(existing.fields ?? {}),
        ...(evidence.fields ?? {})
      },
      layers: uniqueSorted([...existing.layers, ...evidence.layers]),
      observedAt: latestDate(existing.observedAt, evidence.observedAt)
    });
  }

  return [...merged.values()].sort(compareEvidence);
}

function evidenceKey(evidence: FleetOpsSnapshotEvidence) {
  return `${evidence.source}:${evidence.sourceId ?? evidence.summary}`;
}

function compareEvidence(left: FleetOpsSnapshotEvidence, right: FleetOpsSnapshotEvidence) {
  const sourceDelta = left.source.localeCompare(right.source);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  const sourceIdDelta = (left.sourceId ?? "").localeCompare(right.sourceId ?? "");
  if (sourceIdDelta !== 0) {
    return sourceIdDelta;
  }

  return left.summary.localeCompare(right.summary);
}

function latestDate(left: Date | null | undefined, right: Date | null | undefined) {
  if (!left) {
    return right ?? null;
  }

  if (!right) {
    return left;
  }

  return left.getTime() >= right.getTime() ? left : right;
}

function uniqueSorted<T extends string>(values: T[]) {
  return [...new Set(values)].sort();
}
