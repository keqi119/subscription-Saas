import assert from "node:assert/strict";
import test from "node:test";

import {
  selectManifestSuites,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  assertSourceGateCheckout,
  parseLauncherArguments,
  runLauncherCli,
  summarizeDatabaseTestLog
} from "./database-test-launcher-runtime.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const manifest = {
  schemaVersion: "database-test-manifest.v1",
  batches: [{ batchId: "launcher-fixture", suiteIds: ["release.launcher.fixture"] }],
  suites: [
    {
      suiteId: "release.launcher.fixture",
      runner: "node-test",
      files: ["release/test-fixtures/database-launcher-fixture.postgres.test.mjs"],
      chainApplicability: {
        fresh: { status: "required" },
        snapshot: { status: "required" }
      },
      databaseRole: "runtime-equivalent-test",
      parallelism: { mode: "serial", maxShards: 1 },
      timeoutMs: 120000,
      barrier: "database",
      externalDependency: "none",
      owner: "release-engineering",
      expectedCountPolicy: { mode: "exact", collected: 1 }
    }
  ]
};

function selections(request) {
  return selectManifestSuites({
    manifest,
    discoveryDigest: digest,
    discoveryUnclassifiedCount: 0,
    chain: request.chain,
    suiteIds: request.suiteId ? [request.suiteId] : undefined,
    batchId: request.batchId,
    runId: "run-cli-parity",
    secretRootRef: ".release-local/runs/run-cli-parity"
  });
}

test("suite, manifest, and source gate adapters share one selector", () => {
  const suite = selections(
    parseLauncherArguments("suite", ["--suite-id", "release.launcher.fixture", "--chain", "fresh"])
  );
  const manifestSelection = selections(
    parseLauncherArguments("manifest", [
      "--batch",
      "launcher-fixture",
      "--chain",
      "fresh",
      "--concurrency",
      "1"
    ])
  );
  const sourceGate = selections(
    parseLauncherArguments("source-gate", ["--chain", "fresh", "--batch", "launcher-fixture"])
  );
  assert.deepEqual(suite, manifestSelection);
  assert.deepEqual(sourceGate, manifestSelection);
  assert.equal(sourceGate[0].manifestDigest, sha256Canonical(manifest));
});

test("adapters reject caller paths, missing values, duplicates, and unsupported concurrency", async () => {
  for (const argv of [
    ["--suite-id", "release.launcher.fixture", "--chain"],
    ["--suite-id", "release.launcher.fixture", "--file", "injected.test.mjs"],
    ["--suite-id", "a", "--suite-id", "b", "--chain", "fresh"]
  ]) {
    assert.throws(() => parseLauncherArguments("suite", argv), {
      code: "DATABASE_LAUNCHER_ARGUMENT_INVALID"
    });
  }
  await assert.rejects(
    runLauncherCli(
      "manifest",
      ["--batch", "launcher-fixture", "--chain", "fresh", "--concurrency", "2"],
      async (request) => {
        if (request.concurrency !== 1) {
          throw Object.assign(new Error("DATABASE_LAUNCHER_CONCURRENCY_NOT_IMPLEMENTED"), {
            code: "DATABASE_LAUNCHER_CONCURRENCY_NOT_IMPLEMENTED"
          });
        }
      }
    ),
    { code: "DATABASE_LAUNCHER_CONCURRENCY_NOT_IMPLEMENTED" }
  );
});

test("thin adapter forwards only normalized request fields", async () => {
  let observed;
  const report = { schemaVersion: "fixture-report.v1" };
  const result = await runLauncherCli(
    "suite",
    ["--suite-id", "release.launcher.fixture", "--chain", "fresh"],
    async (request) => {
      observed = request;
      return report;
    }
  );
  assert.deepEqual(observed, {
    mode: "suite",
    chain: "fresh",
    suiteId: "release.launcher.fixture",
    batchId: undefined,
    concurrency: 1,
    order: "manifest"
  });
  assert.equal(result, report);
});

test("manifest adapter accepts only manifest and reverse execution order", () => {
  assert.equal(
    parseLauncherArguments("manifest", [
      "--batch",
      "launcher-fixture",
      "--chain",
      "fresh",
      "--concurrency",
      "1",
      "--order",
      "reverse"
    ]).order,
    "reverse"
  );
  assert.equal(
    parseLauncherArguments("manifest", ["--batch", "launcher-fixture", "--chain", "fresh"]).order,
    "manifest"
  );
  assert.throws(
    () =>
      parseLauncherArguments("manifest", [
        "--batch",
        "launcher-fixture",
        "--chain",
        "fresh",
        "--order",
        "random"
      ]),
    { code: "DATABASE_LAUNCHER_ARGUMENT_INVALID" }
  );
});

test("source gate refuses to combine a dirty checkout with the current HEAD", () => {
  assert.throws(
    () =>
      assertSourceGateCheckout({
        status: "M release/contracts/x.json\n",
        sourceSha: "a".repeat(40)
      }),
    { code: "DATABASE_LAUNCHER_SOURCE_CHECKOUT_DIRTY" }
  );
  assert.equal(assertSourceGateCheckout({ status: "", sourceSha: "a".repeat(40) }), "a".repeat(40));
});

test("database diagnostics retain failed test names without retaining failure messages", () => {
  const stdout = `${JSON.stringify({
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        assertionResults: [
          {
            fullName: "runtime role rejects immutable drift",
            status: "failed",
            failureMessages: ["postgresql://runtime:must-not-be-retained@127.0.0.1/test"]
          }
        ]
      }
    ]
  })}\n`;
  const summary = summarizeDatabaseTestLog({ stdout, stderr: "" });
  assert.deepEqual(summary.failedTests, [
    {
      assertionFields: ["failureMessages", "fullName", "status"],
      domainCodes: [],
      errorCodes: [],
      failureDetailTypes: [],
      failureHint: "[URI]",
      failureKinds: [],
      fullName: "runtime role rejects immutable drift",
      locations: []
    }
  ]);
  assert.equal(JSON.stringify(summary).includes("must-not-be-retained"), false);
  assert.match(summary.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(summary.counts.failed, 1);
});
