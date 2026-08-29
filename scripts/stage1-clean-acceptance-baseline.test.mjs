import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  assertControlledEvidencePath,
  buildPublicStage1AcceptanceSummary,
  parseStage1CleanAcceptanceArgs,
  writeControlledJsonFile
} from "./stage1-clean-acceptance-cli-core.mjs";
import { main as baselineMain } from "./stage1-clean-acceptance-baseline.mjs";

const VEHICLE = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);
const SOURCE_URL = "postgresql://stage1:secret@db.internal:5432/subscription_saas_staging?sslmode=require";
const TARGET_URL = "postgresql://stage1:secret@db.internal:5432/subscription_saas_staging_acceptance_test?sslmode=require";
const BASE_ENV = {
  STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY: "1",
  STAGE1_ACCEPTANCE_DATABASE_ALLOWED_HOSTNAME: "db.internal",
  STAGE1_ACCEPTANCE_GIT_SHA: "b".repeat(40),
  STAGE1_ACCEPTANCE_IMAGE_REF: `registry.example/api@sha256:${"c".repeat(64)}`,
  STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL: SOURCE_URL,
  STAGE1_ACCEPTANCE_TARGET_DATABASE_URL: TARGET_URL
};

test("argument parsing requires exactly one mode and an explicit output", () => {
  assert.throws(() => parseStage1CleanAcceptanceArgs([]), /CLI_MODE_REQUIRED/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--dry-run", "--apply", "--output", "x"]), /CLI_MODE_REQUIRED/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--dry-run", "--vehicle-id", VEHICLE]), /EVIDENCE_OUTPUT_REQUIRED/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "x", "--generated-at", "2026-01-01T00:00:00.000Z"]), /CLI_ARGUMENT_UNKNOWN/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "x", "--hash-salt", SHA]), /CLI_ARGUMENT_UNKNOWN/);
});

test("argument parsing normalizes vehicle ids and makes discovery dry-run only", () => {
  assert.deepEqual(
    parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "report.json", "--vehicle-id", VEHICLE.toUpperCase(), "--vehicle-id", VEHICLE]),
    { approvedManifestPath: undefined, approvedManifestSha256: undefined, discoverVehicles: false, mode: "dry-run", outputPath: "report.json", vehicleIds: [VEHICLE] }
  );
  assert.deepEqual(
    parseStage1CleanAcceptanceArgs(["--dry-run", "--discover-vehicles", "--output", "report.json"]),
    { approvedManifestPath: undefined, approvedManifestSha256: undefined, discoverVehicles: true, mode: "dry-run", outputPath: "report.json", vehicleIds: [] }
  );
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--apply", "--discover-vehicles", "--output", "x", "--approved-manifest", "m", "--approved-manifest-sha256", SHA]), /VEHICLE_SELECTION_REQUIRED/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "x"]), /VEHICLE_SELECTION_REQUIRED/);
  assert.throws(() => parseStage1CleanAcceptanceArgs(["--apply", "--output", "x", "--vehicle-id", VEHICLE]), /APPROVED_MANIFEST_REQUIRED/);
});

test("controlled evidence paths stay outside the repository and reject missing parents, directories, and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage1-cli-path-"));
  const repo = join(root, "repo");
  const evidence = join(root, "evidence");
  await mkdir(repo);
  await mkdir(evidence);
  t.after(() => rm(root, { force: true, recursive: true }));

  assert.equal(assertControlledEvidencePath(join(evidence, "report.json"), repo), resolve(evidence, "report.json"));
  assert.throws(() => assertControlledEvidencePath(join(repo, "report.json"), repo), /EVIDENCE_PATH_INSIDE_REPOSITORY/);
  assert.throws(() => assertControlledEvidencePath(join(root, "missing", "report.json"), repo), /EVIDENCE_PARENT_INVALID/);
  assert.throws(() => assertControlledEvidencePath(evidence, repo), /EVIDENCE_TARGET_INVALID/);

  const realFile = join(evidence, "existing.json");
  const linkFile = join(evidence, "linked.json");
  await writeFile(realFile, "existing");
  try {
    await import("node:fs/promises").then(({ symlink }) => symlink(realFile, linkFile));
    assert.throws(() => assertControlledEvidencePath(linkFile, repo), /EVIDENCE_TARGET_INVALID/);
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

test("controlled JSON writing is same-directory atomic, private on Unix, and cleans only its own temp on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage1-cli-write-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = join(root, "report.json");
  await writeControlledJsonFile(output, { ok: true });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { ok: true });
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o777, 0o600);

  const existing = join(root, "existing.json");
  await writeFile(existing, "keep");
  const calls = [];
  const fsApi = {
    async open(path) {
      calls.push(["open", path]);
      return {
        async writeFile() { throw new Error("disk full"); },
        async sync() {},
        async close() { calls.push(["close", path]); }
      };
    },
    async rename() { calls.push(["rename"]); },
    async unlink(path) { calls.push(["unlink", path]); }
  };
  await assert.rejects(writeControlledJsonFile(existing, { replace: true }, fsApi), /EVIDENCE_WRITE_FAILED/);
  assert.equal(await readFile(existing, "utf8"), "keep");
  assert.equal(calls.some(([operation]) => operation === "rename"), false);
  assert.equal(calls.filter(([operation]) => operation === "unlink").length, 1);
  assert.equal(dirname(calls.find(([operation]) => operation === "open")[1]), root);
});

test("public summaries allow only fixed non-sensitive fields", () => {
  const summary = buildPublicStage1AcceptanceSummary({
    candidateCount: 2,
    candidateDigest: "d".repeat(64),
    hashSalt: SHA,
    manifestSha256: "e".repeat(64),
    mode: "dry-run",
    reportPath: "D:/evidence/report.json",
    rowDigests: { access: "secret" },
    safe: true,
    customerPhone: "18616570212",
    url: SOURCE_URL
  });
  assert.deepEqual(summary, {
    candidateCount: 2,
    candidateDigest: "d".repeat(64),
    manifestSha256: "e".repeat(64),
    mode: "dry-run",
    reportPath: "D:/evidence/report.json",
    safe: true
  });
});

test("baseline dry-run generates canonical time/salt, writes a controlled manifest, and always disconnects both clients", async () => {
  const harness = createBaselineHarness();
  const code = await baselineMain(["--dry-run", "--output", "D:/evidence/dry.json", "--vehicle-id", VEHICLE], harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.executeCalls.length, 1);
  assert.equal(harness.executeCalls[0].generatedAt, "2026-08-30T12:34:56.000Z");
  assert.equal(harness.executeCalls[0].hashSalt, "11".repeat(32));
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.clients.every((client) => client.disconnects === 1), true);
  assert.equal(harness.stdout.length, 1);
  assert.equal(harness.stdout[0].includes("hashSalt"), false);
  assert.equal(harness.stdout[0].includes("rowDigests"), false);
});

test("apply reuses approved generatedAt/salt and verifies the canonical manifest SHA before execution", async () => {
  const approved = approvedManifest();
  const harness = createBaselineHarness({ approved });
  const code = await baselineMain([
    "--apply", "--output", "D:/evidence/apply.json", "--vehicle-id", VEHICLE,
    "--approved-manifest", "D:/evidence/dry.json", "--approved-manifest-sha256", SHA
  ], harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.executeCalls[0].generatedAt, approved.generatedAt);
  assert.equal(harness.executeCalls[0].hashSalt, approved.hashSalt);
  assert.deepEqual(harness.executeCalls[0].approvedManifest, approved);

  const mismatch = createBaselineHarness({ approved, canonicalManifestSha: "f".repeat(64) });
  assert.equal(await baselineMain([
    "--apply", "--output", "D:/evidence/apply.json", "--vehicle-id", VEHICLE,
    "--approved-manifest", "D:/evidence/dry.json", "--approved-manifest-sha256", SHA
  ], mismatch.deps), 2);
  assert.equal(mismatch.executeCalls.length, 0);
  assert.equal(mismatch.clients.length, 0);

  const malformed = createBaselineHarness({ approved: { ...approved, generatedAt: "not-an-instant" } });
  assert.equal(await baselineMain([
    "--apply", "--output", "D:/evidence/apply.json", "--vehicle-id", VEHICLE,
    "--approved-manifest", "D:/evidence/dry.json", "--approved-manifest-sha256", SHA
  ], malformed.deps), 2);
  assert.equal(malformed.executeCalls.length, 0);
  assert.equal(malformed.clients.length, 0);

  const noConfirmationEnv = { ...BASE_ENV };
  delete noConfirmationEnv.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
  const noConfirmation = createBaselineHarness({ approved, env: noConfirmationEnv });
  assert.equal(await baselineMain([
    "--apply", "--output", "D:/evidence/apply.json", "--vehicle-id", VEHICLE,
    "--approved-manifest", "D:/evidence/dry.json", "--approved-manifest-sha256", SHA
  ], noConfirmation.deps), 2);
  assert.equal(noConfirmation.clients.length, 0);
});

test("discovery writes minimal candidates, exposes only count/digest, and exits with the stable selection gate", async () => {
  const harness = createBaselineHarness({ candidates: [
    { id: VEHICLE, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" }
  ] });
  const code = await baselineMain(["--dry-run", "--discover-vehicles", "--output", "D:/evidence/candidates.json"], harness.deps);
  assert.equal(code, 3);
  assert.equal(harness.executeCalls.length, 0);
  assert.equal(harness.reports[0].value.candidates[0].id, VEHICLE);
  assert.equal(harness.stdout[0].includes(VEHICLE), false);
  assert.equal(harness.stdout[0].includes("VEHICLE_SELECTION_REQUIRED"), true);
  assert.equal(harness.clients.every((client) => client.disconnects === 1), true);
});

test("an unsafe dry-run writes evidence and exposes only its stable gate code", async () => {
  const harness = createBaselineHarness({ scenario: "unsafe" });
  const code = await baselineMain(["--dry-run", "--output", "D:/evidence/unsafe.json", "--vehicle-id", VEHICLE], harness.deps);
  assert.equal(code, 3);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.stdout[0].includes("VEHICLE_NOT_ELIGIBLE"), true);
  assert.equal(harness.stdout[0].includes(VEHICLE), false);
});

test("baseline never falls back to DATABASE_URL and disconnects on partial connect, execution, write, and SIGINT paths", async () => {
  const missing = createBaselineHarness({ env: { DATABASE_URL: SOURCE_URL } });
  assert.equal(await baselineMain(["--dry-run", "--output", "D:/evidence/x.json", "--vehicle-id", VEHICLE], missing.deps), 2);
  assert.equal(missing.clients.length, 0);

  for (const scenario of ["target-connect", "execute", "gate", "write", "sigint"]) {
    const harness = createBaselineHarness({ scenario });
    const code = await baselineMain(["--dry-run", "--output", "D:/evidence/x.json", "--vehicle-id", VEHICLE], harness.deps);
    assert.equal(code, scenario === "write" ? 5 : scenario === "gate" ? 3 : 4, scenario);
    assert.equal(harness.clients.every((client) => client.disconnects === 1), true, scenario);
  }
});

function approvedManifest() {
  return {
    counts: { access: 1, catalog: 1, customer: 1, templates: 1, vehicle: 1 },
    exceptions: [],
    generatedAt: "2026-08-29T01:02:03.000Z",
    gitSha: "b".repeat(40),
    hashSalt: "9".repeat(64),
    imageRef: `registry.example/api@sha256:${"c".repeat(64)}`,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    rowDigests: { access: SHA, catalog: SHA, customer: SHA, templates: SHA, vehicle: SHA },
    safeToApply: true,
    schemaVersion: 1,
    selection: { adminDigest: SHA, customerDigest: SHA, vehicleDigests: [SHA] },
    source: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA },
    target: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA }
  };
}

function createBaselineHarness({ approved = approvedManifest(), candidates = [], canonicalManifestSha = SHA, env = BASE_ENV, scenario } = {}) {
  const clients = [];
  const executeCalls = [];
  const reports = [];
  const stdout = [];
  const stderr = [];
  let signalHandler;
  const deps = {
    assertEvidencePath: (path) => resolve(path),
    createPrismaClient: async (_url, label) => {
      if (scenario === "target-connect" && label === "target") throw new Error("connection contains secret");
      const client = {
        disconnects: 0,
        async $disconnect() { this.disconnects += 1; },
        async $transaction(callback) {
          return callback({ $queryRaw: async () => [], vehicle: { findMany: async () => candidates } });
        }
      };
      clients.push(client);
      return client;
    },
    discoverCandidates: async (_tx, options) => {
      assert.ok(options.asOf instanceof Date);
      return candidates;
    },
    env,
    executeBaseline: async (options) => {
      executeCalls.push(options);
      if (scenario === "sigint") signalHandler();
      if (scenario === "execute") throw new Error("database secret leaked");
      if (scenario === "gate") throw new Error("MANIFEST_STALE");
      if (scenario === "unsafe") return { manifest: { exceptions: [{ code: "VEHICLE_NOT_ELIGIBLE" }], generatedAt: options.generatedAt, hashSalt: options.hashSalt }, manifestSha256: SHA, mode: "dry-run", safe: false };
      return options.mode === "dry-run"
        ? { manifest: { generatedAt: options.generatedAt, hashSalt: options.hashSalt, rowDigests: { access: "x" } }, manifestSha256: SHA, mode: "dry-run", safe: true }
        : { manifestSha256: SHA, mode: options.mode, safe: true };
    },
    hashManifest: () => canonicalManifestSha,
    installSignalHandler: (handler) => { signalHandler = handler; return () => {}; },
    now: () => new Date("2026-08-30T12:34:56.000Z"),
    randomBytes: () => Buffer.alloc(32, 0x11),
    readTextFile: async () => JSON.stringify({ manifest: approved, manifestSha256: SHA }),
    repoRoot: "D:/repo",
    writeJsonFile: async (path, value) => {
      if (scenario === "write") throw new Error("disk path secret");
      reports.push({ path, value });
    },
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value)
  };
  return { clients, deps, executeCalls, reports, stderr, stdout };
}
