// Internal execution of the exact final manifest on H1-prepared databases.
// The holder must authenticate the envelope, migration preparations, runner
// container and lifecycle callback before providing them here.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runRuntimeSeedFixture,
  runSchemaFixture,
  sha256Bytes,
  sha256Canonical
} from "../../../packages/release-foundation/src/index.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest
} from "../../../packages/release-foundation/src/database-test-launcher.mjs";
import {
  databaseTestCounts,
  summarizeDatabaseTestLog
} from "../../../scripts/release/database-test-launcher-runtime.mjs";
import { assertR3FinalLifecycleOriginals } from "../../../scripts/release/r3-lifecycle-test-runner.mjs";
import { validateFinalDatabaseTestAssignments } from "./database-test-envelope.mjs";
import { observeFinalRuntimeBoundary } from "./final-database-runtime.mjs";

const CODE = "DATABASE_TEST_FINAL_MANIFEST_INVALID";
const MAX_OUTPUT = 524288;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort());
const live = (signal) => need(signal?.addEventListener && !signal.aborted);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const failed = (cause, readbacks, originals) => {
  const error = Object.assign(new Error(CODE), { code: CODE });
  Object.defineProperties(error, {
    cause: { value: cause },
    suiteReadbacks: { value: freeze([...readbacks]) },
    originals: { value: originals }
  });
  return error;
};

function fixedCommand(selection) {
  if (selection.command.executable === "node")
    return { executable: "node", arguments: [...selection.command.arguments] };
  if (selection.command.executable === "pnpm") {
    const args = selection.command.arguments;
    const marker = args.indexOf("vitest");
    need(
      marker >= 0 && same(args.slice(0, marker), ["--filter", "@subscription-saas/api", "exec"])
    );
    return {
      executable: "node",
      arguments: ["apps/api/node_modules/vitest/vitest.mjs", ...args.slice(marker + 1)]
    };
  }
  fail();
}

// The injected executeProcess has the same shape. This default owns its child,
// caps output and settles on actual close; an abort/timeout cannot look passed.
function runProcess(executable, args, { environment, timeoutMs, repoRoot, signal }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = { stdout: [], stderr: [] };
    let size = 0,
      processError = false,
      timedOut = false,
      truncated = false,
      stopping = false,
      closed = false;
    let timeout, kill, drain;
    const send = (name) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        try {
          child.kill(name);
        } catch {
          /* drain remains bounded */
        }
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      send("SIGTERM");
      kill = setTimeout(() => {
        if (!closed) send("SIGKILL");
      }, 1000);
      drain = setTimeout(() => done(null, null), 3000);
    };
    const capture = (stream, bytes) => {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const kept = Math.max(0, Math.min(buffer.length, MAX_OUTPUT - size));
      if (kept) chunks[stream].push(buffer.subarray(0, kept));
      size += buffer.length;
      if (size > MAX_OUTPUT) {
        truncated = true;
        stop();
      }
    };
    const onAbort = () => stop();
    const done = (exitCode, exitSignal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearTimeout(kill);
      clearTimeout(drain);
      signal.removeEventListener("abort", onAbort);
      // Best effort descendant cleanup; this is not a process-group absence claim.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      resolve({
        code: closed ? exitCode : null,
        exitCode: closed ? exitCode : null,
        signal: closed ? exitSignal : null,
        processError: processError || !closed || stopping,
        timedOut,
        truncated,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8")
      });
    };
    let resolved = false;
    child.stdout.on("data", (bytes) => capture("stdout", bytes));
    child.stderr.on("data", (bytes) => capture("stderr", bytes));
    child.once("error", () => {
      processError = true;
      stop();
    });
    child.once("close", (code, signalName) => {
      closed = true;
      done(code, signalName);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal.aborted) onAbort();
  });
}

function credentialFacts(selections, credentials, runtimePreparations) {
  const expected = new Map();
  for (const selection of selections) {
    if (selection.r3ExecutionMode === "lifecycle-owned") continue;
    for (const database of Object.values(selection.databaseAssignment.databases)) {
      need(!expected.has(database.databaseName));
      expected.set(database.databaseName, database);
    }
  }
  need(
    exact(credentials, [...expected.keys()]) && exact(runtimePreparations, [...expected.keys()])
  );
  for (const [name, db] of expected) {
    const credential = credentials[name],
      prepared = runtimePreparations[name];
    need(
      exact(credential, ["username", "password", "capabilityProfile"]) &&
        credential.username === db.runtimeRole &&
        credential.capabilityProfile === "runtime-test" &&
        typeof credential.password === "string" &&
        credential.password.length >= 16 &&
        sha256Bytes(Buffer.from(credential.password, "utf8")) === db.runtimeCredentialFingerprint &&
        db.runtimeCredentialFingerprint !== db.migrationCredentialFingerprint &&
        exact(prepared, ["migrationEvidenceDigest", "schemaFixture"]) &&
        prepared.migrationEvidenceDigest === db.migrationEvidenceDigest
    );
  }
  return expected;
}

async function assertPreparations(selections, prepared, repoRoot) {
  for (const selection of selections) {
    if (selection.r3ExecutionMode === "lifecycle-owned") continue;
    const assignments = [selection.assignment, ...selection.additionalAssignments];
    for (const assignment of assignments) {
      const db = selection.databaseAssignment.databases[assignment.name ?? "target"];
      const actual = prepared[db.databaseName].schemaFixture;
      if (!selection.fixtures) {
        need(actual === null);
        continue;
      }
      const expected = await runSchemaFixture({
        repoRoot,
        runtimeRole: db.runtimeRole,
        fixturePath: selection.fixtures.schema,
        credentialRef: assignment.secretReferences.migrate,
        credentialFingerprint: db.migrationCredentialFingerprint,
        counterpartCredentialFingerprint: db.runtimeCredentialFingerprint,
        executeSql: async () => {}
      });
      need(same(actual, expected));
    }
  }
}

function contextDatabase(db, secretReference) {
  return {
    databaseName: db.databaseName,
    databaseOid: db.databaseOid,
    targetFingerprint: db.databaseIdentityFingerprint,
    runtimeSecretReference: secretReference,
    migrationCredentialFingerprint: db.migrationCredentialFingerprint,
    runtimeCredentialFingerprint: db.runtimeCredentialFingerprint
  };
}

function provisioned(selection, assignment) {
  const main = assignment.databases.target;
  return {
    ...selection.assignment,
    databaseOid: main.databaseOid,
    targetFingerprint: main.databaseIdentityFingerprint,
    additionalDatabases: selection.additionalAssignments.map((item) => {
      const db = assignment.databases[item.name];
      return {
        ...item,
        databaseOid: db.databaseOid,
        targetFingerprint: db.databaseIdentityFingerprint
      };
    })
  };
}

export async function executePreparedFinalManifest({
  envelope,
  manifest,
  discoveryDigest,
  credentials,
  runtimePreparations,
  connectDatabase,
  executeLifecycle,
  signal,
  repoRoot = "/app",
  executeProcess = runProcess
}) {
  const suiteReadbacks = [];
  let currentOriginals = null,
    createdRoot = false;
  try {
    live(signal);
    need(
      path.isAbsolute(repoRoot) &&
        typeof connectDatabase === "function" &&
        typeof executeLifecycle === "function" &&
        typeof executeProcess === "function"
    );
    const held = validateFinalDatabaseTestAssignments({ envelope, manifest, discoveryDigest });
    const selections = held.selections.map((selection) =>
      freeze({ ...selection, runId: envelope.runId })
    );
    credentialFacts(selections, credentials, runtimePreparations);
    await assertPreparations(selections, runtimePreparations, repoRoot);
    live(signal);
    const relativeRoot = path.posix.join(".release-local", "runs", envelope.runId);
    const runRoot = path.resolve(repoRoot, relativeRoot);
    need(runRoot.startsWith(path.resolve(repoRoot, ".release-local", "runs") + path.sep));
    await mkdir(path.dirname(runRoot), { recursive: true, mode: 0o700 });
    await mkdir(runRoot, { mode: 0o700 });
    createdRoot = true;
    let interrupted = false;
    const manifestReport = await runDatabaseManifest({
      selections,
      concurrency: 1,
      executeSuite: async (selection) => {
        if (interrupted) fail();
        const originals = {
          suiteId: selection.suiteId,
          databases: [],
          fixtures: [],
          context: null,
          secretReferences: [],
          process: null,
          logSummary: null,
          lifecycle: null
        };
        currentOriginals = originals;
        try {
          live(signal);
          if (selection.r3ExecutionMode === "lifecycle-owned") {
            const value = await executeLifecycle(selection);
            live(signal);
            need(exact(value, ["report", "originals"]));
            assertR3FinalLifecycleOriginals(value.originals);
            const counts = databaseTestCounts(value.originals.tap);
            need(
              same(value.report.counts, counts) &&
                value.report.terminalStatus === "PASSED" &&
                value.report.sanitizedLogDigest ===
                  sha256Canonical(
                    summarizeDatabaseTestLog({ stdout: value.originals.tap, stderr: "" })
                  )
            );
            originals.lifecycle = value.originals;
            const readback = freeze({
              suiteId: selection.suiteId,
              report: value.report,
              originals
            });
            suiteReadbacks.push(readback);
            currentOriginals = null;
            return value.report;
          }
          const assignment = selection.databaseAssignment;
          const entries = [
            { name: "target", item: selection.assignment },
            ...selection.additionalAssignments.map((item) => ({ name: item.name, item }))
          ];
          const suiteRelative = path.posix.join(relativeRoot, selection.suiteId);
          const suiteRoot = path.resolve(repoRoot, suiteRelative);
          await mkdir(suiteRoot, { mode: 0o700 });
          const opened = [];
          try {
            const contexts = {};
            const boundaries = [];
            const fixtureObservations = [];
            for (const { name } of entries) {
              live(signal);
              const db = assignment.databases[name];
              const credential = credentials[db.databaseName];
              const target = {
                hostname: "postgres",
                port: 5432,
                tlsMode: "require",
                databaseName: db.databaseName
              };
              const connection = await connectDatabase({ credential, target });
              opened.push(connection);
              live(signal);
              const observed = await observeFinalRuntimeBoundary(connection, db);
              originals.databases.push({
                name,
                databaseName: db.databaseName,
                observation: observed
              });
              boundaries.push({ database: name, ...observed.roleBoundary });
              const secretRelative = path.posix.join(suiteRelative, name, "runtime-test.json");
              const secretFile = path.resolve(repoRoot, secretRelative);
              await mkdir(path.dirname(secretFile), { mode: 0o700 });
              await writeFile(
                secretFile,
                JSON.stringify({
                  username: credential.username,
                  password: credential.password,
                  host: "postgres",
                  port: 5432,
                  database: db.databaseName,
                  tlsMode: "require"
                }) + "\n",
                { flag: "wx", mode: 0o600 }
              );
              originals.secretReferences.push({
                name,
                databaseName: db.databaseName,
                reference: secretRelative
              });
              contexts[name] = contextDatabase(db, secretRelative);
              if (selection.fixtures) {
                live(signal);
                const runtime = await runRuntimeSeedFixture({
                  repoRoot,
                  fixturePath: selection.fixtures.seed,
                  credentialRef: secretRelative,
                  credentialFingerprint: db.runtimeCredentialFingerprint,
                  counterpartCredentialFingerprint: db.migrationCredentialFingerprint,
                  executeSql: ({ sql }) => connection.$executeRawUnsafe(sql)
                });
                const fixture = {
                  database: name,
                  migration: runtimePreparations[db.databaseName].schemaFixture,
                  runtime,
                  roleBoundary: {
                    ...observed.roleBoundary.roleAttributes,
                    canCreateSchema: observed.roleBoundary.canCreateSchema,
                    schemaOwner: observed.roleBoundary.schemaOwner,
                    objectOwner: observed.roleBoundary.objectOwner
                  }
                };
                fixtureObservations.push(fixture);
                originals.fixtures.push(fixture);
              }
            }
            const context = {
              schemaVersion: "release-database-test-context.v1",
              operationRef: envelope.operationId,
              suiteId: selection.suiteId,
              profileDigest: envelope.profileDigest,
              allowedFiles: [...selection.files],
              containerId: envelope.runnerContainerId,
              ...contexts.target,
              ...(entries.length > 1 ? { namedDatabases: contexts } : {})
            };
            originals.context = context;
            const contextRelative = path.posix.join(suiteRelative, "context.json");
            await writeFile(
              path.resolve(repoRoot, contextRelative),
              JSON.stringify(context) + "\n",
              { flag: "wx", mode: 0o600 }
            );
            live(signal);
            const command = fixedCommand(selection);
            const result = await executeProcess(command.executable, command.arguments, {
              repoRoot,
              signal,
              timeoutMs: selection.timeoutMs,
              environment: {
                PATH: "/pnpm:/usr/local/bin:/usr/bin:/bin",
                HOME: "/tmp",
                NODE_ENV: "test",
                S1_RELEASE_DATABASE_TEST: "1",
                S1_RELEASE_DATABASE_CONTEXT: contextRelative
              }
            });
            originals.process = result;
            live(signal);
            need(
              result &&
                result.exitCode === 0 &&
                result.signal === null &&
                result.timedOut === false &&
                result.truncated === false &&
                result.processError === false &&
                typeof result.stdout === "string" &&
                typeof result.stderr === "string" &&
                Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= MAX_OUTPUT
            );
            const counts = databaseTestCounts(result.stdout);
            need(
              counts.failed === 0 &&
                counts.cancelled === 0 &&
                counts.skipped === 0 &&
                counts.todo === 0
            );
            const logSummary = summarizeDatabaseTestLog(result);
            originals.logSummary = logSummary;
            const report = buildDatabaseSuiteReport({
              execution: selection,
              operationId: envelope.operationId,
              provisioned: provisioned(selection, assignment),
              result: {
                counts,
                roleBoundaries: boundaries,
                sanitizedLogDigest: sha256Canonical(logSummary),
                ...(selection.fixtures ? { fixtureObservations } : {})
              }
            });
            need(report.terminalStatus === "PASSED");
            const readback = freeze({ suiteId: selection.suiteId, report, originals });
            suiteReadbacks.push(readback);
            currentOriginals = null;
            return report;
          } finally {
            const closed = await Promise.allSettled(opened.map((database) => database.close?.()));
            await rm(suiteRoot, { recursive: true, force: true });
            need(closed.every(({ status }) => status === "fulfilled"));
          }
        } catch (cause) {
          interrupted = true;
          throw cause;
        }
      }
    });
    need(manifestReport.terminalStatus === "PASSED" && suiteReadbacks.length === selections.length);
    return freeze({ manifestReport, suiteReadbacks });
  } catch (cause) {
    throw failed(cause, suiteReadbacks, currentOriginals);
  } finally {
    if (createdRoot) {
      // The path was derived from the authenticated UUID and created by this call.
      await rm(path.resolve(repoRoot, ".release-local", "runs", envelope.runId), {
        recursive: true,
        force: true
      });
    }
  }
}
