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
  const suiteRoot = path.join(
    repoRoot,
    ".release-local",
    "runs",
    execution.runId,
    execution.suiteId
  );
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

export async function executeLauncherRequest({ mode, chain, suiteId, batchId, concurrency = 1 }) {
  if (
    !["suite", "manifest", "source-gate"].includes(mode) ||
    !["fresh", "snapshot"].includes(chain)
  ) {
    throw runtimeError("DATABASE_LAUNCHER_REQUEST_INVALID");
  }
  if (concurrency !== 1) throw runtimeError("DATABASE_LAUNCHER_CONCURRENCY_NOT_IMPLEMENTED");
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
  const cluster = await startCluster(runId, inputs.imageContract, inputs.policy);
  const observations = new Map();
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
      selections,
      executeSuite: async (execution) => {
        const secretStore = await createSecretStore(execution, cluster);
        let provisionedRecord;
        return runDatabaseSuite({
          execution,
          operationId: randomUUID(),
          provision: async () => {
            provisionedRecord = await provisionSuiteDatabase({
              target: cluster.target,
              policy: inputs.policy,
              runId: execution.runId,
              suiteId: execution.suiteId,
              shard: execution.assignment.shard,
              executeAdmin: admin,
              secretStore
            });
            return provisionedRecord;
          },
          deployMigrations: async () => {
            const secret = await readSecret(provisionedRecord.secretReferences.migrate);
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
            observations.set(execution.suiteId, {
              migrationStatusDigest: sha256Canonical(migrationStatus),
              schemaDiffDigest: sha256Canonical(schemaDiff)
            });
          },
          grantRuntimeAccess: async () =>
            grantRuntimeEquivalentAccess({
              databaseName: provisionedRecord.databaseName,
              migrationRole: provisionedRecord.roles.migrate,
              runtimeRole: provisionedRecord.roles["runtime-test"],
              executeDatabase: admin
            }),
          executeTest: async () => {
            const runtimeSecret = await readSecret(
              provisionedRecord.secretReferences["runtime-test"]
            );
            const contextPath = path.join(secretStore.suiteRoot, "context.json");
            await writeFile(
              contextPath,
              `${JSON.stringify(
                {
                  schemaVersion: "release-database-test-context.v1",
                  allowedFiles: execution.files,
                  databaseName: provisionedRecord.databaseName,
                  databaseOid: provisionedRecord.databaseOid,
                  targetFingerprint: provisionedRecord.targetFingerprint,
                  containerId: cluster.containerId,
                  runtimeSecretReference: provisionedRecord.secretReferences["runtime-test"]
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
              { stdout: result.stdout, stderr: result.stderr },
              {
                owner: "release-engineering",
                readers: ["release", "qa", "security", "audit"],
                retentionDays: 180,
                expiryDisposition: "review"
              }
            );
            const counts = tapCounts(result.stdout);
            if (result.signal || (result.code !== 0 && counts.failed === 0)) {
              throw runtimeError("DATABASE_TEST_PROCESS_FAILED", {
                suiteId: execution.suiteId,
                exitCode: result.code
              });
            }
            if (runtimeSecret.database !== execution.assignment.databaseName) {
              throw runtimeError("DATABASE_TEST_RUNTIME_SECRET_MISMATCH");
            }
            return { counts, sanitizedLogDigest: sha256Canonical(acceptedLog) };
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
            await cleanupSuiteDatabase(provisionedRecord, {
              target: cluster.target,
              policy: inputs.policy,
              executeAdmin: admin
            });
            await rm(secretStore.suiteRoot, { recursive: true, force: true });
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
    manifest: new Set(["--batch", "--chain", "--concurrency"]),
    "source-gate": new Set(["--batch", "--chain"])
  }[mode];
  if ([...values.keys()].some((flag) => !allowed.has(flag))) {
    throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
  }
  const chain = values.get("--chain");
  const suiteId = values.get("--suite-id");
  const batchId = values.get("--batch");
  const concurrency = values.has("--concurrency") ? Number(values.get("--concurrency")) : 1;
  if (
    !["fresh", "snapshot"].includes(chain) ||
    (mode === "suite" && !suiteId) ||
    (mode !== "suite" && !batchId) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  ) {
    throw runtimeError("DATABASE_LAUNCHER_ARGUMENT_INVALID");
  }
  return Object.freeze({ mode, chain, suiteId, batchId, concurrency });
}

export async function runLauncherCli(mode, argv, execute = executeLauncherRequest) {
  const result = await execute(parseLauncherArguments(mode, argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result?.terminalStatus === "FAILED") process.exitCode = 1;
  return result;
}
