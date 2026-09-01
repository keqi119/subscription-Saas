import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertApprovedEphemeralTarget,
  classifyDatabaseTests,
  cleanupSuiteDatabase,
  computeMigrationCatalog,
  computeRepositoryContract,
  custodyEvidence,
  discoverDatabaseTestCandidates,
  grantRuntimeEquivalentAccess,
  provisionSuiteDatabase,
  redactEvidence,
  runDatabaseManifest,
  runDatabaseSuite,
  runRuntimeSeedFixture,
  runSchemaFixture,
  runSourceDatabaseGate,
  selectManifestSuites,
  sha256Canonical,
  sha256Bytes
} from "../../packages/release-foundation/src/index.mjs";
import { executeDockerCommand, hardenOwnerOnlyFile } from "./bootstrap-controlled-postgres.mjs";

const repoRoot = process.cwd();

function runtimeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, ...relativePath.split("/")), "utf8"));
}

function sanitizedEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /DATABASE_URL$/i.test(key) ||
      /^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$/i.test(key)
    ) {
      delete environment[key];
    }
  }
  return { ...environment, ...overrides };
}

function resolvedCommand(executable, arguments_) {
  if (executable === "node") return { executable: process.execPath, arguments: arguments_ };
  if (process.platform === "win32" && executable === "pnpm") {
    return {
      executable: process.execPath,
      arguments: [
        path.join(path.dirname(process.execPath), "node_modules/corepack/dist/pnpm.js"),
        ...arguments_
      ]
    };
  }
  return { executable, arguments: arguments_ };
}

async function runProcess(executable, arguments_, { environment, timeoutMs = 120000 } = {}) {
  const resolved = resolvedCommand(executable, arguments_);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, resolved.arguments, {
      cwd: repoRoot,
      env: environment ?? sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function databaseUrl(secret) {
  return `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${encodeURIComponent(secret.database)}?sslmode=${encodeURIComponent(secret.tlsMode)}`;
}

function rowsFromOutput(output, columns) {
  if (!output.trim()) return [];
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value]))
    );
}

async function executePsql({ containerId, credential, databaseName, sql, columns = [] }) {
  const output = await executeDockerCommand({
    args: [
      "exec",
      "--interactive",
      "--env",
      "PGPASSWORD",
      containerId,
      "psql",
      "--host",
      "127.0.0.1",
      "--username",
      credential.username,
      "--dbname",
      databaseName,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "\t"
    ],
    environment: { PGPASSWORD: credential.password },
    input: `${sql}\n`
  });
  return { rows: rowsFromOutput(output, columns) };
}

async function waitForPostgres(containerId, username) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await executeDockerCommand({
        args: ["exec", containerId, "pg_isready", "--username", username, "--dbname", "postgres"]
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw runtimeError("DATABASE_LAUNCHER_POSTGRES_NOT_READY");
}

async function startCluster(runId, imageContract, policy) {
  const clusterRoot = path.join(repoRoot, ".release-local", "runs", runId, "cluster");
  await mkdir(clusterRoot, { recursive: true });
  const bootstrapPassword = randomBytes(24).toString("hex");
  const passwordFile = path.join(clusterRoot, "bootstrap-password");
  await writeFile(passwordFile, bootstrapPassword, { mode: 0o600 });
  await hardenOwnerOnlyFile(passwordFile);
  const provisioner = {
    username: `s1p_${randomBytes(12).toString("hex")}`,
    password: bootstrapPassword
  };
  const image = `${imageContract.repository}@${imageContract.resolvedDigest}`;
  let containerId;
  try {
    containerId = (
      await executeDockerCommand({
        args: [
          "run",
          "--detach",
          "--platform",
          imageContract.platform,
          "--label",
          "subscription-s1-controlled=v1",
          "--label",
          "subscription-s1-launcher=v1",
          "--label",
          `subscription-s1-launcher.run-id=${runId}`,
          "--env",
          `POSTGRES_USER=${provisioner.username}`,
          "--env",
          "POSTGRES_PASSWORD_FILE=/run/secrets/bootstrap-password",
          "--env",
          "POSTGRES_DB=postgres",
          "--mount",
          `type=bind,source=${passwordFile},target=/run/secrets/bootstrap-password,readonly`,
          "--publish",
          "127.0.0.1::5432",
          image
        ]
      })
    ).trim();
    if (!/^[0-9a-f]{64}$/.test(containerId)) {
      throw runtimeError("DATABASE_LAUNCHER_CONTAINER_ID_INVALID");
    }
    await waitForPostgres(containerId, provisioner.username);
    const [inspected] = JSON.parse(await executeDockerCommand({ args: ["inspect", containerId] }));
    if (
      inspected?.Id !== containerId ||
      inspected?.Config?.Image !== image ||
      inspected?.Config?.Labels?.["subscription-s1-controlled"] !== "v1" ||
      inspected?.Config?.Labels?.["subscription-s1-launcher.run-id"] !== runId
    ) {
      throw runtimeError("DATABASE_LAUNCHER_CONTAINER_IDENTITY_MISMATCH");
    }
    const hostPort = Number(inspected?.NetworkSettings?.Ports?.["5432/tcp"]?.[0]?.HostPort);
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      throw runtimeError("DATABASE_LAUNCHER_PORT_INVALID");
    }
    const version = await executePsql({
      containerId,
      credential: provisioner,
      databaseName: "postgres",
      sql: "SHOW server_version_num;",
      columns: ["serverVersionNum"]
    });
    const serverVersionNum = version.rows[0]?.serverVersionNum;
    const target = {
      policyId: policy.policyId,
      environment: "local-controlled",
      host: "127.0.0.1",
      clusterMarker: "subscription-s1-controlled/v1",
      clusterFingerprint: sha256Canonical({ containerId, image, runId }),
      imageDigest: imageContract.resolvedDigest,
      serverVersionNum
    };
    assertApprovedEphemeralTarget(target, policy);
    return { clusterRoot, containerId, hostPort, provisioner, image, target };
  } catch (error) {
    if (containerId && /^[0-9a-f]{64}$/.test(containerId)) {
      await executeDockerCommand({ args: ["rm", "--force", containerId] }).catch(() => {});
    }
    await rm(clusterRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertExactContainer(cluster, runId) {
  const [inspected] = JSON.parse(
    await executeDockerCommand({ args: ["inspect", cluster.containerId] })
  );
  if (
    inspected?.Id !== cluster.containerId ||
    inspected?.Config?.Image !== cluster.image ||
    inspected?.Config?.Labels?.["subscription-s1-launcher.run-id"] !== runId
  ) {
    throw runtimeError("DATABASE_LAUNCHER_CONTAINER_IDENTITY_MISMATCH");
  }
}

async function removeSuccessfulCluster(cluster, runId) {
  await assertExactContainer(cluster, runId);
  await executeDockerCommand({ args: ["rm", "--force", cluster.containerId] });
  await rm(path.join(repoRoot, ".release-local", "runs", runId), {
    recursive: true,
    force: true
  });
}

async function createSecretStore(execution, cluster) {
  const migratePath = path.resolve(repoRoot, execution.assignment.secretReferences.migrate);
  const runtimePath = path.resolve(repoRoot, execution.assignment.secretReferences["runtime-test"]);
  const suiteRoot = path.dirname(migratePath);
  const allowedRoot = path.resolve(repoRoot, ".release-local", "runs", execution.runId);
  const relative = path.relative(allowedRoot, suiteRoot);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(runtimePath) !== suiteRoot
  ) {
    throw runtimeError("DATABASE_LAUNCHER_SECRET_REFERENCE_INVALID");
  }
  await mkdir(suiteRoot, { recursive: true });
  return {
    suiteRoot,
    async create({ profile, databaseName, username }) {
      const expectedReference = execution.assignment.secretReferences[profile];
      if (!expectedReference) throw runtimeError("DATABASE_LAUNCHER_SECRET_PROFILE_INVALID");
      const absolute = path.resolve(repoRoot, expectedReference);
      if (path.dirname(absolute) !== suiteRoot) {
        throw runtimeError("DATABASE_LAUNCHER_SECRET_REFERENCE_INVALID");
      }
      const secret = {
        username,
        password: randomBytes(24).toString("hex"),
        database: databaseName,
        host: "127.0.0.1",
        port: cluster.hostPort,
        tlsMode: "disable"
      };
      await writeFile(absolute, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
      await hardenOwnerOnlyFile(absolute);
      return { reference: expectedReference, username, password: secret.password };
    }
  };
}

async function readSecret(reference) {
  const absolute = path.resolve(repoRoot, reference);
  const allowedRoot = path.resolve(repoRoot, ".release-local", "runs");
  const relative = path.relative(allowedRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeError("DATABASE_LAUNCHER_SECRET_REFERENCE_INVALID");
  }
  return JSON.parse(await readFile(absolute, "utf8"));
}

async function prismaCommand(secret, arguments_, timeoutMs) {
  const result = await runProcess(
    "pnpm",
    ["--filter", "@subscription-saas/api", "exec", "prisma", ...arguments_],
    {
      timeoutMs,
      environment: sanitizedEnvironment({
        DATABASE_URL: databaseUrl(secret),
        STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
      })
    }
  );
  if (result.code !== 0 || result.signal) {
    throw runtimeError("DATABASE_LAUNCHER_PRISMA_FAILED", {
      command: arguments_[0],
      exitCode: result.code
    });
  }
  return redactEvidence(
    { stdout: result.stdout, stderr: result.stderr },
    {
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retentionDays: 180,
      expiryDisposition: "review"
    }
  );
}

async function generatePrismaClient() {
  const result = await runProcess(
    "pnpm",
    ["--filter", "@subscription-saas/api", "prisma:generate"],
    {
      timeoutMs: 120000,
      environment: sanitizedEnvironment({
        STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
      })
    }
  );
  if (result.code !== 0 || result.signal) {
    throw runtimeError("DATABASE_LAUNCHER_PRISMA_GENERATE_FAILED", {
      exitCode: result.code
    });
  }
}

async function observeRuntimeRoleBoundary({ cluster, resource, runtimeSecret }) {
  const result = await executePsql({
    containerId: cluster.containerId,
    credential: runtimeSecret,
    databaseName: resource.record.databaseName,
    sql: [
      'SELECT r.rolsuper AS "superuser",',
      '       r.rolcreatedb AS "createdb",',
      '       r.rolcreaterole AS "createrole",',
      '       r.rolbypassrls AS "bypassrls",',
      "       has_database_privilege(current_user, current_database(), 'CREATE') AS \"canCreateSchema\",",
      '       EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid) AS "schemaOwner",',
      '       EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) AS "objectOwner"',
      "FROM pg_roles AS r WHERE r.rolname = current_user;"
    ].join("\n"),
    columns: [
      "superuser",
      "createdb",
      "createrole",
      "bypassrls",
      "canCreateSchema",
      "schemaOwner",
      "objectOwner"
    ]
  });
  const boundary = result.rows[0];
  if (!boundary || Object.values(boundary).some((value) => value !== "f")) {
    throw runtimeError("DATABASE_TEST_RUNTIME_ROLE_BOUNDARY_FAILED", {
      database: resource.name
    });
  }
  return Object.freeze({
    database: resource.name,
    roleAttributes: Object.freeze({
      superuser: false,
      createdb: false,
      createrole: false,
      bypassrls: false
    }),
    canCreateSchema: false,
    schemaOwner: false,
    objectOwner: false
  });
}

function tapCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} ([0-9]+)$`, "gm"))];
  const value = Number(matches.at(-1)?.[1]);
  if (!Number.isInteger(value)) throw runtimeError("DATABASE_TEST_COUNT_INCOMPLETE", { label });
  return value;
}

function tapCounts(output) {
  const collected = tapCount(output, "tests");
  const passed = tapCount(output, "pass");
  const failed = tapCount(output, "fail");
  return {
    collected,
    selected: collected,
    executed: passed + failed,
    passed,
    failed,
    skipped: tapCount(output, "skipped"),
    todo: tapCount(output, "todo"),
    filtered: 0,
    cancelled: tapCount(output, "cancelled")
  };
}

function vitestJsonReport(output) {
  const trimmed = output.trim();
  const jsonReport = trimmed
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("{") && line.includes('"numTotalTests"'));
  if (!jsonReport) return undefined;
  try {
    return JSON.parse(jsonReport);
  } catch {
    throw runtimeError("DATABASE_TEST_COUNT_INCOMPLETE", { reporter: "vitest-json" });
  }
}

function testCounts(output) {
  const report = vitestJsonReport(output);
  if (report) {
    const values = [
      report.numTotalTests,
      report.numPassedTests,
      report.numFailedTests,
      report.numPendingTests,
      report.numTodoTests
    ];
    if (values.some((value) => !Number.isInteger(value) || value < 0)) {
      throw runtimeError("DATABASE_TEST_COUNT_INCOMPLETE", { reporter: "vitest-json" });
    }
    return {
      collected: report.numTotalTests,
      selected: report.numTotalTests,
      executed: report.numPassedTests + report.numFailedTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests,
      todo: report.numTodoTests,
      filtered: 0,
      cancelled: 0
    };
  }
  return tapCounts(output);
}

export function summarizeDatabaseTestLog({ stdout, stderr }) {
  const report = vitestJsonReport(stdout);
  const summary = {
    schemaVersion: "database-test-log-summary.v1",
    stdoutDigest: sha256Bytes(Buffer.from(stdout, "utf8")),
    stderrDigest: sha256Bytes(Buffer.from(stderr, "utf8")),
    stdoutSizeBytes: Buffer.byteLength(stdout),
    stderrSizeBytes: Buffer.byteLength(stderr)
  };
  if (!report) return summary;
  return {
    ...summary,
    reporter: "vitest-json",
    counts: testCounts(stdout),
    failedTests: report.testResults.flatMap(({ assertionResults = [] }) =>
      assertionResults
        .filter(({ status }) => status === "failed")
        .map((assertion) => {
          const { failureMessages = [], fullName } = assertion;
          const failureText = failureMessages.join("\n");
          const failureHint = failureText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0)
            ?.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi, "[URI]")
            .replace(
              /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
              "[UUID]"
            )
            .replace(/\b1[3-9][0-9]{9}\b/g, "[PHONE]")
            .replace(/\b[0-9a-f]{64}\b/gi, "[DIGEST]")
            .slice(0, 240);
          const failureKinds = [
            [/test timed out|timed out waiting|timeout/i, "TIMEOUT"],
            [/barrier/i, "BARRIER"],
            [/assertionerror|expected .* (?:to|but)/i, "ASSERTION"],
            [/prismaclient/i, "PRISMA"],
            [/httpexception|\bstatus:\s*(?:4|5)\d\d\b/i, "HTTP"]
          ]
            .filter(([pattern]) => pattern.test(failureText))
            .map(([, kind]) => kind);
          return {
            fullName,
            assertionFields: Object.keys(assertion).sort(),
            failureDetailTypes: Array.isArray(assertion.failureDetails)
              ? assertion.failureDetails.map((detail) => detail?.name ?? typeof detail)
              : [],
            failureHint: failureHint ?? null,
            locations: [
              ...new Set(
                [...failureText.matchAll(/([a-z0-9._-]+\.(?:spec|test)\.[cm]?[jt]s):(\d+):(\d+)/gi)]
                  .map(([, file, line, column]) => `${file}:${line}:${column}`)
                  .slice(0, 4)
              )
            ],
            errorCodes: [
              ...new Set([
                ...[...failureText.matchAll(/\bP\d{4}\b/g)].map(([code]) => code),
                ...[...failureText.matchAll(/\b(?:23|40|55)[0-9A-Z]{3}\b/g)].map(([code]) => code)
              ])
            ],
            failureKinds,
            domainCodes: [
              ...new Set(
                [...failureText.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){2,}\b/g)]
                  .map(([code]) => code)
                  .filter((code) => code.length <= 96)
              )
            ].slice(0, 8)
          };
        })
    )
  };
}

function localCustodyStorage() {
  const root = path.join(repoRoot, ".release-local", "evidence");
  return {
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "local-controlled-nonpromotable-writer",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      const absolute = path.join(root, ...key.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      let handle;
      try {
        handle = await open(absolute, "wx", 0o400);
        await handle.writeFile(bytes);
      } catch (error) {
        if (error?.code === "EEXIST") throw runtimeError("EVIDENCE_OVERWRITE_REFUSED");
        throw error;
      } finally {
        await handle?.close();
      }
      return {
        created: true,
        storeRef: `local-controlled-nonpromotable://${key}`,
        contentSizeBytes: Buffer.byteLength(bytes),
        storedAt: requestedAt,
        retainUntil
      };
    },
    async read({ key, identity }) {
      if (identity !== "audit-reader") throw runtimeError("EVIDENCE_AUDIT_READER_REQUIRED");
      try {
        return await readFile(path.join(root, ...key.split("/")));
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    }
  };
}

async function loadSelectionInputs() {
  const [manifest, discovery, exceptions, external, imageContract, policies] = await Promise.all([
    loadJson("release/contracts/database-test-manifest.v1.json"),
    loadJson("release/contracts/database-test-discovery.v1.json"),
    loadJson("release/contracts/database-test-exceptions.v1.json"),
    loadJson("release/contracts/external-validation-applicability.v1.json"),
    loadJson("release/contracts/postgres-image.v1.json"),
    loadJson("release/contracts/database-target-policies.v1.json")
  ]);
  const candidates = await discoverDatabaseTestCandidates(repoRoot, discovery);
  const classification = classifyDatabaseTests(
    candidates,
    manifest.suites,
    exceptions.exceptions,
    external.records
  );
  return {
    manifest,
    discoveryDigest: sha256Canonical(discovery),
    discoveryUnclassifiedCount: classification.unclassified.length,
    imageContract,
    policy: policies.policies.find(({ policyId }) => policyId === "s1-release-ephemeral")
  };
}

async function gitSourceSha() {
  const status = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    environment: sanitizedEnvironment(),
    timeoutMs: 30000
  });
  if (status.code !== 0 || status.signal) {
    throw runtimeError("DATABASE_LAUNCHER_SOURCE_STATUS_FAILED");
  }
  const result = await runProcess("git", ["rev-parse", "HEAD"], {
    environment: sanitizedEnvironment(),
    timeoutMs: 30000
  });
  const sourceSha = result.stdout.trim();
  return assertSourceGateCheckout({ status: status.stdout, sourceSha, exitCode: result.code });
}

export function assertSourceGateCheckout({ status, sourceSha, exitCode = 0 }) {
  if (typeof status !== "string" || status.trim().length > 0) {
    throw runtimeError("DATABASE_LAUNCHER_SOURCE_CHECKOUT_DIRTY");
  }
  if (exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw runtimeError("DATABASE_LAUNCHER_SOURCE_SHA_INVALID");
  }
  return sourceSha;
}

export async function executeLauncherRequest({
  mode,
  chain,
  suiteId,
  batchId,
  concurrency = 1,
  order = "manifest"
}) {
  if (
    !["suite", "manifest", "source-gate"].includes(mode) ||
    !["fresh", "snapshot"].includes(chain) ||
    !["manifest", "reverse"].includes(order) ||
    (mode !== "manifest" && order !== "manifest")
  ) {
    throw runtimeError("DATABASE_LAUNCHER_REQUEST_INVALID");
  }
  const sourceSha = mode === "source-gate" ? await gitSourceSha() : undefined;
  const inputs = await loadSelectionInputs();
  if (!inputs.policy) throw runtimeError("DATABASE_LAUNCHER_POLICY_MISSING");
  const runId = randomUUID();
  const selections = selectManifestSuites({
    manifest: inputs.manifest,
    discoveryDigest: inputs.discoveryDigest,
    discoveryUnclassifiedCount: inputs.discoveryUnclassifiedCount,
    chain,
    suiteIds: suiteId ? [suiteId] : undefined,
    batchId,
    runId,
    secretRootRef: `.release-local/runs/${runId}`
  });
  if (mode === "suite" && selections.length !== 1) {
    throw runtimeError("DATABASE_LAUNCHER_SUITE_SELECTION_INVALID");
  }
  await generatePrismaClient();
  const cluster = await startCluster(runId, inputs.imageContract, inputs.policy);
  const observations = new Map();
  const fixtureObservations = new Map();
  const roleBoundaryObservations = new Map();
  let completed = false;
  try {
    const admin = ({ databaseName, sql }) =>
      executePsql({
        containerId: cluster.containerId,
        credential: cluster.provisioner,
        databaseName,
        sql,
        columns: sql.includes("FROM pg_database") ? ["oid", "marker"] : []
      });
    const manifestReport = await runDatabaseManifest({
      selections: order === "reverse" ? [...selections].reverse() : selections,
      concurrency,
      executeSuite: async (execution) => {
        const resources = [];
        let provisionedRecord;
        return runDatabaseSuite({
          execution,
          operationId: randomUUID(),
          provision: async () => {
            const assignmentExecutions = [
              { name: "target", execution },
              ...execution.additionalAssignments.map((assignment) => ({
                name: assignment.name,
                execution: {
                  ...execution,
                  suiteId: assignment.suiteIdentity,
                  assignment,
                  additionalAssignments: []
                }
              }))
            ];
            for (const item of assignmentExecutions) {
              const secretStore = await createSecretStore(item.execution, cluster);
              const record = await provisionSuiteDatabase({
                target: cluster.target,
                policy: inputs.policy,
                runId: item.execution.runId,
                suiteId: item.execution.suiteId,
                shard: item.execution.assignment.shard,
                executeAdmin: admin,
                secretStore
              });
              resources.push({ ...item, record, secretStore });
            }
            const primary = resources[0].record;
            provisionedRecord = {
              ...primary,
              additionalDatabases: resources.slice(1).map(({ name, record }) => ({
                ...record,
                name
              }))
            };
            return provisionedRecord;
          },
          deployMigrations: async () => {
            const databaseObservations = [];
            for (const resource of resources) {
              const secret = await readSecret(resource.record.secretReferences.migrate);
              await prismaCommand(
                secret,
                ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
                execution.timeoutMs
              );
              const migrationStatus = await prismaCommand(
                secret,
                ["migrate", "status", "--schema", "prisma/schema.prisma"],
                execution.timeoutMs
              );
              const schemaDiff = await prismaCommand(
                secret,
                [
                  "migrate",
                  "diff",
                  "--from-config-datasource",
                  "--to-schema",
                  "prisma/schema.prisma",
                  "--exit-code"
                ],
                execution.timeoutMs
              );
              databaseObservations.push({
                name: resource.name,
                migrationStatusDigest: sha256Canonical(migrationStatus),
                schemaDiffDigest: sha256Canonical(schemaDiff)
              });
            }
            observations.set(execution.suiteId, {
              migrationStatusDigest: sha256Canonical(
                databaseObservations.map(({ name, migrationStatusDigest }) => ({
                  name,
                  migrationStatusDigest
                }))
              ),
              schemaDiffDigest: sha256Canonical(
                databaseObservations.map(({ name, schemaDiffDigest }) => ({
                  name,
                  schemaDiffDigest
                }))
              )
            });
          },
          grantRuntimeAccess: async () => {
            const suiteFixtures = [];
            const suiteRoleBoundaries = [];
            for (const resource of resources) {
              await grantRuntimeEquivalentAccess({
                databaseName: resource.record.databaseName,
                migrationRole: resource.record.roles.migrate,
                runtimeRole: resource.record.roles["runtime-test"],
                executeDatabase: admin
              });
              const runtimeSecret = await readSecret(
                resource.record.secretReferences["runtime-test"]
              );
              const roleBoundary = await observeRuntimeRoleBoundary({
                cluster,
                resource,
                runtimeSecret
              });
              suiteRoleBoundaries.push(roleBoundary);
              if (!execution.fixtures) continue;
              const migrationSecret = await readSecret(resource.record.secretReferences.migrate);
              const migrationFingerprint = sha256Bytes(
                Buffer.from(migrationSecret.password, "utf8")
              );
              const runtimeFingerprint = sha256Bytes(Buffer.from(runtimeSecret.password, "utf8"));
              const migration = await runSchemaFixture({
                credentialRef: resource.record.secretReferences.migrate,
                credentialFingerprint: migrationFingerprint,
                counterpartCredentialFingerprint: runtimeFingerprint,
                fixturePath: execution.fixtures.schema,
                runtimeRole: resource.record.roles["runtime-test"],
                executeSql: ({ credentialRef, sql }) => {
                  if (credentialRef !== resource.record.secretReferences.migrate) {
                    throw runtimeError("DATABASE_FIXTURE_CAPABILITY_MISMATCH");
                  }
                  return executePsql({
                    containerId: cluster.containerId,
                    credential: migrationSecret,
                    databaseName: resource.record.databaseName,
                    sql
                  });
                }
              });
              const runtime = await runRuntimeSeedFixture({
                credentialRef: resource.record.secretReferences["runtime-test"],
                credentialFingerprint: runtimeFingerprint,
                counterpartCredentialFingerprint: migrationFingerprint,
                fixturePath: execution.fixtures.seed,
                executeSql: ({ credentialRef, sql }) => {
                  if (credentialRef !== resource.record.secretReferences["runtime-test"]) {
                    throw runtimeError("DATABASE_FIXTURE_CAPABILITY_MISMATCH");
                  }
                  return executePsql({
                    containerId: cluster.containerId,
                    credential: runtimeSecret,
                    databaseName: resource.record.databaseName,
                    sql
                  });
                }
              });
              suiteFixtures.push({
                database: resource.name,
                migration,
                runtime,
                roleBoundary: Object.freeze({
                  ...roleBoundary.roleAttributes,
                  canCreateSchema: roleBoundary.canCreateSchema,
                  schemaOwner: roleBoundary.schemaOwner,
                  objectOwner: roleBoundary.objectOwner
                })
              });
            }
            roleBoundaryObservations.set(execution.suiteId, Object.freeze(suiteRoleBoundaries));
            if (suiteFixtures.length > 0) {
              fixtureObservations.set(execution.suiteId, Object.freeze(suiteFixtures));
            }
          },
          executeTest: async () => {
            const contextDatabases = {};
            for (const resource of resources) {
              const runtimeSecret = await readSecret(
                resource.record.secretReferences["runtime-test"]
              );
              const migrationSecret = await readSecret(resource.record.secretReferences.migrate);
              contextDatabases[resource.name] = {
                databaseName: resource.record.databaseName,
                databaseOid: resource.record.databaseOid,
                targetFingerprint: resource.record.targetFingerprint,
                runtimeSecretReference: resource.record.secretReferences["runtime-test"],
                runtimeCredentialFingerprint: sha256Bytes(
                  Buffer.from(runtimeSecret.password, "utf8")
                ),
                migrationCredentialFingerprint: sha256Bytes(
                  Buffer.from(migrationSecret.password, "utf8")
                )
              };
            }
            const primaryContext = contextDatabases.target;
            const primaryResource = resources[0];
            const runtimeSecret = await readSecret(
              primaryResource.record.secretReferences["runtime-test"]
            );
            const contextPath = path.join(primaryResource.secretStore.suiteRoot, "context.json");
            await writeFile(
              contextPath,
              `${JSON.stringify(
                {
                  schemaVersion: "release-database-test-context.v1",
                  allowedFiles: execution.files,
                  databaseName: primaryContext.databaseName,
                  databaseOid: primaryContext.databaseOid,
                  targetFingerprint: primaryContext.targetFingerprint,
                  containerId: cluster.containerId,
                  runtimeSecretReference: primaryContext.runtimeSecretReference,
                  runtimeCredentialFingerprint: primaryContext.runtimeCredentialFingerprint,
                  migrationCredentialFingerprint: primaryContext.migrationCredentialFingerprint,
                  ...(resources.length > 1 ? { namedDatabases: contextDatabases } : {})
                },
                null,
                2
              )}\n`,
              { mode: 0o600 }
            );
            await hardenOwnerOnlyFile(contextPath);
            const result = await runProcess(
              execution.command.executable,
              execution.command.arguments,
              {
                timeoutMs: execution.timeoutMs,
                environment: sanitizedEnvironment({
                  S1_RELEASE_DATABASE_TEST: "1",
                  S1_RELEASE_DATABASE_CONTEXT: path.relative(repoRoot, contextPath)
                })
              }
            );
            const acceptedLog = redactEvidence(
              summarizeDatabaseTestLog({ stdout: result.stdout, stderr: result.stderr }),
              {
                owner: "release-engineering",
                readers: ["release", "qa", "security", "audit"],
                retentionDays: 180,
                expiryDisposition: "review"
              }
            );
            const counts = testCounts(result.stdout);
            if (result.signal || (result.code !== 0 && counts.failed === 0)) {
              process.stderr.write(
                `${JSON.stringify({
                  schemaVersion: "database-test-sanitized-diagnostic.v1",
                  suiteId: execution.suiteId,
                  logSummary: acceptedLog
                })}\n`
              );
              throw runtimeError("DATABASE_TEST_PROCESS_FAILED", {
                suiteId: execution.suiteId,
                exitCode: result.code
              });
            }
            if (counts.failed > 0) {
              process.stderr.write(
                `${JSON.stringify({
                  schemaVersion: "database-test-sanitized-diagnostic.v1",
                  suiteId: execution.suiteId,
                  logSummary: acceptedLog
                })}\n`
              );
            }
            if (runtimeSecret.database !== execution.assignment.databaseName) {
              throw runtimeError("DATABASE_TEST_RUNTIME_SECRET_MISMATCH");
            }
            return {
              counts,
              sanitizedLogDigest: sha256Canonical(acceptedLog),
              ...(fixtureObservations.has(execution.suiteId)
                ? { fixtureObservations: fixtureObservations.get(execution.suiteId) }
                : {}),
              roleBoundaries: roleBoundaryObservations.get(execution.suiteId)
            };
          },
          custody: ({ report }) =>
            custodyEvidence({
              value: report,
              policy: {
                owner: "release-engineering",
                readers: ["release", "qa", "security", "audit"],
                retentionDays: 180,
                expiryDisposition: "review"
              },
              storage: localCustodyStorage(),
              createReceiptId: randomUUID,
              attestationRef: `local-controlled-nonpromotable://${runId}/${execution.suiteId}`
            }),
          cleanup: async ({ custodyReceipt }) => {
            if (custodyReceipt.contentDigest !== custodyReceipt.readbackDigest) {
              throw runtimeError("DATABASE_TEST_CUSTODY_INCOMPLETE");
            }
            for (const resource of [...resources].reverse()) {
              await cleanupSuiteDatabase(resource.record, {
                target: cluster.target,
                policy: inputs.policy,
                executeAdmin: admin
              });
              await rm(resource.secretStore.suiteRoot, { recursive: true, force: true });
            }
          }
        });
      }
    });

    let output = manifestReport;
    if (mode === "suite") output = manifestReport.suiteReports[0];
    if (mode === "source-gate") {
      const [migrationCatalog, repositoryContract] = await Promise.all([
        computeMigrationCatalog(repoRoot),
        computeRepositoryContract(repoRoot)
      ]);
      const observationValues = [...observations.values()];
      output = runSourceDatabaseGate({
        manifestReport,
        sourceSha,
        migrationCatalogDigest: migrationCatalog.digest,
        repositoryContractDigest: repositoryContract.digest,
        postgres: {
          imageDigest: inputs.imageContract.resolvedDigest,
          serverVersionNum: cluster.target.serverVersionNum
        },
        schemaDiffDigest: sha256Canonical(
          observationValues.map(({ schemaDiffDigest }) => schemaDiffDigest)
        ),
        migrationStatusDigest: sha256Canonical(
          observationValues.map(({ migrationStatusDigest }) => migrationStatusDigest)
        ),
        provenance: {
          generatedAt: new Date().toISOString(),
          ciRunRef: `local-controlled-nonpromotable://${runId}`,
          executorVersion: "source-database-gate.v1"
        }
      });
    }
    await removeSuccessfulCluster(cluster, runId);
    completed = true;
    return output;
  } catch (error) {
    const incidentPath = path.join(repoRoot, ".release-local", "runs", runId, "incident.json");
    await writeFile(
      incidentPath,
      `${JSON.stringify(
        {
          schemaVersion: "database-launcher-incident.v1",
          runId,
          containerId: cluster.containerId,
          errorCode: error?.code ?? "DATABASE_LAUNCHER_FAILED",
          recordedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    throw error;
  } finally {
    if (!completed) {
      // Custody or execution failure deliberately keeps the exact target for bounded reconciliation.
    }
  }
}

export function parseLauncherArguments(mode, argv) {
  if (!["suite", "manifest", "source-gate"].includes(mode) || !Array.isArray(argv)) {
    throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag ?? "") || value === undefined || values.has(flag)) {
      throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
    }
    values.set(flag, value);
  }
  const allowed = {
    suite: new Set(["--suite-id", "--chain"]),
    manifest: new Set(["--batch", "--chain", "--concurrency", "--order"]),
    "source-gate": new Set(["--batch", "--chain"])
  }[mode];
  if ([...values.keys()].some((flag) => !allowed.has(flag))) {
    throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
  }
  const chain = values.get("--chain");
  const suiteId = values.get("--suite-id");
  const batchId = values.get("--batch");
  const concurrency = values.has("--concurrency") ? Number(values.get("--concurrency")) : 1;
  const order = values.get("--order") ?? "manifest";
  if (
    !["fresh", "snapshot"].includes(chain) ||
    (mode === "suite" && !suiteId) ||
    (mode !== "suite" && !batchId) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !["manifest", "reverse"].includes(order)
  ) {
    throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
  }
  return Object.freeze({ mode, chain, suiteId, batchId, concurrency, order });
}

export async function runLauncherCli(mode, argv, execute = executeLauncherRequest) {
  const result = await execute(parseLauncherArguments(mode, argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.terminalStatus === "FAILED") process.exitCode = 1;
  return result;
}
