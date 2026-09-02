import { spawn as spawnProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runDatabaseManifest,
  runRuntimeSeedFixture,
  selectManifestSuites,
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "@subscription-saas/release-foundation";

import {
  databaseTestCounts,
  summarizeDatabaseTestLog
} from "../../../scripts/release/database-test-launcher-runtime.mjs";
import { runnerError } from "./error-codes.mjs";
import { resolveRunnerReference } from "./reference-paths.mjs";

const databaseEnvironmentPattern =
  /^(?:DATABASE_URL|DIRECT_URL|POSTGRES_URL|STAGING_DATABASE_URL|PG[A-Z0-9_]*)$/iu;

function safeEnvironment(overrides = {}, environment = process.env) {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !databaseEnvironmentPattern.test(key))
    ),
    ...overrides
  });
}

function runProcess(executable, arguments_, { environment, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, arguments_, {
      cwd: "/app",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? 1, signal: signal ?? null, stdout, stderr });
    });
  });
}

function targetContext(target, { databaseOid, databaseIdentityFingerprint }, secretReference) {
  return Object.freeze({
    databaseName: target.databaseName,
    databaseOid,
    targetFingerprint: databaseIdentityFingerprint,
    runtimeSecretReference: secretReference,
    runtimeCredentialFingerprint: target.runtimeCredentialFingerprint,
    migrationCredentialFingerprint: target.migrationCredentialFingerprint
  });
}

function suiteCommand(selection) {
  if (selection.command.executable === "pnpm") {
    const marker = selection.command.arguments.indexOf("vitest");
    if (marker < 0) throw runnerError("DATABASE_TEST_COMMAND_FORBIDDEN");
    return Object.freeze({
      executable: "node",
      arguments: [
        "apps/api/node_modules/vitest/vitest.mjs",
        ...selection.command.arguments.slice(marker + 1)
      ]
    });
  }
  if (selection.command.executable !== "node") {
    throw runnerError("DATABASE_TEST_COMMAND_FORBIDDEN");
  }
  return selection.command;
}

async function preprovisionedSchemaFixtureObservation({
  fixturePath,
  credentialFingerprint,
  repoRoot
}) {
  const sql = await readFile(path.resolve(repoRoot, fixturePath), "utf8");
  const statementClasses = [
    ...new Set(
      sql
        .split(";")
        .map((statement) =>
          statement
            .trim()
            .match(/^([A-Z]+)/iu)?.[1]
            ?.toUpperCase()
        )
        .filter(Boolean)
    )
  ].sort();
  if (
    statementClasses.some((value) =>
      ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE"].includes(value)
    )
  ) {
    throw runnerError("DATABASE_SCHEMA_FIXTURE_DML_FORBIDDEN");
  }
  if (
    statementClasses.length === 0 ||
    statementClasses.some(
      (value) =>
        !["ALTER", "COMMENT", "CREATE", "GRANT", "REVOKE", "SELECT", "WITH"].includes(value)
    )
  ) {
    throw runnerError("DATABASE_SCHEMA_FIXTURE_INVALID");
  }
  return Object.freeze({
    schemaVersion: "fixture-observation.v1",
    capability: "migration",
    credentialFingerprint,
    fixturePath,
    sqlDigest: sha256Bytes(Buffer.from(sql, "utf8")),
    statementClasses
  });
}

async function observeRuntimeBoundary(database, expected) {
  const [identity] = await database.$queryRawUnsafe(`
    SELECT current_database()::text AS "databaseName",
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS "databaseOid",
           current_user::text AS role,
           r.rolsuper AS superuser,
           r.rolcreatedb AS createdb,
           r.rolcreaterole AS createrole,
           r.rolbypassrls AS bypassrls,
           has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateSchema",
           EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid) AS "schemaOwner",
           EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) AS "objectOwner",
           EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS tls
      FROM pg_roles r WHERE r.rolname = current_user
  `);
  const identityFingerprint = sha256Canonical({
    databaseName: identity?.databaseName,
    databaseOid: String(identity?.databaseOid),
    role: identity?.role,
    tls: identity?.tls
  });
  if (
    !identity ||
    identity.databaseName !== expected.databaseName ||
    String(identity.databaseOid) !== expected.databaseOid ||
    identity.role !== expected.runtimeRole ||
    identity.tls !== true ||
    identityFingerprint !== expected.databaseIdentityFingerprint ||
    [
      identity.superuser,
      identity.createdb,
      identity.createrole,
      identity.bypassrls,
      identity.canCreateSchema,
      identity.schemaOwner,
      identity.objectOwner
    ].some(Boolean)
  ) {
    throw runnerError("DATABASE_TEST_TARGET_IDENTITY_MISMATCH");
  }
  return Object.freeze(identity);
}

export async function executeFinalDatabaseManifest({
  envelope,
  manifest,
  credential,
  sourceCredential,
  connectDatabase,
  repoRoot = "/app",
  executeProcess = runProcess,
  environment = process.env
}) {
  if (typeof connectDatabase !== "function") {
    throw runnerError("DATABASE_TEST_EXECUTOR_UNAVAILABLE");
  }
  const targetDatabase = await connectDatabase({ credential, target: envelope.target });
  const sourceDatabase = sourceCredential
    ? await connectDatabase({ credential: sourceCredential, target: envelope.sourceTarget })
    : undefined;
  const runRoot = path.resolve(repoRoot, ".release-local", "runs", envelope.runId);
  const targetSecretRelative = path.posix.join(
    ".release-local",
    "runs",
    envelope.runId,
    "target",
    "runtime-test.json"
  );
  const sourceSecretRelative = path.posix.join(
    ".release-local",
    "runs",
    envelope.runId,
    "source",
    "runtime-test.json"
  );
  const targetSecretFile = path.resolve(repoRoot, targetSecretRelative);
  const sourceSecretFile = path.resolve(repoRoot, sourceSecretRelative);
  try {
    const targetIdentity = await observeRuntimeBoundary(targetDatabase, {
      ...envelope.target,
      databaseOid: envelope.databaseOid,
      databaseIdentityFingerprint: envelope.databaseIdentityFingerprint
    });
    const sourceIdentity = sourceDatabase
      ? await observeRuntimeBoundary(sourceDatabase, envelope.sourceTarget)
      : undefined;
    await mkdir(path.dirname(targetSecretFile), { recursive: true });
    await writeFile(
      targetSecretFile,
      `${JSON.stringify({
        username: credential.username,
        password: credential.password,
        host: envelope.target.hostname,
        port: envelope.target.port ?? 5432,
        database: envelope.target.databaseName,
        tlsMode: "require"
      })}\n`,
      { mode: 0o600 }
    );
    if (sourceCredential) {
      await mkdir(path.dirname(sourceSecretFile), { recursive: true });
      await writeFile(
        sourceSecretFile,
        `${JSON.stringify({
          username: sourceCredential.username,
          password: sourceCredential.password,
          host: envelope.sourceTarget.hostname,
          port: envelope.sourceTarget.port ?? 5432,
          database: envelope.sourceTarget.databaseName,
          tlsMode: "require"
        })}\n`,
        { mode: 0o600 }
      );
    }
    const selected = selectManifestSuites({
      manifest,
      discoveryDigest: envelope.databaseTestDiscoveryDigest,
      discoveryUnclassifiedCount: 0,
      chain: envelope.chain,
      runId: envelope.runId,
      secretRootRef: `.release-local/runs/${envelope.runId}`
    }).map((selection) =>
      Object.freeze({
        ...selection,
        assignment: Object.freeze({
          ...selection.assignment,
          databaseName: envelope.target.databaseName
        }),
        additionalAssignments: Object.freeze(
          selection.additionalAssignments.map((assignment) =>
            Object.freeze({
              ...assignment,
              databaseName: envelope.sourceTarget?.databaseName ?? assignment.databaseName
            })
          )
        )
      })
    );
    const report = await runDatabaseManifest({
      selections: selected,
      concurrency: 1,
      executeSuite: async (selection) => {
        const suiteRoot = path.resolve(runRoot, selection.suiteId);
        const contextRelative = path.posix.join(
          ".release-local",
          "runs",
          envelope.runId,
          selection.suiteId,
          "context.json"
        );
        const contextFile = path.resolve(repoRoot, contextRelative);
        await mkdir(suiteRoot, { recursive: true });
        const target = targetContext(
          envelope.target,
          {
            databaseOid: envelope.databaseOid,
            databaseIdentityFingerprint: envelope.databaseIdentityFingerprint
          },
          targetSecretRelative
        );
        const namedDatabases =
          selection.additionalAssignments.length > 0
            ? {
                source: targetContext(
                  envelope.sourceTarget,
                  envelope.sourceTarget,
                  sourceSecretRelative
                ),
                target
              }
            : undefined;
        await writeFile(
          contextFile,
          `${JSON.stringify({
            schemaVersion: "release-database-test-context.v1",
            allowedFiles: selection.files,
            containerId: envelope.actualRunnerDigest.slice("sha256:".length),
            ...target,
            ...(namedDatabases ? { namedDatabases } : {})
          })}\n`,
          { mode: 0o600 }
        );
        let fixtureObservations;
        if (selection.fixtures) {
          const migration = await preprovisionedSchemaFixtureObservation({
            fixturePath: selection.fixtures.schema,
            credentialFingerprint: envelope.target.migrationCredentialFingerprint,
            repoRoot
          });
          const runtime = await runRuntimeSeedFixture({
            credentialRef: targetSecretRelative,
            credentialFingerprint: envelope.target.runtimeCredentialFingerprint,
            counterpartCredentialFingerprint: envelope.target.migrationCredentialFingerprint,
            fixturePath: selection.fixtures.seed,
            repoRoot,
            executeSql: ({ sql }) => targetDatabase.$executeRawUnsafe(sql)
          });
          fixtureObservations = [
            {
              database: "target",
              migration,
              runtime,
              roleBoundary: {
                superuser: false,
                createdb: false,
                createrole: false,
                bypassrls: false,
                canCreateSchema: false,
                schemaOwner: false,
                objectOwner: false
              }
            }
          ];
        }
        const command = suiteCommand(selection);
        const result = await executeProcess(command.executable, command.arguments, {
          timeoutMs: selection.timeoutMs,
          environment: safeEnvironment(
            {
              S1_RELEASE_DATABASE_TEST: "1",
              S1_RELEASE_DATABASE_CONTEXT: contextRelative
            },
            environment
          )
        });
        const counts = databaseTestCounts(result.stdout);
        if (result.signal || (result.exitCode !== 0 && counts.failed === 0)) {
          throw runnerError("DATABASE_TEST_PROCESS_FAILED", { suiteId: selection.suiteId });
        }
        const roleBoundary = {
          roleAttributes: {
            superuser: targetIdentity.superuser,
            createdb: targetIdentity.createdb,
            createrole: targetIdentity.createrole,
            bypassrls: targetIdentity.bypassrls
          },
          canCreateSchema: targetIdentity.canCreateSchema,
          schemaOwner: targetIdentity.schemaOwner,
          objectOwner: targetIdentity.objectOwner
        };
        return Object.freeze({
          schemaVersion: "database-suite-report.v1",
          operationId: `${envelope.operationId}:${selection.suiteId}`,
          runId: envelope.runId,
          suiteId: selection.suiteId,
          chain: envelope.chain,
          manifestDigest: envelope.databaseTestManifestDigest,
          discoveryDigest: envelope.databaseTestDiscoveryDigest,
          target: {
            databaseName: envelope.target.databaseName,
            databaseOid: envelope.databaseOid,
            targetFingerprint: envelope.databaseIdentityFingerprint,
            ...roleBoundary
          },
          ...(selection.additionalAssignments.length > 0
            ? {
                additionalDatabases: [
                  {
                    name: "source",
                    databaseName: envelope.sourceTarget.databaseName,
                    databaseOid: envelope.sourceTarget.databaseOid,
                    targetFingerprint: envelope.sourceTarget.databaseIdentityFingerprint,
                    roleAttributes: {
                      superuser: sourceIdentity.superuser,
                      createdb: sourceIdentity.createdb,
                      createrole: sourceIdentity.createrole,
                      bypassrls: sourceIdentity.bypassrls
                    },
                    canCreateSchema: sourceIdentity.canCreateSchema,
                    schemaOwner: sourceIdentity.schemaOwner,
                    objectOwner: sourceIdentity.objectOwner
                  }
                ]
              }
            : {}),
          ...(fixtureObservations ? { fixtureObservations } : {}),
          counts,
          sanitizedLogDigest: sha256Canonical(
            summarizeDatabaseTestLog({ stdout: result.stdout, stderr: result.stderr })
          ),
          terminalStatus: counts.failed === 0 ? "PASSED" : "FAILED"
        });
      }
    });
    return Object.freeze({ ...report, reportDigest: sha256Canonical(report) });
  } finally {
    await Promise.allSettled([targetDatabase.close?.(), sourceDatabase?.close?.()]);
    await rm(runRoot, { recursive: true, force: true });
  }
}

function assertCounts(counts) {
  if (
    !counts ||
    counts.collected !== counts.selected ||
    counts.selected !== counts.executed ||
    counts.executed !== counts.passed + counts.failed ||
    counts.failed !== 0 ||
    counts.skipped !== 0 ||
    counts.todo !== 0 ||
    counts.filtered !== 0 ||
    counts.cancelled !== 0
  ) {
    throw runnerError("DATABASE_TEST_COUNT_INCOMPLETE");
  }
}

export async function executeDatabaseTestEnvelope({
  envelope,
  roots,
  readCredential,
  executeManifest
}) {
  validateContract("database-test-launch-envelope.v1", envelope);
  validateContract("build-proof.v1", envelope.buildProof);
  if (
    envelope.buildProofDigest !== sha256Canonical(envelope.buildProof) ||
    envelope.actualRunnerDigest !== envelope.buildProof.identity.images.runner.imageDigest
  ) {
    throw runnerError("RUNNER_LAUNCH_ENVELOPE_IDENTITY_MISMATCH");
  }
  const manifest = JSON.parse(
    await readFile(resolveRunnerReference(envelope.databaseTestManifestReference, roots), "utf8")
  );
  validateContract("database-test-manifest.v1", manifest);
  if (sha256Canonical(manifest) !== envelope.databaseTestManifestDigest) {
    throw runnerError("DATABASE_TEST_MANIFEST_DIGEST_MISMATCH");
  }
  const credential = await readCredential(
    resolveRunnerReference(envelope.capabilitySecretReference, roots)
  );
  if (
    credential.capabilityProfile !== "runtime-test" ||
    credential.username !== envelope.target.runtimeRole ||
    sha256Bytes(Buffer.from(credential.password, "utf8")) !==
      envelope.target.runtimeCredentialFingerprint ||
    envelope.target.runtimeCredentialFingerprint === envelope.target.migrationCredentialFingerprint
  ) {
    throw runnerError("DATABASE_TEST_CAPABILITY_MISMATCH");
  }
  const sourceCredential = envelope.sourceCapabilitySecretReference
    ? await readCredential(resolveRunnerReference(envelope.sourceCapabilitySecretReference, roots))
    : undefined;
  if (
    sourceCredential &&
    (sourceCredential.capabilityProfile !== "runtime-test" ||
      sourceCredential.username !== envelope.sourceTarget.runtimeRole ||
      sourceCredential.username === credential.username ||
      sha256Bytes(Buffer.from(sourceCredential.password, "utf8")) !==
        envelope.sourceTarget.runtimeCredentialFingerprint ||
      envelope.sourceTarget.runtimeCredentialFingerprint ===
        envelope.sourceTarget.migrationCredentialFingerprint)
  ) {
    throw runnerError("DATABASE_TEST_CAPABILITY_MISMATCH");
  }
  if (typeof executeManifest !== "function") {
    throw runnerError("DATABASE_TEST_EXECUTOR_UNAVAILABLE");
  }
  const report = await executeManifest({ envelope, manifest, credential, sourceCredential });
  assertCounts(report?.counts);
  return Object.freeze({ ...report, terminalStatus: "PASSED" });
}
