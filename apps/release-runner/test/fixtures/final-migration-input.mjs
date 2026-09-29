// Synthetic wire facts for pure consistency tests; no database or credential authority.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../../packages/release-foundation/src/canonical-json.mjs";
import { computeMigrationCatalog } from "../../../../packages/release-foundation/src/catalogs.mjs";
import {
  sha256Bytes,
  sha256Canonical
} from "../../../../packages/release-foundation/src/digest.mjs";
import { planR3DatabaseTargets } from "../../../../scripts/release/r3-database-targets.mjs";
import { finalDatabaseEnvelopeFixture } from "./final-database-envelope.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const lifecycleSuite = "node.release-database-lifecycle.postgres";
let catalogPromise;

export async function finalMigrationInputFixture({
  chain = "fresh",
  lifecycleShard,
  suiteId,
  name = "target"
} = {}) {
  const { envelope, manifest } = await finalDatabaseEnvelopeFixture(chain);
  const globalObjectPolicy = JSON.parse(
    await readFile(
      new URL(
        "../../../../release/contracts/migration-global-object-policy.v1.json",
        import.meta.url
      )
    )
  );
  catalogPromise ??= computeMigrationCatalog(repoRoot);
  const migrationCatalog = await catalogPromise;
  const chosenSuite =
    suiteId ?? (lifecycleShard === undefined ? manifest.suites[0].suiteId : lifecycleSuite);
  const plan = planR3DatabaseTargets({
    operationRef: envelope.operationId,
    phase: "final",
    chain,
    manifest
  });
  const lifecycle = lifecycleShard !== undefined;
  const planned = lifecycle
    ? plan.reservations.find((item) => item.shard === lifecycleShard)
    : plan.targets.find((item) => item.suiteId === chosenSuite && item.name === name);
  if (!planned || lifecycle !== (chosenSuite === lifecycleSuite))
    throw new Error("FIXTURE_ASSIGNMENT_INVALID");
  const assigned = lifecycle ? null : envelope.suiteAssignments[chosenSuite].databases[name];
  const databaseOid = assigned?.databaseOid ?? String(9001 + lifecycleShard);
  const marker =
    assigned?.marker ??
    canonicalJson({
      markerVersion: "subscription-s1-ephemeral/v1",
      runIdDigest: sha256Canonical(envelope.operationId),
      suiteIdDigest: sha256Canonical("database-lifecycle"),
      shard: lifecycleShard,
      createdAt: "2026-09-28T00:00:00.000Z"
    });
  const migrationRole = planned.roles.migrate;
  const database = {
    databaseName: planned.databaseName,
    databaseOid,
    marker,
    migrationRole,
    migrationCredentialFingerprint:
      assigned?.migrationCredentialFingerprint ??
      sha256Bytes(Buffer.from(`${planned.databaseName}:migrate`)),
    runtimeCredentialFingerprint:
      assigned?.runtimeCredentialFingerprint ??
      sha256Bytes(Buffer.from(`${planned.databaseName}:runtime-test`)),
    databaseIdentityFingerprint: sha256Canonical({
      databaseName: planned.databaseName,
      databaseOid,
      role: migrationRole,
      tls: true
    }),
    targetLockDigest: sha256Canonical({
      kind: "r3-database-target",
      engineId: envelope.postgres.engineId,
      systemIdentifier: envelope.postgres.systemIdentifier,
      databaseOid,
      marker
    })
  };
  const buildProof = structuredClone(envelope.buildProof);
  buildProof.identity.migrationCatalogDigest = migrationCatalog.digest;
  const input = {
    schemaVersion: "r3-final-migration-input.v1",
    phase: "final",
    chain,
    profileDigest: envelope.profileDigest,
    sessionId: envelope.sessionId,
    sessionNonce: envelope.sessionNonce,
    operationId: envelope.operationId,
    runId: envelope.runId,
    attemptId: envelope.attemptId,
    candidateUseExecutionRecordDigest: envelope.candidateUseExecutionRecordDigest,
    matchingSourceEvidenceDigest: envelope.matchingSourceEvidenceDigest,
    matchingSourceResultDigest: `sha256:${"6".repeat(64)}`,
    destinationAdmissionDigest: envelope.destinationAdmissionDigest,
    creationEvidenceDigest: envelope.creationEvidenceDigest,
    databaseTargetPlanDigest: sha256Canonical(plan),
    databaseTestManifestDigest: sha256Canonical(manifest),
    databaseTestDiscoveryDigest: envelope.databaseTestDiscoveryDigest,
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    sourceSha: buildProof.identity.sourceSha,
    runnerContainerId: envelope.runnerContainerId,
    migrationContainerId: "9".repeat(64),
    postgres: { ...envelope.postgres, hostname: "postgres" },
    assignment: lifecycle
      ? { kind: "lifecycle-owned", suiteId: chosenSuite, lifecycleShard }
      : { kind: "suite", suiteId: chosenSuite, name },
    database,
    expectedSchemaDigest: `sha256:${"5".repeat(64)}`,
    migrationCatalogDigest: migrationCatalog.digest
  };
  return { input, manifest, migrationCatalog, globalObjectPolicy };
}
