import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const launcher = fileURLToPath(new URL("./launch-manual-stage1.mjs", import.meta.url));
const identity = {
  databaseOid: "123",
  systemIdentifier: "cluster",
  serverVersionNum: "170000",
  serverAddress: "127.0.0.1",
  serverPort: 55441,
  role: "release_provisioner",
  tls: true,
  clusterMarker: "marker"
};

async function fixture({
  identityFor = (databaseName) => ({ ...identity, databaseName }),
  closeFor = () => null
} = {}) {
  const source = await readFile(launcher, "utf8");
  const begin = source.indexOf(
    "  const databaseAdmin = async (plan, work, observations = null, lifecycle = false) => {"
  );
  const end = source.indexOf("\n  const provisionDatabases = async () => {", begin);
  assert.ok(begin >= 0 && end > begin);
  const opened = [];
  const stats = { identity: 0, recheck: 0, statements: 0, observed: 0 };
  const run = vm.runInNewContext(`${source.slice(begin, end)}\ndatabaseAdmin`, {
    lifecycleAttempted: false,
    lifecycleReady: false,
    completionReady: false,
    code: "TEST_STOP",
    fail: (code) => {
      throw new Error(code);
    },
    closed: false,
    postgresSecret: {
      bytes: Buffer.from("opaque"),
      recheck: async () => {
        stats.recheck++;
      }
    },
    createPostgresConnector:
      () =>
      async ({ target }) => {
        const item = { databaseName: target.databaseName, closed: 0 };
        opened.push(item);
        return {
          execute: async () => {
            stats.statements++;
          },
          query: async (sql) => {
            if (sql === "IDENTITY") {
              stats.identity++;
              return [{ identity: identityFor(target.databaseName, stats.identity) }];
            }
            stats.observed++;
            return [{ ok: true }];
          },
          close: async () => {
            item.closed++;
            const failure = closeFor(target.databaseName);
            if (failure) throw failure;
          }
        };
      },
    fixed: { spec: { operationRef: "operation" } },
    consumption: { executionRecordDigest: "digest" },
    pgIdentitySql: "IDENTITY",
    postgresTarget: { postgres: identity },
    consumerAttempted: true,
    diagnostics: []
  });
  return { run, opened, stats };
}

test("37-target pass reuses postgres connection but rechecks identity on every switch", async () => {
  const { run, opened, stats } = await fixture();
  const targets = Array.from({ length: 37 }, (_, i) => ({ databaseName: `target_${i}` }));
  const observations = [];
  await run(
    { targets },
    async (executeAdmin) => {
      for (const target of targets) {
        for (let i = 0; i < 3; i++)
          await executeAdmin({ databaseName: "postgres", sql: "SELECT role" });
        await executeAdmin({ databaseName: target.databaseName, sql: "SELECT schema" });
      }
    },
    observations
  );
  assert.equal(opened.length, 38);
  assert.equal(stats.recheck, 74);
  assert.equal(stats.identity, 74);
  assert.equal(stats.statements, 114);
  assert.equal(stats.observed, 148);
  assert.equal(observations.length, 148);
  assert.ok(opened.every((item) => item.closed === 1));
});

test("failure closes both retained postgres and active target connections", async () => {
  const { run, opened } = await fixture();
  const failure = new Error("work failed");
  await assert.rejects(
    run({ targets: [{ databaseName: "target" }] }, async (executeAdmin) => {
      await executeAdmin({ databaseName: "postgres", sql: "SELECT role" });
      await executeAdmin({ databaseName: "target", sql: "SELECT schema" });
      throw failure;
    }),
    (error) => error === failure
  );
  assert.equal(opened.length, 2);
  assert.ok(opened.every((item) => item.closed === 1));
});

test("reused postgres connection rejects a changed identity and closes both connections", async () => {
  const { run, opened, stats } = await fixture({
    identityFor: (databaseName, call) => ({
      ...identity,
      databaseName,
      systemIdentifier:
        databaseName === "postgres" && call === 3 ? "changed" : identity.systemIdentifier
    })
  });
  await assert.rejects(
    run({ targets: [{ databaseName: "target" }] }, async (executeAdmin) => {
      await executeAdmin({ databaseName: "postgres", sql: "SELECT role" });
      await executeAdmin({ databaseName: "target", sql: "SELECT schema" });
      await executeAdmin({ databaseName: "postgres", sql: "SELECT role" });
    }),
    { message: "TEST_STOP" }
  );
  assert.equal(stats.identity, 3);
  assert.equal(opened.length, 2);
  assert.ok(opened.every((item) => item.closed === 1));
});

test("a target close error does not skip retained postgres cleanup", async () => {
  const closeFailure = new Error("target close failed");
  const { run, opened } = await fixture({
    closeFor: (databaseName) => (databaseName === "target" ? closeFailure : null)
  });
  await assert.rejects(
    run({ targets: [{ databaseName: "target" }] }, async (executeAdmin) => {
      await executeAdmin({ databaseName: "postgres", sql: "SELECT role" });
      await executeAdmin({ databaseName: "target", sql: "SELECT schema" });
    }),
    (error) => error === closeFailure
  );
  assert.ok(opened.every((item) => item.closed === 1));
});
