import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  startCluster,
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

test("release check relies on the controlled source database gate instead of ambient migrate status", async () => {
  const [releaseCheck, apiPackage] = await Promise.all([
    readFile(path.join(repositoryRoot, "scripts/release-check.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "apps/api/package.json"), "utf8").then(JSON.parse)
  ]);

  assert.equal(releaseCheck.includes('"Prisma migrate status"'), false);
  assert.equal(releaseCheck.includes('"prisma:migrate:status"'), false);
  assert.match(apiPackage.scripts.test, /test:database/);
  assert.equal(
    apiPackage.scripts["test:database"],
    "node ../../scripts/release/run-source-database-gate.mjs"
  );
});

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

test("source database launcher explicitly pulls the pinned image before a pull-disabled run", async () => {
  const calls = [];
  const imageContract = {
    repository: "docker.io/library/postgres",
    resolvedDigest: `sha256:${"1".repeat(64)}`,
    platform: "linux/amd64"
  };

  await assert.rejects(
    startCluster("explicit-pull-test", imageContract, {}, {
      executeDocker: async (input) => {
        calls.push(input);
        if (input.args[0] === "run") {
          throw Object.assign(new Error("stop after observing the run contract"), {
            code: "TEST_STOP_AFTER_RUN"
          });
        }
        return "pulled";
      }
    }),
    { code: "TEST_STOP_AFTER_RUN" }
  );

  assert.deepEqual(calls[0], {
    purpose: "pull",
    args: [
      "pull",
      "--platform",
      "linux/amd64",
      `${imageContract.repository}@${imageContract.resolvedDigest}`
    ]
  });
  const runCall = calls.find(({ args }) => args[0] === "run");
  assert.ok(runCall);
  assert.deepEqual(runCall.args.slice(0, 4), [
    "run",
    "--pull=never",
    "--detach",
    "--platform"
  ]);
});

test("source database launcher classifies a missing local image without exposing Docker stderr", async () => {
  const imageContract = {
    repository: "docker.io/library/postgres",
    resolvedDigest: `sha256:${"2".repeat(64)}`,
    platform: "linux/amd64"
  };
  let calls = 0;

  await assert.rejects(
    startCluster("missing-local-image-test", imageContract, {}, {
      executeDocker: async ({ args }) => {
        calls += 1;
        if (args[0] === "pull") return "pulled";
        throw Object.assign(new Error("redacted"), {
          code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED",
          diagnostic: `Unable to find image '${imageContract.repository}@${imageContract.resolvedDigest}' locally`
        });
      }
    }),
    (error) => {
      assert.equal(error.code, "DATABASE_LAUNCHER_CONTAINER_IMAGE_NOT_LOCAL");
      assert.equal(JSON.stringify(error).includes(imageContract.resolvedDigest), false);
      return true;
    }
  );
  assert.equal(calls, 2);
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

test("TAP diagnostics retain bounded release database failure codes", () => {
  const stdout = [
    "TAP version 13",
    "not ok 1 - provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
    "  error: 'DATABASE_LIFECYCLE_CHILD_FAILED private detail must not be retained'",
    "  code: 'DATABASE_LIFECYCLE_CHILD_FAILED'",
    "# tests 1",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0"
  ].join("\n");
  const summary = summarizeDatabaseTestLog({ stdout, stderr: "" });
  assert.deepEqual(summary.domainCodes, ["DATABASE_LIFECYCLE_CHILD_FAILED"]);
  assert.deepEqual(summary.failureHints, ["DATABASE_LIFECYCLE_CHILD_FAILED"]);
  assert.equal(JSON.stringify(summary).includes("private detail"), false);
});

test("TAP diagnostics retain the failed test name and repository source location", () => {
  const stdout = [
    "TAP version 13",
    "not ok 1 - provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
    "  ---",
    "  location: '/home/runner/work/subscription-Saas/subscription-Saas/packages/release-foundation/test/database-lifecycle.postgres.test.mjs:445:1'",
    "  failureType: 'testCodeFailure'",
    "  error: 'expected runtime role not to own the schema'",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    "  ...",
    "# tests 2",
    "# pass 1",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0"
  ].join("\n");

  const summary = summarizeDatabaseTestLog({ stdout, stderr: "" });
  assert.deepEqual(summary.failedTests, [
    {
      fullName: "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
      errorCodes: ["ERR_ASSERTION"],
      failureKinds: ["ASSERTION"],
      sourceLocations: [
        "packages/release-foundation/test/database-lifecycle.postgres.test.mjs:445:1"
      ]
    }
  ]);
  assert.equal(JSON.stringify(summary).includes("expected runtime role"), false);
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
