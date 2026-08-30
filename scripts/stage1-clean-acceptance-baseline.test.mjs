import assert from "node:assert/strict";
import * as hostFsSync from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  assertControlledEvidencePath,
  buildPublicStage1AcceptanceSummary,
  buildStage1AcceptanceDatabaseEnvSwitch,
  createStage1AcceptancePrismaClient,
  parseStage1CleanAcceptanceArgs,
  writeControlledJsonFile
} from "./stage1-clean-acceptance-cli-core.mjs";
import { main as baselineMain } from "./stage1-clean-acceptance-baseline.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  STAGE1_ACCEPTANCE_WHITELIST_DELEGATES
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const VEHICLE = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);
const SOURCE_URL =
  "postgresql://stage1:secret@db.internal:5432/subscription_saas_staging?sslmode=require";
const TARGET_URL =
  "postgresql://stage1:secret@db.internal:5432/subscription_saas_staging_acceptance_test?sslmode=require";
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
  assert.throws(
    () => parseStage1CleanAcceptanceArgs(["--dry-run", "--apply", "--output", "x"]),
    /CLI_MODE_REQUIRED/
  );
  assert.throws(
    () => parseStage1CleanAcceptanceArgs(["--dry-run", "--vehicle-id", VEHICLE]),
    /EVIDENCE_OUTPUT_REQUIRED/
  );
  assert.throws(
    () =>
      parseStage1CleanAcceptanceArgs([
        "--dry-run",
        "--output",
        "x",
        "--generated-at",
        "2026-01-01T00:00:00.000Z"
      ]),
    /CLI_ARGUMENT_UNKNOWN/
  );
  assert.throws(
    () => parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "x", "--hash-salt", SHA]),
    /CLI_ARGUMENT_UNKNOWN/
  );
});

test("argument parsing normalizes vehicle ids and makes discovery dry-run only", () => {
  assert.deepEqual(
    parseStage1CleanAcceptanceArgs([
      "--dry-run",
      "--output",
      "report.json",
      "--vehicle-id",
      VEHICLE.toUpperCase(),
      "--vehicle-id",
      VEHICLE
    ]),
    {
      approvedManifestPath: undefined,
      approvedManifestSha256: undefined,
      discoverVehicles: false,
      mode: "dry-run",
      outputPath: "report.json",
      vehicleIds: [VEHICLE]
    }
  );
  assert.deepEqual(
    parseStage1CleanAcceptanceArgs(["--dry-run", "--discover-vehicles", "--output", "report.json"]),
    {
      approvedManifestPath: undefined,
      approvedManifestSha256: undefined,
      discoverVehicles: true,
      mode: "dry-run",
      outputPath: "report.json",
      vehicleIds: []
    }
  );
  assert.throws(
    () =>
      parseStage1CleanAcceptanceArgs([
        "--apply",
        "--discover-vehicles",
        "--output",
        "x",
        "--approved-manifest",
        "m",
        "--approved-manifest-sha256",
        SHA
      ]),
    /VEHICLE_SELECTION_REQUIRED/
  );
  assert.throws(
    () => parseStage1CleanAcceptanceArgs(["--dry-run", "--output", "x"]),
    /VEHICLE_SELECTION_REQUIRED/
  );
  assert.throws(
    () => parseStage1CleanAcceptanceArgs(["--apply", "--output", "x", "--vehicle-id", VEHICLE]),
    /APPROVED_MANIFEST_REQUIRED/
  );
});

test("controlled evidence paths stay outside the repository and reject missing parents, directories, and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage1-cli-path-"));
  const repo = join(root, "repo");
  const evidence = join(root, "evidence");
  await mkdir(repo);
  await mkdir(evidence);
  t.after(() => rm(root, { force: true, recursive: true }));

  const createSecurity = hostEvidenceSecurity(evidence, "create");
  const readSecurity = hostEvidenceSecurity(evidence, "read");
  assert.equal(
    assertControlledEvidencePath(join(evidence, "report.json"), repo, createSecurity),
    resolve(evidence, "report.json")
  );
  assert.throws(
    () => assertControlledEvidencePath(join(repo, "report.json"), repo, createSecurity),
    /EVIDENCE_PATH_INSIDE_REPOSITORY/
  );
  assert.throws(
    () => assertControlledEvidencePath(join(root, "missing", "report.json"), repo, createSecurity),
    /EVIDENCE_PARENT_INVALID/
  );
  assert.throws(
    () => assertControlledEvidencePath(evidence, repo, hostEvidenceSecurity(root, "create")),
    /EVIDENCE_TARGET_EXISTS/
  );

  const realFile = join(evidence, "existing.json");
  const linkFile = join(evidence, "linked.json");
  await writeFile(realFile, "existing");
  assert.equal(assertControlledEvidencePath(realFile, repo, readSecurity), resolve(realFile));
  assert.throws(
    () => assertControlledEvidencePath(realFile, repo, createSecurity),
    /EVIDENCE_TARGET_EXISTS/
  );
  assert.throws(
    () => assertControlledEvidencePath(join(evidence, "missing.json"), repo, readSecurity),
    /EVIDENCE_TARGET_INVALID/
  );
  try {
    await import("node:fs/promises").then(({ symlink }) => symlink(realFile, linkFile));
    assert.throws(
      () => assertControlledEvidencePath(linkFile, repo, readSecurity),
      /EVIDENCE_TARGET_INVALID/
    );
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

test("virtual Win32 paths enforce case-insensitive containment, canonical parents, ACLs, and non-link reads", () => {
  const repo = "C:\\acceptance\\repo";
  const evidence = "C:\\acceptance\\repo-evidence";
  const fsSync = virtualWindowsFs();
  const createSecurity = {
    fsSync,
    intent: "create",
    pathApi: path.win32,
    platform: "win32",
    verifyWindowsAcl: windowsAcl(evidence, true, path.win32)
  };

  assert.throws(
    () => assertControlledEvidencePath("c:\\ACCEPTANCE\\REPO\\inside.json", repo, createSecurity),
    /EVIDENCE_PATH_INSIDE_REPOSITORY/
  );
  assert.equal(
    assertControlledEvidencePath(`${evidence}\\report.json`, repo, createSecurity),
    `${evidence}\\report.json`,
    "an adjacent repository prefix is not inside the repository"
  );
  assert.equal(
    assertControlledEvidencePath("C:/acceptance/repo-evidence/report.json", repo, createSecurity),
    `${evidence}\\report.json`,
    "Win32 separator normalization preserves the canonical path"
  );
  assert.throws(
    () =>
      assertControlledEvidencePath(
        "C:\\acceptance\\evidence-alias\\report.json",
        repo,
        createSecurity
      ),
    /EVIDENCE_PARENT_INVALID/
  );
  assert.throws(
    () =>
      assertControlledEvidencePath(
        "C:\\acceptance\\evidence-junction\\report.json",
        repo,
        createSecurity
      ),
    /EVIDENCE_PARENT_INVALID/
  );
  assert.throws(
    () =>
      assertControlledEvidencePath(`${evidence}\\report.json`, repo, {
        ...createSecurity,
        verifyWindowsAcl: undefined
      }),
    /EVIDENCE_DIRECTORY_NOT_CONTROLLED/
  );
  assert.throws(
    () =>
      assertControlledEvidencePath(`${evidence}\\report.json`, repo, {
        ...createSecurity,
        verifyWindowsAcl: windowsAcl(evidence, false, path.win32)
      }),
    /EVIDENCE_DIRECTORY_NOT_CONTROLLED/
  );

  const readSecurity = { ...createSecurity, intent: "read" };
  assert.equal(
    assertControlledEvidencePath(`${evidence}\\existing.json`, repo, readSecurity),
    `${evidence}\\existing.json`
  );
  assert.throws(
    () => assertControlledEvidencePath(`${evidence}\\linked.json`, repo, readSecurity),
    /EVIDENCE_TARGET_INVALID/
  );
});

test("virtual POSIX paths require a root-owned mode-0700 evidence directory", () => {
  const repo = "/acceptance/repo";
  const evidence = "/acceptance/repo-evidence";
  const options = (uid, mode) => ({
    fsSync: virtualPosixDirectoryFs(evidence, uid, mode),
    intent: "create",
    pathApi: path.posix,
    platform: "linux"
  });
  assert.equal(
    assertControlledEvidencePath(`${evidence}/report.json`, repo, options(0, 0o40700)),
    `${evidence}/report.json`
  );
  assert.throws(
    () => assertControlledEvidencePath(`${evidence}/report.json`, repo, options(1000, 0o40700)),
    /EVIDENCE_DIRECTORY_NOT_CONTROLLED/
  );
  assert.throws(
    () => assertControlledEvidencePath(`${evidence}/report.json`, repo, options(0, 0o40755)),
    /EVIDENCE_DIRECTORY_NOT_CONTROLLED/
  );
});

test("controlled JSON writing is same-directory atomic, private on Unix, and cleans only its own temp on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage1-cli-write-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = join(root, "report.json");
  const security = { ...hostEvidenceSecurity(root, "create"), repoRoot: repo };
  await writeControlledJsonFile(output, { ok: true }, undefined, security);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { ok: true });
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o777, 0o600);

  const existing = join(root, "existing.json");
  await writeFile(existing, "keep");
  await assert.rejects(
    writeControlledJsonFile(existing, { replace: true }, undefined, security),
    /EVIDENCE_TARGET_EXISTS/
  );
  assert.equal(await readFile(existing, "utf8"), "keep");

  const failedOutput = join(root, "failed.json");
  const calls = [];
  const fsApi = {
    async open(path, flag, mode) {
      calls.push(["open", path, flag, mode]);
      return {
        async writeFile() {
          throw new Error("disk full");
        },
        async sync() {},
        async close() {
          calls.push(["close", path]);
        }
      };
    },
    async link() {
      calls.push(["link"]);
    },
    async unlink(path) {
      calls.push(["unlink", path]);
    }
  };
  await assert.rejects(
    writeControlledJsonFile(failedOutput, { replace: true }, fsApi, security),
    /EVIDENCE_WRITE_FAILED/
  );
  assert.equal(await readFile(existing, "utf8"), "keep");
  assert.equal(
    calls.some(([operation]) => operation === "link"),
    false
  );
  assert.equal(calls.filter(([operation]) => operation === "unlink").length, 1);
  const openCall = calls.find(([operation]) => operation === "open");
  assert.equal(dirname(openCall[1]), root);
  assert.deepEqual(openCall.slice(2), ["wx", 0o600]);

  const unsupportedOutput = join(root, "unsupported.json");
  const unsupportedCalls = [];
  await assert.rejects(
    writeControlledJsonFile(
      unsupportedOutput,
      { ok: true },
      {
        async open(path, flag, mode) {
          unsupportedCalls.push(["open", path, flag, mode]);
          return {
            async writeFile() {
              unsupportedCalls.push(["write"]);
            },
            async sync() {
              unsupportedCalls.push(["sync"]);
            },
            async close() {
              unsupportedCalls.push(["close"]);
            }
          };
        },
        async unlink(path) {
          unsupportedCalls.push(["unlink", path]);
        }
      },
      security
    ),
    /EVIDENCE_WRITE_FAILED/
  );
  assert.deepEqual(unsupportedCalls[0].slice(2), ["wx", 0o600]);
  assert.equal(
    unsupportedCalls.some(([operation]) => operation === "unlink"),
    true
  );
  await assert.rejects(readFile(unsupportedOutput, "utf8"));

  const concurrentOutput = join(root, "concurrent.json");
  const settled = await Promise.allSettled([
    writeControlledJsonFile(concurrentOutput, { writer: 1 }, undefined, security),
    writeControlledJsonFile(concurrentOutput, { writer: 2 }, undefined, security)
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.ok([1, 2].includes(JSON.parse(await readFile(concurrentOutput, "utf8")).writer));
});

test("the real generated Prisma client emits no sensitive validation log without connecting to a database", async () => {
  const sensitive = ["HASH_SECRET", "PHONE_SECRET", "OBJECT_KEY_SECRET", "INVOCATION_SECRET"];
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = function (chunk, ...args) {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = function (chunk, ...args) {
    stderr += String(chunk);
    return true;
  };
  let client;
  let validationError;
  try {
    client = await createStage1AcceptancePrismaClient(
      "postgresql://unused:unused@127.0.0.1:1/no_connection",
      "probe",
      { repoRoot: resolve(".") }
    );
    await assert.rejects(
      client.user.create({
        data: {
          username: "PII_USER",
          passwordHash: "HASH_SECRET",
          notAField: {
            invocation: "INVOCATION_SECRET",
            objectKey: "OBJECT_KEY_SECRET",
            phone: "PHONE_SECRET"
          }
        }
      }),
      (error) => {
        validationError = error;
        return error?.name === "PrismaClientValidationError";
      }
    );
  } finally {
    await client?.$disconnect();
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  for (const value of sensitive) {
    assert.equal(stdout.includes(value), false, `stdout leaked ${value}`);
    assert.equal(stderr.includes(value), false, `stderr leaked ${value}`);
  }
  assert.equal(stdout.includes("prisma.user.create"), false);
  assert.equal(stderr.includes("prisma.user.create"), false);
  assert.equal(validationError?.name, "PrismaClientValidationError");
});

test("public summaries allow only fixed non-sensitive fields", () => {
  const summary = buildPublicStage1AcceptanceSummary({
    auditCreated: 0,
    candidateCount: 2,
    candidateDigest: "d".repeat(64),
    deleted: 0,
    hashSalt: SHA,
    inserted: 0,
    manifestSha256: "e".repeat(64),
    mode: "dry-run",
    reportPath: "D:/evidence/report.json",
    rowDigests: { access: "secret" },
    safe: true,
    updated: 0,
    customerPhone: "18616570212",
    url: SOURCE_URL
  });
  assert.deepEqual(summary, {
    auditCreated: 0,
    candidateCount: 2,
    candidateDigest: "d".repeat(64),
    deleted: 0,
    inserted: 0,
    manifestSha256: "e".repeat(64),
    mode: "dry-run",
    reportPath: "D:/evidence/report.json",
    safe: true,
    updated: 0
  });
});

test("database env switch binds the real env URL to approved source and target semantics", () => {
  const source =
    "postgresql://stage1:p%40ss@db.internal:5432/subscription_saas_staging?schema=public&sslmode=require";
  const target =
    "postgresql://stage1:p%40ss@db.internal:5432/subscription_saas_staging_acceptance_20260830t010203z?schema=public&sslmode=require";

  for (const quote of ["", "'", '"']) {
    const input = `A=1\nDATABASE_URL=${quote}${source}${quote}\nB=2\n`;
    const output = buildStage1AcceptanceDatabaseEnvSwitch(input, source, target);
    assert.equal(output, `A=1\nDATABASE_URL=${quote}${target}${quote}\nB=2\n`);
    assert.equal(output.includes("p@ss"), false, "percent-encoded credentials stay encoded");
  }

  const invalidSources = [
    source.replace("subscription_saas_staging", "wrong_database"),
    source.replace("db.internal", "other.internal"),
    source.replace("p%40ss", "wrong"),
    source.replace("schema=public", "schema=other")
  ];
  for (const actual of invalidSources) {
    assert.throws(
      () => buildStage1AcceptanceDatabaseEnvSwitch(`DATABASE_URL=${actual}\n`, source, target),
      (error) =>
        error.message === "ENV_DATABASE_URL_SOURCE_MISMATCH" && !error.message.includes(source)
    );
  }
  assert.throws(
    () =>
      buildStage1AcceptanceDatabaseEnvSwitch(
        `DATABASE_URL=${source}\n`,
        source,
        target.replace("db.internal", "other.internal")
      ),
    /APPROVED_DATABASE_URL_PAIR_INVALID/
  );
  assert.throws(
    () =>
      buildStage1AcceptanceDatabaseEnvSwitch(
        `DATABASE_URL=${source}\nDATABASE_URL=${source}\n`,
        source,
        target
      ),
    /ENV_DATABASE_URL_COUNT_INVALID/
  );
});

test("baseline help is deterministic, non-sensitive, and bypasses environment and database processing", async () => {
  const stdout = [];
  const stderr = [];
  const environment = new Proxy(
    {},
    {
      get() {
        throw new Error("help must not read environment");
      }
    }
  );
  const deps = {
    assertEvidencePath() {
      throw new Error("help must not inspect evidence paths");
    },
    createPrismaClient() {
      throw new Error("help must not create Prisma clients");
    },
    env: environment,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value)
  };
  const expected =
    [
      "Usage: stage1-clean-acceptance-baseline.mjs --dry-run|--apply|--replay --output <controlled-evidence-file> [options]",
      "Arguments:",
      "--dry-run: generate a baseline manifest without applying it.",
      "--apply: apply an approved baseline manifest.",
      "--replay: replay an approved baseline manifest.",
      "--discover-vehicles: dry-run vehicle candidate discovery only.",
      "--output <value>: controlled evidence output.",
      "--vehicle-id <uuid>: repeatable selected vehicle identifier.",
      "--approved-manifest <value>: approved manifest input.",
      "--approved-manifest-sha256 <sha256>: approved manifest digest.",
      "Constraints:",
      "CLI_MODE_REQUIRED: exactly one mode is required.",
      "EVIDENCE_OUTPUT_REQUIRED: --output is required.",
      "VEHICLE_SELECTION_REQUIRED: select vehicles or use dry-run discovery.",
      "APPROVED_MANIFEST_REQUIRED: apply and replay require approved manifest evidence.",
      "BASELINE_APPLY_CONFIRMATION_REQUIRED: apply requires explicit confirmation."
    ].join("\n") + "\n";

  assert.equal(await baselineMain(["--help"], deps), 0);
  assert.deepEqual(stdout, [expected]);
  assert.deepEqual(stderr, []);
  for (const sensitive of [
    SOURCE_URL,
    TARGET_URL,
    "keqi_119",
    "18616570212",
    "secret",
    "D:/evidence"
  ]) {
    assert.equal(expected.includes(sensitive), false);
  }

  assert.equal(await baselineMain(["--help", "--dry-run"], deps), 2);
  assert.deepEqual(stderr, ['{"error":{"code":"CLI_ARGUMENT_UNKNOWN"}}\n']);
});

test("baseline dry-run generates canonical time/salt, writes a controlled manifest, and always disconnects both clients", async () => {
  const harness = createBaselineHarness();
  const code = await baselineMain(
    ["--dry-run", "--output", "D:/evidence/dry.json", "--vehicle-id", VEHICLE],
    harness.deps
  );
  assert.equal(code, 0);
  assert.equal(harness.executeCalls.length, 1);
  assert.equal(harness.executeCalls[0].generatedAt, "2026-08-30T12:34:56.000Z");
  assert.equal(harness.executeCalls[0].hashSalt, "11".repeat(32));
  assert.equal(harness.reports.length, 1);
  assert.equal(
    harness.clients.every((client) => client.disconnects === 1),
    true
  );
  assert.equal(harness.stdout.length, 1);
  assert.equal(harness.stdout[0].includes("hashSalt"), false);
  assert.equal(harness.stdout[0].includes("rowDigests"), false);
});

test("apply reuses approved generatedAt/salt and verifies the canonical manifest SHA before execution", async () => {
  const approved = approvedManifest();
  const harness = createBaselineHarness({ approved });
  const code = await baselineMain(
    [
      "--apply",
      "--output",
      "D:/evidence/apply.json",
      "--vehicle-id",
      VEHICLE,
      "--approved-manifest",
      "D:/evidence/dry.json",
      "--approved-manifest-sha256",
      SHA
    ],
    harness.deps
  );
  assert.equal(code, 0);
  assert.equal(harness.executeCalls[0].generatedAt, approved.generatedAt);
  assert.equal(harness.executeCalls[0].hashSalt, approved.hashSalt);
  assert.deepEqual(harness.executeCalls[0].approvedManifest, approved);

  const mismatch = createBaselineHarness({ approved, canonicalManifestSha: "f".repeat(64) });
  assert.equal(
    await baselineMain(
      [
        "--apply",
        "--output",
        "D:/evidence/apply.json",
        "--vehicle-id",
        VEHICLE,
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      mismatch.deps
    ),
    2
  );
  assert.equal(mismatch.executeCalls.length, 0);
  assert.equal(mismatch.clients.length, 0);

  const malformed = createBaselineHarness({
    approved: { ...approved, generatedAt: "not-an-instant" }
  });
  assert.equal(
    await baselineMain(
      [
        "--apply",
        "--output",
        "D:/evidence/apply.json",
        "--vehicle-id",
        VEHICLE,
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      malformed.deps
    ),
    2
  );
  assert.equal(malformed.executeCalls.length, 0);
  assert.equal(malformed.clients.length, 0);

  const noConfirmationEnv = { ...BASE_ENV };
  delete noConfirmationEnv.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
  const noConfirmation = createBaselineHarness({ approved, env: noConfirmationEnv });
  assert.equal(
    await baselineMain(
      [
        "--apply",
        "--output",
        "D:/evidence/apply.json",
        "--vehicle-id",
        VEHICLE,
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      noConfirmation.deps
    ),
    2
  );
  assert.equal(noConfirmation.clients.length, 0);

  const approvalCases = [
    { ...approved, rawSecret: "TOP_LEVEL_SECRET" },
    { ...approved, selection: { ...approved.selection, rawCustomerPhone: "18616570212" } },
    { ...approved, selection: { ...approved.selection, vehicleDigests: [SHA, SHA] } },
    { ...approved, selection: { ...approved.selection, vehicleDigests: ["b".repeat(64), SHA] } }
  ];
  for (const rejected of approvalCases) {
    const invalid = createBaselineHarness({ approved: rejected });
    assert.equal(
      await baselineMain(
        [
          "--apply",
          "--output",
          "D:/evidence/apply.json",
          "--vehicle-id",
          VEHICLE,
          "--approved-manifest",
          "D:/evidence/dry.json",
          "--approved-manifest-sha256",
          SHA
        ],
        invalid.deps
      ),
      2
    );
    assert.equal(invalid.clients.length, 0);
  }

  const wrapper = {
    manifest: approved,
    manifestSha256: SHA,
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: approvedTargetCountEvidence()
  };
  for (const rejectedReport of [
    { ...wrapper, rawSecret: "WRAPPER_SECRET" },
    { ...wrapper, result: { rawPhone: "18616570212" } }
  ]) {
    const invalid = createBaselineHarness({ approved, approvedReport: rejectedReport });
    assert.equal(
      await baselineMain(
        [
          "--apply",
          "--output",
          "D:/evidence/apply.json",
          "--vehicle-id",
          VEHICLE,
          "--approved-manifest",
          "D:/evidence/dry.json",
          "--approved-manifest-sha256",
          SHA
        ],
        invalid.deps
      ),
      2
    );
    assert.equal(invalid.clients.length, 0);
  }

  const samePath = createBaselineHarness({ approved });
  assert.equal(
    await baselineMain(
      [
        "--apply",
        "--output",
        "D:/evidence/dry.json",
        "--vehicle-id",
        VEHICLE,
        "--approved-manifest",
        "D:/evidence/dry.json",
        "--approved-manifest-sha256",
        SHA
      ],
      samePath.deps
    ),
    2
  );
  assert.equal(samePath.clients.length, 0);
});

test("apply and replay reject every strict approved-wrapper violation before connecting", async () => {
  const approved = approvedManifest();
  for (const mode of ["apply", "replay"]) {
    for (const [caseName, approvedReport] of invalidApprovedReports(approved)) {
      const harness = createBaselineHarness({ approved, approvedReport });
      assert.equal(
        await baselineMain(
          [
            `--${mode}`,
            "--output",
            `D:/evidence/${mode}.json`,
            "--vehicle-id",
            VEHICLE,
            "--approved-manifest",
            "D:/evidence/dry.json",
            "--approved-manifest-sha256",
            SHA
          ],
          harness.deps
        ),
        2,
        `${mode}:${caseName}`
      );
      assert.equal(harness.clients.length, 0, `${mode}:${caseName}`);
    }
  }
});

test("replay report and public summary expose exact zero write counts", async () => {
  const harness = createBaselineHarness({ approved: approvedManifest() });
  const code = await baselineMain(
    [
      "--replay",
      "--output",
      "D:/evidence/replay.json",
      "--vehicle-id",
      VEHICLE,
      "--approved-manifest",
      "D:/evidence/dry.json",
      "--approved-manifest-sha256",
      SHA
    ],
    harness.deps
  );

  assert.equal(code, 0);
  const expectedCounts = { auditCreated: 0, deleted: 0, inserted: 0, updated: 0 };
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expectedCounts).map((key) => [key, harness.reports[0].value[key]])
    ),
    expectedCounts
  );
  const summary = JSON.parse(harness.stdout[0]);
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedCounts).map((key) => [key, summary[key]])),
    expectedCounts
  );
  for (const forbidden of [SOURCE_URL, TARGET_URL, VEHICLE, "18616570212"]) {
    assert.equal(harness.stdout[0].includes(forbidden), false);
  }
});

test("discovery writes minimal candidates, exposes only count/digest, and exits with the stable selection gate", async () => {
  const harness = createBaselineHarness({
    candidates: [{ id: VEHICLE, salePriceStatus: "EFFECTIVE", status: "AVAILABLE" }]
  });
  const code = await baselineMain(
    ["--dry-run", "--discover-vehicles", "--output", "D:/evidence/candidates.json"],
    harness.deps
  );
  assert.equal(code, 3);
  assert.equal(harness.executeCalls.length, 0);
  assert.equal(harness.reports[0].value.candidates[0].id, VEHICLE);
  assert.equal(harness.stdout[0].includes(VEHICLE), false);
  assert.equal(harness.stdout[0].includes("VEHICLE_SELECTION_REQUIRED"), true);
  assert.equal(
    harness.clients.every((client) => client.disconnects === 1),
    true
  );
});

test("an unsafe dry-run writes evidence and exposes only its stable gate code", async () => {
  const harness = createBaselineHarness({ scenario: "unsafe" });
  const code = await baselineMain(
    ["--dry-run", "--output", "D:/evidence/unsafe.json", "--vehicle-id", VEHICLE],
    harness.deps
  );
  assert.equal(code, 3);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.stdout[0].includes("VEHICLE_NOT_ELIGIBLE"), true);
  assert.equal(harness.stdout[0].includes(VEHICLE), false);
});

test("baseline never falls back to DATABASE_URL and disconnects on partial connect, execution, write, and SIGINT paths", async () => {
  const missing = createBaselineHarness({ env: { DATABASE_URL: SOURCE_URL } });
  assert.equal(
    await baselineMain(
      ["--dry-run", "--output", "D:/evidence/x.json", "--vehicle-id", VEHICLE],
      missing.deps
    ),
    2
  );
  assert.equal(missing.clients.length, 0);

  for (const scenario of ["target-connect", "execute", "gate", "write", "sigint"]) {
    const harness = createBaselineHarness({ scenario });
    const code = await baselineMain(
      ["--dry-run", "--output", "D:/evidence/x.json", "--vehicle-id", VEHICLE],
      harness.deps
    );
    assert.equal(code, scenario === "write" ? 5 : scenario === "gate" ? 3 : 4, scenario);
    assert.equal(
      harness.clients.every((client) => client.disconnects === 1),
      true,
      scenario
    );
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
    selection: { adminDigest: SHA, customerDigest: SHA, vehicleDigests: [SHA, "b".repeat(64)] },
    source: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA },
    target: { databaseDigest: SHA, migrationCatalogDigest: SHA, schemaDigest: SHA }
  };
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

function invalidApprovedReports(manifest) {
  const wrapper = {
    manifest,
    manifestSha256: SHA,
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: approvedTargetCountEvidence()
  };
  const missingMode = structuredClone(wrapper);
  delete missingMode.mode;
  const missingOperation = structuredClone(wrapper);
  delete missingOperation.operation;
  const missingTableCounts = structuredClone(wrapper);
  delete missingTableCounts.targetCountEvidence.tableCounts;
  return [
    ["missing-mode", missingMode],
    ["wrong-mode", { ...structuredClone(wrapper), mode: "apply" }],
    ["missing-operation", missingOperation],
    ["wrong-operation", { ...structuredClone(wrapper), operation: "OTHER" }],
    [
      "incomplete-manifest",
      { ...structuredClone(wrapper), manifest: { safeToApply: true, exceptions: [] } }
    ],
    [
      "arbitrary-count-keys",
      {
        ...structuredClone(wrapper),
        targetCountEvidence: {
          forbiddenCountKeys: ["arbitraryForbidden"],
          forbiddenCounts: { arbitraryForbidden: 0 },
          tableCountKeys: ["arbitraryTable"],
          tableCounts: { arbitraryTable: 0 }
        }
      }
    ],
    [
      "replaced-table-key",
      {
        ...structuredClone(wrapper),
        targetCountEvidence: {
          ...approvedTargetCountEvidence(),
          tableCountKeys: ["replacementTable", ...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES.slice(1)],
          tableCounts: {
            replacementTable: 0,
            ...Object.fromEntries(
              STAGE1_ACCEPTANCE_WHITELIST_DELEGATES.slice(1).map((key) => [key, 0])
            )
          }
        }
      }
    ],
    ["missing-table-counts", missingTableCounts],
    [
      "nonzero-table-count",
      {
        ...structuredClone(wrapper),
        targetCountEvidence: {
          ...approvedTargetCountEvidence(),
          tableCounts: {
            ...approvedTargetCountEvidence().tableCounts,
            [STAGE1_ACCEPTANCE_WHITELIST_DELEGATES[0]]: 1
          }
        }
      }
    ]
  ];
}

function hostEvidenceSecurity(parent, intent) {
  if (process.platform === "win32") {
    return { intent, platform: "win32", verifyWindowsAcl: windowsAcl(parent, true, path.win32) };
  }
  const canonicalParent = resolve(parent);
  return {
    fsSync: {
      existsSync: hostFsSync.existsSync,
      lstatSync(candidate) {
        const stat = hostFsSync.lstatSync(candidate);
        if (resolve(candidate) !== canonicalParent) return stat;
        return {
          ...stat,
          uid: 0,
          mode: (stat.mode & ~0o777) | 0o700,
          isDirectory: () => stat.isDirectory(),
          isFile: () => stat.isFile(),
          isSymbolicLink: () => stat.isSymbolicLink()
        };
      },
      realpathSync: hostFsSync.realpathSync
    },
    intent,
    pathApi: path,
    platform: process.platform
  };
}

function virtualWindowsFs() {
  const entries = new Map();
  const add = (entryPath, kind, realpath = entryPath) => {
    const canonicalPath = path.win32.normalize(entryPath);
    entries.set(canonicalPath.toLowerCase(), {
      canonicalPath,
      kind,
      realpath: path.win32.normalize(realpath)
    });
  };
  add("C:\\acceptance\\repo", "directory");
  add("C:\\acceptance\\repo-evidence", "directory");
  add("C:\\acceptance\\evidence-alias", "directory", "C:\\acceptance\\repo-evidence");
  add("C:\\acceptance\\evidence-junction", "junction", "C:\\acceptance\\repo-evidence");
  add("C:\\acceptance\\repo-evidence\\existing.json", "file");
  add(
    "C:\\acceptance\\repo-evidence\\linked.json",
    "symlink",
    "C:\\acceptance\\repo-evidence\\existing.json"
  );

  const entry = (candidate) => entries.get(path.win32.normalize(candidate).toLowerCase());
  return {
    existsSync: (candidate) => Boolean(entry(candidate)),
    lstatSync(candidate) {
      const value = entry(candidate);
      if (!value) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        mode: value.kind === "directory" ? 0o40700 : 0o100600,
        uid: 0,
        isDirectory: () => value.kind === "directory" || value.kind === "junction",
        isFile: () => value.kind === "file",
        isSymbolicLink: () => value.kind === "symlink" || value.kind === "junction"
      };
    },
    realpathSync(candidate) {
      const value = entry(candidate);
      if (!value) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return value.realpath;
    }
  };
}

function virtualPosixDirectoryFs(parent, uid, mode) {
  return {
    existsSync: (candidate) => path.posix.normalize(candidate) === parent,
    lstatSync(candidate) {
      if (path.posix.normalize(candidate) !== parent)
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        mode,
        uid,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false
      };
    },
    realpathSync: (candidate) => path.posix.normalize(candidate)
  };
}

function windowsAcl(canonicalPath, safe = true, pathApi = path) {
  return () => ({ canonicalPath: pathApi.resolve(canonicalPath), safe });
}

function createBaselineHarness({
  approved = approvedManifest(),
  approvedReport,
  candidates = [],
  canonicalManifestSha = SHA,
  env = BASE_ENV,
  scenario
} = {}) {
  const clients = [];
  const executeCalls = [];
  const reports = [];
  const stdout = [];
  const stderr = [];
  let signalHandler;
  const deps = {
    assertEvidencePath: (path) => resolve(path),
    createPrismaClient: async (_url, label) => {
      if (scenario === "target-connect" && label === "target")
        throw new Error("connection contains secret");
      const client = {
        disconnects: 0,
        async $disconnect() {
          this.disconnects += 1;
        },
        async $transaction(callback) {
          return callback({
            $queryRaw: async () => [],
            vehicle: { findMany: async () => candidates }
          });
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
      if (scenario === "unsafe")
        return {
          manifest: {
            exceptions: [{ code: "VEHICLE_NOT_ELIGIBLE" }],
            generatedAt: options.generatedAt,
            hashSalt: options.hashSalt
          },
          manifestSha256: SHA,
          mode: "dry-run",
          safe: false
        };
      return options.mode === "dry-run"
        ? {
            manifest: {
              generatedAt: options.generatedAt,
              hashSalt: options.hashSalt,
              rowDigests: { access: "x" }
            },
            manifestSha256: SHA,
            mode: "dry-run",
            safe: true
          }
        : {
            auditCreated: options.mode === "replay" ? 0 : 1,
            deleted: 0,
            inserted: options.mode === "replay" ? 0 : 5,
            manifestSha256: SHA,
            mode: options.mode,
            safe: true,
            updated: 0
          };
    },
    hashManifest: () => canonicalManifestSha,
    installSignalHandler: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    now: () => new Date("2026-08-30T12:34:56.000Z"),
    randomBytes: () => Buffer.alloc(32, 0x11),
    readTextFile: async () =>
      JSON.stringify(
        approvedReport ?? {
          manifest: approved,
          manifestSha256: SHA,
          mode: "dry-run",
          operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
          safe: true,
          targetCountEvidence: approvedTargetCountEvidence()
        }
      ),
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
