import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCustodyComplete } from "./evidence-custody.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";
import { suiteDatabaseName } from "./database-target.mjs";

const countKeys = Object.freeze([
  "cancelled",
  "collected",
  "executed",
  "failed",
  "filtered",
  "passed",
  "selected",
  "skipped",
  "todo"
]);
const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

function launcherError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function validateManifest(manifest) {
  try {
    validateContract("database-test-manifest.v1", manifest);
  } catch (error) {
    throw launcherError("DATABASE_TEST_MANIFEST_INVALID", { causeCode: error?.code });
  }
  const suiteIds = new Set();
  const files = new Set();
  for (const suite of manifest.suites) {
    if (suiteIds.has(suite.suiteId)) {
      throw launcherError("DATABASE_TEST_SUITE_DUPLICATE", { suiteId: suite.suiteId });
    }
    suiteIds.add(suite.suiteId);
    for (const file of suite.files) {
      if (files.has(file)) throw launcherError("DATABASE_TEST_FILE_DUPLICATE", { file });
      files.add(file);
    }
  }
  const batchIds = new Set();
  for (const batch of manifest.batches) {
    if (batchIds.has(batch.batchId)) {
      throw launcherError("DATABASE_TEST_BATCH_DUPLICATE", { batchId: batch.batchId });
    }
    batchIds.add(batch.batchId);
    if (batch.suiteIds.some((suiteId) => !suiteIds.has(suiteId))) {
      throw launcherError("DATABASE_TEST_BATCH_SUITE_UNKNOWN", { batchId: batch.batchId });
    }
  }
}

function selectedIds(manifest, { suiteIds, batchId }) {
  if (suiteIds !== undefined && batchId !== undefined) {
    throw launcherError("DATABASE_TEST_SELECTION_AMBIGUOUS");
  }
  if (suiteIds !== undefined) {
    if (
      !Array.isArray(suiteIds) ||
      suiteIds.length === 0 ||
      new Set(suiteIds).size !== suiteIds.length
    ) {
      throw launcherError("DATABASE_TEST_SUITE_SELECTION_INVALID");
    }
    const known = new Set(manifest.suites.map(({ suiteId }) => suiteId));
    const unknown = suiteIds.find((suiteId) => !known.has(suiteId));
    if (unknown) throw launcherError("DATABASE_TEST_SUITE_UNKNOWN", { suiteId: unknown });
    return suiteIds;
  }
  if (batchId !== undefined) {
    const batch = manifest.batches.find((candidate) => candidate.batchId === batchId);
    if (!batch) throw launcherError("DATABASE_TEST_BATCH_UNKNOWN", { batchId });
    return batch.suiteIds;
  }
  return manifest.suites.map(({ suiteId }) => suiteId);
}

function commandFor(suite) {
  if (suite.runner === "node-test") {
    return Object.freeze({
      executable: "node",
      arguments: Object.freeze(["--test", "--test-reporter=tap", ...suite.files])
    });
  }
  if (suite.runner === "vitest") {
    const packageFiles = suite.files.map((file) => {
      const prefix = "apps/api/";
      if (!file.startsWith(prefix)) {
        throw launcherError("DATABASE_TEST_VITEST_FILE_OUTSIDE_API", { file });
      }
      return file.slice(prefix.length);
    });
    return Object.freeze({
      executable: "pnpm",
      arguments: Object.freeze([
        "--filter",
        "@subscription-saas/api",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        "--reporter=json",
        ...packageFiles
      ])
    });
  }
  throw launcherError("DATABASE_TEST_RUNNER_UNKNOWN", { runner: suite.runner });
}

export function selectManifestSuites({
  manifest,
  discoveryDigest,
  discoveryUnclassifiedCount,
  chain,
  suiteIds,
  batchId,
  runId,
  secretRootRef,
  callerFilePaths,
  frameworkViolations = []
}) {
  validateManifest(manifest);
  if (callerFilePaths !== undefined) {
    throw launcherError("DATABASE_TEST_CALLER_PATH_FORBIDDEN");
  }
  if (frameworkViolations.length > 0) {
    throw launcherError("DATABASE_TEST_FRAMEWORK_BYPASS", { violations: frameworkViolations });
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(discoveryDigest ?? "") || discoveryUnclassifiedCount !== 0) {
    throw launcherError("DATABASE_TEST_DISCOVERY_INCOMPLETE");
  }
  if (
    !["fresh", "snapshot"].includes(chain) ||
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof secretRootRef !== "string" ||
    secretRootRef.length === 0 ||
    path.isAbsolute(secretRootRef) ||
    secretRootRef.split(/[\\/]/).includes("..")
  ) {
    throw launcherError("DATABASE_TEST_SELECTION_INPUT_INVALID");
  }
  const manifestDigest = sha256Canonical(manifest);
  const byId = new Map(manifest.suites.map((suite) => [suite.suiteId, suite]));
  return Object.freeze(
    selectedIds(manifest, { suiteIds, batchId }).map((suiteId, index) => {
      const suite = byId.get(suiteId);
      if (suite.chainApplicability[chain].status !== "required") {
        throw launcherError("DATABASE_TEST_CHAIN_NOT_REQUIRED", { suiteId, chain });
      }
      const databaseName = suiteDatabaseName(runId, suiteId, index);
      const referenceRoot = `${secretRootRef.replaceAll("\\", "/")}/${suiteId}`;
      const additionalAssignments =
        suite.databaseTopology === "source-target"
          ? [
              Object.freeze({
                name: "source",
                suiteIdentity: `${suiteId}.source`,
                databaseName: suiteDatabaseName(runId, `${suiteId}.source`, index + 1000),
                shard: index + 1000,
                secretReferences: Object.freeze({
                  migrate: `${referenceRoot}/source/migrate.json`,
                  "runtime-test": `${referenceRoot}/source/runtime-test.json`,
                  ...(chain === "snapshot"
                    ? { restore: `${referenceRoot}/source/restore.json` }
                    : {})
                })
              })
            ]
          : [];
      return Object.freeze({
        suiteId,
        runId,
        chain,
        manifestDigest,
        discoveryDigest,
        files: Object.freeze([...suite.files]),
        assignment: Object.freeze({
          databaseName,
          shard: index,
          secretReferences: Object.freeze({
            migrate: `${referenceRoot}/migrate.json`,
            "runtime-test": `${referenceRoot}/runtime-test.json`,
            ...(chain === "snapshot" ? { restore: `${referenceRoot}/restore.json` } : {})
          })
        }),
        additionalAssignments: Object.freeze(additionalAssignments),
        command: commandFor(suite),
        timeoutMs: suite.timeoutMs,
        barrier: suite.barrier,
        parallelism: Object.freeze({ ...suite.parallelism }),
        expectedCountPolicy: Object.freeze({ ...suite.expectedCountPolicy }),
        fixtures: suite.fixtures ? Object.freeze({ ...suite.fixtures }) : undefined
      });
    })
  );
}

export function normalizeDatabaseTestCounts(value, expectedPolicy = { mode: "complete" }) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(countKeys) ||
    countKeys.some((key) => !Number.isInteger(value[key]) || value[key] < 0)
  ) {
    throw launcherError("DATABASE_TEST_COUNT_INCOMPLETE");
  }
  if (
    value.collected !== value.selected ||
    value.selected !== value.executed ||
    value.executed !== value.passed + value.failed ||
    value.skipped !== 0 ||
    value.todo !== 0 ||
    value.filtered !== 0 ||
    value.cancelled !== 0
  ) {
    throw launcherError("DATABASE_TEST_COUNT_EQUATION_FAILED", { counts: value });
  }
  if (expectedPolicy.mode === "exact" && value.collected !== expectedPolicy.collected) {
    throw launcherError("DATABASE_TEST_EXPECTED_COUNT_MISMATCH", {
      expected: expectedPolicy.collected,
      actual: value.collected
    });
  }
  return Object.freeze(Object.fromEntries(countKeys.map((key) => [key, value[key]])));
}

function assertProvisioned(execution, provisioned) {
  if (
    provisioned?.databaseName !== execution.assignment.databaseName ||
    provisioned?.secretReferences?.migrate !== execution.assignment.secretReferences.migrate ||
    provisioned?.secretReferences?.["runtime-test"] !==
      execution.assignment.secretReferences["runtime-test"] ||
    provisioned?.secretReferences?.restore !== execution.assignment.secretReferences.restore ||
    !/^[0-9]+$/.test(provisioned?.databaseOid ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(provisioned?.targetFingerprint ?? "")
  ) {
    throw launcherError("DATABASE_TEST_ASSIGNMENT_MISMATCH");
  }
  const additional = provisioned.additionalDatabases ?? [];
  if (
    additional.length !== execution.additionalAssignments.length ||
    additional.some((database, index) => {
      const expected = execution.additionalAssignments[index];
      return (
        database.name !== expected.name ||
        database.databaseName !== expected.databaseName ||
        database.secretReferences?.migrate !== expected.secretReferences.migrate ||
        database.secretReferences?.["runtime-test"] !== expected.secretReferences["runtime-test"] ||
        database.secretReferences?.restore !== expected.secretReferences.restore ||
        !/^[0-9]+$/.test(database.databaseOid ?? "") ||
        !/^sha256:[0-9a-f]{64}$/.test(database.targetFingerprint ?? "")
      );
    })
  ) {
    throw launcherError("DATABASE_TEST_ADDITIONAL_ASSIGNMENT_MISMATCH");
  }
}

function assertFixtureObservations(execution, observations) {
  if (!execution.fixtures) {
    if (observations !== undefined) {
      throw launcherError("DATABASE_TEST_FIXTURE_OBSERVATION_UNEXPECTED");
    }
    return;
  }
  const expectedNames = ["target", ...execution.additionalAssignments.map(({ name }) => name)];
  const boundaryKeys = [
    "bypassrls",
    "canCreateSchema",
    "createdb",
    "createrole",
    "objectOwner",
    "schemaOwner",
    "superuser"
  ];
  if (
    !Array.isArray(observations) ||
    observations.length !== expectedNames.length ||
    observations.some(
      (entry, index) =>
        entry?.database !== expectedNames[index] ||
        entry?.migration?.schemaVersion !== "fixture-observation.v1" ||
        entry.migration.capability !== "migration" ||
        entry?.runtime?.schemaVersion !== "fixture-observation.v1" ||
        entry.runtime.capability !== "runtime-test" ||
        entry.migration.credentialFingerprint === entry.runtime.credentialFingerprint ||
        JSON.stringify(Object.keys(entry.roleBoundary ?? {}).sort()) !==
          JSON.stringify(boundaryKeys) ||
        Object.values(entry.roleBoundary ?? {}).some((value) => value !== false)
    )
  ) {
    throw launcherError("DATABASE_TEST_FIXTURE_OBSERVATION_INVALID");
  }
}

function assertRoleBoundaries(execution, observations) {
  const expectedNames = ["target", ...execution.additionalAssignments.map(({ name }) => name)];
  const attributeKeys = ["bypassrls", "createdb", "createrole", "superuser"];
  if (
    !Array.isArray(observations) ||
    observations.length !== expectedNames.length ||
    observations.some(
      (entry, index) =>
        entry?.database !== expectedNames[index] ||
        JSON.stringify(Object.keys(entry.roleAttributes ?? {}).sort()) !==
          JSON.stringify(attributeKeys) ||
        Object.values(entry.roleAttributes ?? {}).some((value) => value !== false) ||
        entry.canCreateSchema !== false ||
        entry.schemaOwner !== false ||
        entry.objectOwner !== false
    )
  ) {
    throw launcherError("DATABASE_TEST_RUNTIME_ROLE_BOUNDARY_INVALID");
  }
  return new Map(observations.map((entry) => [entry.database, entry]));
}

function roleBoundaryReport(entry) {
  return {
    roleAttributes: entry.roleAttributes,
    canCreateSchema: entry.canCreateSchema,
    schemaOwner: entry.schemaOwner,
    objectOwner: entry.objectOwner
  };
}

export async function runDatabaseSuite({
  execution,
  provision,
  deployMigrations,
  grantRuntimeAccess,
  executeTest,
  custody,
  cleanup,
  operationId
}) {
  if (
    typeof provision !== "function" ||
    typeof deployMigrations !== "function" ||
    typeof grantRuntimeAccess !== "function" ||
    typeof executeTest !== "function" ||
    typeof custody !== "function" ||
    typeof cleanup !== "function" ||
    typeof operationId !== "string" ||
    operationId.length === 0
  ) {
    throw launcherError("DATABASE_TEST_EXECUTION_INPUT_INVALID");
  }
  const provisioned = await provision(execution);
  assertProvisioned(execution, provisioned);
  await deployMigrations({ execution, provisioned });
  await grantRuntimeAccess({ execution, provisioned });
  const result = await executeTest({ execution, provisioned });
  const counts = normalizeDatabaseTestCounts(result?.counts, execution.expectedCountPolicy);
  assertFixtureObservations(execution, result?.fixtureObservations);
  const roleBoundaries = assertRoleBoundaries(execution, result?.roleBoundaries);
  if (!/^sha256:[0-9a-f]{64}$/.test(result?.sanitizedLogDigest ?? "")) {
    throw launcherError("DATABASE_TEST_LOG_DIGEST_INVALID");
  }
  const report = Object.freeze({
    schemaVersion: "database-suite-report.v1",
    operationId,
    runId: execution.runId,
    suiteId: execution.suiteId,
    chain: execution.chain,
    manifestDigest: execution.manifestDigest,
    discoveryDigest: execution.discoveryDigest,
    target: Object.freeze({
      databaseName: provisioned.databaseName,
      databaseOid: provisioned.databaseOid,
      targetFingerprint: provisioned.targetFingerprint,
      ...roleBoundaryReport(roleBoundaries.get("target"))
    }),
    ...(provisioned.additionalDatabases?.length
      ? {
          additionalDatabases: Object.freeze(
            provisioned.additionalDatabases.map((database) =>
              Object.freeze({
                name: database.name,
                databaseName: database.databaseName,
                databaseOid: database.databaseOid,
                targetFingerprint: database.targetFingerprint,
                ...roleBoundaryReport(roleBoundaries.get(database.name))
              })
            )
          )
        }
      : {}),
    counts,
    ...(result.fixtureObservations
      ? { fixtureObservations: Object.freeze([...result.fixtureObservations]) }
      : {}),
    sanitizedLogDigest: result.sanitizedLogDigest,
    terminalStatus: counts.failed === 0 ? "PASSED" : "FAILED"
  });
  const reportDigest = sha256Canonical(report);
  const custodyReceipt = await custody({ report, digest: reportDigest, execution, provisioned });
  assertCustodyComplete(custodyReceipt, reportDigest);
  await cleanup({ execution, provisioned, custodyReceipt });
  return report;
}

function addCounts(reports) {
  return Object.freeze(
    Object.fromEntries(
      countKeys.map((key) => [
        key,
        reports.reduce((total, report) => total + report.counts[key], 0)
      ])
    )
  );
}

function assertSuiteReportMatches(selection, report) {
  const additionalReports = report?.additionalDatabases ?? [];
  if (
    report?.schemaVersion !== "database-suite-report.v1" ||
    report.runId !== selection.runId ||
    report.suiteId !== selection.suiteId ||
    report.chain !== selection.chain ||
    report.manifestDigest !== selection.manifestDigest ||
    report.discoveryDigest !== selection.discoveryDigest ||
    report.target?.databaseName !== selection.assignment.databaseName ||
    additionalReports.length !== selection.additionalAssignments.length ||
    additionalReports.some((database, index) => {
      const expected = selection.additionalAssignments[index];
      return database.name !== expected.name || database.databaseName !== expected.databaseName;
    })
  ) {
    throw launcherError("DATABASE_TEST_SUITE_REPORT_MISMATCH", {
      suiteId: selection.suiteId
    });
  }
}

export async function runDatabaseManifest({ selections, executeSuite, concurrency = 1 }) {
  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    typeof executeSuite !== "function" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    (concurrency > 1 && selections.some(({ parallelism }) => parallelism?.mode !== "parallel"))
  ) {
    throw launcherError("DATABASE_TEST_MANIFEST_EXECUTION_INVALID");
  }
  const [first] = selections;
  if (
    selections.some(
      (selection) =>
        selection.runId !== first.runId ||
        selection.chain !== first.chain ||
        selection.manifestDigest !== first.manifestDigest ||
        selection.discoveryDigest !== first.discoveryDigest
    )
  ) {
    throw launcherError("DATABASE_TEST_MANIFEST_SELECTION_MISMATCH");
  }
  const suiteReports = new Array(selections.length);
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < selections.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const report = await executeSuite(selections[index]);
        assertSuiteReportMatches(selections[index], report);
        suiteReports[index] = report;
      } catch (error) {
        failures.push({ index, error });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selections.length) }, () => worker())
  );
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0].error;
  }
  const counts = addCounts(suiteReports);
  const report = {
    schemaVersion: "database-test-manifest-report.v1",
    runId: first.runId,
    chain: first.chain,
    manifestDigest: first.manifestDigest,
    discoveryDigest: first.discoveryDigest,
    suiteReports,
    counts,
    sanitizedLogDigest: sha256Canonical(
      suiteReports.map(({ sanitizedLogDigest }) => sanitizedLogDigest)
    ),
    terminalStatus: suiteReports.every(({ terminalStatus }) => terminalStatus === "PASSED")
      ? "PASSED"
      : "FAILED"
  };
  validateContract("database-test-manifest-report.v1", report);
  return Object.freeze(report);
}

export function runSourceDatabaseGate({
  manifestReport,
  sourceSha,
  migrationCatalogDigest,
  repositoryContractDigest,
  postgres,
  schemaDiffDigest,
  migrationStatusDigest,
  snapshot,
  provenance
}) {
  try {
    validateContract("database-test-manifest-report.v1", manifestReport);
  } catch (error) {
    throw launcherError("DATABASE_TEST_MANIFEST_REPORT_INVALID", {
      causeCode: error?.code
    });
  }
  const counts = normalizeDatabaseTestCounts(manifestReport.counts);
  const aggregateCounts = addCounts(manifestReport.suiteReports);
  if (sha256Canonical(counts) !== sha256Canonical(aggregateCounts)) {
    throw launcherError("DATABASE_TEST_COUNT_EQUATION_FAILED", {
      counts,
      aggregateCounts
    });
  }
  if (counts.failed !== 0 || manifestReport.terminalStatus !== "PASSED") {
    throw launcherError("DATABASE_TEST_SOURCE_GATE_FAILED", {
      counts,
      terminalStatus: manifestReport.terminalStatus
    });
  }
  if (
    (manifestReport.chain === "snapshot" &&
      (snapshot === null ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        [
          "snapshotMetadataDigest",
          "snapshotBundleDigest",
          "sourceMigrationHead",
          "ownershipMapDigest",
          "ownershipObservationDigest"
        ].some((field) => typeof snapshot[field] !== "string" || snapshot[field].length === 0))) ||
    (manifestReport.chain === "fresh" && snapshot !== undefined)
  ) {
    throw launcherError("DATABASE_TEST_SNAPSHOT_EVIDENCE_INVALID");
  }
  const evidence = {
    schemaVersion: "source-gate-evidence.v1",
    sourceSha,
    migrationCatalogDigest,
    repositoryContractDigest,
    databaseTestManifestDigest: manifestReport.manifestDigest,
    databaseTestDiscoveryDigest: manifestReport.discoveryDigest,
    postgres,
    chain: manifestReport.chain,
    counts,
    terminalStatus: manifestReport.terminalStatus,
    schemaDiffDigest,
    migrationStatusDigest,
    ...(snapshot ? { snapshot } : {}),
    sanitizedLogDigest: manifestReport.sanitizedLogDigest,
    provenance
  };
  validateContract("source-gate-evidence.v1", evidence);
  return Object.freeze(evidence);
}

function resolvedLocalReference(repoRoot, reference, suffixPattern) {
  if (
    typeof reference !== "string" ||
    path.isAbsolute(reference) ||
    reference.split(/[\\/]/).includes("..") ||
    !suffixPattern.test(reference.replaceAll("\\", "/"))
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_REFERENCE_INVALID");
  }
  const absolute = path.resolve(repoRoot, reference);
  const allowedRoot = path.resolve(repoRoot, ".release-local", "runs");
  const relative = path.relative(allowedRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_REFERENCE_INVALID");
  }
  return absolute;
}

function defaultLoadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_INVALID");
  }
}

function databaseUrl(secret) {
  return `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${encodeURIComponent(secret.database)}?sslmode=${encodeURIComponent(secret.tlsMode)}`;
}

function loadRuntimeDatabase({ context, repoRoot, loadJson }) {
  const secretPath = resolvedLocalReference(
    repoRoot,
    context.runtimeSecretReference,
    /\/runtime-test\.json$/
  );
  const secret = loadJson(secretPath);
  if (
    !/^s1ci_[0-9a-f]{24}$/.test(context.databaseName ?? "") ||
    !/^[0-9]+$/.test(context.databaseOid ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(context.targetFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(context.runtimeCredentialFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(context.migrationCredentialFingerprint ?? "") ||
    context.runtimeCredentialFingerprint === context.migrationCredentialFingerprint ||
    typeof secret?.username !== "string" ||
    !/^s1r_[0-9a-f]{24}$/.test(secret.username) ||
    typeof secret.password !== "string" ||
    secret.password.length < 16 ||
    sha256Bytes(Buffer.from(secret.password, "utf8")) !== context.runtimeCredentialFingerprint ||
    secret.database !== context.databaseName ||
    secret.host !== "127.0.0.1" ||
    !Number.isInteger(secret.port) ||
    secret.port < 1 ||
    secret.port > 65535 ||
    secret.tlsMode !== "disable"
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_SECRET_INVALID");
  }
  return Object.freeze({
    ...context,
    databaseUrl: databaseUrl(secret),
    runtimeCredential: Object.freeze({ username: secret.username, password: secret.password })
  });
}

export function requiredReleaseDatabaseTestContext(
  moduleUrl,
  { environment = process.env, repoRoot = defaultRepositoryRoot, loadJson = defaultLoadJson } = {}
) {
  if (environment.S1_RELEASE_DATABASE_TEST !== "1") {
    throw launcherError("RELEASE_DATABASE_TEST_LAUNCHER_REQUIRED");
  }
  const contextPath = resolvedLocalReference(
    repoRoot,
    environment.S1_RELEASE_DATABASE_CONTEXT,
    /\/context\.json$/
  );
  const context = loadJson(contextPath);
  if (
    context?.schemaVersion !== "release-database-test-context.v1" ||
    !Array.isArray(context.allowedFiles) ||
    context.allowedFiles.length === 0 ||
    !/^[0-9a-f]{12,64}$/.test(context.containerId ?? "")
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_INVALID");
  }
  const caller = (
    String(moduleUrl).startsWith("file:")
      ? fileURLToPath(moduleUrl)
      : path.resolve(repoRoot, String(moduleUrl))
  ).replaceAll("\\", "/");
  if (!context.allowedFiles.some((file) => caller.endsWith(`/${file}`))) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_CALLER_FORBIDDEN");
  }
  const primary = loadRuntimeDatabase({ context, repoRoot, loadJson });
  if (context.namedDatabases === undefined) return primary;
  if (
    context.namedDatabases === null ||
    typeof context.namedDatabases !== "object" ||
    Array.isArray(context.namedDatabases) ||
    JSON.stringify(Object.keys(context.namedDatabases).sort()) !==
      JSON.stringify(["source", "target"])
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_INVALID");
  }
  const namedDatabases = Object.freeze(
    Object.fromEntries(
      Object.entries(context.namedDatabases).map(([name, database]) => [
        name,
        loadRuntimeDatabase({ context: database, repoRoot, loadJson })
      ])
    )
  );
  if (
    namedDatabases.target.databaseName !== primary.databaseName ||
    namedDatabases.target.databaseOid !== primary.databaseOid ||
    namedDatabases.target.targetFingerprint !== primary.targetFingerprint ||
    namedDatabases.target.runtimeCredentialFingerprint !== primary.runtimeCredentialFingerprint ||
    namedDatabases.source.databaseName === namedDatabases.target.databaseName ||
    namedDatabases.source.runtimeCredentialFingerprint ===
      namedDatabases.target.runtimeCredentialFingerprint
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_INVALID");
  }
  return Object.freeze({ ...primary, namedDatabases });
}
