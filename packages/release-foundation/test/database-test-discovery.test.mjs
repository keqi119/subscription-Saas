import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  candidateReasons,
  classifyDatabaseTests,
  discoverDatabaseTestCandidates,
  trackedTestUniverse
} from "../src/index.mjs";

const execFileAsync = promisify(execFile);

const rules = {
  contractVersion: "database-test-discovery.v1",
  candidateRules: {
    filenamePatterns: ["[.-](integration|e2e(?:-spec)?|postgres|schema)[.-]"],
    databaseClientImports: ["(?:from|require\\()\\s*['\"](?:pg|@prisma/client)['\"]"],
    databaseEnvironmentReads: ["(?:process\\.env\\.)?DATABASE_URL"],
    explicitDatabaseLabels: ["@database-test"]
  }
};

async function withFixtureRepo(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "database-test-discovery-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function trackedFile(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  await execFileAsync("git", ["add", "--", relativePath], { cwd: root });
}

function suite(suiteId, files, overrides = {}) {
  return {
    suiteId,
    runner: "node-test",
    files,
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
    ...overrides
  };
}

test("tracked test universe is repository-wide rather than directory-specific", () => {
  assert.deepEqual(
    trackedTestUniverse([
      "apps/api/test/a.spec.ts",
      "packages/x/__tests__/b.ts",
      "scripts/c.integration.test.mjs",
      "apps/api/src/production.ts"
    ]),
    ["apps/api/test/a.spec.ts", "packages/x/__tests__/b.ts", "scripts/c.integration.test.mjs"]
  );
});

test("discovers candidates by filename, imports, environment use, and explicit label", async () => {
  await withFixtureRepo(async (fixtureRoot) => {
    await trackedFile(fixtureRoot, "imports-pg.spec.ts", 'import pg from "pg";\n');
    await trackedFile(fixtureRoot, "labeled.spec.ts", "// @database-test\n");
    await trackedFile(fixtureRoot, "reads-database-url.test.mjs", "process.env.DATABASE_URL;\n");
    await trackedFile(fixtureRoot, "schema.integration.spec.ts", "export {};\n");
    await trackedFile(fixtureRoot, "pure-unit.spec.ts", "export {};\n");
    await trackedFile(fixtureRoot, "src/production.ts", "process.env.DATABASE_URL;\n");

    const candidates = await discoverDatabaseTestCandidates(fixtureRoot, rules);
    assert.deepEqual(
      candidates.map(({ path: relativePath }) => relativePath),
      [
        "imports-pg.spec.ts",
        "labeled.spec.ts",
        "reads-database-url.test.mjs",
        "schema.integration.spec.ts"
      ]
    );
    assert.deepEqual(
      candidates.find(({ path: relativePath }) => relativePath === "schema.integration.spec.ts")
        ?.reasons,
      ["filename-pattern"]
    );
  });
});

test("fails when a candidate is neither manifested nor excepted", () => {
  const candidates = [{ path: "database.integration.spec.ts", reasons: ["filename-pattern"] }];
  assert.throws(() => classifyDatabaseTests(candidates, [], []), {
    code: "DATABASE_TEST_UNCLASSIFIED"
  });
});

test("requires exact one-to-one classification", () => {
  const candidates = [
    { path: "a.integration.spec.ts", reasons: ["filename-pattern"] },
    { path: "schema-text.spec.ts", reasons: ["explicit-database-label"] }
  ];
  const manifest = [suite("suite.a", ["a.integration.spec.ts"])];
  const exceptions = [
    {
      path: "schema-text.spec.ts",
      owner: "release-engineering",
      reason: "Inspects committed Schema text only.",
      scope: "source-only",
      reviewDate: "2026-12-01"
    }
  ];
  const report = classifyDatabaseTests(candidates, manifest, exceptions);
  assert.equal(report.unclassified.length, 0);
  assert.equal(report.manifested.length, 1);
  assert.equal(report.excepted.length, 1);

  assert.throws(() => classifyDatabaseTests(candidates, manifest, [...exceptions, exceptions[0]]), {
    code: "DATABASE_TEST_EXCEPTION_DUPLICATE"
  });
});

test("rejects manifest files absent from discovery and incomplete exceptions", () => {
  assert.throws(
    () => classifyDatabaseTests([], [suite("suite.missing", ["missing.spec.ts"])], []),
    { code: "DATABASE_TEST_MANIFEST_NOT_DISCOVERED" }
  );
  assert.throws(
    () =>
      classifyDatabaseTests(
        [{ path: "schema.spec.ts", reasons: ["filename-pattern"] }],
        [],
        [{ path: "schema.spec.ts", reason: "text only" }]
      ),
    { code: "DATABASE_TEST_EXCEPTION_INVALID" }
  );
});

test("external database suites require a separately owned applicability record", () => {
  const candidates = [{ path: "supplier.integration.spec.ts", reasons: ["filename-pattern"] }];
  const manifest = [
    suite("supplier.database-contract", ["supplier.integration.spec.ts"], {
      externalDependency: "supplier:fadada"
    })
  ];
  assert.throws(() => classifyDatabaseTests(candidates, manifest, [], []), {
    code: "DATABASE_TEST_EXTERNAL_APPLICABILITY_MISSING"
  });

  const report = classifyDatabaseTests(
    candidates,
    manifest,
    [],
    [
      {
        applicabilityId: "supplier.fadada",
        relatedSuiteId: "supplier.database-contract",
        status: "must-external-verify",
        owner: "esign-integration",
        reason: "Provider callback is outside the database contract.",
        reviewDate: "2026-12-01"
      }
    ]
  );
  assert.equal(report.unclassified.length, 0);
});

test("exports the four closed candidate reason values", () => {
  assert.deepEqual(candidateReasons, [
    "filename-pattern",
    "database-client-import",
    "database-environment-read",
    "explicit-database-label"
  ]);
});
