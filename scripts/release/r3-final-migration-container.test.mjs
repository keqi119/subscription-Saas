import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { finalMigrationInputFixture } from "../../apps/release-runner/test/fixtures/final-migration-input.mjs";
import { runR3MigrationRunnerChannel } from "./r3-final-migration-channel.mjs";

async function fixture(exitCode = 0, extraStdout = false) {
  const { input } = await finalMigrationInputFixture();
  const { executeR3FinalMigrationContainer, finalMigrationContainerSpec } =
    await import("./r3-final-migration-container.mjs");
  const identity = {
    operationRef: input.operationId,
    sourceSha: input.sourceSha,
    imageReference: `${input.buildProof.identity.images.runner.registry}@${input.actualRunnerDigest}`,
    imageDigest: input.actualRunnerDigest,
    runnerContainerId: input.runnerContainerId,
    postgresAddress: "172.28.0.2"
  };
  const spec = finalMigrationContainerSpec(identity),
    cid = input.migrationContainerId;
  const imageId = `sha256:${"a".repeat(64)}`;
  const image = {
    Id: imageId,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [identity.imageReference],
    Config: { Labels: { "org.opencontainers.image.revision": identity.sourceSha }, Env: [] }
  };
  const controller = new AbortController(),
    events = [],
    results = [];
  let started = false,
    finished = false,
    deleted = false,
    runner;
  const inspected = () => ({
    Id: cid,
    Name: `/${spec.name}`,
    Image: imageId,
    Config: structuredClone(spec.body),
    HostConfig: structuredClone(spec.body.HostConfig),
    Mounts: [],
    State: {
      Status: finished ? "exited" : started ? "running" : "created",
      Running: started && !finished,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: started && !finished ? 122 : 0,
      ExitCode: exitCode,
      OOMKilled: false,
      Error: ""
    }
  });
  const fakeEngine = async (method, url, body, status) => {
    events.push(`${method} ${url}`);
    let value;
    if (url.startsWith("/images/")) value = image;
    else if (url.startsWith("/containers/create?")) {
      assert.deepEqual(body, spec.body);
      value = { Id: cid, Warnings: [] };
    } else if (url.endsWith("/start")) {
      assert.ok(events.includes("attach-ready"));
      started = true;
      value = "";
    } else if (url.includes("/wait?")) value = { StatusCode: exitCode };
    else if (method === "DELETE") {
      deleted = true;
      value = "";
    } else if (url.endsWith("/json")) {
      if (status === 404) assert.equal(deleted, true);
      value = status === 404 ? { message: "No such container" } : inspected();
    } else throw new Error(`unexpected Engine call ${url}`);
    return typeof value === "string" ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  };
  const openAttach = () => {
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    const startedAt = new Date().toISOString();
    let sentBytes = 0,
      receivedBytes = 0,
      frames = 0;
    const inputWrite = stdin.write.bind(stdin),
      outputWrite = stdout.write.bind(stdout);
    stdin.write = (bytes, ...args) => {
      sentBytes += Buffer.byteLength(bytes);
      return inputWrite(bytes, ...args);
    };
    stdout.write = (bytes, ...args) => {
      receivedBytes += Buffer.byteLength(bytes);
      frames++;
      return outputWrite(bytes, ...args);
    };
    const childSignal = new AbortController();
    const nextResult = (stage, payload) => {
      const result = {
        schemaVersion: "r3-final-migration-result.v1",
        stage,
        bindingDigest: sha256Canonical(input),
        predecessorDigest: sha256Canonical(results.at(-1) ?? input),
        baselineManifestIdentityDigest: sha256Canonical("identity"),
        baselineManifestDigest: sha256Canonical("baseline"),
        planDigest: sha256Canonical("plan"),
        ...payload
      };
      results.push(result);
      return result;
    };
    runner = runR3MigrationRunnerChannel({
      incoming: stdin,
      outgoing: stdout,
      signal: childSignal.signal,
      openRuntime: async () => ({
        plan: async () => nextResult("plan", { baseline: {}, plan: {}, originals: [] }),
        apply: async () => nextResult("apply", { postStateObservation: {} }),
        verify: async () =>
          nextResult("verify", { observation: {}, originals: [], processOriginals: [] }),
        prepare: async () => nextResult("prepare", { preparation: {} }),
        close: async () => {}
      })
    });
    runner.catch(() => {});
    const completed = runner.then(() => {
      finished = true;
      if (extraStdout) stdout.write("unexpected-after-finished\n");
      stdout.end();
      stderr.end();
      return {
        status: "STREAM_ENDED",
        socketClosed: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        frames,
        sentBytes,
        receivedBytes
      };
    });
    completed.catch(() => {});
    return {
      stdin,
      stdout,
      stderr,
      ready: Promise.resolve().then(() => events.push("attach-ready")),
      completed,
      close: async () => {
        childSignal.abort();
        await runner.catch(() => {});
      }
    };
  };
  const run = () =>
    executeR3FinalMigrationContainer({
      identity,
      signal: controller.signal,
      engineCall: fakeEngine,
      recheck: async () => {},
      register: async (id) => {
        assert.equal(id, cid);
        events.push("registered");
      },
      started: async (id) => {
        assert.equal(id, cid);
        assert.equal(started, true);
        assert.equal(finished, false);
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
        return {
          input,
          credential: {
            username: input.database.migrationRole,
            password: "synthetic-private-password",
            capabilityProfile: "migrate"
          }
        };
      },
      assess: async () => {},
      openAttach
    });
  return { run, events, cid, results, identity };
}

test("the owned migration container attaches before start and requires actual exit and deletion readback", async () => {
  const f = await fixture();
  const result = await f.run();
  assert.deepEqual(result.results, f.results);
  assert.equal(result.containerId, f.cid);
  assert.equal(result.exit.StatusCode, 0);
  assert.equal(result.deleted, true);
  assert.ok(f.events.indexOf("started-hook") > f.events.indexOf(`POST /containers/${f.cid}/start`));
  assert.equal(f.events.at(-1), "unregistered");
  assert.equal(JSON.stringify(result).includes("synthetic-private-password"), false);
});

test("a completed protocol with nonzero actual exit remains failed while exact owned cleanup still runs", async () => {
  const f = await fixture(7);
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "R3_FINAL_MIGRATION_CONTAINER_FAILED");
    assert.equal(error.originals.exit.StatusCode, 7);
    assert.equal(error.originals.deleted, true);
    assert.equal(JSON.stringify(error.originals).includes("synthetic-private-password"), false);
    return true;
  });
  assert.equal(f.events.at(-1), "unregistered");
});

test("output arriving after the final protocol frame cannot be hidden by stream disposal", async () => {
  const f = await fixture(0, true);
  await assert.rejects(f.run(), { code: "R3_FINAL_MIGRATION_CONTAINER_FAILED" });
  assert.equal(f.events.at(-1), "unregistered");
});

test("container originals independently reconstruct the owned execution and reject tampered evidence", async () => {
  const { assessR3FinalContainerOriginals } = await import("./r3-final-migration-container.mjs");
  const f = await fixture();
  const completed = await f.run();
  const assess = (originals) =>
    assessR3FinalContainerOriginals({ identity: f.identity, role: "migration", originals });
  const receipt = assess(completed.originals);
  assert.equal(receipt.containerId, f.cid);
  assert.deepEqual(receipt.resultDigests, completed.results.map(sha256Canonical));
  for (const change of [
    (o) => {
      o.exchanges[1].requestBody.HostConfig.Privileged = true;
    },
    (o) => {
      o.exchanges.splice(3, 1);
    },
    (o) => {
      o.channelStartExchangeCount = 3;
    },
    (o) => {
      o.transport.socketClosed = false;
    },
    (o) => {
      o.transport.sentBytes++;
    },
    (o) => {
      o.channel.results[2].bindingDigest = `sha256:${"0".repeat(64)}`;
    },
    (o) => {
      o.channel.transcript[1].raw = "credential must never be retained";
    },
    (o) => {
      o.inputIdentity.migrationContainerId = "f".repeat(64);
    }
  ]) {
    const changed = structuredClone(completed.originals);
    change(changed);
    assert.throws(() => assess(changed), { code: "R3_FINAL_MIGRATION_CONTAINER_FAILED" });
  }
});
