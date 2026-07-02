import { describe, expect, it } from "vitest";

import { mergeFleetOpsConfidence } from "../src/fleet-ops/facade/fleet-ops.confidence.merge";

describe("mergeFleetOpsConfidence", () => {
  it("merges PR confidence scores with deterministic weighted averaging", () => {
    const first = mergeFleetOpsConfidence({
      inputs: [
        { label: "state", score: 90, weight: 0.35 },
        { label: "timeline", score: 70, weight: 0.25 },
        { label: "economics", score: 80, weight: 0.2 },
        { label: "risk", score: 60, weight: 0.2 }
      ]
    });
    const second = mergeFleetOpsConfidence({
      inputs: [
        { label: "state", score: 90, weight: 0.35 },
        { label: "timeline", score: 70, weight: 0.25 },
        { label: "economics", score: 80, weight: 0.2 },
        { label: "risk", score: 60, weight: 0.2 }
      ]
    });

    expect(first).toEqual(second);
    expect(first.score).toBe(77);
    expect(first.band).toBe("MEDIUM");
  });

  it("penalizes conflicts, fallback evidence, and missing data without hiding the reasons", () => {
    const confidence = mergeFleetOpsConfidence({
      conflictCount: 2,
      fallbackPenaltyCount: 3,
      inputs: [
        { label: "state", score: 90, weight: 0.5 },
        { label: "timeline", score: 70, weight: 0.5 },
        { label: "economics", score: null, weight: 0.2 }
      ],
      missingDataCount: 1
    });

    expect(confidence.score).toBe(50);
    expect(confidence.band).toBe("LOW");
    expect(confidence.reasons).toEqual(
      expect.arrayContaining([
        "Applied conflict penalty for 2 conflict(s).",
        "Applied missing data penalty for 1 missing source(s).",
        "Applied fallback evidence penalty for 3 projected day(s)."
      ])
    );
  });

  it("returns UNKNOWN when no confidence source is present", () => {
    expect(
      mergeFleetOpsConfidence({
        inputs: [{ label: "state", score: null, weight: 1 }]
      })
    ).toEqual({
      band: "UNKNOWN",
      reasons: ["Weighted 0 confidence source(s)."],
      score: 0
    });
  });
});
