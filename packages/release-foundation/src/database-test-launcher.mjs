import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCustodyComplete } from "./evidence-custody.mjs";
import { sha256Canonical } from "./digest.mjs";
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
        ...suite.files
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
            "runtime-test": `${referenceRoot}/runtime-test.json`
          })
        }),
        command: commandFor(suite),
        timeoutMs: suite.timeoutMs,
        barrier: suite.barrier,
        expectedCountPolicy: Object.freeze({ ...suite.expectedCountPolicy })
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
    !/^[0-9]+$/.test(provisioned?.databaseOid ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(provisioned?.targetFingerprint ?? "")
  ) {
    throw launcherError("DATABASE_TEST_ASSIGNMENT_MISMATCH");
  }
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
      targetFingerprint: provisioned.targetFingerprint
    }),
    counts,
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
  if (
    report?.schemaVersion !== "database-suite-report.v1" ||
    report.runId !== selection.runId ||
    report.suiteId !== selection.suiteId ||
    report.chain !== selection.chain ||
    report.manifestDigest !== selection.manifestDigest ||
    report.discoveryDigest !== selection.discoveryDigest ||
    report.target?.databaseName !== selection.assignment.databaseName
  ) {
    throw launcherError("DATABASE_TEST_SUITE_REPORT_MISMATCH", {
      suiteId: selection.suiteId
    });
  }
}

export async function runDatabaseManifest({ selections, executeSuite }) {
  if (!Array.isArray(selections) || selections.length === 0 || typeof executeSuite !== "function") {
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
  const suiteReports = [];
  for (const selection of selections) {
    const report = await executeSuite(selection);
    assertSuiteReportMatches(selection, report);
    suiteReports.push(report);
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
  provenance
}) {
  try {
    validateContract("database-test-manifest-report.v1", manifestReport);
  } catch (error) {
    throw launcherError("DATABASE_TEST_MANIFEST_REPORT_INVALID", {
      causeCode: error?.code
    });
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
    counts: manifestReport.counts,
    terminalStatus: manifestReport.terminalStatus,
    schemaDiffDigest,
    migrationStatusDigest,
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

export function requiredReleaseDatabaseTestContext(
  moduleUrl,
  { environment = process.env, repoRoot = process.cwd(), loadJson = defaultLoadJson } = {}
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
    !/^s1ci_[0-9a-f]{24}$/.test(context.databaseName ?? "") ||
    !/^[0-9]+$/.test(context.databaseOid ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(context.targetFingerprint ?? "") ||
    !/^[0-9a-f]{12,64}$/.test(context.containerId ?? "")
  ) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_INVALID");
  }
  const caller = fileURLToPath(moduleUrl).replaceAll("\\", "/");
  if (!context.allowedFiles.some((file) => caller.endsWith(`/${file}`))) {
    throw launcherError("RELEASE_DATABASE_TEST_CONTEXT_CALLER_FORBIDDEN");
  }
  const secretPath = resolvedLocalReference(
    repoRoot,
    context.runtimeSecretReference,
    /\/runtime-test\.json$/
  );
  const secret = loadJson(secretPath);
  if (
    typeof secret?.username !== "string" ||
    !/^s1r_[0-9a-f]{24}$/.test(secret.username) ||
    typeof secret.password !== "string" ||
    secret.password.length < 16 ||
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
