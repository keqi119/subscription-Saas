// Internal consistency checks only. H1 owns authentication, actual image/target
// observation and credential release; an envelope is not independent authority.
import {
  canonicalJson,
  sha256Canonical,
  validateContract
} from "@subscription-saas/release-foundation";
import { planManualR3TargetLocks } from "../../../packages/release-foundation/src/manual-r3-target-locks.mjs";
import {
  bindR3FinalManifest,
  planR3DatabaseTargets
} from "../../../scripts/release/r3-database-targets.mjs";
import { runnerError } from "./error-codes.mjs";

const FINAL = "database-test-launch-envelope.v2";
const CODE = "DATABASE_TEST_TARGET_ASSIGNMENT_MISMATCH";
const need = (condition) => {
  if (!condition) throw runnerError(CODE);
};
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateDatabaseTestEnvelopeVersion(envelope) {
  const version = envelope?.schemaVersion;
  if (!["database-test-launch-envelope.v1", FINAL].includes(version))
    throw runnerError("DATABASE_TEST_ENVELOPE_VERSION_UNSUPPORTED");
  validateContract(version, envelope);
  return version;
}

export function validateFinalDatabaseTestAssignments({ envelope, manifest, discoveryDigest }) {
  validateDatabaseTestEnvelopeVersion(envelope);
  validateContract("database-test-manifest.v1", manifest);
  try {
    need(envelope.schemaVersion === FINAL);
    const held = structuredClone(envelope);
    const build = held.buildProof.identity;
    need(
      held.buildProofDigest === sha256Canonical(held.buildProof) &&
        held.actualRunnerDigest === build.images.runner.imageDigest &&
        held.sourceSha === build.sourceSha &&
        Object.values(build.images).every(
          (image) => image.sourceRevision === held.sourceSha && image.platform === "linux/amd64"
        ) &&
        held.runnerContainerId !== held.postgres.containerId &&
        held.databaseTestManifestDigest === sha256Canonical(manifest) &&
        held.databaseTestDiscoveryDigest === discoveryDigest
    );
    const plan = planR3DatabaseTargets({
      operationRef: held.operationId,
      phase: "final",
      chain: held.chain,
      manifest
    });
    need(held.databaseTargetPlanDigest === sha256Canonical(plan));
    const selections = bindR3FinalManifest({
      operationRef: held.operationId,
      chain: held.chain,
      manifest,
      plan,
      discoveryDigest,
      discoveryUnclassifiedCount: 0
    });
    const assignments = held.suiteAssignments;
    need(same(Object.keys(assignments).sort(), selections.map(({ suiteId }) => suiteId).sort()));
    const credentialFingerprints = new Set(),
      secretReferences = new Set(),
      migrationEvidence = new Set(),
      targets = [];
    for (const selection of selections) {
      const assignment = assignments[selection.suiteId];
      if (selection.r3ExecutionMode === "lifecycle-owned") {
        need(assignment.kind === "lifecycle-owned");
        for (const [index, reservation] of assignment.reservations.entries()) {
          const expected = plan.reservations[index];
          need(
            reservation.shard === expected.shard &&
              reservation.databaseName === expected.databaseName &&
              same(reservation.roles, expected.roles)
          );
        }
        continue;
      }
      need(assignment.kind === "suite");
      const names = ["target", ...selection.additionalAssignments.map(({ name }) => name)];
      need(same(Object.keys(assignment.databases).sort(), [...names].sort()));
      for (const name of names) {
        const database = assignment.databases[name];
        const expected = plan.targets.find(
          (target) => target.suiteId === selection.suiteId && target.name === name
        );
        need(
          expected &&
            database.databaseName === expected.databaseName &&
            database.runtimeRole === expected.roles["runtime-test"] &&
            database.migrationRole === expected.roles.migrate &&
            database.runtimeSecretReference ===
              `secret-file:///run/secrets/${expected.databaseName}-runtime-test.json` &&
            database.databaseIdentityFingerprint ===
              sha256Canonical({
                databaseName: database.databaseName,
                databaseOid: database.databaseOid,
                role: database.runtimeRole,
                tls: true
              })
        );
        const marker = JSON.parse(database.marker);
        need(
          typeof marker.createdAt === "string" &&
            Number.isFinite(Date.parse(marker.createdAt)) &&
            new Date(marker.createdAt).toISOString() === marker.createdAt &&
            database.marker ===
              canonicalJson({
                markerVersion: "subscription-s1-ephemeral/v1",
                runIdDigest: sha256Canonical(held.operationId),
                suiteIdDigest: sha256Canonical(
                  name === "source" ? `${selection.suiteId}.source` : selection.suiteId
                ),
                shard: expected.shard,
                createdAt: marker.createdAt
              })
        );
        for (const digest of [
          database.runtimeCredentialFingerprint,
          database.migrationCredentialFingerprint
        ]) {
          need(!credentialFingerprints.has(digest));
          credentialFingerprints.add(digest);
        }
        need(
          !secretReferences.has(database.runtimeSecretReference) &&
            !migrationEvidence.has(database.migrationEvidenceDigest)
        );
        secretReferences.add(database.runtimeSecretReference);
        migrationEvidence.add(database.migrationEvidenceDigest);
        targets.push({
          databaseName: database.databaseName,
          databaseOid: database.databaseOid,
          marker: database.marker
        });
      }
    }
    const locks = planManualR3TargetLocks({
      operationRef: held.operationId,
      engineId: held.postgres.engineId,
      systemIdentifier: held.postgres.systemIdentifier,
      targets
    });
    for (const assignment of Object.values(assignments)) {
      const entries =
        assignment.kind === "suite" ? Object.values(assignment.databases) : assignment.reservations;
      for (const entry of entries)
        need(
          locks.entries.find(({ databaseName }) => databaseName === entry.databaseName)
            ?.lockDigest === entry.targetLockDigest
        );
    }
    return freeze({
      plan,
      selections: selections.map((selection) => ({
        ...selection,
        databaseAssignment: assignments[selection.suiteId]
      }))
    });
  } catch {
    throw runnerError(CODE);
  }
}
