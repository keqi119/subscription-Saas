import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { main as validatorMain } from "./stage1-clean-acceptance-target-validator.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  STAGE1_ACCEPTANCE_WHITELIST_DELEGATES
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const SHA = "a".repeat(64);
const TARGET_URL =
  "postgresql://stage1:secret@db.internal:5432/subscription_saas_staging_acceptance_test?sslmode=require";
const APPROVED = {
  counts: { access: 1, catalog: 1, customer: 1, templates: 1, vehicle: 1 },
  exceptions: [],
  generatedAt: "2026-08-30T00:00:00.000Z",
  gitSha: "b".repeat(40),
  hashSalt: "b".repeat(64),
  imageRef: `registry.example/api@sha256:${"c".repeat(64)}`,
  operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
  rowDigests: { access: SHA, catalog: SHA, customer: SHA, templates: SHA, vehicle: SHA },
  safeToApply: true,
  schemaVersion: 1,
  selection: { adminDigest: SHA, customerDigest: SHA, vehicleDigests: [SHA, "b".repeat(64)] },
  source: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA },
  target: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA }
};

test("target validator uses only its dedicated target URL, starts READ ONLY, writes a redacted report, and disconnects", async () => {
  const harness = createValidatorHarness();
  const code = await validatorMain(
    [
      "--output",
      "D:/evidence/validator.json",
      "--approved-manifest",
      "D:/evidence/dry.json",
      "--approved-manifest-sha256",
      SHA
    ],
    harness.deps
  );
  assert.equal(code, 0);
  assert.deepEqual(harness.factoryUrls, [TARGET_URL]);
  assert.match(harness.calls[0].sql, /SET TRANSACTION READ ONLY/);
  assert.equal(harness.validateCalls.length, 1);
  assert.equal(harness.client.disconnects, 1);
  assert.equal(harness.stdout[0].includes(APPROVED.hashSalt), false);
  assert.equal(harness.stdout[0].includes("rowDigests"), false);
  assert.equal(harness.reports.length, 1);
});

test("target validator rejects approval/input before connecting and never reads DATABASE_URL or source URL", async () => {
  const harness = createValidatorHarness({
    env: {
      DATABASE_URL: "postgresql://poison/production",
      STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL: "postgresql://poison/source",
      STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME: "db.internal"
    }
  });
  assert.equal(
    await validatorMain(
      [
        "--output",
        "D:/evidence/validator.json",
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      harness.deps
    ),
    2
  );
  assert.deepEqual(harness.factoryUrls, []);

  const mismatch = createValidatorHarness({ canonicalManifestSha: "c".repeat(64) });
  assert.equal(
    await validatorMain(
      [
        "--output",
        "D:/evidence/validator.json",
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      mismatch.deps
    ),
    2
  );
  assert.deepEqual(mismatch.factoryUrls, []);

  const samePath = createValidatorHarness();
  assert.equal(
    await validatorMain(
      [
        "--output",
        "D:/evidence/dry.json",
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      samePath.deps
    ),
    2
  );
  assert.deepEqual(samePath.factoryUrls, []);

  const arbitraryCounts = createValidatorHarness({
    approvedReport: {
      manifest: APPROVED,
      manifestSha256: SHA,
      mode: "dry-run",
      operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
      safe: true,
      targetCountEvidence: {
        forbiddenCountKeys: ["arbitraryForbidden"],
        forbiddenCounts: { arbitraryForbidden: 0 },
        tableCountKeys: ["arbitraryTable"],
        tableCounts: { arbitraryTable: 0 }
      }
    }
  });
  assert.equal(
    await validatorMain(
      [
        "--output",
        "D:/evidence/validator.json",
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      arbitraryCounts.deps
    ),
    2
  );
  assert.deepEqual(arbitraryCounts.factoryUrls, []);
});

test("target validator maps invariant, connection, write, and SIGINT failures and always disconnects created clients", async () => {
  for (const [scenario, expected] of [
    ["validate", 3],
    ["connect", 4],
    ["write", 5],
    ["sigint", 4]
  ]) {
    const harness = createValidatorHarness({ scenario });
    const code = await validatorMain(
      [
        "--output",
        "D:/evidence/validator.json",
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      harness.deps
    );
    assert.equal(code, expected, scenario);
    if (scenario !== "connect") assert.equal(harness.client.disconnects, 1, scenario);
    assert.equal(harness.stderr.join("\n").includes("secret"), false, scenario);
  }
});

function createValidatorHarness({
  approvedReport,
  canonicalManifestSha = SHA,
  env,
  scenario
} = {}) {
  const calls = [];
  const factoryUrls = [];
  const reports = [];
  const stdout = [];
  const stderr = [];
  const validateCalls = [];
  let signalHandler;
  const client = {
    disconnects: 0,
    async $disconnect() {
      this.disconnects += 1;
    },
    async $transaction(callback) {
      return callback({
        async $queryRaw(strings) {
          calls.push({ sql: strings.raw ? strings.raw.join("?") : strings.join("?") });
          return [];
        }
      });
    }
  };
  const deps = {
    assertEvidencePath: (path) => resolve(path),
    createPrismaClient: async (url) => {
      factoryUrls.push(url);
      if (scenario === "connect") throw new Error("secret connection");
      return client;
    },
    env: env ?? {
      DATABASE_URL: "postgresql://poison/production",
      STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL: "postgresql://poison/source",
      STAGE1_ACCEPTANCE_TARGET_DATABASE_URL: TARGET_URL,
      STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME: "db.internal"
    },
    hashManifest: () => canonicalManifestSha,
    installSignalHandler: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    readTextFile: async () =>
      JSON.stringify(
        approvedReport ?? {
          manifest: APPROVED,
          manifestSha256: SHA,
          mode: "dry-run",
          operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
          safe: true,
          targetCountEvidence: approvedTargetCountEvidence()
        }
      ),
    repoRoot: "D:/repo",
    validateTarget: async (_tx, options) => {
      validateCalls.push(options);
      if (scenario === "sigint") signalHandler();
      if (scenario === "validate") throw new Error("MANIFEST_STALE");
      return {
        counts: { access: 7 },
        manifestSha256: SHA,
        safe: true,
        target: {
          databaseDigest: "d".repeat(64),
          migrationCatalogDigest: "e".repeat(64),
          schemaDigest: "f".repeat(64)
        }
      };
    },
    writeJsonFile: async (path, value) => {
      if (scenario === "write") throw new Error("secret path");
      reports.push({ path, value });
    },
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value)
  };
  return { calls, client, deps, factoryUrls, reports, stderr, stdout, validateCalls };
}

function approvedTargetCountEvidence() {
  return {
    forbiddenCountKeys: [...STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES],
    forbiddenCounts: Object.fromEntries(
      STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.map((key) => [key, 0])
    ),
    tableCountKeys: [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES],
    tableCounts: Object.fromEntries(STAGE1_ACCEPTANCE_WHITELIST_DELEGATES.map((key) => [key, 0]))
  };
}
