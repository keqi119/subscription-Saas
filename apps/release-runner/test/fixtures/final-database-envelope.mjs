// Synthetic final launch facts for contract tests; no credential or execution authority.
import { readFile } from "node:fs/promises";

import { canonicalJson } from "../../../../packages/release-foundation/src/canonical-json.mjs";
import {
  sha256Bytes,
  sha256Canonical
} from "../../../../packages/release-foundation/src/digest.mjs";
import { planManualR3TargetLocks } from "../../../../packages/release-foundation/src/manual-r3-target-locks.mjs";
import { planR3DatabaseTargets } from "../../../../scripts/release/r3-database-targets.mjs";

const operationId = "10000000-0000-4000-8000-000000000001";
const createdAt = "2026-09-28T00:00:00.000Z";
const postgres = {
  engineId: "synthetic-final-engine",
  containerId: "b".repeat(64),
  systemIdentifier: "7340000000000000002",
  imageDigest: `sha256:${"c".repeat(64)}`,
  hostname: "final-postgres",
  port: 5432,
  tlsMode: "require"
};
const fingerprint = (databaseName, profile) =>
  sha256Bytes(Buffer.from(`${databaseName}:${profile}`));

export async function finalDatabaseEnvelopeFixture(chain = "fresh") {
  const read = async (url) => JSON.parse(await readFile(new URL(url, import.meta.url)));
  const manifest = await read("../../../../release/contracts/database-test-manifest.v1.json");
  const discovery = await read("../../../../release/contracts/database-test-discovery.v1.json");
  const buildProof = await read("../../../../scripts/release/fixtures/build-proof.valid.json");
  const plan = planR3DatabaseTargets({
    operationRef: operationId,
    phase: "final",
    chain,
    manifest
  });
  const plannedTargets = plan.targets.map((target, index) => {
    const markerFacts = {
      markerVersion: "subscription-s1-ephemeral/v1",
      runIdDigest: sha256Canonical(operationId),
      suiteIdDigest: sha256Canonical(
        target.name === "source" ? `${target.suiteId}.source` : target.suiteId
      ),
      shard: target.shard,
      createdAt
    };
    const marker = canonicalJson(markerFacts);
    return {
      ...target,
      databaseOid: String(3001 + index),
      marker: target.kind === "application" ? `subscription-s1-ephemeral/v1:${marker}` : marker
    };
  });
  const locks = planManualR3TargetLocks({
    operationRef: operationId,
    engineId: postgres.engineId,
    systemIdentifier: postgres.systemIdentifier,
    targets: plannedTargets.map(({ databaseName, databaseOid, marker }) => ({
      databaseName,
      databaseOid,
      marker
    }))
  });
  const lockByDatabase = new Map(
    locks.entries.map(({ databaseName, lockDigest }) => [databaseName, lockDigest])
  );
  const database = (target) => ({
    databaseName: target.databaseName,
    databaseOid: target.databaseOid,
    marker: target.marker,
    runtimeRole: target.roles["runtime-test"],
    migrationRole: target.roles.migrate,
    runtimeCredentialFingerprint: fingerprint(target.databaseName, "runtime-test"),
    migrationCredentialFingerprint: fingerprint(target.databaseName, "migrate"),
    databaseIdentityFingerprint: sha256Canonical({
      databaseName: target.databaseName,
      databaseOid: target.databaseOid,
      role: target.roles["runtime-test"],
      tls: true
    }),
    targetLockDigest: lockByDatabase.get(target.databaseName),
    migrationEvidenceDigest: fingerprint(target.databaseName, "migration-evidence"),
    runtimeSecretReference: `secret-file:///run/secrets/${target.databaseName}-runtime-test.json`
  });
  const suiteAssignments = Object.fromEntries(
    manifest.suites.map(({ suiteId }) => {
      if (suiteId === "node.release-database-lifecycle.postgres")
        return [
          suiteId,
          {
            kind: "lifecycle-owned",
            reservations: plan.reservations.map((reservation) => ({
              shard: reservation.shard,
              databaseName: reservation.databaseName,
              roles: reservation.roles,
              targetLockDigest: lockByDatabase.get(reservation.databaseName)
            }))
          }
        ];
      const targets = plannedTargets.filter((target) => target.suiteId === suiteId);
      return [
        suiteId,
        {
          kind: "suite",
          databases: {
            target: database(targets.find((target) => target.name === "target")),
            ...(targets.some((target) => target.name === "source")
              ? { source: database(targets.find((target) => target.name === "source")) }
              : {})
          }
        }
      ];
    })
  );
  const envelope = {
    schemaVersion: "database-test-launch-envelope.v2",
    executionMode: "database-test",
    phase: "final",
    chain,
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    profileDigest: `sha256:${"d".repeat(64)}`,
    candidateUseExecutionRecordDigest: `sha256:${"e".repeat(64)}`,
    matchingSourceEvidenceDigest: `sha256:${"f".repeat(64)}`,
    destinationAdmissionDigest: `sha256:${"1".repeat(64)}`,
    creationEvidenceDigest: `sha256:${"2".repeat(64)}`,
    databaseTargetPlanDigest: sha256Canonical(plan),
    databaseTestManifestDigest: sha256Canonical(manifest),
    databaseTestDiscoveryDigest: sha256Canonical(discovery),
    custodyPolicyDigest: `sha256:${"3".repeat(64)}`,
    sourceSha: buildProof.identity.sourceSha,
    runnerContainerId: "a".repeat(64),
    sessionId: "20000000-0000-4000-8000-000000000002",
    sessionNonce: "4".repeat(64),
    operationId,
    runId: "30000000-0000-4000-8000-000000000003",
    attemptId: "40000000-0000-4000-8000-000000000004",
    databaseTestManifestReference: "launch-file:///run/launch/database-test-manifest.json",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.json",
    journalReference: "evidence-file:///evidence/final-database-test.json",
    postgres,
    suiteAssignments
  };
  return { envelope, manifest };
}
