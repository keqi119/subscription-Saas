import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "../src/digest.mjs";

import {
  runDatabaseManifest,
  runDatabaseSuite,
  runSourceDatabaseGate,
  requiredReleaseDatabaseTestContext,
  selectManifestSuites,
  sha256Bytes,
  sha256Canonical,
  suiteDatabaseName
} from "../src/index.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const leastPrivilegeBoundary = Object.freeze({
  roleAttributes: Object.freeze({
    superuser: false,
    createdb: false,
    createrole: false,
    bypassrls: false
  }),
  canCreateSchema: false,
  schemaOwner: false,
  objectOwner: false
});
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

function select(overrides = {}) {
  return selectManifestSuites({
    manifest,
    discoveryDigest: digest,
    discoveryUnclassifiedCount: 0,
    chain: "fresh",
    runId: "run-launcher-1",
    secretRootRef: ".release-local/runs/run-launcher-1",
    ...overrides
  });
}

function completeCounts(overrides = {}) {
  return {
    collected: 1,
    selected: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    todo: 0,
    filtered: 0,
    cancelled: 0,
    ...overrides
  };
}

function receipt(contentDigest) {
  return {
    schemaVersion: "custody-receipt.v1",
    receiptId: "e48f89a4-3c36-4b49-abd8-f60245e9f35b",
    contentDigest,
    contentSizeBytes: 1,
    storeRef: "artifact://release/evidence",
    uploadedAt: "2026-09-02T08:00:00.000Z",
    readbackAt: "2026-09-02T08:00:01.000Z",
    readbackDigest: contentDigest,
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: "2027-03-01T08:00:00.000Z",
    expiryDisposition: "review",
    attestationRef: "attestation://test/database-suite"
  };
}

test("suite, batch, and source-gate selection share one manifest selector", () => {
  const bySuite = select({ suiteIds: ["release.launcher.fixture"] });
  const byBatch = select({ batchId: "launcher-fixture" });
  const forSourceGate = select({ batchId: "launcher-fixture" });
  assert.deepEqual(bySuite, byBatch);
  assert.deepEqual(forSourceGate, byBatch);
  assert.equal(bySuite[0].manifestDigest, sha256Canonical(manifest));
  assert.equal(
    bySuite[0].assignment.databaseName,
    suiteDatabaseName("run-launcher-1", "release.launcher.fixture", 0)
  );
  assert.deepEqual(bySuite[0].command, {
    executable: "node",
    arguments: [
      "--test",
      "--test-reporter=tap",
      "release/test-fixtures/database-launcher-fixture.postgres.test.mjs"
    ]
  });
});

test("vitest commands translate repository paths to the filtered API package", () => {
  const vitestManifest = {
    ...manifest,
    batches: [{ batchId: "api-fixture", suiteIds: ["api.fixture.postgres"] }],
    suites: [
      {
        ...manifest.suites[0],
        files: ["apps/api/test/fixture.integration.spec.ts"],
        runner: "vitest",
        suiteId: "api.fixture.postgres"
      }
    ]
  };

  const [selection] = select({
    batchId: "api-fixture",
    manifest: vitestManifest
  });

  assert.deepEqual(selection.command.arguments.slice(-2), [
    "--reporter=json",
    "test/fixture.integration.spec.ts"
  ]);
});

test("vitest commands reject files outside the filtered API package", () => {
  assert.throws(
    () =>
      select({
        manifest: {
          ...manifest,
          suites: [
            {
              ...manifest.suites[0],
              files: ["packages/release-foundation/test/fixture.postgres.test.mjs"],
              runner: "vitest"
            }
          ]
        }
      }),
    { code: "DATABASE_TEST_VITEST_FILE_OUTSIDE_API" }
  );
});

test("selector rejects unknown ids, unclassified discovery, duplicates, and caller file paths", () => {
  assert.throws(() => select({ suiteIds: ["unknown"] }), {
    code: "DATABASE_TEST_SUITE_UNKNOWN"
  });
  assert.throws(() => select({ batchId: "unknown" }), {
    code: "DATABASE_TEST_BATCH_UNKNOWN"
  });
  assert.throws(() => select({ discoveryUnclassifiedCount: 1 }), {
    code: "DATABASE_TEST_DISCOVERY_INCOMPLETE"
  });
  assert.throws(() => select({ callerFilePaths: ["forbidden.test.mjs"] }), {
    code: "DATABASE_TEST_CALLER_PATH_FORBIDDEN"
  });
  assert.throws(
    () =>
      select({
        manifest: {
          ...manifest,
          suites: [manifest.suites[0], { ...manifest.suites[0], suiteId: "duplicate" }]
        }
      }),
    { code: "DATABASE_TEST_FILE_DUPLICATE" }
  );
});

test("selector rejects framework bypass findings and unapproved chain exclusion", () => {
  assert.throws(() => select({ frameworkViolations: [{ kind: "only" }] }), {
    code: "DATABASE_TEST_FRAMEWORK_BYPASS"
  });
  assert.throws(
    () =>
      select({
        manifest: {
          ...manifest,
          suites: [
            {
              ...manifest.suites[0],
              chainApplicability: {
                ...manifest.suites[0].chainApplicability,
                fresh: { status: "approved-na" }
              }
            }
          ]
        }
      }),
    { code: "DATABASE_TEST_MANIFEST_INVALID" }
  );
});

test("runs one suite in provision, migration, runtime, custody, cleanup order", async () => {
  const [execution] = select({ suiteIds: ["release.launcher.fixture"] });
  const events = [];
  const report = await runDatabaseSuite({
    execution,
    provision: async (value) => {
      events.push("provision");
      return {
        ...value.assignment,
        databaseOid: "19001",
        targetFingerprint: digest,
        marker: "subscription-s1-ephemeral/v1"
      };
    },
    deployMigrations: async () => events.push("migrate"),
    grantRuntimeAccess: async () => events.push("grant"),
    executeTest: async () => {
      events.push("test");
      return {
        counts: completeCounts(),
        sanitizedLogDigest: digest,
        roleBoundaries: [{ database: "target", ...leastPrivilegeBoundary }]
      };
    },
    custody: async ({ digest: subjectDigest }) => {
      events.push("custody");
      return receipt(subjectDigest);
    },
    cleanup: async ({ custodyReceipt }) => {
      events.push("cleanup");
      assert.equal(custodyReceipt.contentDigest, custodyReceipt.readbackDigest);
    },
    operationId: "operation-launcher-1"
  });
  assert.deepEqual(events, ["provision", "migrate", "grant", "test", "custody", "cleanup"]);
  assert.deepEqual(report.counts, completeCounts());
  assert.equal(report.terminalStatus, "PASSED");
});

test("rejects incomplete reporter counts and does not clean without custody", async () => {
  const [execution] = select({ suiteIds: ["release.launcher.fixture"] });
  let cleanupCalled = false;
  await assert.rejects(
    runDatabaseSuite({
      execution,
      provision: async (value) => ({
        ...value.assignment,
        databaseOid: "19001",
        targetFingerprint: digest,
        marker: "subscription-s1-ephemeral/v1"
      }),
      deployMigrations: async () => {},
      grantRuntimeAccess: async () => {},
      executeTest: async () => ({
        counts: {
          collected: 1,
          selected: 1,
          executed: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          todo: 0
        },
        sanitizedLogDigest: digest
      }),
      custody: async () => receipt(digest),
      cleanup: async () => {
        cleanupCalled = true;
      },
      operationId: "operation-launcher-2"
    }),
    { code: "DATABASE_TEST_COUNT_INCOMPLETE" }
  );
  assert.equal(cleanupCalled, false);
});

test("manifest and source-gate reports aggregate the same selected suite", async () => {
  const selections = select({ batchId: "launcher-fixture" });
  const suiteReport = {
    schemaVersion: "database-suite-report.v1",
    operationId: "operation-launcher-3",
    runId: selections[0].runId,
    suiteId: selections[0].suiteId,
    chain: "fresh",
    manifestDigest: selections[0].manifestDigest,
    discoveryDigest: selections[0].discoveryDigest,
    target: {
      databaseName: selections[0].assignment.databaseName,
      databaseOid: "19001",
      targetFingerprint: digest,
      ...leastPrivilegeBoundary
    },
    counts: completeCounts(),
    sanitizedLogDigest: digest,
    terminalStatus: "PASSED"
  };
  const manifestReport = await runDatabaseManifest({
    selections,
    executeSuite: async () => suiteReport
  });
  const sourceGate = runSourceDatabaseGate({
    manifestReport,
    sourceSha: "a".repeat(40),
    migrationCatalogDigest: digest,
    repositoryContractDigest: digest,
    postgres: { imageDigest: digest, serverVersionNum: "170011" },
    schemaDiffDigest: digest,
    migrationStatusDigest: digest,
    postSchemaDigest: digest,
    provenance: {
      generatedAt: "2026-09-02T08:00:00.000Z",
      ciRunRef: "local-controlled://run-1",
      executorVersion: "source-database-gate.v1"
    }
  });
  assert.deepEqual(manifestReport.counts, completeCounts());
  assert.deepEqual(sourceGate.counts, manifestReport.counts);
  assert.equal(sourceGate.databaseTestManifestDigest, selections[0].manifestDigest);
});

test("manifest refuses a suite report from another assignment", async () => {
  const selections = select({ batchId: "launcher-fixture" });
  await assert.rejects(
    runDatabaseManifest({
      selections,
      executeSuite: async () => ({
        schemaVersion: "database-suite-report.v1",
        operationId: "operation-forged",
        runId: selections[0].runId,
        suiteId: selections[0].suiteId,
        chain: selections[0].chain,
        manifestDigest: selections[0].manifestDigest,
        discoveryDigest: selections[0].discoveryDigest,
        target: {
          databaseName: "s1ci_ffffffffffffffffffffffff",
          databaseOid: "19002",
          targetFingerprint: digest
        },
        counts: completeCounts(),
        sanitizedLogDigest: digest,
        terminalStatus: "PASSED"
      })
    }),
    { code: "DATABASE_TEST_SUITE_REPORT_MISMATCH" }
  );
});

test("generic suite execution refuses lifecycle-owned targets before provisioning", async () => {
  let provisionCalled = false;
  await assert.rejects(
    runDatabaseSuite({
      execution: { r3ExecutionMode: "lifecycle-owned" },
      operationId: "lifecycle-must-use-its-runner",
      provision: async () => {
        provisionCalled = true;
      },
      deployMigrations: async () => {},
      grantRuntimeAccess: async () => {},
      executeTest: async () => {},
      custody: async () => {},
      cleanup: async () => {}
    }),
    { code: "DATABASE_TEST_LIFECYCLE_RUNNER_REQUIRED" }
  );
  assert.equal(provisionCalled, false);
});

test("database test context resolves only the assigned runtime secret reference", () => {
  const password = "runtime-private-password";
  const context = {
    schemaVersion: "release-database-test-context.v1",
    allowedFiles: ["release/test-fixtures/database-launcher-fixture.postgres.test.mjs"],
    databaseName: "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
    databaseOid: "19001",
    targetFingerprint: digest,
    runtimeCredentialFingerprint: sha256Bytes(Buffer.from(password, "utf8")),
    migrationCredentialFingerprint: `sha256:${"c".repeat(64)}`,
    containerId: "a".repeat(64),
    runtimeSecretReference: ".release-local/runs/run-1/release.launcher.fixture/runtime-test.json"
  };
  const secret = {
    username: "s1r_aaaaaaaaaaaaaaaaaaaaaaaa",
    password,
    database: context.databaseName,
    host: "127.0.0.1",
    port: 54321,
    tlsMode: "disable"
  };
  const result = requiredReleaseDatabaseTestContext(
    new URL(
      "../../../release/test-fixtures/database-launcher-fixture.postgres.test.mjs",
      import.meta.url
    ).href,
    {
      environment: {
        S1_RELEASE_DATABASE_TEST: "1",
        S1_RELEASE_DATABASE_CONTEXT:
          ".release-local/runs/run-1/release.launcher.fixture/context.json"
      },
      repoRoot: process.cwd(),
      loadJson: (filePath) => (filePath.endsWith("context.json") ? context : secret)
    }
  );
  assert.equal(result.databaseName, context.databaseName);
  assert.match(result.databaseUrl, /^postgresql:\/\//);
  assert.equal(result.runtimeCredential.username, secret.username);
});

test("database test context resolves two distinct launcher-assigned runtime databases", () => {
  const runtime = (name, letter, reference) => {
    const password = `runtime-private-password-${letter}`;
    return {
      context: {
        databaseName: name,
        databaseOid: letter === "a" ? "19001" : "19002",
        targetFingerprint: digest,
        runtimeSecretReference: reference,
        runtimeCredentialFingerprint: sha256Bytes(Buffer.from(password, "utf8")),
        migrationCredentialFingerprint: `sha256:${letter.repeat(64)}`
      },
      secret: {
        username: `s1r_${letter.repeat(24)}`,
        password,
        database: name,
        host: "127.0.0.1",
        port: 54321,
        tlsMode: "disable"
      }
    };
  };
  const source = runtime(
    "s1ci_aaaaaaaaaaaaaaaaaaaaaaaa",
    "b",
    ".release-local/runs/run-1/release.launcher.fixture/source/runtime-test.json"
  );
  const target = runtime(
    "s1ci_cccccccccccccccccccccccc",
    "d",
    ".release-local/runs/run-1/release.launcher.fixture/runtime-test.json"
  );
  const context = {
    schemaVersion: "release-database-test-context.v1",
    allowedFiles: ["release/test-fixtures/database-launcher-fixture.postgres.test.mjs"],
    containerId: "a".repeat(64),
    ...target.context,
    namedDatabases: { source: source.context, target: target.context }
  };
  const byReference = new Map([
    [source.context.runtimeSecretReference, source.secret],
    [target.context.runtimeSecretReference, target.secret]
  ]);
  const result = requiredReleaseDatabaseTestContext(
    new URL(
      "../../../release/test-fixtures/database-launcher-fixture.postgres.test.mjs",
      import.meta.url
    ).href,
    {
      environment: {
        S1_RELEASE_DATABASE_TEST: "1",
        S1_RELEASE_DATABASE_CONTEXT:
          ".release-local/runs/run-1/release.launcher.fixture/context.json"
      },
      repoRoot: process.cwd(),
      loadJson: (filePath) => {
        if (filePath.endsWith("context.json")) return context;
        const normalized = filePath.replaceAll("\\", "/");
        const reference = [...byReference.keys()].find((item) => normalized.endsWith(item));
        return byReference.get(reference);
      }
    }
  );
  assert.equal(result.namedDatabases.source.databaseUrl.includes(source.secret.database), true);
  assert.equal(result.namedDatabases.target.databaseUrl.includes(target.secret.database), true);
  assert.notEqual(
    result.namedDatabases.source.runtimeCredentialFingerprint,
    result.namedDatabases.target.runtimeCredentialFingerprint
  );
});

test("database test context fails closed without launcher or with path traversal", () => {
  assert.throws(() => requiredReleaseDatabaseTestContext(import.meta.url, { environment: {} }), {
    code: "RELEASE_DATABASE_TEST_LAUNCHER_REQUIRED"
  });
  assert.throws(
    () =>
      requiredReleaseDatabaseTestContext(import.meta.url, {
        environment: {
          S1_RELEASE_DATABASE_TEST: "1",
          S1_RELEASE_DATABASE_CONTEXT: "../context.json"
        }
      }),
    { code: "RELEASE_DATABASE_TEST_CONTEXT_REFERENCE_INVALID" }
  );
});

function h1ContextFixture() {
  const profile = JSON.parse(
    readFileSync(
      new URL("../../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
    )
  );
  const operationRef = "10000000-0000-4000-8000-000000000001";
  const suiteId = "script.stage1-clean-acceptance.postgres";
  const allowedFile = "scripts/stage1-clean-acceptance.postgres.test.mjs";
  const secrets = new Map();
  const database = (letter) => {
    const databaseName = `s1ci_${letter.repeat(24)}`;
    const password = `private-runtime-password-${letter}`;
    const runtimeSecretReference = `r3/${operationRef}/database-credentials/${databaseName}-runtime-test.json`;
    secrets.set(runtimeSecretReference, {
      username: `s1r_${sha256Text(databaseName).slice(0, 24)}`,
      password,
      database: databaseName,
      host: "127.0.0.1",
      port: 55441,
      tlsMode: "require"
    });
    return {
      databaseName,
      databaseOid: letter === "a" ? "19001" : "19002",
      targetFingerprint: digest,
      runtimeSecretReference,
      runtimeCredentialFingerprint: sha256Bytes(Buffer.from(password)),
      migrationCredentialFingerprint: `sha256:${"c".repeat(64)}`
    };
  };
  const target = database("a"),
    source = database("b");
  const context = {
    schemaVersion: "release-database-test-context.v1",
    operationRef,
    suiteId,
    profileDigest: sha256Canonical(profile),
    containerId: "a".repeat(64),
    allowedFiles: [allowedFile],
    ...target,
    namedDatabases: { source, target }
  };
  const environment = {
    S1_RELEASE_DATABASE_TEST: "1",
    S1_RELEASE_DATABASE_CONTEXT: `r3/${operationRef}/database-test-contexts/${suiteId}/context.json`
  };
  const reads = [];
  const options = {
    environment,
    repoRoot: process.cwd(),
    loadJson(filePath, settings) {
      reads.push({ filePath, settings });
      if (
        filePath === path.resolve(process.cwd(), "release/contracts/manual-stage1-profile.v2.json")
      )
        return profile;
      if (
        filePath === `${profile.storage.credentialRoot}/${environment.S1_RELEASE_DATABASE_CONTEXT}`
      )
        return context;
      const reference = filePath.slice(profile.storage.credentialRoot.length + 1);
      assert.ok(secrets.has(reference), "reader must use a known credential path");
      return secrets.get(reference);
    }
  };
  return { profile, context, options, secrets, reads, allowedFile };
}

test("H1 database test context reads single and paired runtime credentials from the fixed profile", () => {
  const f = h1ContextFixture();
  const paired = requiredReleaseDatabaseTestContext(f.allowedFile, f.options);
  assert.equal(
    paired.namedDatabases.source.databaseName,
    f.context.namedDatabases.source.databaseName
  );
  assert.match(paired.databaseUrl, /@127\.0\.0\.1:55441\/s1ci_[a-f0-9]{24}\?sslmode=require$/u);
  assert.equal(paired.namedDatabases.target.databaseUrl, paired.databaseUrl);
  assert.ok(
    f.reads
      .slice(1)
      .every(
        ({ filePath, settings }) =>
          filePath.startsWith(`${f.profile.storage.credentialRoot}/r3/`) &&
          settings.privateRoot === f.profile.storage.credentialRoot
      )
  );
  delete f.context.namedDatabases;
  assert.equal(
    requiredReleaseDatabaseTestContext(f.allowedFile, f.options).databaseUrl,
    paired.databaseUrl
  );
});

test("H1 database test context refuses operation, profile, caller and credential substitutions", () => {
  const cases = [
    [
      "operation",
      (f) => {
        f.context.operationRef = "20000000-0000-4000-8000-000000000002";
      }
    ],
    [
      "suite",
      (f) => {
        f.context.suiteId = "another.suite";
      }
    ],
    [
      "profile",
      (f) => {
        f.context.profileDigest = digest;
      }
    ],
    [
      "root override",
      (f) => {
        f.options.environment.S1_RELEASE_DATABASE_CONTEXT = "/tmp/context.json";
      }
    ],
    [
      "credential traversal",
      (f) => {
        f.context.runtimeSecretReference = "../runtime-test.json";
      }
    ],
    [
      "cross operation",
      (f) => {
        f.context.runtimeSecretReference = f.context.runtimeSecretReference.replace(
          "10000000",
          "20000000"
        );
      }
    ],
    [
      "migration credential",
      (f) => {
        f.context.runtimeSecretReference = f.context.runtimeSecretReference.replace(
          "-runtime-test.json",
          "-migrate.json"
        );
      }
    ],
    [
      "port",
      (f) => {
        f.secrets.get(f.context.runtimeSecretReference).port = 5432;
      }
    ],
    [
      "TLS",
      (f) => {
        f.secrets.get(f.context.runtimeSecretReference).tlsMode = "disable";
      }
    ],
    [
      "role",
      (f) => {
        f.secrets.get(f.context.runtimeSecretReference).username = `s1r_${"f".repeat(24)}`;
      }
    ],
    [
      "password",
      (f) => {
        f.secrets.get(f.context.runtimeSecretReference).password = "different-runtime-password";
      }
    ],
    [
      "same database",
      (f) => {
        f.context.namedDatabases.source = f.context.namedDatabases.target;
      }
    ],
    [
      "caller suffix",
      (f) => {
        f.allowedFile = `other-checkout/${f.allowedFile}`;
      }
    ]
  ];
  for (const [name, mutate] of cases) {
    const f = h1ContextFixture();
    mutate(f);
    assert.throws(
      () => requiredReleaseDatabaseTestContext(f.allowedFile, f.options),
      (error) => /^RELEASE_DATABASE_TEST_/u.test(error.code ?? ""),
      name
    );
  }
});

test(
  "H1 database test context checks real private files and rejects links and broad modes",
  { skip: process.platform !== "linux" || process.getuid?.() !== 0 },
  () => {
    const scratchRoot = path.join(os.homedir(), ".cache/stage1-r3-tests");
    mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(scratchRoot, "test-context-"));
    try {
      const f = h1ContextFixture();
      const repoRoot = path.join(directory, "checkout");
      f.profile.storage.credentialRoot = path.join(directory, "credential");
      f.context.profileDigest = sha256Canonical(f.profile);
      const write = (filename, value) => {
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
      };
      write(path.join(repoRoot, "release/contracts/manual-stage1-profile.v2.json"), f.profile);
      write(
        path.join(
          f.profile.storage.credentialRoot,
          f.options.environment.S1_RELEASE_DATABASE_CONTEXT
        ),
        f.context
      );
      for (const [reference, secret] of f.secrets)
        write(path.join(f.profile.storage.credentialRoot, reference), secret);
      const options = { environment: f.options.environment, repoRoot };
      const read = () => requiredReleaseDatabaseTestContext(f.allowedFile, options);
      assert.equal(read().databaseName, f.context.databaseName);
      const filename = path.join(
        f.profile.storage.credentialRoot,
        f.context.runtimeSecretReference
      );
      chmodSync(filename, 0o644);
      assert.throws(read, { code: "RELEASE_DATABASE_TEST_CONTEXT_INVALID" });
      chmodSync(filename, 0o600);
      const linked = path.join(directory, "linked.json");
      linkSync(filename, linked);
      assert.throws(read, { code: "RELEASE_DATABASE_TEST_CONTEXT_INVALID" });
      unlinkSync(filename);
      symlinkSync(linked, filename);
      assert.throws(read, { code: "RELEASE_DATABASE_TEST_CONTEXT_INVALID" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
