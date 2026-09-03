import { sha256Text } from "./digest.mjs";

function targetError(details) {
  return Object.assign(new Error("EPHEMERAL_TARGET_REJECTED"), {
    code: "EPHEMERAL_TARGET_REJECTED",
    details
  });
}

export function suiteDatabaseName(runId, suiteId, shard) {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof suiteId !== "string" ||
    suiteId.length === 0 ||
    !Number.isInteger(shard) ||
    shard < 0
  ) {
    throw targetError({ field: "suite-identity" });
  }
  return `s1ci_${sha256Text(`${runId}:${suiteId}:${shard}`).slice(0, 24)}`;
}

export function assertApprovedEphemeralTarget(metadata, policy) {
  let databaseNamePattern;
  try {
    databaseNamePattern = new RegExp(policy?.databaseNamePattern);
  } catch {
    throw targetError({ field: "policy" });
  }
  if (
    policy?.schemaVersion !== "database-target-policy.v1" ||
    metadata?.policyId !== policy.policyId ||
    !policy.allowedEnvironments?.includes(metadata.environment) ||
    !policy.allowedHosts?.includes(metadata.host) ||
    metadata.clusterMarker !== policy.requiredClusterMarker ||
    metadata.imageDigest !== policy.requiredImageDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.clusterFingerprint ?? "") ||
    !new RegExp(`^${policy.requiredServerVersionMajor}[0-9]{4}$`).test(
      String(metadata.serverVersionNum ?? "")
    ) ||
    policy.databaseNamePattern !== "^s1ci_[0-9a-f]{24}$" ||
    !databaseNamePattern.test("s1ci_000000000000000000000000")
  ) {
    throw targetError({ policyId: policy?.policyId });
  }
  return metadata;
}
