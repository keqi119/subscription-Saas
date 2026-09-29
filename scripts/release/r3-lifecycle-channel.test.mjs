import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  openR3LifecycleHostChannel,
  openR3LifecycleRunnerChannel
} from "./r3-lifecycle-channel.mjs";

const bindingDigest = `sha256:${"a".repeat(64)}`;
const failure = { code: "R3_LIFECYCLE_CHANNEL_FAILED" };

function harness() {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const abort = new AbortController();
  const records = [0, 1].map((shard) => ({
    recordVersion: "provisioned-database.v1",
    targetFingerprint: "fixture-target",
    databaseName: `fixture_${shard}`,
    databaseOid: String(100 + shard),
    marker: `fixture-marker-${shard}`,
    runId: "fixture-run",
    suiteId: "database-lifecycle",
    shard,
    roles: { migrate: `migration_${shard}`, "runtime-test": `runtime_${shard}` },
    secretReferences: {
      migrate: `secret/${shard}/migrate`,
      "runtime-test": `secret/${shard}/runtime`
    },
    createdAt: "2026-09-29T00:00:00.000Z"
  }));
  const calls = [];
  const context = {
    runId: "fixture-run",
    target: { clusterFingerprint: "fixture-target" },
    policy: {},
    reservations: records.map(({ shard, databaseName, roles }) => ({ shard, databaseName, roles }))
  };
  const adapter = {
    ...context,
    async provision(shard) {
      calls.push(["provision", shard]);
      return records[shard];
    }
  };
  for (const action of [
    "migrate",
    "grantRuntimeAccess",
    "runtimeRole",
    "migrationOwnership",
    "attemptRuntimeCreate",
    "cleanup",
    "countDatabase",
    "siblingDatabase",
    "countOwned"
  ]) {
    adapter[action] = async (record) => {
      calls.push([action, record]);
      if (action === "attemptRuntimeCreate")
        throw Object.assign(new Error("private diagnostic"), { code: "42501" });
      if (
        action === "cleanup" &&
        (record.databaseName.endsWith("_forged") || record.marker === "forged")
      )
        throw Object.assign(new Error("private diagnostic"), { code: "CLEANUP_IDENTITY_MISMATCH" });
      if (["migrate", "grantRuntimeAccess", "cleanup"].includes(action))
        return { privateDiagnostic: "must stay on H1" };
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
              migrationCount: "128"
            }
          ]
        };
      if (action === "siblingDatabase") return { rows: [{ databaseName: record.databaseName }] };
      return { rows: [{ count: "0" }] };
    };
  }
  const host = openR3LifecycleHostChannel({
    adapter,
    input: requests,
    output: responses,
    bindingDigest,
    signal: abort.signal
  });
  return { requests, responses, abort, records, context, calls, host, adapter };
}

test("finite lifecycle stream exchanges real callback outputs and keeps privileged results on the host", async () => {
  const h = harness();
  const runner = openR3LifecycleRunnerChannel({
    context: h.context,
    input: h.responses,
    output: h.requests,
    bindingDigest,
    signal: h.abort.signal
  });
  try {
    const a = runner.adapter;
    const records = await Promise.all([0, 1].map((n) => a.provision(n)));
    assert.deepEqual(records, h.records);
    await Promise.all(records.map((r) => a.migrate(r)));
    await Promise.all(records.map((r) => a.grantRuntimeAccess(r)));
    for (const r of records) {
      assert.equal((await a.runtimeRole(r)).rows[0].login, "true");
      assert.equal((await a.migrationOwnership(r)).rows[0].migrationCount, "128");
      await assert.rejects(a.attemptRuntimeCreate(r), { code: "42501" });
    }
    await assert.rejects(
      a.cleanup({ ...records[0], databaseName: `${records[0].databaseName}_forged` }),
      { code: "CLEANUP_IDENTITY_MISMATCH" }
    );
    await assert.rejects(a.cleanup({ ...records[0], marker: "forged" }), {
      code: "CLEANUP_IDENTITY_MISMATCH"
    });
    await a.cleanup(records[0]);
    assert.equal((await a.countDatabase(records[0])).rows[0].count, "0");
    assert.equal(
      (await a.siblingDatabase(records[1])).rows[0].databaseName,
      records[1].databaseName
    );
    await a.cleanup(records[1]);
    await a.countOwned();
    const clientTranscript = await runner.finish();
    const hostTranscript = await h.host.completed;
    assert.equal(h.calls.length, 19);
    assert.deepEqual(clientTranscript, hostTranscript);
    assert.equal(clientTranscript.length, 40);
    assert.ok(Object.isFrozen(clientTranscript));
    assert.doesNotMatch(
      JSON.stringify(clientTranscript),
      /private diagnostic|privateDiagnostic|must stay on H1/
    );
    assert.equal(h.calls.find(([action]) => action === "migrate")[1], h.records[0]);
    await assert.rejects(a.provision(0), failure);
  } finally {
    h.abort.abort();
  }
});

test("host rejects foreign binding, added SQL, out-of-order and oversized frames before any callback", async () => {
  for (const change of [
    { bindingDigest: `sha256:${"b".repeat(64)}` },
    { sql: "DROP DATABASE forbidden" },
    { sequence: 2 },
    { action: "migrate" },
    { padding: "x".repeat(131072) }
  ]) {
    const h = harness();
    const rejected = assert.rejects(h.host.completed, failure);
    h.requests.write(
      JSON.stringify({
        channel: "r3-lifecycle.v1",
        bindingDigest,
        sequence: 1,
        action: "provision",
        shard: 0,
        variant: null,
        ...change
      }) + "\n"
    );
    await rejected;
    assert.equal(h.calls.length, 0);
    h.abort.abort();
  }
});

test("premature EOF and abort reject instead of leaving an open successful channel", async () => {
  for (const end of [(h) => h.requests.end(), (h) => h.abort.abort()]) {
    const h = harness();
    const rejected = assert.rejects(h.host.completed, failure);
    end(h);
    await rejected;
    assert.equal(h.calls.length, 0);
    h.abort.abort();
  }
});

test("a valid frame followed by malformed input or abort cannot start a privileged callback", async () => {
  for (const suffix of ["\n", "abort"]) {
    const h = harness();
    const rejected = assert.rejects(
      h.host.completed,
      (error) =>
        error.code === failure.code &&
        error.originals?.frames.length === 1 &&
        !Object.keys(error).includes("originals")
    );
    h.requests.write(
      JSON.stringify({
        channel: "r3-lifecycle.v1",
        bindingDigest,
        sequence: 1,
        action: "provision",
        shard: 0,
        variant: null
      }) +
        "\n" +
        (suffix === "abort" ? "" : suffix)
    );
    if (suffix === "abort") h.abort.abort();
    await rejected;
    assert.equal(h.calls.length, 0);
    h.abort.abort();
  }
});

test("an unexpected callback failure retains private originals on both sides", async () => {
  const h = harness();
  h.adapter.provision = async () => {
    throw new Error("private diagnostic");
  };
  const runner = openR3LifecycleRunnerChannel({
    context: h.context,
    input: h.responses,
    output: h.requests,
    bindingDigest,
    signal: h.abort.signal
  });
  const retained = (error) =>
    error.code === failure.code &&
    error.originals?.frames.length === 2 &&
    !Object.keys(error).includes("originals") &&
    !JSON.stringify(error.originals).includes("private diagnostic");
  try {
    await Promise.all([
      assert.rejects(runner.adapter.provision(0), retained),
      assert.rejects(h.host.completed, retained)
    ]);
  } finally {
    h.abort.abort();
  }
});
