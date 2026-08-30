import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  STAGE1_ACCEPTANCE_WHITELIST_DELEGATES
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";
import * as cliCore from "./stage1-clean-acceptance-cli-core.mjs";
import * as governance from "./stage1-task9-preflight-governance.mjs";

const { buildTask9ApprovalSummary, validateTask9DatabasePair, validateTask9DiscoverySelection } =
  governance;

const source =
  "postgresql://subscription_saas:secret@postgres:5432/subscription_saas_staging?schema=public";
const target =
  "postgresql://subscription_saas:secret@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z?schema=public";
const vehicleId = "123e4567-e89b-42d3-a456-426614174000";

test("validates the exact source/target pair without exposing malformed credential URLs", () => {
  assert.deepEqual(
    validateTask9DatabasePair(
      source,
      target,
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120000z"
    ),
    {
      code: "OK"
    }
  );
  const rejected = validateTask9DatabasePair(
    "postgresql://user:credential-leak@%",
    target,
    "postgres",
    "subscription_saas",
    "subscription_saas_staging_acceptance_20260830t120000z"
  );
  assert.notEqual(rejected.code, "OK");
  assert.doesNotMatch(JSON.stringify(rejected), /credential-leak/);
  assert.equal(
    validateTask9DatabasePair(
      source,
      target,
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120001z"
    ).code,
    "TARGET_DATABASE_INVALID"
  );
  assert.equal(
    validateTask9DatabasePair(
      source.replace("/subscription_saas_staging?", "/not_the_source?"),
      target,
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120000z"
    ).code,
    "SOURCE_DATABASE_INVALID"
  );
  assert.equal(
    validateTask9DatabasePair(
      source,
      target.replace("schema=public", "schema=other"),
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120000z"
    ).code,
    "DATABASE_URL_SEMANTICS_INVALID"
  );
});

test("requires one UUID candidate", () => {
  assert.deepEqual(
    validateTask9DiscoverySelection({ candidates: [{ id: vehicleId }] }, vehicleId),
    {
      code: "OK"
    }
  );
  assert.equal(
    validateTask9DiscoverySelection({ candidates: [] }, vehicleId).code,
    "VEHICLE_SELECTION_INVALID"
  );
});

test("Task 9 resource gates accept exact boundaries and fail closed one unit below or malformed", () => {
  assert.deepEqual(governance.validateTask9DiskAvailableKb("10485760"), {
    availableKb: 10485760,
    code: "OK"
  });
  assert.equal(governance.validateTask9DiskAvailableKb("10485759").code, "DISK_HEADROOM_LOW");
  assert.equal(governance.validateTask9DiskAvailableKb("10GiB").code, "DISK_STATE_INVALID");

  assert.deepEqual(governance.validateTask9ApiMemoryState("402653184B / 536870912B"), {
    code: "OK",
    headroomBytes: 134217728,
    limitBytes: 536870912,
    usageBytes: 402653184
  });
  assert.equal(
    governance.validateTask9ApiMemoryState("402653185B / 536870912B").code,
    "API_MEMORY_HEADROOM_LOW"
  );
  assert.equal(
    governance.validateTask9ApiMemoryState("384MiB / unlimited").code,
    "API_MEMORY_STATE_INVALID"
  );

  assert.deepEqual(governance.validateTask9PostgresConnectionState("20|30"), {
    activeConnections: 20,
    code: "OK",
    headroomConnections: 10,
    maxConnections: 30
  });
  assert.equal(
    governance.validateTask9PostgresConnectionState("21|30").code,
    "POSTGRES_CONNECTION_HEADROOM_LOW"
  );
  assert.equal(
    governance.validateTask9PostgresConnectionState("twenty|30").code,
    "POSTGRES_CONNECTION_STATE_INVALID"
  );
});

test("validate-selection reads the hidden UUID only from the environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "task9-selection-env-"));
  const reportPath = join(directory, "discovery.json");
  const scriptPath = fileURLToPath(
    new URL("./stage1-task9-preflight-governance.mjs", import.meta.url)
  );
  writeFileSync(reportPath, JSON.stringify({ candidates: [{ id: vehicleId }] }), "utf8");
  try {
    const accepted = spawnSync(process.execPath, [scriptPath, "validate-selection", reportPath], {
      encoding: "utf8",
      env: { ...process.env, APPROVED_VEHICLE_UUID: vehicleId }
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const rejected = spawnSync(process.execPath, [scriptPath, "validate-selection", reportPath], {
      encoding: "utf8",
      env: { ...process.env, APPROVED_VEHICLE_UUID: "223e4567-e89b-42d3-a456-426614174000" }
    });
    assert.equal(rejected.status, 1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("approval summary and common reader accept the same exact canonical wrapper", () => {
  const report = validApprovedReport();
  const summary = buildTask9ApprovalSummary(report);
  assert.equal(summary.safe, true);
  assert.equal(summary.exceptionsCount, 0);
  const validated = cliCore.validateApprovedStage1AcceptanceWrapper(
    report,
    report.manifestSha256,
    hashStage1CleanAcceptanceManifest
  );
  assert.deepEqual(validated.manifest, report.manifest);
  assert.deepEqual(
    cliCore.readApprovedStage1AcceptanceManifest(
      JSON.stringify(report),
      report.manifestSha256,
      hashStage1CleanAcceptanceManifest
    ),
    report.manifest
  );
});

test("approval summary rejects every wrapper shape Task 10 rejects", () => {
  const valid = validApprovedReport();
  const mutations = [
    ({ mode: _ignored, ...report }) => report,
    (report) => ({ ...report, mode: "apply" }),
    ({ operation: _ignored, ...report }) => report,
    (report) => ({ ...report, operation: "OTHER_OPERATION" }),
    (report) => ({ ...report, manifest: { safeToApply: true, exceptions: [] } }),
    (report) => ({
      ...report,
      targetCountEvidence: {
        ...report.targetCountEvidence,
        forbiddenCountKeys: report.targetCountEvidence.forbiddenCountKeys.slice(1)
      }
    }),
    (report) => ({
      ...report,
      targetCountEvidence: {
        ...report.targetCountEvidence,
        tableCountKeys: ["replacement", ...report.targetCountEvidence.tableCountKeys.slice(1)],
        tableCounts: {
          replacement: 0,
          ...Object.fromEntries(Object.entries(report.targetCountEvidence.tableCounts).slice(1))
        }
      }
    }),
    (report) => ({
      ...report,
      targetCountEvidence: {
        ...report.targetCountEvidence,
        tableCounts: {
          ...report.targetCountEvidence.tableCounts,
          [report.targetCountEvidence.tableCountKeys[0]]: 1
        }
      }
    })
  ];
  for (const mutate of mutations) {
    const report = mutate(structuredClone(valid));
    const summary = buildTask9ApprovalSummary(report);
    assert.equal(summary.safe, undefined);
    assert.equal(typeof summary.code, "string");
    assert.throws(() =>
      cliCore.validateApprovedStage1AcceptanceWrapper(
        report,
        report.manifestSha256,
        hashStage1CleanAcceptanceManifest
      )
    );
  }
});

test("keeps Task 9 dry-run target-count evidence compatible with the approved-manifest reader", () => {
  const manifest = validManifest();
  const hash = hashStage1CleanAcceptanceManifest(manifest);
  const report = {
    manifest,
    manifestSha256: hash,
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: {
      forbiddenCountKeys: Object.keys(expectedForbiddenCounts()),
      forbiddenCounts: expectedForbiddenCounts(),
      tableCountKeys: [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES],
      tableCounts: expectedTableCounts()
    }
  };
  assert.deepEqual(
    cliCore.readApprovedStage1AcceptanceManifest(
      JSON.stringify(report),
      hash,
      hashStage1CleanAcceptanceManifest
    ),
    manifest
  );
});

test("rejects malformed or nonzero approved target-count evidence", () => {
  const manifest = validManifest();
  const hash = hashStage1CleanAcceptanceManifest(manifest);
  const valid = {
    forbiddenCountKeys: Object.keys(expectedForbiddenCounts()),
    forbiddenCounts: expectedForbiddenCounts(),
    tableCountKeys: [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES],
    tableCounts: expectedTableCounts()
  };
  for (const evidence of [
    { ...valid, forbiddenCountKeys: [...valid.forbiddenCountKeys, valid.forbiddenCountKeys[0]] },
    {
      ...valid,
      forbiddenCountKeys: valid.forbiddenCountKeys.slice(1),
      forbiddenCounts: Object.fromEntries(Object.entries(valid.forbiddenCounts).slice(1))
    },
    {
      ...valid,
      forbiddenCountKeys: ["replacementForbidden", ...valid.forbiddenCountKeys.slice(1)],
      forbiddenCounts: {
        replacementForbidden: 0,
        ...Object.fromEntries(Object.entries(valid.forbiddenCounts).slice(1))
      }
    },
    { ...valid, forbiddenCounts: { ...valid.forbiddenCounts, extra: 0 } },
    {
      ...valid,
      tableCountKeys: valid.tableCountKeys.slice(1),
      tableCounts: Object.fromEntries(Object.entries(valid.tableCounts).slice(1))
    },
    {
      ...valid,
      tableCountKeys: ["replacementTable", ...valid.tableCountKeys.slice(1)],
      tableCounts: {
        replacementTable: 0,
        ...Object.fromEntries(Object.entries(valid.tableCounts).slice(1))
      }
    },
    { ...valid, tableCounts: [] },
    {
      ...valid,
      tableCounts: { ...valid.tableCounts, [valid.tableCountKeys[0]]: 0.5 }
    },
    { ...valid, tableCounts: { ...valid.tableCounts, [valid.tableCountKeys[0]]: 1 } }
  ]) {
    assert.throws(() =>
      cliCore.readApprovedStage1AcceptanceManifest(
        JSON.stringify({
          manifest,
          manifestSha256: hash,
          mode: "dry-run",
          operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
          safe: true,
          targetCountEvidence: evidence
        }),
        hash,
        hashStage1CleanAcceptanceManifest
      )
    );
  }
});

test("rejects self-consistent arbitrary approved target-count key universes", () => {
  const manifest = validManifest();
  const hash = hashStage1CleanAcceptanceManifest(manifest);
  const arbitraryEvidence = {
    forbiddenCountKeys: ["arbitraryForbiddenDomain"],
    forbiddenCounts: { arbitraryForbiddenDomain: 0 },
    tableCountKeys: ["arbitraryTable"],
    tableCounts: { arbitraryTable: 0 }
  };
  assert.throws(() =>
    cliCore.readApprovedStage1AcceptanceManifest(
      JSON.stringify({
        manifest,
        manifestSha256: hash,
        mode: "dry-run",
        operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
        safe: true,
        targetCountEvidence: arbitraryEvidence
      }),
      hash,
      hashStage1CleanAcceptanceManifest
    )
  );
});

function expectedForbiddenCounts() {
  return Object.fromEntries(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.map((key) => [key, 0]));
}

function expectedTableCounts() {
  return Object.fromEntries(STAGE1_ACCEPTANCE_WHITELIST_DELEGATES.map((key) => [key, 0]));
}

function validApprovedReport() {
  const manifest = validManifest();
  return {
    manifest,
    manifestSha256: hashStage1CleanAcceptanceManifest(manifest),
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: {
      forbiddenCountKeys: [...STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES],
      forbiddenCounts: expectedForbiddenCounts(),
      tableCountKeys: [...STAGE1_ACCEPTANCE_WHITELIST_DELEGATES],
      tableCounts: expectedTableCounts()
    }
  };
}

function validManifest() {
  return {
    schemaVersion: 1,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    gitSha: "b".repeat(40),
    imageRef: `registry.test/api@sha256:${"a".repeat(64)}`,
    source: digestContext(),
    target: digestContext(),
    selection: {
      adminDigest: "c".repeat(64),
      customerDigest: "d".repeat(64),
      vehicleDigests: ["e".repeat(64)]
    },
    counts: domains(0),
    rowDigests: domains("f".repeat(64)),
    exceptions: [],
    safeToApply: true,
    generatedAt: "2026-08-30T12:00:00.000Z",
    hashSalt: "f".repeat(64)
  };
}
function digestContext() {
  return {
    databaseDigest: "a".repeat(64),
    migrationCatalogDigest: "b".repeat(64),
    schemaDigest: "c".repeat(64)
  };
}
function domains(value) {
  return Object.fromEntries(
    ["access", "catalog", "customer", "templates", "vehicle"].map((key) => [key, value])
  );
}
