import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  selectManifestSuites,
  sha256Canonical,
  sha256Bytes,
  snapshotBundleDigest
} from "../../packages/release-foundation/src/index.mjs";
import {
  assertSourceGateCheckout,
  executeLauncherRequest,
  parseLauncherArguments,
  resolveLauncherRepositoryRoot,
  runLauncherCli,
  sourceGateProvenance,
  startCluster,
  summarizeDatabaseTestLog,
  waitForPostgresVersion
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

test("keeps closure reconciliation database execution behind the controlled launcher", async () => {
  const [releaseCheck, rootPackage] = await Promise.all([
    readFile(path.join(repositoryRoot, "scripts/release-check.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8").then(JSON.parse)
  ]);

  assert.match(releaseCheck, /stage1:p0-closure:reconcile:unit/);
  assert.equal(
    rootPackage.scripts["stage1:p0-closure:reconcile:unit"],
    'node --test --test-name-pattern="^(freezes|mutation-tests|validates|requires)" scripts/stage1-p0-subscription-closure-reconciliation.test.mjs'
  );
  assert.equal(
    rootPackage.scripts["stage1:p0-closure:reconcile"],
    "pnpm stage1:p0-closure:reconcile:unit && node scripts/release/run-database-suite.mjs --suite-id node.closure-reconciliation.postgres --chain fresh"
  );
});

test("database readiness waits for the authenticated TCP version query", async () => {
  const attempts = [];
  const serverVersionNum = await waitForPostgresVersion(
    "a".repeat(64),
    { username: "controlled", password: "secret" },
    {
      queryVersion: async (request) => {
        attempts.push(request);
        if (attempts.length === 1) {
          const error = new Error("temporary bootstrap server is socket-only");
          error.code = "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED";
          throw error;
        }
        return { rows: [{ serverVersionNum: "170011" }] };
      },
      pause: async () => {}
    }
  );

  assert.equal(serverVersionNum, "170011");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], {
    containerId: "a".repeat(64),
    credential: { username: "controlled", password: "secret" },
    databaseName: "postgres",
    sql: "SHOW server_version_num;",
    columns: ["serverVersionNum"]
  });
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
    startCluster(
      "explicit-pull-test",
      imageContract,
      {},
      {
        executeDocker: async (input) => {
          calls.push(input);
          if (input.args[0] === "run") {
            throw Object.assign(new Error("stop after observing the run contract"), {
              code: "TEST_STOP_AFTER_RUN"
            });
          }
          return "pulled";
        }
      }
    ),
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
  assert.deepEqual(runCall.args.slice(0, 4), ["run", "--pull=never", "--detach", "--platform"]);
});

test("source database launcher classifies a missing local image without exposing Docker stderr", async () => {
  const imageContract = {
    repository: "docker.io/library/postgres",
    resolvedDigest: `sha256:${"2".repeat(64)}`,
    platform: "linux/amd64"
  };
  let calls = 0;

  await assert.rejects(
    startCluster(
      "missing-local-image-test",
      imageContract,
      {},
      {
        executeDocker: async ({ args }) => {
          calls += 1;
          if (args[0] === "pull") return "pulled";
          throw Object.assign(new Error("redacted"), {
            code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED",
            diagnostic: `Unable to find image '${imageContract.repository}@${imageContract.resolvedDigest}' locally`
          });
        }
      }
    ),
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
      fullName:
        "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
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

// Native boundaries are mocked; this exercises the production launcher/restore adapter,
// not a shared restore callback or an admitted candidate-use channel.
async function withSnapshotNativeFixture(fault, action) {
  const originalSpawn = childProcess.spawn,
    originalRead = fs.promises.readFile;
  const contract = JSON.parse(
    await originalRead(
      path.join(repositoryRoot, "release/contracts/sanitization-contract.v1.json"),
      "utf8"
    )
  );
  const ownershipMap = JSON.parse(
    await originalRead(
      path.join(repositoryRoot, "release/contracts/snapshot-ownership-map.v1.json"),
      "utf8"
    )
  );
  const imageContract = JSON.parse(
    await originalRead(
      path.join(repositoryRoot, "release/contracts/postgres-image.v1.json"),
      "utf8"
    )
  );
  const dump = Buffer.from("sanitized custom dump native fixture"),
    dumpDigest = sha256Bytes(dump);
  const createdAt = new Date(Date.now() - 60_000).toISOString(),
    expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const privilegeObservation = {
    schemaVersion: "source-privilege-observation.v1",
    capabilityDigest: digest
  };
  const fingerprintObservation = {
    schemaVersion: "source-fingerprint.v1",
    identity: {
      migrationHead: contract.source.knownMigrationHeads[0],
      databaseIdentityFingerprint: digest
    }
  };
  const scan = {
    schemaVersion: "sanitization-scan.v1",
    subjectDigest: dumpDigest,
    contractDigest: sha256Canonical(contract),
    scannerVersion: "snapshot-scan/1",
    status: "PASSED",
    findingsCount: 0,
    scannedAt: createdAt
  };
  const metadata = {
    schemaVersion: "snapshot-metadata.v1",
    dumpDigest,
    sourceMigrationHead: contract.source.knownMigrationHeads[0],
    sourcePrivilegeObservationDigest: sha256Canonical(privilegeObservation),
    sourceFingerprintBeforeDigest: sha256Canonical(fingerprintObservation.identity),
    sourceFingerprintAfterDigest: sha256Canonical(fingerprintObservation.identity),
    sanitizationContractDigest: sha256Canonical(contract),
    ownershipMapDigest: sha256Canonical(ownershipMap),
    ownershipContractVersion: ownershipMap.mapVersion,
    scanDigest: sha256Canonical(scan),
    scanSubjectDigest: dumpDigest,
    exportToolVersion: "snapshot-export/1",
    scanToolVersion: "snapshot-scan/1",
    createdAt,
    reviewAt: expiresAt,
    expiresAt,
    owner: contract.lifecycle.owner,
    readers: contract.lifecycle.readers,
    accessPolicyRef: contract.lifecycle.accessPolicyRef,
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/1"
  };
  const bundleDigest = snapshotBundleDigest({
    dump,
    metadata,
    scan,
    privilegeObservation,
    fingerprintObservation
  });
  const custodyReceipt = {
    schemaVersion: "custody-receipt.v1",
    receiptId: "ea4d51a1-4e63-491a-80ca-fc478b2fd53f",
    contentDigest: bundleDigest,
    contentSizeBytes: dump.length,
    storeRef: "artifact://release/native-fixture",
    uploadedAt: createdAt,
    readbackAt: createdAt,
    readbackDigest: bundleDigest,
    owner: contract.lifecycle.owner,
    readers: contract.lifecycle.readers,
    retainUntil: new Date(Date.parse(createdAt) + 180 * 86_400_000).toISOString(),
    expiryDisposition: "review",
    attestationRef: "attestation://release/native-fixture"
  };
  const inputs = new Map(
    Object.entries({
      "snapshot-metadata.json": metadata,
      "sanitized-snapshot.dump": dump,
      "sanitization-scan.v1.json": scan,
      "source-privilege-observation.v1.json": privilegeObservation,
      "source-fingerprint.v1.json": fingerprintObservation,
      "custody-receipt.v1.json": custodyReceipt
    }).map(([name, value]) => [
      path.join(repositoryRoot, ".release-inputs", name),
      Buffer.isBuffer(value) ? value : JSON.stringify(value)
    ])
  );
  const calls = [],
    containerId = "c".repeat(64),
    image = imageContract.repository + "@" + imageContract.resolvedDigest;
  let runId, databaseName, marker, copiedPath, directoryPath;
  const dispatch = (executable, args, input) => {
    if (executable !== "docker") {
      assert.ok(
        executable === "icacls" || executable === process.execPath,
        "only fixture-local native commands"
      );
      return { stdout: "", code: 0 };
    }
    calls.push({ args: [...args] });
    if (args[0] === "pull") return { stdout: "pulled", code: 0 };
    if (args[0] === "run") {
      runId = args
        .find((value) => value.startsWith("subscription-s1-launcher.run-id="))
        .split("=")[1];
      return { stdout: containerId + "\n", code: 0 };
    }
    if (args[0] === "inspect")
      return {
        stdout: JSON.stringify([
          {
            Id: containerId,
            Config: {
              Image: image,
              Labels: {
                "subscription-s1-controlled": "v1",
                "subscription-s1-launcher.run-id": runId
              }
            },
            NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "15432" }] } }
          }
        ]),
        code: 0
      };
    if (args[0] === "cp") {
      copiedPath = args[2].slice(containerId.length + 1);
      return { stdout: "", code: 0 };
    }
    if (args.includes("pg_restore")) return { stdout: "", code: 1 }; // Stops the control after observing the real adapter's restore command.
    if (args.includes("mkdir")) {
      directoryPath = args.at(-1);
      return { stdout: "", code: fault === "directory-exists" ? 1 : 0 };
    }
    if (args.includes("stat")) {
      const directory = args.at(-1) === directoryPath;
      return {
        stdout: directory ? "41c0:0:700:0:1:101\n" : "8180:0:600:" + dump.length + ":1:102\n",
        code: 0
      };
    }
    if (args.includes("chmod") || args.includes("rm")) return { stdout: "", code: 0 };
    if (args.includes("sha256sum"))
      return {
        stdout: (fault === "sha" ? "f".repeat(64) : dumpDigest.slice(7)) + "  " + copiedPath + "\n",
        code: 0
      };
    assert.ok(args.includes("psql"), "expected fixed fixture Docker command");
    if (input.trim() === "SHOW server_version_num;") return { stdout: "170011\n", code: 0 };
    const created = input.match(/CREATE DATABASE "(s1ci_[0-9a-f]{24})"/);
    if (created) databaseName = created[1];
    const comment = input.match(/COMMENT ON DATABASE "s1ci_[0-9a-f]{24}" IS '([^']+)'/);
    if (comment) marker = comment[1];
    if (input.includes("FROM pg_roles")) return { stdout: "f\tf\tf\tf\tf\n", code: 0 };
    if (input.includes("FROM pg_database") && input.includes("current_database()")) {
      const role = args[args.indexOf("--username") + 1],
        owner = "s1m_" + sha256Bytes(Buffer.from(databaseName)).slice(7, 31);
      return {
        stdout:
          [databaseName, role, fault === "oid" ? "19002" : "19001", marker, owner, "170011"].join(
            "\t"
          ) + "\n",
        code: 0
      };
    }
    if (input.includes("FROM pg_database")) return { stdout: "19001\t" + marker + "\n", code: 0 };
    return { stdout: "", code: 0 };
  };
  fs.promises.readFile = async (file, options) =>
    inputs.has(String(file)) ? inputs.get(String(file)) : originalRead(file, options);
  childProcess.spawn = function fixtureNativeSpawn(executable, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      queueMicrotask(() => {
        try {
          const result = dispatch(executable, args, input);
          child.stdout.end(result.stdout);
          child.stderr.end();
          child.emit("exit", result.code, null);
        } catch (error) {
          child.emit("error", error);
        }
      });
    };
    if (executable === "docker") child.stdin.on("finish", complete);
    else complete();
    return child;
  };
  syncBuiltinESMExports();
  try {
    await action({
      calls,
      containerId,
      dumpDigest,
      get copiedPath() {
        return copiedPath;
      }
    });
  } finally {
    childProcess.spawn = originalSpawn;
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    if (runId) {
      assert.match(runId, /^[0-9a-f-]{36}$/);
      const runsRoot = path.join(repositoryRoot, ".release-local", "runs"),
        ownedRoot = path.resolve(runsRoot, runId);
      assert.equal(path.dirname(ownedRoot), runsRoot);
      await fs.promises.rm(ownedRoot, { recursive: true, force: true });
    }
  }
}

test("snapshot native adapter verifies copied bytes and actual target before restore", async (t) => {
  for (const fault of ["none", "sha", "oid"])
    await t.test(fault, async () => {
      await withSnapshotNativeFixture(fault, async (fixture) => {
        let error;
        try {
          await executeLauncherRequest({
            mode: "suite",
            chain: "snapshot",
            suiteId: "release.launcher.fixture",
            snapshotMetadataFile: ".release-inputs/snapshot-metadata.json"
          });
        } catch (caught) {
          error = caught;
        }
        const restores = fixture.calls.filter((call) => call.args.includes("pg_restore"));
        assert.equal(restores.length, fault === "none" ? 1 : 0);
        assert.equal(
          error?.code,
          fault === "none"
            ? "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED"
            : fault === "sha"
              ? "SNAPSHOT_RESTORE_COPY_MISMATCH"
              : "SNAPSHOT_RESTORE_TARGET_MISMATCH"
        );
        assert.equal(fixture.calls.filter((call) => call.args[0] === "cp").length, 1);
      });
    });
});
