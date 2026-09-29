import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  executeR3LifecycleSuite,
  assertR3FinalLifecycleOriginals
} from "./r3-lifecycle-test-runner.mjs";
import { finalDatabaseEnvelopeFixture } from "../../apps/release-runner/test/fixtures/final-database-envelope.mjs";
import { validateFinalDatabaseTestAssignments } from "../../apps/release-runner/src/database-test-envelope.mjs";
import {
  computeMigrationCatalog,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  executeR3FinalRuntimeContainer,
  finalRuntimeContainerSpec
} from "./r3-final-migration-container.mjs";

async function probe(rejectLifecycle) {
  const { runR3FinalHostChannel, runR3FinalRunnerChannel } =
    await import("./r3-final-runtime-channel.mjs");
  const { envelope, manifest } = await finalDatabaseEnvelopeFixture();
  const { selections } = validateFinalDatabaseTestAssignments({
    envelope,
    manifest,
    discoveryDigest: envelope.databaseTestDiscoveryDigest
  });
  const selection = {
    ...selections.find((s) => s.r3ExecutionMode === "lifecycle-owned"),
    runId: envelope.runId
  };
  const policies = JSON.parse(
    await readFile(
      new URL("../../release/contracts/database-target-policies.v1.json", import.meta.url)
    )
  );
  const policy = policies.policies.find((p) => p.policyId === "s1-release-compose-ephemeral");
  const catalog = await computeMigrationCatalog(fileURLToPath(new URL("../../", import.meta.url)));
  const target = {
    policyId: policy.policyId,
    environment: "ci-fresh",
    host: "127.0.0.1",
    clusterMarker: policy.requiredClusterMarker,
    clusterFingerprint: sha256Canonical("fake cluster"),
    imageDigest: policy.requiredImageDigest,
    serverVersionNum: "170011"
  };
  const reservations = envelope.suiteAssignments[selection.suiteId].reservations;
  const context = { runId: envelope.operationId, target, policy, reservations };
  const records = reservations.map((r) => ({
    recordVersion: "provisioned-database.v1",
    targetFingerprint: target.clusterFingerprint,
    databaseName: r.databaseName,
    databaseOid: String(9000 + r.shard),
    marker: `fixture-${r.shard}`,
    runId: context.runId,
    suiteId: "database-lifecycle",
    shard: r.shard,
    roles: r.roles,
    secretReferences: Object.fromEntries(
      Object.keys(r.roles).map((role) => [role, `secret/${r.shard}/${role}`])
    ),
    createdAt: "2026-09-29T00:00:00.000Z"
  }));
  const calls = [];
  const adapter = { ...context };
  for (const action of [
    "provision",
    "migrate",
    "grantRuntimeAccess",
    "runtimeRole",
    "migrationOwnership",
    "attemptRuntimeCreate",
    "cleanup",
    "countDatabase",
    "siblingDatabase",
    "countOwned"
  ])
    adapter[action] = async (record) => {
      calls.push(action);
      if (action === "provision") return records[record];
      if (action === "attemptRuntimeCreate")
        throw Object.assign(new Error("denied"), { code: "42501" });
      if (
        action === "cleanup" &&
        (record.databaseName.endsWith("_forged") || record.marker === "forged")
      )
        throw Object.assign(new Error("denied"), { code: "CLEANUP_IDENTITY_MISMATCH" });
      if (["migrate", "grantRuntimeAccess", "cleanup"].includes(action))
        return { privateMigrationCredential: "must-not-cross-channel" };
      if (action === "runtimeRole")
        return {
          rows: [
            {
              super: "false",
              createdb: "false",
              createrole: "false",
              bypassrls: "false",
              login: "true"
            }
          ]
        };
      if (action === "migrationOwnership")
        return {
          rows: [
            {
              schemaOwner: record.roles.migrate,
              migrationOwner: record.roles.migrate,
              canCreate: "false",
              memberships: "0",
              migrationCount: String(catalog.entries.length)
            }
          ]
        };
      if (action === "siblingDatabase") return { rows: [{ databaseName: record.databaseName }] };
      return { rows: [{ count: "0" }] };
    };
  const credentials = Object.fromEntries(
    Object.values(envelope.suiteAssignments)
      .filter((a) => a.kind === "suite")
      .flatMap((a) => Object.values(a.databases))
      .map((db) => [
        db.databaseName,
        {
          username: db.runtimeRole,
          password: `${db.databaseName}:runtime-test`,
          capabilityProfile: "runtime-test"
        }
      ])
  );
  const input = { envelope, credentials, runtimePreparations: {}, lifecycleContext: context };
  const h2r = new PassThrough(),
    r2h = new PassThrough(),
    abort = new AbortController();
  let assessed = false,
    lifecycleFailure;
  const assessLifecycle = async ({ selection: received, originals }) => {
    assert.deepEqual(received, JSON.parse(JSON.stringify(selection)));
    assert.equal(originals.counts.passed, 2);
    assert.equal(calls.length, 19);
    if (rejectLifecycle) throw new Error("independent lifecycle rejection");
    return { report: { suiteId: selection.suiteId, terminalStatus: "PASSED" }, originals };
  };
  const assessResult = async (result) => {
    assessed = true;
    assert.equal(result.lifecycle.report.terminalStatus, "PASSED");
  };
  const runner = runR3FinalRunnerChannel({
    incoming: h2r,
    outgoing: r2h,
    signal: abort.signal,
    executeLifecycleSuite: async (options) => {
      const originals = await executeR3LifecycleSuite(options).catch((cause) => {
        lifecycleFailure = cause.originals;
        throw cause;
      });
      // This test runs the actual importer and 19 adapter actions in a local
      // child, not an image. Only its fixed image path is a simulated boundary.
      assert.throws(() => assertR3FinalLifecycleOriginals(originals));
      for (const event of originals.testEvents)
        event.data.file =
          "/app/packages/release-foundation/test/database-lifecycle.postgres.test.mjs";
      return originals;
    },
    executeManifest: async (received, { executeLifecycle }) => {
      assert.equal(received.envelope.runnerContainerId, envelope.runnerContainerId);
      return { lifecycle: await executeLifecycle(selection) };
    }
  });
  runner.catch(() => abort.abort());
  const events = [];
  let running = false,
    stopped = false,
    deleted = false;
  const cid = envelope.runnerContainerId;
  const identity = {
    operationRef: envelope.operationId,
    sourceSha: envelope.sourceSha,
    imageDigest: envelope.actualRunnerDigest,
    imageReference: `ghcr.io/keqi119/subscription-runner@${envelope.actualRunnerDigest}`,
    postgresAddress: "172.28.0.2"
  };
  const spec = finalRuntimeContainerSpec(identity);
  const imageId = `sha256:${"e".repeat(64)}`;
  const image = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [identity.imageReference],
    Config: { Env: [], Labels: { "org.opencontainers.image.revision": identity.sourceSha } }
  };
  const inspected = () => ({
    Id: cid,
    Name: `/${spec.name}`,
    Image: imageId,
    Config: structuredClone(spec.body),
    HostConfig: structuredClone(spec.body.HostConfig),
    Mounts: [],
    State: {
      Status: stopped ? "exited" : running ? "running" : "created",
      Running: running && !stopped,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: running && !stopped ? 321 : 0,
      ExitCode: 0,
      OOMKilled: false,
      Error: ""
    }
  });
  const engineCall = async (method, url, body, status) => {
    events.push(`${method} ${url}`);
    let value;
    if (url.startsWith("/images/")) value = image;
    else if (url.startsWith("/containers/create?")) {
      assert.deepEqual(body, spec.body);
      value = { Id: cid, Warnings: [] };
    } else if (url.endsWith("/start")) {
      assert.ok(events.includes("attach-ready"));
      running = true;
      value = "";
    } else if (url.includes("/wait?")) {
      stopped = true;
      value = { StatusCode: 0 };
    } else if (method === "DELETE") {
      deleted = true;
      value = "";
    } else if (url.endsWith("/json")) {
      if (status === 404) assert.equal(deleted, true);
      value = status === 404 ? { message: "No such container" } : inspected();
    } else throw new Error(`unexpected Engine call ${method} ${url}`);
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  };
  const host = rejectLifecycle
    ? runR3FinalHostChannel({
        input,
        incoming: r2h,
        outgoing: h2r,
        signal: abort.signal,
        lifecycleAdapter: adapter,
        assessLifecycle,
        assessResult
      })
    : executeR3FinalRuntimeContainer({
        identity,
        signal: abort.signal,
        engineCall,
        recheck: async () => {},
        lifecycleAdapter: adapter,
        assessLifecycle,
        assess: assessResult,
        register: async (id) => {
          assert.equal(id, cid);
          events.push("registered");
        },
        started: async (id) => {
          assert.equal(id, cid);
          assert.equal(running, true);
          assert.equal(stopped, false);
          assert.equal(events.at(-1), `GET /containers/${cid}/json`);
          events.push("started-hook");
        },
        unregister: async (id) => {
          assert.equal(id, cid);
          assert.equal(deleted, true);
          events.push("unregistered");
        },
        prepare: async (id) => {
          assert.equal(id, cid);
          return { input };
        },
        openAttach: () => {
          const stderr = new PassThrough();
          const completed = runner.then(() => {
            r2h.end();
            h2r.end();
            stderr.end();
            return { status: "STREAM_ENDED", socketClosed: true };
          });
          completed.catch(() => {});
          return {
            stdin: h2r,
            stdout: r2h,
            stderr,
            ready: Promise.resolve().then(() => events.push("attach-ready")),
            completed,
            close: async () => {}
          };
        }
      });
  host.catch(() => abort.abort()); // The owner closes/cancels transport after host rejection.
  const result = await Promise.allSettled([host, runner]);
  h2r.destroy();
  r2h.destroy();
  assert.equal(
    calls.length,
    19,
    JSON.stringify(
      lifecycleFailure ?? result.map((r) => r.reason?.originals.transcript.map(({ type }) => type))
    )
  );
  if (rejectLifecycle) {
    assert.ok(
      result.every(
        (r) => r.status === "rejected" && r.reason.code === "R3_FINAL_RUNTIME_CHANNEL_FAILED"
      )
    );
    assert.equal(assessed, false);
    for (const r of result)
      assert.equal(
        JSON.stringify(r.reason.originals).includes(Object.values(credentials)[0].password),
        false
      );
  } else {
    assert.ok(
      result.every((r) => r.status === "fulfilled"),
      result.map((r) => `${r.reason?.stack}\n${JSON.stringify(r.reason?.originals)}`).join("\n")
    );
    assert.equal(assessed, true);
    assert.deepEqual(result[0].value.transcript, result[1].value.transcript);
    assert.equal(result[0].value.transcript.length, 49);
    assert.deepEqual(result[0].value.result, result[1].value.result);
    assert.equal(result[0].value.deleted, true);
    assert.equal(result[0].value.exit.StatusCode, 0);
    assert.equal(result[0].value.originals.trailingBytes, 0);
    assert.equal(result[0].value.originals.stderrBase64, "");
    assert.equal(events.at(-1), "unregistered");
    assert.ok(events.indexOf("started-hook") > events.indexOf(`POST /containers/${cid}/start`));
    assert.equal(
      JSON.stringify(result[0].value).includes(Object.values(credentials)[0].password),
      false
    );
    assert.equal(JSON.stringify(result[0].value).includes("must-not-cross-channel"), false);
  }
  process.stdout.write("probe passed\n");
}

if (process.env.R3_FINAL_RUNTIME_CHANNEL_PROBE) {
  await probe(process.env.R3_FINAL_RUNTIME_CHANNEL_PROBE === "reject");
} else {
  for (const mode of ["normal", "reject"])
    test(`final runtime channel composes actual lifecycle importer (${mode})`, async () => {
      const env = { ...process.env, R3_FINAL_RUNTIME_CHANNEL_PROBE: mode };
      for (const key of ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "DATABASE_URL"]) delete env[key];
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
        child.stdout.on("data", (b) => {
          stdout += b;
        });
        child.stderr.on("data", (b) => {
          stderr += b;
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      });
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /probe passed/u);
    });
}
