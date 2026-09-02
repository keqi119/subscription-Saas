import {
  buildPostStateObservation,
  deterministicPlanDigest,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { runnerError } from "../error-codes.mjs";
import { assertAppliedMigrationPrefix, verifySchema } from "./db-schema-verify.mjs";

function migrationName(entry) {
  return entry.path.split("/").at(-2) ?? null;
}

function assertRequiredFunction(context, name) {
  if (typeof context?.[name] !== "function") {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING", { adapter: name });
  }
}

export async function planMigration(context, input) {
  assertRequiredFunction(context, "loadMigrationCatalog");
  assertRequiredFunction(context, "observeMigrationState");
  assertRequiredFunction(context, "readToolVersions");
  const [catalog, current, toolVersions] = await Promise.all([
    context.loadMigrationCatalog(),
    context.observeMigrationState(),
    context.readToolVersions()
  ]);
  assertAppliedMigrationPrefix(catalog, current.appliedMigrations);
  if (current.databaseIdentityFingerprint !== input.databaseIdentityFingerprint) {
    throw runnerError("RUNNER_DATABASE_IDENTITY_MISMATCH");
  }
  if (current.schemaOwner !== input.expectedOwner) {
    throw runnerError("SCHEMA_OWNER_MISMATCH");
  }
  const pendingMigrations = catalog.entries.slice(current.appliedMigrations.length);
  return Object.freeze({
    schemaVersion: "deterministic-plan.v1",
    identity: Object.freeze({
      planType: "migration-plan.v1",
      commandKey: "db.migrate.deploy@1",
      inputDigest: sha256Canonical(input),
      databaseIdentityFingerprint: input.databaseIdentityFingerprint,
      baselineManifestIdentityDigest: input.baselineManifestIdentityDigest,
      baselineManifestDigest: input.baselineManifestDigest,
      migrationCatalogDigest: catalog.digest,
      currentMigrationHead: current.migrationHead,
      pendingMigrations: Object.freeze(
        pendingMigrations.map((entry) => Object.freeze({ ...entry }))
      ),
      expectedPostMigrationHead: migrationName(catalog.entries.at(-1)),
      expectedSchemaDigest: input.expectedSchemaDigest,
      expectedOwner: input.expectedOwner,
      allowedExtensions: Object.freeze([...(input.allowedExtensions ?? [])].sort()),
      expectedWriteScope: Object.freeze(["_prisma_migrations", "schema-ddl"])
    }),
    provenance: Object.freeze({
      planner: "db.migrate.deploy@1",
      toolVersions: Object.freeze({ ...toolVersions })
    })
  });
}

function postcondition(id, expected, actual) {
  const expectedDigest = sha256Canonical(expected);
  const actualDigest = sha256Canonical(actual);
  return Object.freeze({
    id,
    status: expectedDigest === actualDigest ? "PASSED" : "FAILED",
    expectedDigest,
    actualDigest
  });
}

export async function applyMigration(context, approved) {
  assertRequiredFunction(context, "withMigrationLock");
  assertRequiredFunction(context, "executePrismaMigrateDeploy");
  return context.withMigrationLock(async () => {
    const currentPlan = await planMigration(context, approved.input);
    const currentPlanDigest = deterministicPlanDigest(currentPlan);
    if (currentPlanDigest !== approved.planDigest) {
      throw runnerError("PLAN_CHANGED_SINCE_APPROVAL", {
        approvedPlanDigest: approved.planDigest,
        currentPlanDigest
      });
    }
    if (currentPlan.identity.pendingMigrations.length > 0) {
      await context.executePrismaMigrateDeploy({
        timeoutMs: 1_800_000,
        expectedMigrations: currentPlan.identity.pendingMigrations
      });
    }
    const observation = await verifySchema(context, approved.input);
    const postconditions = [
      postcondition(
        "migration-head-equals-catalog-head",
        currentPlan.identity.expectedPostMigrationHead,
        observation.migrationHead
      ),
      postcondition("schema-diff-zero", { exitCode: 0, stdout: "" }, observation.schemaDiff),
      postcondition("schema-owner-matches", approved.input.expectedOwner, observation.schemaOwner),
      postcondition(
        "extensions-allowed",
        [...approved.input.allowedExtensions].sort(),
        [...observation.extensions].sort()
      )
    ];
    return buildPostStateObservation({
      operationId: approved.input.operationId,
      attemptId: approved.input.attemptId,
      runId: approved.input.runId,
      baselineManifestIdentityDigest: approved.input.baselineManifestIdentityDigest,
      baselineManifestDigest: approved.input.baselineManifestDigest,
      commandId: "db.migrate.deploy",
      commandVersion: "1",
      planDigest: approved.planDigest,
      databaseIdentityFingerprint: approved.input.databaseIdentityFingerprint,
      postMigrationHead: observation.migrationHead,
      postSchemaDigest: observation.schemaDigest,
      configurationFingerprint: sha256Canonical({
        schemaOwner: observation.schemaOwner,
        extensions: observation.extensions,
        toolVersions: observation.toolVersions
      }),
      postconditions,
      observedAt: (context.now?.() ?? new Date()).toISOString()
    });
  });
}

export async function dbMigrateDeployHandler({ baseline, request, database }) {
  if (request.phase === "dry-run") {
    const plan = await planMigration(database, request.input);
    return Object.freeze({
      baseline,
      plan,
      planDigest: deterministicPlanDigest(plan),
      terminalStatus: "PASSED"
    });
  }
  if (request.phase === "apply") {
    const postStateObservation = await applyMigration(database, {
      input: request.input,
      planDigest: request.planDigest
    });
    return Object.freeze({ baseline, postStateObservation, terminalStatus: "PASSED" });
  }
  if (request.phase === "replay" || request.phase === "reconcile") {
    const observation = await verifySchema(database, request.input);
    return Object.freeze({ baseline, observation, terminalStatus: "PASSED" });
  }
  throw runnerError("RUNNER_COMMAND_PHASE_UNSUPPORTED");
}
