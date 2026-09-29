// Pure consistency of one final migration wire input. The H1 caller must
// authenticate the parent/source facts and observe the held target separately.
import { canonicalJson } from "../../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../../packages/release-foundation/src/schema-registry.mjs";
import { planR3DatabaseTargets } from "../../../scripts/release/r3-database-targets.mjs";

const CODE = "FINAL_MIGRATION_INPUT_INVALID";
const LIFECYCLE = "node.release-database-lifecycle.postgres";
// Only these six fields vary between migrations under the same authenticated parent.
const CHILD_FIELDS = new Set([
  "schemaVersion",
  "assignment",
  "database",
  "migrationContainerId",
  "expectedSchemaDigest",
  "migrationCatalogDigest"
]);
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateFinalMigrationInput({
  input,
  manifest,
  migrationCatalog,
  globalObjectPolicy
}) {
  try {
    validateContract("r3-final-migration-input.v1", input);
    validateContract("database-test-manifest.v1", manifest);
    validateContract("migration-global-object-policy.v1", globalObjectPolicy);
    const held = structuredClone(input);
    need(
      migrationCatalog?.catalogVersion === "migration-catalog.v1" &&
        Array.isArray(migrationCatalog.entries) &&
        migrationCatalog.entries.length > 0 &&
        migrationCatalog.digest ===
          sha256Canonical({
            catalogVersion: migrationCatalog.catalogVersion,
            entries: migrationCatalog.entries
          }) &&
        held.migrationCatalogDigest === migrationCatalog.digest &&
        held.buildProof.identity.migrationCatalogDigest === migrationCatalog.digest &&
        held.buildProofDigest === sha256Canonical(held.buildProof) &&
        held.actualRunnerDigest === held.buildProof.identity.images.runner.imageDigest &&
        held.sourceSha === held.buildProof.identity.sourceSha &&
        Object.values(held.buildProof.identity.images).every(
          (image) => image.sourceRevision === held.sourceSha && image.platform === "linux/amd64"
        ) &&
        held.databaseTestManifestDigest === sha256Canonical(manifest) &&
        new Set([held.runnerContainerId, held.migrationContainerId, held.postgres.containerId])
          .size === 3
    );
    const plan = planR3DatabaseTargets({
      operationRef: held.operationId,
      phase: "final",
      chain: held.chain,
      manifest
    });
    need(held.databaseTargetPlanDigest === sha256Canonical(plan));
    const assignment = held.assignment;
    const suite = manifest.suites.find(({ suiteId }) => suiteId === assignment.suiteId);
    need(suite);
    const lifecycle = assignment.kind === "lifecycle-owned";
    need(lifecycle === (assignment.suiteId === LIFECYCLE));
    const planned = lifecycle
      ? plan.reservations.find(({ shard }) => shard === assignment.lifecycleShard)
      : plan.targets.find(
          ({ suiteId, name, kind }) =>
            suiteId === assignment.suiteId && name === assignment.name && kind === "suite"
        );
    need(planned);
    const db = held.database;
    need(
      db.databaseName === planned.databaseName &&
        db.migrationRole === planned.roles.migrate &&
        db.databaseIdentityFingerprint ===
          sha256Canonical({
            databaseName: db.databaseName,
            databaseOid: db.databaseOid,
            role: db.migrationRole,
            tls: true
          }) &&
        db.targetLockDigest ===
          sha256Canonical({
            kind: "r3-database-target",
            engineId: held.postgres.engineId,
            systemIdentifier: held.postgres.systemIdentifier,
            databaseOid: db.databaseOid,
            marker: db.marker
          })
    );
    let marker;
    try {
      marker = JSON.parse(db.marker);
    } catch {
      fail();
    }
    need(
      marker &&
        typeof marker === "object" &&
        !Array.isArray(marker) &&
        typeof marker.createdAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(marker.createdAt) &&
        !Number.isNaN(Date.parse(marker.createdAt)) &&
        new Date(marker.createdAt).toISOString() === marker.createdAt &&
        db.marker ===
          canonicalJson({
            markerVersion: "subscription-s1-ephemeral/v1",
            runIdDigest: sha256Canonical(held.operationId),
            suiteIdDigest: sha256Canonical(
              lifecycle
                ? "database-lifecycle"
                : assignment.name === "source"
                  ? `${assignment.suiteId}.source`
                  : assignment.suiteId
            ),
            shard: planned.shard,
            createdAt: marker.createdAt
          })
    );
    // The policy is the sole source of extension names; the wire cannot add one.
    const allowedExtensions = [
      ...new Set(["plpgsql", ...globalObjectPolicy.allowedExtensions])
    ].sort();
    const parentBindingDigest = sha256Canonical(
      Object.fromEntries(Object.entries(held).filter(([key]) => !CHILD_FIELDS.has(key)))
    );
    return freeze({
      input: held,
      parentBindingDigest,
      assignment: structuredClone(assignment),
      target: {
        hostname: "postgres",
        port: 5432,
        tlsMode: "require",
        databaseName: db.databaseName
      },
      allowedExtensions
    });
  } catch {
    fail();
  }
}
