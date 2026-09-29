import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { finalMigrationInputFixture } from "../../apps/release-runner/test/fixtures/final-migration-input.mjs";

const digest = (value) => sha256Canonical(value);
async function fixture() {
  const { input } = await finalMigrationInputFixture();
  const channel = await import("./r3-final-migration-channel.mjs");
  const incoming = new PassThrough(),
    outgoing = new PassThrough(),
    controller = new AbortController();
  const credential = {
    username: input.database.migrationRole,
    password: "private-channel-fixture-password",
    capabilityProfile: "migrate"
  };
  const calls = [],
    results = [],
    assessments = [];
  const result = (stage, payload) => {
    const value = {
      schemaVersion: "r3-final-migration-result.v1",
      stage,
      bindingDigest: digest(input),
      predecessorDigest: results.length ? digest(results.at(-1)) : digest(input),
      baselineManifestIdentityDigest: digest("baseline-identity"),
      baselineManifestDigest: digest("baseline"),
      planDigest: digest("plan"),
      ...payload
    };
    results.push(value);
    return value;
  };
  const runtime = {
    plan: async () => {
      calls.push("plan");
      return result("plan", { baseline: {}, plan: {} });
    },
    apply: async (request) => {
      calls.push("apply");
      assert.deepEqual(request, {
        predecessorDigest: digest(results.at(-1)),
        planDigest: digest("plan")
      });
      return result("apply", { postStateObservation: {} });
    },
    verify: async (request) => {
      calls.push("verify");
      assert.deepEqual(request, { predecessorDigest: digest(results.at(-1)) });
      return result("verify", { observation: {}, originals: [], processOriginals: [] });
    },
    close: async () => {
      calls.push("close");
    }
  };
  return {
    input,
    channel,
    incoming,
    outgoing,
    controller,
    credential,
    calls,
    results,
    assessments,
    runtime
  };
}

test("the fixed migration conversation waits for host assessment and never retains its credential frame", async () => {
  const f = await fixture();
  const host = f.channel.runR3MigrationHostChannel({
    input: f.input,
    credential: f.credential,
    incoming: f.outgoing,
    outgoing: f.incoming,
    signal: f.controller.signal,
    assess: async ({ stage, result }) => {
      f.assessments.push(stage);
      assert.equal(result.bindingDigest, digest(f.input));
    }
  });
  const runner = f.channel.runR3MigrationRunnerChannel({
    incoming: f.incoming,
    outgoing: f.outgoing,
    signal: f.controller.signal,
    openRuntime: async ({ input, credential, signal }) => {
      assert.deepEqual(input, f.input);
      assert.deepEqual(credential, f.credential);
      assert.equal(signal.aborted, false);
      return f.runtime;
    }
  });
  const [hostResult, runnerResult] = await Promise.all([host, runner]);
  assert.deepEqual(f.calls, ["plan", "apply", "verify", "close"]);
  assert.deepEqual(f.assessments, ["plan", "apply", "verify"]);
  assert.deepEqual(hostResult.results, f.results);
  assert.deepEqual(hostResult.transcript, runnerResult.transcript);
  assert.equal(hostResult.transcript.length, 9);
  assert.equal(JSON.stringify(hostResult).includes(f.credential.password), false);
});

test("a rejected host plan cannot start apply and closing the pipe cancels the runtime", async () => {
  const f = await fixture();
  const host = f.channel.runR3MigrationHostChannel({
    input: f.input,
    credential: f.credential,
    incoming: f.outgoing,
    outgoing: f.incoming,
    signal: f.controller.signal,
    assess: async () => {
      throw new Error("synthetic independent rejection");
    }
  });
  let runtimeSignal;
  const runner = f.channel.runR3MigrationRunnerChannel({
    incoming: f.incoming,
    outgoing: f.outgoing,
    signal: f.controller.signal,
    openRuntime: async ({ signal }) => {
      runtimeSignal = signal;
      return f.runtime;
    }
  });
  await assert.rejects(host, (error) => {
    assert.equal(error.code, "R3_FINAL_MIGRATION_CHANNEL_FAILED");
    assert.equal(JSON.stringify(error.originals).includes(f.credential.password), false);
    return true;
  });
  f.incoming.end();
  await assert.rejects(runner, { code: "R3_FINAL_MIGRATION_CHANNEL_FAILED" });
  assert.equal(runtimeSignal.aborted, true);
  assert.deepEqual(f.calls, ["plan", "close"]);
});

for (const suffix of ["{}\n", "{"])
  test(`unsolicited bytes ${JSON.stringify(suffix)} after a valid APPLY stop the write before its callback starts`, async () => {
    const f = await fixture();
    const next = () =>
      new Promise((resolve) => f.outgoing.once("data", (bytes) => resolve(JSON.parse(bytes))));
    const helloPending = next();
    const runner = f.channel.runR3MigrationRunnerChannel({
      incoming: f.incoming,
      outgoing: f.outgoing,
      signal: f.controller.signal,
      openRuntime: async () => f.runtime
    });
    const hello = await helloPending;
    const bindingDigest = digest(f.input);
    const planPending = next();
    f.incoming.write(
      `${JSON.stringify({ channel: "r3-final-migration.v1", type: "START", sequence: 1, bindingDigest, challenge: hello.challenge, input: f.input, credential: f.credential })}\n`
    );
    const plan = await planPending;
    await new Promise((resolve) => setImmediate(resolve));
    f.incoming.write(
      `${JSON.stringify({ channel: "r3-final-migration.v1", type: "APPLY", sequence: 3, bindingDigest, predecessorDigest: digest(plan.result), planDigest: plan.result.planDigest })}\n${suffix}`
    );
    runner.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.equal(f.calls.includes("apply"), false);
    } finally {
      f.controller.abort();
      await runner.catch(() => {});
    }
    await assert.rejects(runner, { code: "R3_FINAL_MIGRATION_CHANNEL_FAILED" });
    assert.deepEqual(f.calls, ["plan", "close"]);
  });
