import childProcess from "node:child_process";
// Internal execution on already admitted/provisioned H1 targets. The holder
// supplies captured I/O and retains originals; this module grants no authority.
import {
  grantRuntimeEquivalentAccess,
  runSchemaFixture,
  runRuntimeSeedFixture,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { buildDatabaseSuiteReport } from "../../packages/release-foundation/src/database-test-launcher.mjs";
import {
  databaseTestCounts,
  prismaPostSchemaArguments,
  summarizeDatabaseTestLog
} from "./database-test-launcher-runtime.mjs";

const CODE = "R3_SOURCE_SUITE_UNAVAILABLE";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const boundaryFields = [
  "superuser",
  "createdb",
  "createrole",
  "bypassrls",
  "canCreateSchema",
  "schemaOwner",
  "objectOwner"
];
export const r3RuntimeBoundarySql = [
  'SELECT r.rolsuper AS "superuser", r.rolcreatedb AS "createdb",',
  'r.rolcreaterole AS "createrole", r.rolbypassrls AS "bypassrls",',
  `has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateSchema",`,
  'EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AS "schemaOwner",',
  'EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AS "objectOwner"',
  "FROM pg_roles r WHERE r.rolname=current_user"
].join(" ");

export function r3RuntimeBoundary(database, readback) {
  const row = readback?.rows?.[0];
  if (readback?.rows?.length !== 1 || !row || boundaryFields.some((key) => row[key] !== false))
    fail();
  return {
    database,
    roleAttributes: Object.fromEntries(boundaryFields.slice(0, 4).map((key) => [key, row[key]])),
    ...Object.fromEntries(boundaryFields.slice(4).map((key) => [key, row[key]]))
  };
}

export async function executeR3SourceSuite({
  execution,
  records,
  clusterFingerprint,
  containerId,
  profileDigest,
  repoRoot,
  readSecret,
  executeCredential,
  runPrisma,
  writeContext,
  runTest,
  recheck
}) {
  const originals = {
    processes: [],
    databases: [],
    fixtures: [],
    runtimeReadbacks: [],
    context: null,
    test: null
  };
  try {
    if (
      execution?.r3ExecutionMode !== "suite" ||
      !Array.isArray(records) ||
      [readSecret, executeCredential, runPrisma, writeContext, runTest, recheck].some(
        (fn) => typeof fn !== "function"
      )
    )
      fail();
    const assignments = [
      { ...execution.assignment, name: "target" },
      ...execution.additionalAssignments
    ];
    if (records.length !== assignments.length) fail();
    const resources = [];
    for (const [index, assignment] of assignments.entries()) {
      const record = records[index];
      if (
        record.databaseName !== assignment.databaseName ||
        record.shard !== assignment.shard ||
        sha256Canonical(record.secretReferences) !== sha256Canonical(assignment.secretReferences)
      )
        fail();
      await recheck();
      const migrate = await readSecret(record, "migrate"),
        runtime = await readSecret(record, "runtime-test");
      for (const [profile, secret] of [
        ["migrate", migrate],
        ["runtime-test", runtime]
      ]) {
        if (
          secret?.username !== record.roles[profile] ||
          secret.database !== record.databaseName ||
          secret.host !== "127.0.0.1" ||
          secret.port !== 55441 ||
          secret.tlsMode !== "require" ||
          typeof secret.password !== "string" ||
          secret.password.length < 16
        )
          fail();
      }
      const migrationCredentialFingerprint = sha256Bytes(Buffer.from(migrate.password, "utf8"));
      const runtimeCredentialFingerprint = sha256Bytes(Buffer.from(runtime.password, "utf8"));
      if (migrationCredentialFingerprint === runtimeCredentialFingerprint) fail();
      resources.push({
        record,
        name: assignment.name,
        migrationCredentialFingerprint,
        runtimeCredentialFingerprint
      });
      originals.databases.push(record);
    }
    const migrationObservations = [];
    const roleBoundaries = [];
    const contextDatabases = {};
    for (const resource of resources) {
      const { record, name, migrationCredentialFingerprint, runtimeCredentialFingerprint } =
        resource;
      const commands = [
        ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
        ["migrate", "status", "--schema", "prisma/schema.prisma"],
        [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code"
        ],
        prismaPostSchemaArguments()
      ];
      const results = [];
      for (const args of commands) {
        await recheck();
        const result = await runPrisma(record, args, execution.timeoutMs);
        originals.processes.push({ databaseName: record.databaseName, arguments: args, result });
        if (
          result.code !== 0 ||
          result.signal !== null ||
          result.processError ||
          result.timedOut ||
          result.truncated
        )
          fail();
        results.push(result);
      }
      migrationObservations.push({
        name,
        migrationStatusDigest: sha256Canonical(results[1]),
        schemaDiffDigest: sha256Canonical(results[2]),
        postSchemaDigest: sha256Bytes(Buffer.from(results[3].stdout, "utf8"))
      });
      await grantRuntimeEquivalentAccess({
        databaseName: record.databaseName,
        migrationRole: record.roles.migrate,
        runtimeRole: record.roles["runtime-test"],
        executeDatabase: ({ databaseName, sql }) => {
          if (databaseName !== record.databaseName) fail();
          return executeCredential(record, "migrate", sql);
        }
      });
      const roleReadback = await executeCredential(record, "runtime-test", r3RuntimeBoundarySql);
      originals.runtimeReadbacks.push({
        databaseName: record.databaseName,
        readback: roleReadback
      });
      const boundary = r3RuntimeBoundary(name, roleReadback);
      roleBoundaries.push(boundary);
      if (execution.fixtures) {
        const common = { repoRoot, runtimeRole: record.roles["runtime-test"] };
        const migration = await runSchemaFixture({
          ...common,
          fixturePath: execution.fixtures.schema,
          credentialRef: record.secretReferences.migrate,
          credentialFingerprint: migrationCredentialFingerprint,
          counterpartCredentialFingerprint: runtimeCredentialFingerprint,
          executeSql: ({ credentialRef, sql }) => {
            if (credentialRef !== record.secretReferences.migrate) fail();
            return executeCredential(record, "migrate", sql);
          }
        });
        const runtime = await runRuntimeSeedFixture({
          ...common,
          fixturePath: execution.fixtures.seed,
          credentialRef: record.secretReferences["runtime-test"],
          credentialFingerprint: runtimeCredentialFingerprint,
          counterpartCredentialFingerprint: migrationCredentialFingerprint,
          executeSql: ({ credentialRef, sql }) => {
            if (credentialRef !== record.secretReferences["runtime-test"]) fail();
            return executeCredential(record, "runtime-test", sql);
          }
        });
        originals.fixtures.push({
          database: name,
          migration,
          runtime,
          roleBoundary: {
            ...boundary.roleAttributes,
            ...Object.fromEntries(boundaryFields.slice(4).map((key) => [key, boundary[key]]))
          }
        });
      }
      contextDatabases[name] = {
        databaseName: record.databaseName,
        databaseOid: record.databaseOid,
        targetFingerprint: clusterFingerprint,
        runtimeSecretReference: record.secretReferences["runtime-test"],
        migrationCredentialFingerprint,
        runtimeCredentialFingerprint
      };
    }
    const context = {
      schemaVersion: "release-database-test-context.v1",
      operationRef: execution.runId,
      suiteId: execution.suiteId,
      profileDigest,
      allowedFiles: [...execution.files],
      containerId,
      ...contextDatabases.target,
      ...(resources.length > 1 ? { namedDatabases: contextDatabases } : {})
    };
    originals.context = context;
    const reference = await writeContext(execution, context);
    if (
      reference !== `r3/${execution.runId}/database-test-contexts/${execution.suiteId}/context.json`
    )
      fail();
    await recheck();
    originals.test = await runTest(execution, reference);
    const counts = databaseTestCounts(originals.test.stdout);
    if (
      originals.test.code !== 0 ||
      originals.test.signal !== null ||
      originals.test.processError ||
      originals.test.timedOut ||
      originals.test.truncated
    )
      fail();
    const logSummary = summarizeDatabaseTestLog(originals.test);
    const provisioned = {
      ...records[0],
      targetFingerprint: clusterFingerprint,
      additionalDatabases: records.slice(1).map((record, index) => ({
        ...record,
        name: resources[index + 1].name,
        targetFingerprint: clusterFingerprint
      }))
    };
    const report = buildDatabaseSuiteReport({
      execution,
      provisioned,
      operationId: execution.runId,
      result: {
        counts,
        roleBoundaries,
        sanitizedLogDigest: sha256Canonical(logSummary),
        ...(execution.fixtures ? { fixtureObservations: originals.fixtures } : {})
      }
    });
    await recheck();
    return { report, originals, logSummary, migrationObservations };
  } catch (cause) {
    const error = Object.assign(new Error(CODE), { code: CODE });
    Object.defineProperty(error, "originals", { value: originals });
    Object.defineProperty(error, "cause", { value: cause });
    throw error;
  }
}

export async function runR3SourceProcess({
  executable,
  args,
  timeoutMs,
  environment = {},
  repoRoot,
  signal: abortSignal,
  recheck
}) {
  await recheck();
  if (!["node", "pnpm"].includes(executable) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    fail();
  const result = await new Promise((resolve) => {
    const child = childProcess.spawn(executable === "node" ? process.execPath : executable, args, {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      signal: abortSignal
    });
    const chunks = { stdout: [], stderr: [] };
    let size = 0,
      truncated = false,
      processError = false,
      timedOut = false;
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") processError = true;
        }
      }
    };
    for (const stream of ["stdout", "stderr"])
      child[stream].on("data", (chunk) => {
        const remaining = Math.max(0, 524288 - size);
        chunks[stream].push(Buffer.from(chunk.subarray(0, remaining)));
        size += chunk.length;
        if (size > 524288) {
          truncated = true;
          stop();
        }
      });
    abortSignal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.once("error", () => {
      processError = true;
      stop();
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", stop);
      stop();
      resolve({
        code: exitCode,
        signal,
        processError,
        timedOut,
        truncated,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8")
      });
    });
  });
  // Always return the actual process result for private failure preservation.
  return result;
}
