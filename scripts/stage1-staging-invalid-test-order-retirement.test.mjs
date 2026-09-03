import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";

const cli = await import("./stage1-staging-invalid-test-order-retirement.mjs").catch(() => ({}));

const target = {
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
};
const operatorId = "11111111-1111-4111-8111-111111111111";

function required(name) {
  assert.equal(typeof cli[name], "function", `${name} must be exported`);
  return cli[name];
}

test("apply requires staging and the exact narrowly named confirmation", () => {
  const validate = required("assertStage1StagingInvalidTestOrderRetirementApplyEnvironment");
  assert.doesNotThrow(() => validate("dry-run", {}));
  assert.doesNotThrow(() =>
    validate("apply", {
      DEPLOYMENT_ENV: "Staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1"
    })
  );
  assert.doesNotThrow(() =>
    validate("apply", {
      APP_ENV: "staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1"
    })
  );

  for (const env of [
    {},
    {
      APP_ENV: "production",
      DEPLOYMENT_ENV: "staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1"
    },
    {
      DEPLOYMENT_ENV: "production",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1"
    },
    {
      APP_ENV: "staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "true"
    },
    {
      APP_ENV: "staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: " 1 "
    }
  ]) {
    assert.throws(
      () => validate("apply", env),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_(STAGING|APPLY_CONFIRMATION)_REQUIRED/
    );
  }
});

test("apply accepts only the deployed staging database identity", () => {
  const validate = required("assertStage1StagingInvalidTestOrderRetirementDatabaseIdentity");
  assert.doesNotThrow(() => validate([{ databaseName: "subscription_saas_staging" }]));
  for (const rows of [
    [],
    [{ databaseName: "subscription_saas_prod" }],
    [{ databaseName: "subscription_saas_staging" }, { databaseName: "subscription_saas_staging" }]
  ]) {
    assert.throws(
      () => validate(rows),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_DATABASE_IDENTITY_MISMATCH/
    );
  }
});

test("target mismatch fails before Prisma creation", async () => {
  let prismaCreated = false;
  await assert.rejects(
    required("runStage1StagingInvalidTestOrderRetirementCli")({
      args: dryRunArgs({ orderNo: "ORD-WRONG" }),
      createPrisma: async () => {
        prismaCreated = true;
        return {};
      },
      env: {}
    }),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH/
  );
  assert.equal(prismaCreated, false);
});

test("invalid apply environment fails before Prisma creation", async () => {
  let prismaCreated = false;
  await assert.rejects(
    required("runStage1StagingInvalidTestOrderRetirementCli")({
      args: applyArgs(),
      createPrisma: async () => {
        prismaCreated = true;
        return {};
      },
      env: { DEPLOYMENT_ENV: "production" }
    }),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_STAGING_REQUIRED/
  );
  assert.equal(prismaCreated, false);
});

test("CLI passes the approved inputs, awaits stdout, then writes optional output", async () => {
  const events = [];
  const prisma = { marker: "prisma" };
  const report = {
    applied: null,
    classification: { disposition: "CANDIDATE", evidenceDigest: "a".repeat(64) },
    generatedAt: "2026-08-29T00:00:00.000Z",
    mode: "dry-run",
    safeToApply: true
  };
  let releaseStdout;
  const pending = required("runStage1StagingInvalidTestOrderRetirementCli")({
    args: [...dryRunArgs(), "--output", "output/retirement.json"],
    createPrisma: async () => prisma,
    env: {},
    execute: async (input) => {
      assert.deepEqual(input, {
        expectedEvidenceDigest: null,
        mode: "dry-run",
        operatorId,
        prisma
      });
      return { exitCode: 0, report };
    },
    writeOutput: async (path, contents) => {
      events.push(["output", path, contents]);
    },
    writeStdout: () =>
      new Promise((resolve) => {
        releaseStdout = () => {
          events.push(["stdout"]);
          resolve();
        };
      })
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  releaseStdout();
  assert.equal(await pending, 0);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  assert.deepEqual(events, [["stdout"], ["output", "output/retirement.json", json]]);
});

test("stdout writer resolves after callback and removes its error listener", async () => {
  const writeStdout = required("writeStage1StagingInvalidTestOrderRetirementStdout");
  let release;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      release = callback;
    }
  });
  let completed = false;
  const pending = writeStdout("report\n", stream).then(() => {
    completed = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await pending;
  assert.equal(completed, true);
  assert.equal(stream.listenerCount("error"), 0);
});

test("process errors expose one stable credential-safe JSON object", async () => {
  const runProcess = required("runStage1StagingInvalidTestOrderRetirementProcess");
  const publicError = required("stage1StagingInvalidTestOrderRetirementPublicError");
  const stderr = [];
  let disconnects = 0;

  const exitCode = await runProcess({
    disconnect: async () => {
      disconnects += 1;
      throw new Error("postgresql://secret:password@host/db");
    },
    run: async () => {
      throw new Error("signedDocumentObjectKey=private/signed.pdf");
    },
    writeStderr: (value) => stderr.push(value)
  });

  assert.equal(exitCode, 1);
  assert.equal(disconnects, 1);
  assert.deepEqual(publicError(), {
    error: "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_FAILED"
  });
  assert.deepEqual(JSON.parse(stderr[0]), publicError());
  assert.doesNotMatch(stderr.join(""), /password|postgresql|private\/signed\.pdf/);
});

test("package scripts expose dry-run, apply, and test entry points", async () => {
  const [packageJson, releaseCheck] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./release-check.mjs", import.meta.url), "utf8")
  ]);

  assert.equal(
    packageJson.scripts["stage1:staging-invalid-test-order-retirement:dry-run"],
    "node scripts/release/trusted-launch-runner.mjs --command stage1.invalid-test-order.retire@1 --phase dry-run --request-file .release-inputs/invalid-test-order-retirement.json"
  );
  assert.equal(
    packageJson.scripts["stage1:staging-invalid-test-order-retirement:apply"],
    "node scripts/release/trusted-launch-runner.mjs --command stage1.invalid-test-order.retire@1 --phase apply --request-file .release-inputs/invalid-test-order-retirement.json"
  );
  assert.equal(
    packageJson.scripts["stage1:staging-invalid-test-order-retirement:test:unit"],
    "node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs scripts/stage1-staging-invalid-test-order-retirement.test.mjs"
  );
  assert.equal(
    packageJson.scripts["stage1:staging-invalid-test-order-retirement:test"],
    "pnpm stage1:staging-invalid-test-order-retirement:test:unit && node scripts/release/run-database-suite.mjs --suite-id runner.stage1-invalid-test-order-retire --chain fresh"
  );
  assert.match(releaseCheck, /stage1:staging-invalid-test-order-retirement:test:unit/u);
  assert.doesNotMatch(releaseCheck, /stage1:staging-invalid-test-order-retirement:test"/u);
});

function dryRunArgs(overrides = {}) {
  const current = { ...target, ...overrides };
  return [
    "--dry-run",
    "--order-id",
    current.orderId,
    "--order-no",
    current.orderNo,
    "--vehicle-id",
    current.vehicleId,
    "--vehicle-no",
    current.vehicleNo,
    "--vin",
    current.vin,
    "--operator-id",
    operatorId
  ];
}

function applyArgs() {
  const args = dryRunArgs();
  args[0] = "--apply";
  args.push("--expected-evidence-digest", "a".repeat(64));
  return args;
}
