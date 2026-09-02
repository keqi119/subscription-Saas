import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  selectManifestSuites,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  assertSourceGateCheckout,
  parseLauncherArguments,
  resolveLauncherRepositoryRoot,
  runLauncherCli,
  sourceGateProvenance,
  summarizeDatabaseTestLog
} from "./database-test-launcher-runtime.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
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

test("binds promotable source evidence only to this protected main workflow run", () => {
  const sourceSha = "a".repeat(40);
  assert.equal(
    sourceGateProvenance(sourceSha, {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "keqi119/subscription-Saas",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "901",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW_REF:
        "keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main"
    }).ciRunRef,
    "github://keqi119/subscription-Saas/actions/runs/901/attempts/2"
  );
  assert.throws(
    () =>
      sourceGateProvenance(sourceSha, {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "keqi119/subscription-Saas",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "b".repeat(40),
        GITHUB_RUN_ID: "901",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW_REF:
          "keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main"
      }),
    { code: "DATABASE_LAUNCHER_SOURCE_PROVENANCE_UNTRUSTED" }
  );
});

test("marks the ordinary CI source gate as nonpromotable while binding its exact run", () => {
  const sourceSha = "a".repeat(40);
  assert.equal(
    sourceGateProvenance(sourceSha, {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "keqi119/subscription-Saas",
      GITHUB_REF: "refs/pull/314/merge",
      GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: "902",
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_WORKFLOW_REF: "keqi119/subscription-Saas/.github/workflows/ci.yml@refs/pull/314/merge"
    }).ciRunRef,
    "github-nonpromotable://keqi119/subscription-Saas/actions/runs/902/attempts/3"
  );
  assert.throws(
    () =>
      sourceGateProvenance(sourceSha, {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "keqi119/subscription-Saas",
        GITHUB_REF: "refs/pull/314/merge",
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: "902",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_WORKFLOW_REF: "keqi119/subscription-Saas/.github/workflows/ci.yml@refs/heads/main"
      }),
    { code: "DATABASE_LAUNCHER_SOURCE_PROVENANCE_UNTRUSTED" }
  );
});

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

test("source gate defaults to the complete fresh manifest", () => {
  const request = parseLauncherArguments("source-gate", []);
  assert.deepEqual(request, {
    mode: "source-gate",
    chain: "fresh",
    suiteId: undefined,
    batchId: undefined,
    concurrency: 1,
    order: "manifest",
    snapshotMetadataFile: undefined
  });
  assert.deepEqual(selections(request), selections({ ...request, batchId: "launcher-fixture" }));
});

test("launcher resolves the repository independently from the caller working directory", () => {
  const moduleUrl = pathToFileURL(
    path.join(repositoryRoot, "scripts/release/database-test-launcher-runtime.mjs")
  ).href;
  assert.equal(resolveLauncherRepositoryRoot(moduleUrl), repositoryRoot);
});

test("post-schema observation emits Prisma 7 compatible migrate diff arguments", async () => {
  const runtime = await import("./database-test-launcher-runtime.mjs");
  assert.deepEqual(runtime.prismaPostSchemaArguments(), [
    "migrate",
    "diff",
    "--from-empty",
    "--to-config-datasource",
    "--script"
  ]);
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
    order: "manifest",
    snapshotMetadataFile: undefined
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
      locations: [],
      sourceLocations: []
    }
  ]);
  assert.equal(JSON.stringify(summary).includes("must-not-be-retained"), false);
  assert.match(summary.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(summary.counts.failed, 1);
});

test("TAP diagnostics retain only bounded integration error codes", () => {
  const stdout = [
    "TAP version 13",
    "not ok 1 - controlled snapshot integration",
    "  error: 'INTEGRATION_SEED_P2002 customer 18616570212'",
    "# tests 1",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0"
  ].join("\n");
  const summary = summarizeDatabaseTestLog({ stdout, stderr: "" });
  assert.deepEqual(summary.domainCodes, ["INTEGRATION_SEED_P2002"]);
  assert.deepEqual(summary.failureHints, ["INTEGRATION_SEED_P2002"]);
  assert.equal(JSON.stringify(summary).includes("18616570212"), false);
});

test("Vitest diagnostics retain bounded repository source stack locations", () => {
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
            fullName: "governed write rejects an invalid command",
            status: "failed",
            failureMessages: [
              "ConflictException: invalid command\n    at assertDatabaseEventTime (D:/repo/apps/api/src/subscription-closure/subscription-closure.repository.ts:2757:11)\n    at user supplied path (D:/secrets/customer.txt:1:1)"
            ]
          }
        ]
      }
    ]
  })}\n`;
  const summary = summarizeDatabaseTestLog({ stdout, stderr: "" });
  assert.deepEqual(summary.failedTests[0]?.sourceLocations, [
    "apps/api/src/subscription-closure/subscription-closure.repository.ts:2757:11"
  ]);
  assert.equal(JSON.stringify(summary).includes("customer.txt"), false);
});
