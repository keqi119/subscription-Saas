import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exportSanitizedSnapshot,
  transformRecord,
  verifySnapshotMetadata
} from "../src/snapshot/export-sanitized.mjs";
import { scanSanitizedArtifact } from "../src/snapshot/scan-artifact.mjs";
import { canonicalJson, sha256Bytes, sha256Canonical } from "../src/index.mjs";
import {
  cleanupProtectedSnapshotWorkspace,
  runProtectedSnapshotExport
} from "../../../scripts/release/export-sanitized-snapshot.mjs";

// @database-test: classified as a protected-boundary contract test; adapters are injected doubles.

const digest = (character) => `sha256:${character.repeat(64)}`;
const fixedNow = new Date("2026-09-02T08:00:00.000Z");

function contract() {
  return {
    schemaVersion: "sanitization-contract.v1",
    contractId: "stage1-staging-snapshot",
    contractVersion: "1",
    source: {
      allowedEnvironment: "staging",
      keyTables: ["public.application", "public.customer"],
      knownMigrationHeads: ["20260901010000_stage1_schema_drift_convergence"]
    },
    transformations: [
      {
        table: "public.customer",
        column: "mobile",
        method: "deterministic-token",
        keyReference: "secret://stage1-snapshot-export/tokenization-key"
      },
      {
        table: "public.customer_identity",
        column: "id_card_no",
        method: "deterministic-token",
        keyReference: "secret://stage1-snapshot-export/tokenization-key"
      },
      {
        table: "public.user",
        column: "password_hash",
        method: "fixed-disabled-value",
        fixedValue: "disabled-for-snapshot"
      }
    ],
    scanRules: [
      "china-mobile",
      "china-id-card",
      "credential-url",
      "bearer-token",
      "private-key",
      "provider-token"
    ],
    tools: { exporterVersion: "snapshot-export/1", scannerVersion: "snapshot-scan/1" },
    lifecycle: {
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      reviewAfterDays: 30,
      expiresAfterDays: 30,
      accessPolicyRef: "policy://stage1-sanitized-snapshot"
    }
  };
}

function ownershipMap() {
  return {
    schemaVersion: "ownership-map.v1",
    mapId: "stage1-snapshot-owner-map",
    mapVersion: "1",
    sourceOwners: ["subscription", "subscription_saas"],
    targetOwnerProfile: "migrate",
    schemas: ["public"],
    objectClasses: ["schema", "table"],
    excludedExtensions: ["pgcrypto"]
  };
}

test("applies deterministic field transformations without retaining source values", () => {
  const policy = contract();
  const first = transformRecord(
    { mobile: "18616570212", name: "Alice" },
    {
      table: "public.customer",
      contract: policy,
      tokenizationKey: Buffer.from("unit-test-key")
    }
  );
  const second = transformRecord(
    { mobile: "18616570212", name: "Bob" },
    {
      table: "public.customer",
      contract: policy,
      tokenizationKey: Buffer.from("unit-test-key")
    }
  );
  assert.equal(first.mobile, second.mobile);
  assert.notEqual(first.mobile, "18616570212");
  assert.equal(first.name, "Alice");
});

for (const [name, value] of [
  ["phone", "18616570212"],
  ["identity", "310101199001011234"],
  ["credential URL", "postgres://admin:secret@database.example/staging"],
  ["bearer", "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"],
  ["provider token", "ghp_1234567890abcdefghijklmnop"],
  ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"]
]) {
  test(`rejects sanitized artifact containing ${name}`, async () => {
    await assert.rejects(
      () =>
        scanSanitizedArtifact({ bytes: Buffer.from(`COPY data ${value}`), contract: contract() }),
      { code: "SNAPSHOT_SENSITIVE_DATA_DETECTED" }
    );
  });
}

function exportFixture(overrides = {}) {
  const policy = contract();
  const ownerPolicy = ownershipMap();
  const raw = Buffer.from("raw-staging-dump");
  const sanitized = Buffer.from("sanitized fixture without customer values");
  let fingerprintCalls = 0;
  const uploads = [];
  const events = [];
  const source = {
    trustPolicy: "protected-snapshot-source/v1",
    async observePrivileges() {
      return {
        roleIdentityFingerprint: digest("1"),
        databaseIdentityFingerprint: digest("2"),
        superuser: false,
        createDatabase: false,
        createRole: false,
        bypassRls: false,
        schemaOwner: false,
        canCreateSchema: false,
        tableWritePrivileges: [],
        tableTruncatePrivileges: [],
        writableFunctionExecutePrivileges: [],
        objectOwners: ["subscription"]
      };
    },
    async openReadOnlySnapshot() {
      events.push("snapshot-opened");
      return {
        snapshotId: "00000003-0000001A-1",
        isolationLevel: "REPEATABLE READ",
        readOnly: true,
        deferrable: true
      };
    },
    async readFingerprint() {
      fingerprintCalls += 1;
      return {
        migrationHead: "20260901010000_stage1_schema_drift_convergence",
        databaseIdentityFingerprint: digest("2"),
        roleIdentityFingerprint: digest("1"),
        tables: [
          { table: "public.application", rowCount: 1, checksum: digest("3") },
          { table: "public.customer", rowCount: 2, checksum: digest("4") }
        ]
      };
    },
    async exportRaw() {
      events.push("raw-exported");
      return raw;
    },
    async closeSnapshot() {
      events.push("snapshot-closed");
    }
  };
  const workspace = {
    trustPolicy: "isolated-sanitization-workspace/v1",
    async restoreRaw(input) {
      assert.deepEqual(input, raw);
      events.push("raw-restored");
    },
    async applyTransformations() {
      events.push("transformed");
    },
    async exportSanitized() {
      events.push("sanitized-exported");
      return sanitized;
    },
    async destroy() {
      events.push("workspace-destroyed");
    }
  };
  const publisher = {
    trustPolicy: "snapshot-final-bundle/v1",
    async publishFinalBundle(bundle) {
      uploads.push(bundle);
      const bundleDigest = sha256Canonical({
        dumpDigest: sha256Bytes(bundle.dump),
        metadataDigest: sha256Canonical(bundle.metadata),
        privilegeObservationDigest: sha256Canonical(bundle.privilegeObservation),
        fingerprintObservationDigest: sha256Canonical(bundle.fingerprintObservation),
        scanDigest: sha256Canonical(bundle.scan)
      });
      return {
        schemaVersion: "custody-receipt.v1",
        receiptId: "ea4d51a1-4e63-491a-80ca-fc478b2fd53f",
        contentDigest: bundleDigest,
        contentSizeBytes: 1,
        storeRef: "artifact://release/sanitized-snapshot",
        uploadedAt: fixedNow.toISOString(),
        readbackAt: fixedNow.toISOString(),
        readbackDigest: bundleDigest,
        owner: policy.lifecycle.owner,
        readers: policy.lifecycle.readers,
        retainUntil: "2027-03-01T08:00:00.000Z",
        expiryDisposition: "review",
        attestationRef: "attestation://release/sanitized-snapshot"
      };
    }
  };
  return {
    contract: policy,
    ownershipMap: ownerPolicy,
    source,
    workspace,
    publisher,
    secretReference: "secret://stage1-snapshot-export/source",
    tokenizationSecretReference: "secret://stage1-snapshot-export/tokenization-key",
    now: () => fixedNow,
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/1",
    uploads,
    events,
    fingerprintCalls: () => fingerprintCalls,
    ...overrides
  };
}

function runExport(input) {
  const { uploads, events, fingerprintCalls, ...operation } = input;
  return exportSanitizedSnapshot(operation);
}

test("exports only a scanned final bundle after matching source fingerprints", async () => {
  const input = exportFixture();
  const metadata = await runExport(input);
  assert.equal(metadata.schemaVersion, "snapshot-metadata.v1");
  assert.equal(input.fingerprintCalls(), 2);
  assert.equal(input.uploads.length, 1);
  assert.equal(metadata.dumpDigest, sha256Bytes(input.uploads[0].dump));
  assert.deepEqual(input.events.slice(-2), ["snapshot-closed", "workspace-destroyed"]);
});

test("source fingerprint drift prevents all publication", async () => {
  const input = exportFixture();
  const readFingerprint = input.source.readFingerprint;
  input.source.readFingerprint = async (...args) => {
    const result = await readFingerprint(...args);
    return input.fingerprintCalls() === 2
      ? { ...result, tables: [{ ...result.tables[0], rowCount: 99 }, result.tables[1]] }
      : result;
  };
  await assert.rejects(() => runExport(input), {
    code: "SNAPSHOT_SOURCE_FINGERPRINT_CHANGED"
  });
  assert.equal(input.uploads.length, 0);
  assert.equal(input.events.includes("workspace-destroyed"), true);
});

for (const fault of ["restoreRaw", "applyTransformations", "exportSanitized"]) {
  test(`fault during ${fault} uploads no raw or partial artifact`, async () => {
    const input = exportFixture();
    input.workspace[fault] = async () => {
      throw new Error(`fault-${fault}`);
    };
    await assert.rejects(() => runExport(input), {
      code: "SNAPSHOT_PUBLICATION_INCOMPLETE_FORBIDDEN"
    });
    assert.equal(input.uploads.length, 0);
    assert.equal(input.events.includes("workspace-destroyed"), true);
  });
}

test("cleanup failure prevents final publication", async () => {
  const input = exportFixture();
  input.workspace.destroy = async () => {
    throw new Error("fault-destroy");
  };
  await assert.rejects(() => runExport(input), {
    code: "SNAPSHOT_SECURE_CLEANUP_FAILED"
  });
  assert.equal(input.uploads.length, 0);
});

test("metadata verification rejects expiry, contract drift, unknown head, and dump drift", async () => {
  const input = exportFixture();
  const metadata = await runExport(input);
  const bundle = input.uploads[0];
  for (const [name, overrides, expected] of [
    ["expired", { now: new Date("2026-10-03T08:00:00.000Z") }, "SNAPSHOT_EXPIRED"],
    [
      "contract",
      { contract: { ...input.contract, contractVersion: "2" } },
      "SNAPSHOT_CONTRACT_DRIFT"
    ],
    [
      "migration",
      { knownMigrationHeads: ["20260101000000_unknown"] },
      "SNAPSHOT_MIGRATION_HEAD_UNKNOWN"
    ],
    ["dump", { dump: Buffer.from("changed") }, "SNAPSHOT_DUMP_DIGEST_MISMATCH"]
  ]) {
    assert.throws(
      () =>
        verifySnapshotMetadata({
          metadata,
          contract: input.contract,
          ownershipMap: input.ownershipMap,
          dump: bundle.dump,
          scan: bundle.scan,
          knownMigrationHeads: input.contract.source.knownMigrationHeads,
          now: fixedNow,
          ...overrides
        }),
      { code: expected },
      name
    );
  }
});

test("protected entrypoint accepts only secret references and a complete publication", async () => {
  const input = exportFixture();
  const request = {
    environmentClass: "staging",
    sourceSecretReference: "secret://stage1-snapshot-export/source",
    tokenizationSecretReference: "secret://stage1-snapshot-export/tokenization-key",
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/1"
  };
  const adapters = {
    trustPolicy: "protected-snapshot-adapters/v1",
    source: input.source,
    workspace: input.workspace,
    publisher: input.publisher,
    async assertFinalPublication({ allowedFileNames, metadata }) {
      assert.equal(metadata.schemaVersion, "snapshot-metadata.v1");
      return { complete: true, fileNames: [...allowedFileNames].reverse() };
    }
  };
  const metadata = await runProtectedSnapshotExport({
    request,
    contract: input.contract,
    ownershipMap: input.ownershipMap,
    adapters,
    now: input.now
  });
  assert.equal(metadata.schemaVersion, "snapshot-metadata.v1");
  await assert.rejects(
    () =>
      runProtectedSnapshotExport({
        request: { ...request, databaseUrl: "postgres://writer:secret@staging/data" },
        contract: input.contract,
        ownershipMap: input.ownershipMap,
        adapters,
        now: input.now
      }),
    { code: "SNAPSHOT_EXPORT_REQUEST_INVALID" }
  );
});

test("protected workflow exposes no PR trigger or raw artifact upload", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/sanitized-snapshot.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /environment: stage1-snapshot-export/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, stage1-snapshot-export\]/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /node scripts\/release\/export-sanitized-snapshot\.mjs --cleanup/);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(workflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.doesNotMatch(workflow, /uses:\s*[^\s]+@(v\d+|main|master|latest)\b/);
  assert.equal(/pull_request:/.test(workflow), false);
  const uploadBlock = workflow.slice(
    workflow.indexOf("Upload only the complete final publication")
  );
  assert.equal(/raw|partial/i.test(uploadBlock), false);
});

test("repository sanitization contract targets current tables and migration head", async () => {
  const [policy, prismaSchema, migrationEntries] = await Promise.all([
    readFile(
      new URL("../../../release/contracts/sanitization-contract.v1.json", import.meta.url),
      "utf8"
    ).then(JSON.parse),
    readFile(new URL("../../../apps/api/prisma/schema.prisma", import.meta.url), "utf8"),
    readdir(new URL("../../../apps/api/prisma/migrations/", import.meta.url), {
      withFileTypes: true
    })
  ]);
  const migrationHead = migrationEntries
    .filter((entry) => entry.isDirectory() && /^[0-9]{14}_[a-z0-9_]+$/.test(entry.name))
    .map(({ name }) => name)
    .sort()
    .at(-1);
  assert.deepEqual(policy.source.knownMigrationHeads, [migrationHead]);
  const mappedTables = new Set(
    [...prismaSchema.matchAll(/@@map\("([a-z][a-z0-9_]*)"\)/g)].map((match) => `public.${match[1]}`)
  );
  for (const table of new Set([
    ...policy.source.keyTables,
    ...policy.transformations.map(({ table }) => table)
  ])) {
    assert.equal(mappedTables.has(table), true, table);
  }
});

test("cleanup removes only exact snapshot paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "snapshot-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo");
  const runnerTemp = path.join(root, "runner-temp");
  const inputFile = path.join(repoRoot, ".release-inputs", "snapshot-export-request.v1.json");
  const publication = path.join(repoRoot, ".release-output", "sanitized-snapshot");
  const sibling = path.join(repoRoot, ".release-output", "another-operation", "proof.json");
  const rawWorkspace = path.join(runnerTemp, "stage1-snapshot-export");
  await Promise.all([
    mkdir(path.dirname(inputFile), { recursive: true }),
    mkdir(publication, { recursive: true }),
    mkdir(path.dirname(sibling), { recursive: true }),
    mkdir(rawWorkspace, { recursive: true })
  ]);
  await Promise.all([
    writeFile(inputFile, "request"),
    writeFile(path.join(publication, "snapshot.dump"), "snapshot"),
    writeFile(sibling, "keep"),
    writeFile(path.join(rawWorkspace, "raw.dump"), "raw")
  ]);
  await cleanupProtectedSnapshotWorkspace({ repoRoot, runnerTemp });
  await assert.rejects(() => stat(inputFile), { code: "ENOENT" });
  await assert.rejects(() => stat(publication), { code: "ENOENT" });
  await assert.rejects(() => stat(rawWorkspace), { code: "ENOENT" });
  assert.equal(await readFile(sibling, "utf8"), "keep");
});
