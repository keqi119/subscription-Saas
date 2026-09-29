// Internal comparison only; no evidence reader, authority or public-barrel API.
import { encodeManualJson } from "./manual-stage1-contracts.mjs";

const EVIDENCE = "MANUAL_EVIDENCE_BINDING_MISMATCH";
const requireThat = (condition, code = EVIDENCE) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
function instant(value) {
  const n = Date.parse(value);
  requireThat(
    typeof value === "string" && Number.isFinite(n) && new Date(n).toISOString() === value,
    "MANUAL_TIME_INVALID"
  );
  return n;
}

// Only the shared verifier constructs these facts from authenticated contexts.
// In particular, matchingSourceEvidenceDigest denotes the source SUCCEEDED
// candidate-use execution record, never its result or acknowledgement digest.
export function assertR3MatchingSources(accumulator) {
  const matchedSources = new Map();
  for (const [requestDigest, final] of accumulator.r3FinalUses) {
    requireThat(
      ["fresh", "snapshot"].includes(final.chain) &&
        ["snapshot-consumer", "candidate-use"].includes(final.stage) &&
        (final.stage !== "snapshot-consumer" || final.chain === "snapshot") &&
        (final.chain !== "snapshot" ||
          final.stage !== "candidate-use" ||
          final.consumerMatchingSourceEvidenceDigest === final.matchingSourceEvidenceDigest)
    );
    const matches = [...accumulator.r3Sources.values()].filter(
      (source) =>
        source.closedAt !== null &&
        source.profileDigest === final.profileDigest &&
        source.buildProofDigest === final.buildProofDigest &&
        source.sourceSha === final.sourceSha &&
        source.chain === final.chain &&
        source.manifestDigest === final.manifestDigest &&
        source.manifestRawDigest === final.manifestRawDigest &&
        (final.chain !== "snapshot" || equal(source.snapshot, final.snapshot)) &&
        ["repository", "repositoryId", "runId", "runAttempt", "callerWorkflowPath"].every(
          (field) => source.ci[field] === final.ci[field]
        )
    );
    requireThat(matches.length === 1, EVIDENCE);
    const source = matches[0];
    requireThat(
      source.terminalDigest === final.matchingSourceEvidenceDigest &&
        instant(source.closedAt) <= instant(final.allocatedAt) &&
        source.operationRef !== final.operationRef &&
        source.sessionId !== final.sessionId &&
        source.sessionNonce !== final.sessionNonce &&
        !source.runIds.includes(final.runId) &&
        source.engineId !== final.engineId &&
        source.containerId !== final.containerId &&
        source.systemIdentifier !== final.systemIdentifier &&
        final.targetLocks.every((digest) => !source.targetLocks.includes(digest)),
      EVIDENCE
    );
    // These scalars come from the complete source-original proof in the core,
    // never from a final caller's claimed schema or an unverified result JSON.
    requireThat(
      ["terminalDigest", "resultDigest", "reconstructedDigest", "postSchemaDigest"].every(
        (key) => typeof source[key] === "string" && /^sha256:[0-9a-f]{64}$/u.test(source[key])
      )
    );
    if (Object.hasOwn(final, "sourceClaims")) {
      const claims = final.sourceClaims;
      requireThat(
        final.stage === "candidate-use" &&
          claims &&
          typeof claims === "object" &&
          !Array.isArray(claims) &&
          Object.keys(claims).sort().join(",") ===
            "expectedSchemaDigest,matchingSourceEvidenceDigest,matchingSourceResultDigest" &&
          claims.matchingSourceEvidenceDigest === source.terminalDigest &&
          claims.matchingSourceResultDigest === source.resultDigest &&
          claims.expectedSchemaDigest === source.postSchemaDigest
      );
    }
    matchedSources.set(
      requestDigest,
      Object.freeze(
        Object.fromEntries(
          [
            "terminalDigest",
            "resultDigest",
            "reconstructedDigest",
            "postSchemaDigest",
            "operationRef",
            "sessionId",
            "sessionNonce"
          ].map((key) => [key, source[key]])
        )
      )
    );
  }
  return matchedSources;
}
