// Internal selection over facts produced by the complete manual history replay.
// This does not read a store or authenticate an execution record.
const EVIDENCE = "MANUAL_EVIDENCE_BINDING_MISMATCH";
const requireThat = (condition) => {
  if (!condition) throw Object.assign(new Error(EVIDENCE), { code: EVIDENCE });
};

export function selectSingleR3FinalUse(finalUses, selectedRequestDigest) {
  const chosen = finalUses.get(selectedRequestDigest);
  requireThat(chosen?.stage === "candidate-use");
  const matchingRequestDigests = [...finalUses]
    .filter(
      ([, value]) =>
        value.stage === "candidate-use" &&
        value.profileDigest === chosen.profileDigest &&
        value.buildProofDigest === chosen.buildProofDigest &&
        value.sourceSha === chosen.sourceSha &&
        value.chain === chosen.chain &&
        value.matchingSourceEvidenceDigest === chosen.matchingSourceEvidenceDigest &&
        ["repository", "repositoryId", "runId", "runAttempt", "callerWorkflowPath"].every(
          (field) => value.ci[field] === chosen.ci[field]
        )
    )
    .map(([digest]) => digest);
  requireThat(
    matchingRequestDigests.length === 1 && matchingRequestDigests[0] === selectedRequestDigest
  );
  return Object.freeze({
    chosen,
    matchingRequestDigests: Object.freeze(matchingRequestDigests)
  });
}
