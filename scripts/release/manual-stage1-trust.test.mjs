import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import {
  encodeManualJson,
  computeMigrationCatalog,
  computeRepositoryContract,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { produceManualBuildCustody } from "./manual-build-custody-producer.mjs";
import { assessR3WorkspaceObservation } from "../../packages/release-foundation/src/r3-workspace-observation.mjs";
import { signR3WorkspaceBinding } from "../../packages/release-foundation/src/r3-workspace-report.mjs";

// The first RED is an assertion, not an import crash. Subsequent assertions
// exercise the production entrypoint; there is no trusted-result mock.
const trust = await import("./manual-stage1-trust.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/manual-stage1-trust.mjs"))
    return null;
  throw error;
});
const machineId = "0123456789abcdef0123456789abcdef";
const profileName = "release/contracts/manual-stage1-profile.v2.json";
const bindingName = "release/contracts/manual-stage1-owner-binding.v1.json";
const rootNames = ["key", "journal", "archive", "backup", "credential"];

async function fixture(t) {
  assert.equal(
    process.platform,
    "linux",
    "Synthetic native filesystem fixture runs on isolated Linux"
  );
  const root = await fs.mkdtemp(path.join(tmpdir(), "r13-trust-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("r13-trust-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(path.join(repoRoot, "release", "contracts"), { recursive: true });
  const storage = { keyRef: "owner.key", retentionDays: 90 };
  for (const name of rootNames) {
    storage[`${name}Root`] = path.join(root, name);
    await fs.mkdir(storage[`${name}Root`], { mode: 0o700 });
  }
  const keys = generateKeyPairSync("ed25519");
  const profile = {
    schemaVersion: "manual-stage1-profile.v2",
    profileId: randomUUID(),
    ownerId: "synthetic-owner",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    buildTrust: {
      repository: "keqi119/subscription-Saas",
      workflow: "keqi119/subscription-Saas/.github/workflows/docker-images.yml",
      sourceRef: "refs/heads/main",
      oidcIssuer: "https://token.actions.githubusercontent.com",
      runnerClass: "github-hosted"
    },
    allowedCommands: [
      { commandId: "db.migrate.deploy", commandVersion: "1", capability: "migrate" },
      { commandId: "db.schema.verify", commandVersion: "1", capability: "verify" }
    ],
    allowedTargets: [
      {
        endpointPolicyId: "synthetic-policy",
        endpoint: "db.invalid:5432",
        databaseName: "synthetic-db",
        purposes: ["synthetic-fresh"],
        roles: { observer: "observer", migrate: "migrate", verify: "verify" },
        tls: "required"
      }
    ],
    storage
  };
  const approval = {
    schemaVersion: "manual-stage1-owner-approval.v1",
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    principal: { platform: "posix", uid: process.getuid() },
    hostFingerprint: sha256Bytes(
      Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)
    ),
    approvedAt: "2026-09-01T00:00:00.000Z",
    promotionEligible: false
  };
  const approvalBytes = encodeManualJson(approval);
  const approvalDigest = sha256Bytes(approvalBytes);
  const binding = {
    ...approval,
    schemaVersion: "manual-stage1-owner-binding.v1",
    approvalDigest,
    approvalReference: `inputs/h1/${approvalDigest.slice(7)}.approval.json`
  };
  const approvalPath = path.join(storage.archiveRoot, binding.approvalReference);
  await fs.mkdir(path.dirname(approvalPath), { recursive: true, mode: 0o700 });
  const publish = (file, bytes) => fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  await publish(path.join(repoRoot, profileName), encodeManualJson(profile));
  await publish(path.join(repoRoot, bindingName), encodeManualJson(binding));
  await publish(approvalPath, approvalBytes);
  const machineFile = path.join(root, "synthetic-machine-id");
  await publish(machineFile, Buffer.from(`${machineId}\n`));
  const counters = { privateKeyReads: 0, writes: 0 };
  const nativeOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (file, flags, ...rest) => {
    if (String(file).startsWith(storage.keyRoot + path.sep)) counters.privateKeyReads++;
    if (String(flags) !== "r" && String(file).startsWith(root)) counters.writes++;
    return nativeOpen(file === "/etc/machine-id" ? machineFile : file, flags, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { root, repoRoot, profile, approval, binding, approvalPath, machineFile, counters, keys };
}

async function operationFixture(t) {
  const f = await fixture(t);
  const operationRef = randomUUID();
  // This reader only establishes raw source identity. Build schemas and trust
  // are exercised by the separate H2 verifier tests, not by an index's claims.
  const proofBytes = Buffer.from('{\n  "source": "synthetic-proof"\n}\n');
  const materialBytes = Buffer.from('{\n  "source": "synthetic-material"\n}\n');
  const operation = {
    schemaVersion: "manual-operation-input.v1",
    operationRef,
    runId: randomUUID(),
    createdAt: "2026-09-01T00:00:00.000Z",
    profileDigest: sha256Canonical(f.profile),
    buildProofDigest: sha256Canonical(JSON.parse(proofBytes)),
    proofRawDigest: sha256Bytes(proofBytes),
    materialRawDigest: sha256Bytes(materialBytes),
    custodyReceiptRawDigest: `sha256:${"a".repeat(64)}`,
    targetIntent: { endpointPolicyId: "synthetic-policy", databaseName: "synthetic-db" },
    purpose: "synthetic-fresh",
    scenario: "normal",
    operations: Object.fromEntries(
      ["observe", "migrate", "verify"].map((name) => [
        name,
        {
          operationId: randomUUID(),
          idempotencyKey: `manual-stage1:${operationRef}:${name}`
        }
      ])
    ),
    promotionEligible: false
  };
  const indexPath = path.join(
    f.profile.storage.archiveRoot,
    "inputs",
    "operations",
    operationRef,
    "index.json"
  );
  const buildRoot = path.join(f.profile.storage.archiveRoot, "inputs", "build");
  await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const proofPath = path.join(buildRoot, `${operation.proofRawDigest.slice(7)}.proof.json`);
  const materialPath = path.join(
    buildRoot,
    `${operation.materialRawDigest.slice(7)}.material.json`
  );
  for (const [file, bytes] of [
    [indexPath, encodeManualJson(operation)],
    [proofPath, proofBytes],
    [materialPath, materialBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return {
    ...f,
    operationRef,
    operation,
    indexPath,
    proofPath,
    materialPath,
    proofBytes,
    materialBytes
  };
}
function reader() {
  const api = production();
  assert.equal(
    typeof api.readFixedManualOperation,
    "function",
    "fixed operation reader must exist"
  );
  return api.readFixedManualOperation;
}

let publicKeyInputKeys;
async function publicKeyInputFixture(t, mutate = () => {}) {
  const f = await fixture(t);
  publicKeyInputKeys ??= generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
  const publicKeyPem = publicKeyInputKeys.publicKey.export({ type: "spki", format: "pem" });
  const keyFingerprint = sha256Bytes(
    publicKeyInputKeys.publicKey.export({ type: "spki", format: "der" })
  );
  const creation = {
    kind: "h1-snapshot-key-creation-readback",
    ownerId: f.profile.ownerId,
    principal: { ...f.approval.principal },
    hostFingerprint: f.approval.hostFingerprint,
    profileDigest: sha256Canonical(f.profile),
    createdAt: "2026-09-01T10:50:23.296Z",
    algorithm: "RSA-OAEP-SHA256",
    modulusLength: 3072,
    publicExponent: 65537,
    keyRef: "snapshot-rsa3072.pk8.der",
    keyFingerprint,
    publicKeyPem,
    softwareKeyExportable: true,
    challengeDomain: "subscription-saas/H1-snapshot-key-creation/v1",
    challengeDigest: `sha256:${"a".repeat(64)}`,
    wrappedChallengeDigest: `sha256:${"b".repeat(64)}`,
    roundtripVerified: true,
    promotionEligible: false
  };
  const recovery = {
    kind: "h1-snapshot-key-recovery-readback",
    verifiedAt: "2026-09-01T10:50:24.762Z",
    ownerId: creation.ownerId,
    hostFingerprint: creation.hostFingerprint,
    profileDigest: creation.profileDigest,
    keyFingerprint,
    creationReadbackRawDigest: "",
    publicKeyPem,
    primaryVolumeClosed: true,
    sameHostIndependentEncryptedVolumeRestore: true,
    offHostRecoveryVerified: false,
    challengeDomain: "subscription-saas/H1-snapshot-independent-recovery/v1",
    challengeDigest: `sha256:${"c".repeat(64)}`,
    wrappedChallengeDigest: `sha256:${"d".repeat(64)}`,
    roundtripVerified: true,
    promotionEligible: false
  };
  mutate({ creation, recovery });
  const creationRawBytes = Buffer.from(JSON.stringify(creation));
  recovery.creationReadbackRawDigest = sha256Bytes(creationRawBytes);
  const recoveryRawBytes = Buffer.from(JSON.stringify(recovery));
  const operationRef = randomUUID();
  const index = {
    schemaVersion: "h1-snapshot-key-input-index.v1",
    operationRef,
    profileDigest: sha256Canonical(f.profile),
    creationRawDigest: sha256Bytes(creationRawBytes),
    recoveryRawDigest: sha256Bytes(recoveryRawBytes)
  };
  const inputsRoot = path.join(f.profile.storage.archiveRoot, "inputs", "h1-snapshot-key");
  const indexPath = path.join(inputsRoot, operationRef, "index.json");
  const creationPath = path.join(
    inputsRoot,
    "raw",
    `${index.creationRawDigest.slice(7)}.creation.json`
  );
  const recoveryPath = path.join(
    inputsRoot,
    "raw",
    `${index.recoveryRawDigest.slice(7)}.recovery.json`
  );
  await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(creationPath), { recursive: true, mode: 0o700 });
  for (const [file, bytes] of [
    [indexPath, encodeManualJson(index)],
    [creationPath, creationRawBytes],
    [recoveryPath, recoveryRawBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const held = [];
  const fixtureOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await fixtureOpen(...args);
    if (String(args[0]).startsWith(inputsRoot + path.sep)) {
      const item = { file: String(args[0]), closed: false };
      held.push(item);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        try {
          return await close();
        } finally {
          item.closed = true;
        }
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  return {
    ...f,
    operationRef,
    index,
    indexPath,
    creationPath,
    recoveryPath,
    creationRawBytes,
    recoveryRawBytes,
    held
  };
}
function publicKeyInputReader() {
  const api = production();
  assert.equal(
    typeof api.readFixedH1SnapshotPublicKeyInputs,
    "function",
    "fixed public-key original reader must exist"
  );
  return api.readFixedH1SnapshotPublicKeyInputs;
}

test("H1 KEY INPUT preserves noncanonical originals, isolates raw copies and closes only its own handles", async (t) => {
  const f = await publicKeyInputFixture(t);
  const result = await publicKeyInputReader()({
    repoRoot: f.repoRoot,
    operationRef: f.operationRef
  });
  t.after(() => result.close());
  assert.deepEqual(Object.keys(result).sort(), [
    "close",
    "creation",
    "creationRawBytes",
    "recheck",
    "recovery",
    "recoveryRawBytes",
    "refs"
  ]);
  assert.deepEqual(result.creationRawBytes, f.creationRawBytes);
  assert.notEqual(sha256Bytes(result.creationRawBytes), sha256Canonical(result.creation));
  assert.ok(Object.isFrozen(result.creation.principal) && Object.isFrozen(result.refs));
  assert.equal(result.refs.creationRawDigest, f.index.creationRawDigest);
  assert.equal(result.refs.recoveryRawDigest, f.index.recoveryRawDigest);
  result.creationRawBytes.fill(0);
  await result.recheck();
  const other = await publicKeyInputReader()({
    repoRoot: f.repoRoot,
    operationRef: f.operationRef
  });
  t.after(() => other.close());
  assert.equal(f.held.filter((item) => !item.closed).length, 6);
  await result.close();
  await result.close();
  assert.equal(f.held.filter((item) => !item.closed).length, 3);
  assert.ok(result.recoveryRawBytes.every((byte) => byte === 0));
  await assert.rejects(result.recheck(), { code: "H1_SNAPSHOT_PUBLIC_INPUT_UNAVAILABLE" });
  await other.recheck();
  await other.close();
  assert.ok(f.held.every((item) => item.closed));
  noAuthorityAccess(f);
});

test("H1 KEY INPUT refuses noncanonical index, changed raw bytes and future readbacks without leaks", async (t) => {
  for (const mode of ["index", "raw", "future"]) {
    await t.test(mode, async (st) => {
      const f = await publicKeyInputFixture(st, ({ creation, recovery }) => {
        if (mode === "future") {
          creation.createdAt = new Date(Date.now() + 60000).toISOString();
          recovery.verifiedAt = new Date(Date.now() + 61000).toISOString();
        }
      });
      if (mode === "index") await fs.appendFile(f.indexPath, "\n");
      if (mode === "raw") await fs.appendFile(f.creationPath, " ");
      await assert.rejects(
        publicKeyInputReader()({ repoRoot: f.repoRoot, operationRef: f.operationRef }),
        { code: "H1_SNAPSHOT_PUBLIC_INPUT_UNAVAILABLE" }
      );
      assert.ok(f.held.every((item) => item.closed));
      noAuthorityAccess(f);
    });
  }
});

test("H1 KEY INPUT lifetime rechecks original bytes, host, owner binding and actual profile expiry", async (t) => {
  for (const mode of ["raw", "host", "owner-binding", "expiry"]) {
    await t.test(mode, async (st) => {
      const f = await publicKeyInputFixture(st);
      const result = await publicKeyInputReader()({
        repoRoot: f.repoRoot,
        operationRef: f.operationRef
      });
      st.after(() => result.close());
      if (mode === "raw") await fs.appendFile(f.recoveryPath, " ");
      if (mode === "host") await fs.writeFile(f.machineFile, `${"f".repeat(32)}\n`);
      if (mode === "owner-binding") {
        const approvedAt = "2026-09-02T00:00:00.000Z";
        const approvalBytes = encodeManualJson({ ...f.approval, approvedAt });
        const approvalDigest = sha256Bytes(approvalBytes);
        const changed = {
          ...f.binding,
          approvedAt,
          approvalDigest,
          approvalReference: `inputs/h1/${approvalDigest.slice(7)}.approval.json`
        };
        await fs.writeFile(
          path.join(f.profile.storage.archiveRoot, changed.approvalReference),
          approvalBytes,
          { flag: "wx", mode: 0o600 }
        );
        await fs.writeFile(path.join(f.repoRoot, bindingName), encodeManualJson(changed));
      }
      if (mode === "expiry") st.mock.method(Date, "now", () => Date.parse(f.profile.expiresAt));
      await assert.rejects(result.recheck(), { code: "H1_SNAPSHOT_PUBLIC_INPUT_UNAVAILABLE" });
      await result.close();
      assert.ok(f.held.every((item) => item.closed));
      noAuthorityAccess(f);
    });
  }
});

test("OP accepts the complete fixed index as nonauthorizing data and returns independent raw buffers", async (t) => {
  const f = await operationFixture(t);
  const result = await reader()({ repoRoot: f.repoRoot, operationRef: f.operationRef });
  assert.deepEqual(Object.keys(result).sort(), [
    "indexDigest",
    "materialBytes",
    "operation",
    "proofBytes"
  ]);
  assert.deepEqual(result.operation, f.operation);
  assert.equal(result.indexDigest, sha256Canonical(f.operation));
  assert.ok(Object.isFrozen(result.operation.operations.migrate));
  assert.ok(Object.isFrozen(result.operation.targetIntent));
  assert.deepEqual(result.proofBytes, f.proofBytes);
  assert.deepEqual(result.materialBytes, f.materialBytes);
  result.proofBytes.fill(0);
  result.materialBytes.fill(0);
  const again = await reader()({ repoRoot: f.repoRoot, operationRef: f.operationRef });
  assert.deepEqual(again.proofBytes, f.proofBytes);
  assert.deepEqual(again.materialBytes, f.materialBytes);
  noAuthorityAccess(f);
});

for (const ref of [
  "sha256:" + "a".repeat(64),
  "../other",
  "/tmp/index.json",
  "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF"
]) {
  test(`OP rejects non-UUID operationRef ${ref}`, async (t) => {
    const f = await operationFixture(t);
    await assert.rejects(reader()({ repoRoot: f.repoRoot, operationRef: ref }), {
      code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  });
}
for (const [name, mutate] of [
  ["missing index", async (f) => fs.unlink(f.indexPath)],
  ["noncanonical index", async (f) => fs.appendFile(f.indexPath, "\n")],
  ["invalid UTF-8", async (f) => fs.writeFile(f.indexPath, Buffer.from([0xff]))],
  ["oversize index", async (f) => fs.writeFile(f.indexPath, Buffer.alloc(1048577, 32))],
  [
    "future owner field",
    async (f) => {
      f.operation.ownerId = "forged-owner";
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "nested future approval",
    async (f) => {
      f.operation.operations.migrate.approved = true;
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "wrong operation identity",
    async (f) => {
      f.operation.operationRef = randomUUID();
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "wrong profile digest",
    async (f) => {
      f.operation.profileDigest = `sha256:${"b".repeat(64)}`;
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "wrong idempotency identity",
    async (f) => {
      f.operation.operations.migrate.idempotencyKey += ":alias";
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  ["raw proof change", async (f) => fs.appendFile(f.proofPath, " ")],
  ["raw material change", async (f) => fs.appendFile(f.materialPath, " ")],
  [
    "index symlink",
    async (f) => {
      await fs.rename(f.indexPath, `${f.indexPath}.original`);
      await fs.symlink(`${f.indexPath}.original`, f.indexPath);
    }
  ],
  [
    "proof symlink",
    async (f) => {
      await fs.rename(f.proofPath, `${f.proofPath}.original`);
      await fs.symlink(`${f.proofPath}.original`, f.proofPath);
    }
  ]
]) {
  test(`OP rejects ${name} without authority access`, async (t) => {
    const f = await operationFixture(t);
    await mutate(f);
    await assert.rejects(reader()({ repoRoot: f.repoRoot, operationRef: f.operationRef }), {
      code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  });
}

async function rewriteBuild(f) {
  f.proofBytes = Buffer.from(JSON.stringify(f.proof, null, 2) + "\n");
  f.materialBytes = Buffer.from(JSON.stringify(f.material, null, 2) + "\n");
  f.gh.proof = [verifiedItem(f.proofBytes, f.sourceSha, "build-proof.json")];
  Object.assign(f.receipt, {
    contentDigest: sha256Canonical(f.proof),
    readbackDigest: sha256Canonical(f.proof),
    contentSizeBytes: encodeManualJson(f.proof).length,
    attestationRef: sha256Canonical(f.gh.proof[0].attestation.bundle)
  });
  f.receiptBytes = encodeManualJson(f.receipt);
  const buildRoot = path.dirname(f.proofPath);
  f.proofPath = path.join(buildRoot, `${sha256Bytes(f.proofBytes).slice(7)}.proof.json`);
  f.materialPath = path.join(buildRoot, `${sha256Bytes(f.materialBytes).slice(7)}.material.json`);
  f.receiptPath = path.join(
    buildRoot,
    `${sha256Bytes(f.proofBytes).slice(7)}.custody-receipt.retention90.v1.json`
  );
  f.gh.paths = { proof: f.proofPath, receipt: f.receiptPath };
  f.gh.receipt = [
    verifiedItem(f.receiptBytes, f.sourceSha, "custody-receipt.json", "2026-09-01T00:00:02.000Z")
  ];
  for (const [file, bytes] of [
    [f.proofPath, f.proofBytes],
    [f.materialPath, f.materialBytes],
    [f.receiptPath, f.receiptBytes]
  ])
    await fs.writeFile(file, bytes, { mode: 0o600 });
}
for (const name of ["api", "web", "runner"]) {
  test(`EDGE rejects independently attested ${name} image drift through the shared identity assertion`, async (t) => {
    const f = await buildFixture(t);
    f.proof.identity.images[name].imageDigest = digest("f");
    await rewriteBuild(f);
    await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
    noAuthorityAccess(f);
  });
}
test("EDGE rejects independently attested builder material reference drift", async (t) => {
  const f = await buildFixture(t);
  f.proof.provenance.materials.find(({ name }) => name === "builder").reference =
    "oci://other.invalid/builder";
  await rewriteBuild(f);
  await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
  noAuthorityAccess(f);
});
test("EDGE rejects receipt attestation preceding authoritative readback", async (t) => {
  const f = await buildFixture(t);
  f.gh.receipt[0].verificationResult.verifiedTimestamps[0].timestamp = generatedAt;
  await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
  noAuthorityAccess(f);
});
test("EDGE recomputes the registered verifier contract after a one-byte mutation", async (t) => {
  const f = await buildFixture(t);
  const before = await computeRepositoryContract(f.repoRoot);
  await fs.appendFile(path.join(f.repoRoot, "scripts/release/verify-build-proof.mjs"), " ");
  const after = await computeRepositoryContract(f.repoRoot);
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.digest, f.proof.identity.repositoryContractDigest);
  await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
  noAuthorityAccess(f);
});
test("EDGE verifies real HEAD independently of identical committed source bytes", async (t) => {
  const f = await buildFixture(t);
  await git(f.repoRoot, "commit", "--allow-empty", "--no-verify", "-m", "Synthetic different HEAD");
  assert.equal(
    (await computeRepositoryContract(f.repoRoot)).digest,
    f.proof.identity.repositoryContractDigest
  );
  assert.notEqual(await git(f.repoRoot, "rev-parse", "HEAD"), f.sourceSha);
  await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
  noAuthorityAccess(f);
});
function environment(t, values) {
  const old = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
test("EDGE ignores GH_HOST override and always verifies the fixed github.com repository", async (t) => {
  const f = await buildFixture(t);
  environment(t, { GH_HOST: "untrusted.invalid" });
  const result = await verifyFixture(f);
  assert.equal(result.buildProofDigest, sha256Canonical(f.proof));
  noAuthorityAccess(f);
});
test("EDGE ignores GIT_DIR and GIT_WORK_TREE overrides when observing the actual checkout", async (t) => {
  const f = await buildFixture(t);
  const other = path.join(f.root, "other-repo");
  await fs.mkdir(other);
  await git(other, "init", "--initial-branch=main");
  await git(other, "commit", "--allow-empty", "--no-verify", "-m", "Other synthetic repository");
  environment(t, { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other });
  const result = await verifyFixture(f);
  assert.equal(result.buildProofDigest, sha256Canonical(f.proof));
  noAuthorityAccess(f);
});
test("EDGE ignores profile argv and environment path selectors", async (t) => {
  const f = await fixture(t);
  const argv = [...process.argv];
  process.argv.push(
    "--trust-root",
    "/untrusted",
    "--profile-file",
    "/untrusted/profile.json",
    "--archive-root",
    "/untrusted/archive"
  );
  t.after(() => {
    process.argv.splice(0, process.argv.length, ...argv);
  });
  environment(t, {
    MANUAL_STAGE1_PROFILE: "/untrusted/profile.json",
    MANUAL_STAGE1_ARCHIVE_ROOT: "/untrusted/archive"
  });
  assert.deepEqual(await production().loadFixedManualProfile({ repoRoot: f.repoRoot }), f.profile);
  noAuthorityAccess(f);
});
test("EDGE never falls back to a historical v1 profile filename", async (t) => {
  const f = await fixture(t);
  await fs.rename(
    path.join(f.repoRoot, profileName),
    path.join(f.repoRoot, profileName.replace("v2", "v1"))
  );
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});
test("EDGE rejects a fully self-consistent approval for a different actual uid", async (t) => {
  const f = await fixture(t);
  f.approval.principal.uid++;
  await rebind(f);
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});
test("EDGE rejects a writable repository parent even when its fixed files remain owner-only", async (t) => {
  const f = await fixture(t);
  await fs.chmod(path.join(f.repoRoot, "release", "contracts"), 0o777);
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});
test("EDGE rejects nonregular fixed input before attempting an open that could block", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.repoRoot, profileName),
    lstat = fs.lstat.bind(fs),
    open = fs.open.bind(fs);
  let opened = 0;
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const stat = await lstat(target, ...args);
    if (target !== file) return stat;
    return new Proxy(stat, {
      get: (object, key) => (key === "isFile" ? () => false : Reflect.get(object, key))
    });
  });
  t.mock.method(fs, "open", (target, ...args) => {
    if (target === file) opened++;
    return open(target, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  assert.equal(opened, 0);
  noAuthorityAccess(f);
});
for (const [name, mutate] of [
  [
    "operation input extra IO authority",
    (f) => ({ repoRoot: f.repoRoot, operationRef: f.operationRef, io: {} })
  ],
  [
    "operationRef uppercase alias",
    (f) => ({ repoRoot: f.repoRoot, operationRef: f.operationRef.toUpperCase() })
  ]
]) {
  test(`EDGE rejects ${name}`, async (t) => {
    const f = await operationFixture(t);
    await assert.rejects(reader()(mutate(f)), { code: "MANUAL_OPERATION_INPUT_UNAVAILABLE" });
    noAuthorityAccess(f);
  });
}
test("EDGE rejects a linked Windows host executable before authority access", async (t) => {
  const f = await windowsFixture(t),
    file = f.mapped(f.systemFiles[0]);
  await fs.rename(file, file + ".original");
  await fs.symlink(file + ".original", file);
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});
test("EDGE rejects Windows executable replacement during the host probe", async (t) => {
  const f = await windowsFixture(t);
  f.windows.before = async (file) => {
    if (file === f.systemFiles[1])
      await fs.writeFile(f.mapped(f.systemFiles[0]), "changed executable bytes");
  };
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});

test("EDGE rejects private-key PEM in the profile public SPKI field", async (t) => {
  const f = await fixture(t);
  f.profile.publicKeyPem = f.keys.privateKey.export({ type: "pkcs8", format: "pem" });
  await rebind(f);
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});
for (const name of ["manual-stage1-trust.mjs", "verify-build-proof.mjs"]) {
  test(`EDGE rejects attested ${name} counterpart different from the actually executing module`, async (t) => {
    const f = await buildFixture(t);
    await fs.appendFile(path.join(f.repoRoot, "scripts", "release", name), " ");
    await git(f.repoRoot, "add", "--all");
    await git(
      f.repoRoot,
      "commit",
      "--no-verify",
      "-m",
      "Different synthetic module implementation"
    );
    f.sourceSha = await git(f.repoRoot, "rev-parse", "HEAD");
    const repositoryContract = await computeRepositoryContract(f.repoRoot),
      migrationCatalog = await computeMigrationCatalog(f.repoRoot);
    Object.assign(f.material, {
      sourceSha: f.sourceSha,
      checkoutRef: f.sourceSha,
      repositoryContractDigest: repositoryContract.digest,
      migrationCatalogDigest: migrationCatalog.digest
    });
    for (const image of f.material.images) image.sourceRevision = f.sourceSha;
    f.proof = structuredClone(
      createBuildProof({
        sourceSha: f.sourceSha,
        images: f.material.images,
        repositoryContract,
        migrationCatalog,
        provenance: {
          generatedAt,
          ciRunRef: f.material.ciRunRef,
          attestationRef: f.material.builder.provenanceRef,
          checkoutRef: f.sourceSha,
          buildMaterialObservation: f.material
        }
      })
    );
    f.gh.run.head_sha = f.sourceSha;
    await rewriteBuild(f);
    assert.equal(
      (await computeRepositoryContract(f.repoRoot)).digest,
      f.proof.identity.repositoryContractDigest
    );
    await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
    noAuthorityAccess(f);
  });
}
test("EDGE rejects a substituted file handle before reading any of its bytes", async (t) => {
  const f = await fixture(t),
    file = path.join(f.repoRoot, profileName),
    substitute = path.join(f.root, "substituted-profile.json");
  await fs.writeFile(substitute, encodeManualJson(f.profile), { mode: 0o600 });
  const open = fs.open.bind(fs);
  let reads = 0;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target !== file) return open(target, ...args);
    const handle = await open(substitute, ...args);
    return {
      stat: (...params) => handle.stat(...params),
      close: () => handle.close(),
      read: (...params) => {
        reads++;
        return handle.read(...params);
      }
    };
  });
  syncBuiltinESMExports();
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  assert.equal(reads, 0);
  noAuthorityAccess(f);
});
test("EDGE rejects coordinated proof and material image source drift", async (t) => {
  const f = await buildFixture(t);
  for (const name of ["api", "web", "runner"]) {
    const image = f.material.images.find((item) => item.name === name);
    image.sourceRevision = "e".repeat(40);
    f.proof.identity.images[name].sourceRevision = image.sourceRevision;
    const materialDigest = sha256Canonical(f.material);
    f.proof.provenance.registryResolutionEvidenceDigest = materialDigest;
    f.proof.provenance.materials.find(
      (item) => item.name === "build-material-observation"
    ).reference = materialDigest;
    await rewriteBuild(f);
    await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" }, name);
    image.sourceRevision = f.sourceSha;
    f.proof.identity.images[name].sourceRevision = f.sourceSha;
  }
  noAuthorityAccess(f);
});
test("EDGE clears synthetic signing-key read scratch buffers after native session close", async (t) => {
  const f = await sessionFixture(t),
    open = fs.open.bind(fs),
    scratch = new Set();
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file !== f.keyPath) return handle;
    return {
      stat: (...params) => handle.stat(...params),
      close: () => handle.close(),
      read: (buffer, ...params) => {
        scratch.add(buffer);
        return handle.read(buffer, ...params);
      }
    };
  });
  syncBuiltinESMExports();
  const session = await openFixture(f);
  await session.close();
  assert.ok(scratch.size > 0);
  for (const buffer of scratch)
    assert.ok(
      buffer.every((byte) => byte === 0),
      "key read scratch must be cleared"
    );
});

for (const relative of [profileName, bindingName]) {
  test(`H1ACL rejects writable repository input ${relative}`, async (t) => {
    const f = await fixture(t);
    await fs.chmod(path.join(f.repoRoot, relative), 0o666);
    await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
      code: "H1_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  });
}

function production() {
  assert.ok(trust, "fixed manual trust entrypoint must exist");
  return trust;
}
function noAuthorityAccess(f) {
  assert.deepEqual(f.counters, { privateKeyReads: 0, writes: 0 });
}

const repository = "keqi119/subscription-Saas";
const workflowPath = ".github/workflows/docker-images.yml";
const generatedAt = "2026-09-01T00:00:00.000Z";
const runId = 2801;
const digest = (character) => `sha256:${character.repeat(64)}`;
const nativeExecFile = childProcess.execFile.bind(childProcess);
const gitEnvironment = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Synthetic Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid"
};
function git(repoRoot, ...args) {
  return new Promise((resolve, reject) =>
    nativeExecFile(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", repoRoot, ...args],
      { env: gitEnvironment, shell: false, encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
    )
  );
}
function verifiedItem(bytes, sourceSha, name, timestamp = generatedAt) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha256: sha256Bytes(bytes).slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {}
      },
      runDetails: { builder: { id: "https://github.com/actions/runner" } }
    }
  };
  return {
    attestation: {
      bundle: {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: {
          certificate: { rawBytes: Buffer.from("synthetic-certificate").toString("base64") },
          tlogEntries: []
        },
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: encodeManualJson(statement).toString("base64"),
          signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }]
        }
      },
      bundle_url: "https://synthetic.invalid/short-lived-download",
      initiator: "github"
    },
    verificationResult: {
      statement,
      signature: {
        certificate: {
          issuer: "https://token.actions.githubusercontent.com",
          subjectAlternativeName: {
            type: "URI",
            value: `https://github.com/${repository}/${workflowPath}@refs/heads/main`
          },
          buildSignerURI: `https://github.com/${repository}/${workflowPath}@refs/heads/main`,
          buildSignerDigest: sourceSha,
          runnerEnvironment: "github-hosted",
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryDigest: sourceSha,
          sourceRepositoryRef: "refs/heads/main",
          sourceRepositoryIdentifier: "10001",
          sourceRepositoryOwnerURI: "https://github.com/keqi119",
          sourceRepositoryOwnerIdentifier: "10002",
          buildConfigURI: `https://github.com/${repository}/${workflowPath}@refs/heads/main`,
          buildConfigDigest: sourceSha,
          buildTrigger: "push",
          runInvocationURI: `https://github.com/${repository}/actions/runs/${runId}/attempts/1`,
          sourceRepositoryVisibilityAtSigning: "public"
        }
      },
      verifiedTimestamps: [{ type: "Tlog", uri: "https://rekor.sigstore.dev", timestamp }]
    }
  };
}

async function buildFixture(
  t,
  { canonicalProof = false, extraEntrypoints = [], r3TargetPolicy = false } = {}
) {
  const f = await fixture(t);
  const manifest = "release/contracts/repository-contract-files.v1.json";
  const entrypoints = [
    "scripts/release/manual-stage1-trust.mjs",
    "scripts/release/verify-build-proof.mjs",
    ...extraEntrypoints
  ];
  await fs.mkdir(path.join(f.repoRoot, "scripts", "release"), { recursive: true });
  await fs.mkdir(path.join(f.repoRoot, "apps", "api", "prisma", "migrations"), { recursive: true });
  for (const file of entrypoints)
    await fs.copyFile(
      new URL(`./${path.basename(file)}`, import.meta.url),
      path.join(f.repoRoot, file)
    );
  const extraContracts = [];
  if (r3TargetPolicy) {
    for (const name of [
      "manual-stage1-r3-target-policy.v1.json",
      "database-target-policies.v1.json",
      "database-test-manifest.v1.json"
    ]) {
      const value = JSON.parse(
        await fs.readFile(new URL(`../../release/contracts/${name}`, import.meta.url))
      );
      if (name === "manual-stage1-r3-target-policy.v1.json")
        value.profileDigest = sha256Canonical(f.profile);
      const file = `release/contracts/${name}`;
      await fs.writeFile(path.join(f.repoRoot, file), encodeManualJson(value), { mode: 0o600 });
      extraContracts.push(file);
    }
  }
  await fs.writeFile(
    path.join(f.repoRoot, manifest),
    encodeManualJson({
      contractVersion: "repository-contract-files.v1",
      files: [manifest, profileName, bindingName, ...entrypoints, ...extraContracts].sort()
    }),
    { mode: 0o600 }
  );
  await git(f.repoRoot, "init", "--initial-branch=main");
  await git(f.repoRoot, "add", "--all");
  await git(f.repoRoot, "commit", "--no-verify", "-m", "Synthetic fixed trust inputs");
  const sourceSha = await git(f.repoRoot, "rev-parse", "HEAD");
  const contract = await computeRepositoryContract(f.repoRoot);
  const catalog = await computeMigrationCatalog(f.repoRoot);
  const ciRunRef = `https://github.com/${repository}/actions/runs/${runId}`;
  const images = ["api", "web", "runner"].map((name, index) => {
    const image = `ghcr.io/keqi119/subscription-${name}`,
      imageDigest = digest(String(index + 1));
    return {
      name,
      image,
      platform: "linux/amd64",
      digest: imageDigest,
      sourceRevision: sourceSha,
      baseImageDigests: [
        { image: "node:22-bookworm-slim", declaredDigest: digest("a"), digest: digest("b") }
      ],
      builderName: "https://mobyproject.org/buildkit@v1",
      buildAttestationRef: `oci://${image}@${imageDigest}#provenance=${digest("c")}`,
      registrySubject: `${image}@${imageDigest}`,
      buildRunRef: ciRunRef
    };
  });
  const material = {
    schemaVersion: "build-material-observation.v1",
    sourceSha,
    checkoutRef: sourceSha,
    ciRunRef,
    repositoryContractDigest: contract.digest,
    migrationCatalogDigest: catalog.digest,
    policyDigest: digest("f"),
    promotionEligibility: "trusted-candidate",
    images,
    externalActions: [
      { name: "actions/checkout", commitSha: "2".repeat(40) },
      { name: "docker/build-push-action", commitSha: "3".repeat(40) }
    ],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("4")}`
    },
    observedAt: generatedAt
  };
  const proof = structuredClone(
    createBuildProof({
      sourceSha,
      images,
      migrationCatalog: catalog,
      repositoryContract: contract,
      provenance: {
        generatedAt,
        ciRunRef,
        attestationRef: material.builder.provenanceRef,
        checkoutRef: sourceSha,
        buildMaterialObservation: material
      }
    })
  );
  const proofBytes = canonicalProof
    ? encodeManualJson(proof)
    : Buffer.from(JSON.stringify(proof, null, 2) + "\n");
  const materialBytes = Buffer.from(JSON.stringify(material, null, 2) + "\n");
  const proofItem = verifiedItem(proofBytes, sourceSha, "build-proof.json");
  const receipt = {
    schemaVersion: "custody-receipt.retention90.v1",
    receiptId: randomUUID(),
    contentDigest: sha256Canonical(proof),
    contentSizeBytes: encodeManualJson(proof).length,
    storeRef: `s3://synthetic-authority/private/${sha256Canonical(proof).slice(7)}.json`,
    uploadedAt: generatedAt,
    readbackAt: "2026-09-01T00:00:01.000Z",
    readbackDigest: sha256Canonical(proof),
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: "2026-11-30T00:00:00.000Z",
    expiryDisposition: "review",
    attestationRef: sha256Canonical(proofItem.attestation.bundle)
  };
  const buildRoot = path.join(f.profile.storage.archiveRoot, "inputs", "build");
  await fs.mkdir(buildRoot, { recursive: true, mode: 0o700 });
  const proofPath = path.join(buildRoot, `${sha256Bytes(proofBytes).slice(7)}.proof.json`);
  const materialPath = path.join(buildRoot, `${sha256Bytes(materialBytes).slice(7)}.material.json`);
  const receiptPath = path.join(
    buildRoot,
    `${sha256Bytes(proofBytes).slice(7)}.custody-receipt.retention90.v1.json`
  );
  const receiptBytes = encodeManualJson(receipt);
  for (const [file, bytes] of [
    [proofPath, proofBytes],
    [materialPath, materialBytes],
    [receiptPath, receiptBytes]
  ])
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const gh = {
    proof: [proofItem],
    receipt: [
      verifiedItem(receiptBytes, sourceSha, "custody-receipt.json", "2026-09-01T00:00:02.000Z")
    ],
    run: {
      id: runId,
      run_attempt: 1,
      head_sha: sourceSha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      path: workflowPath,
      html_url: ciRunRef,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      event: "push",
      workflow_id: 3001
    },
    calls: [],
    before: null,
    error: null,
    stderr: Buffer.alloc(0),
    raw: null
  };
  gh.paths = { proof: proofPath, receipt: receiptPath };
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    if (file !== "gh") return nativeExecFile(file, args, options, callback);
    gh.calls.push({ file, args: [...args], options: { ...options } });
    Promise.resolve()
      .then(async () => {
        if (gh.before) await gh.before(args);
        if (gh.error) return callback(gh.error, Buffer.alloc(0), gh.stderr);
        if ((options.env?.GH_HOST ?? process.env.GH_HOST ?? "github.com") !== "github.com")
          return callback(
            new Error("Synthetic gh was routed to a different host"),
            Buffer.alloc(0),
            Buffer.alloc(0)
          );
        let value;
        if (args[0] === "attestation" && args[1] === "verify" && args[2] === gh.paths.proof)
          value = gh.proof;
        else if (args[0] === "attestation" && args[1] === "verify" && args[2] === gh.paths.receipt)
          value = gh.receipt;
        else if (
          args[0] === "api" &&
          args[1] === `repos/${repository}/actions/runs/${runId}/attempts/1`
        )
          value = gh.run;
        else if (
          gh.jobAdmission &&
          args[0] === "attestation" &&
          args[1] === "verify" &&
          args[2] === gh.jobAdmission.path
        )
          value = gh.jobAdmission.attestation;
        else if (
          gh.jobAdmission &&
          args[0] === "api" &&
          args[1] === `repos/${repository}/actions/runs/${gh.jobAdmission.run.id}/attempts/1`
        )
          value = gh.jobAdmission.run;
        else if (
          gh.jobAdmission &&
          args[0] === "api" &&
          args[1] === `repos/${repository}/actions/jobs/${gh.jobAdmission.job.id}`
        )
          value = gh.jobAdmission.job;
        else throw new Error("Unexpected synthetic gh invocation");
        callback(null, gh.raw ?? Buffer.from(JSON.stringify(value)), gh.stderr);
      })
      .catch((error) => callback(error, Buffer.alloc(0), Buffer.alloc(0)));
    return { kill() {} };
  });
  syncBuiltinESMExports();
  return {
    ...f,
    sourceSha,
    proof,
    material,
    proofBytes,
    materialBytes,
    proofPath,
    materialPath,
    receipt,
    receiptBytes,
    receiptPath,
    gh
  };
}
function verifier() {
  assert.equal(
    typeof production().verifyManualBuild,
    "function",
    "fixed build verifier must exist"
  );
  return production().verifyManualBuild;
}

test("R3 POLICY API rejects trust overrides and accessors before native IO", async (t) => {
  assert.equal(typeof trust.readFixedR3TargetPolicy, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected IO or accessor");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = {
    repoRoot: path.resolve("unused"),
    proofBytes: Buffer.from("{}"),
    materialBytes: Buffer.from("{}")
  };
  for (const value of [
    { ...input, policyFile: "/caller/policy.json" },
    { ...input, verifiedBuild: { trusted: true } },
    { ...input, repoRoot: { toString: denied } },
    Object.defineProperty({ ...input }, "proofBytes", { get: denied, enumerable: true })
  ])
    await assert.rejects(trust.readFixedR3TargetPolicy(value), {
      code: "R3_TARGET_POLICY_INPUT_UNAVAILABLE"
    });
  assert.equal(effects, 0);
});

test(
  "R3 POLICY holds the build-bound fixed policy and refuses later source drift",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await buildFixture(t, { r3TargetPolicy: true });
    const result = await trust.readFixedR3TargetPolicy({
      repoRoot: f.repoRoot,
      proofBytes: f.proofBytes,
      materialBytes: f.materialBytes
    });
    t.after(() => result.close());
    assert.equal(result.profileDigest, sha256Canonical(f.profile));
    assert.equal(result.build.buildProofDigest, sha256Canonical(f.proof));
    assert.equal(result.sourceSha, f.sourceSha);
    assert.equal(result.databaseTargetPolicy.policyId, "s1-release-compose-ephemeral");
    assert.equal(result.policy.transport.engineEndpoint, "tcp://127.0.0.1:55440");
    assert.ok(Object.isFrozen(result.policy.workspace));
    assert.ok(Object.isFrozen(result.databaseTargetPolicy.allowedEnvironments));
    assert.equal(result.build.promotionEligible, false);
    assert.equal(f.gh.calls.length, 3, "both raw subjects and actual build run are verified");
    await result.recheck();
    const policyPath = path.join(
      f.repoRoot,
      "release/contracts/manual-stage1-r3-target-policy.v1.json"
    );
    await fs.appendFile(policyPath, " ");
    await assert.rejects(result.recheck(), { code: "R3_TARGET_POLICY_INPUT_UNAVAILABLE" });
    await result.close();
    await assert.rejects(result.recheck(), { code: "R3_TARGET_POLICY_INPUT_UNAVAILABLE" });
    noAuthorityAccess(f);
  }
);

test(
  "R3 POLICY rejects a different H1 binding and missing trusted build",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await buildFixture(t, { r3TargetPolicy: true });
    const input = {
      repoRoot: f.repoRoot,
      proofBytes: f.proofBytes,
      materialBytes: f.materialBytes
    };
    const policyPath = path.join(
      f.repoRoot,
      "release/contracts/manual-stage1-r3-target-policy.v1.json"
    );
    const bytes = await fs.readFile(policyPath),
      policy = JSON.parse(bytes);
    policy.profileDigest = `sha256:${"f".repeat(64)}`;
    await fs.writeFile(policyPath, encodeManualJson(policy));
    await assert.rejects(trust.readFixedR3TargetPolicy(input), {
      code: "R3_TARGET_POLICY_INPUT_UNAVAILABLE"
    });
    assert.equal(f.gh.calls.length, 0);
    await fs.writeFile(policyPath, bytes);
    f.gh.error = new Error("synthetic attestation verification failed");
    await assert.rejects(trust.readFixedR3TargetPolicy(input), {
      code: "R3_TARGET_POLICY_INPUT_UNAVAILABLE"
    });
    assert.equal(f.gh.calls.length, 1);
    noAuthorityAccess(f);
  }
);
async function r3CreationFixture(t, { phase = "source", chain = "snapshot" } = {}) {
  const f = await buildFixture(t, { r3TargetPolicy: true });
  const policyBytes = await fs.readFile(
    path.join(f.repoRoot, "release/contracts/manual-stage1-r3-target-policy.v1.json")
  );
  const policy = JSON.parse(policyBytes),
    operationRef = randomUUID(),
    id = operationRef.replaceAll("-", "");
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: sha256Canonical(f.profile),
    ownerId: f.profile.ownerId,
    sourceSha: f.sourceSha,
    buildProofDigest: sha256Canonical(f.proof),
    proofRawDigest: sha256Bytes(f.proofBytes),
    materialRawDigest: sha256Bytes(f.materialBytes),
    targetPolicyDigest: sha256Bytes(policyBytes),
    phase,
    chain,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    workspace: {
      id,
      capacityBytes: 64 * 1024 * 1024,
      backingFile: path.posix.join(policy.workspace.backingRoot, id + ".luks"),
      mountPath: path.posix.join(policy.workspace.mountRoot, id),
      keyFile: path.posix.join(policy.workspace.keyRoot, id + ".key"),
      mapperName: policy.workspace.mapperPrefix + id
    },
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const specPath = path.join(
    f.profile.storage.archiveRoot,
    "inputs",
    "r3",
    operationRef,
    "creation-spec.json"
  );
  await fs.mkdir(path.dirname(specPath), { recursive: true, mode: 0o700 });
  const specBytes = encodeManualJson(spec);
  await fs.writeFile(specPath, specBytes, { flag: "wx", mode: 0o600 });
  return { ...f, operationRef, policy, spec, specPath, specBytes };
}

test("R3 CREATION API rejects overrides and accessors before native IO", async (t) => {
  assert.equal(typeof trust.readFixedR3CreationSpec, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected IO or accessor");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = { repoRoot: path.resolve("unused"), operationRef: randomUUID() };
  for (const value of [
    { ...input, specFile: "/caller/spec.json" },
    { ...input, proofBytes: Buffer.from("{}") },
    { ...input, operationRef: "../escape" },
    { ...input, repoRoot: { toString: denied } },
    Object.defineProperty({ ...input }, "operationRef", { get: denied, enumerable: true })
  ])
    await assert.rejects(trust.readFixedR3CreationSpec(value), {
      code: "R3_CREATION_INPUT_UNAVAILABLE"
    });
  assert.equal(effects, 0);
});

test(
  "R3 CREATION holds the candidate-bound spec and rejects original drift",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3CreationFixture(t);
    const result = await trust.readFixedR3CreationSpec({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef
    });
    t.after(() => result.close());
    const required = [
      "spec",
      "creationSpecDigest",
      "policy",
      "databaseTargetPolicy",
      "build",
      "sourceSha",
      "recheck",
      "close"
    ];
    assert.ok(required.every((key) => Object.hasOwn(result, key)));
    assert.ok(
      Object.keys(result).every((key) =>
        [...required, "targetPolicyDigest", "profileDigest"].includes(key)
      )
    );
    assert.deepEqual(result.spec, f.spec);
    assert.equal(result.creationSpecDigest, sha256Bytes(f.specBytes));
    assert.equal(result.policy.profileDigest, sha256Canonical(f.profile));
    assert.equal(result.databaseTargetPolicy.policyId, "s1-release-compose-ephemeral");
    assert.equal(result.build.buildProofDigest, sha256Canonical(f.proof));
    assert.equal(result.sourceSha, f.sourceSha);
    assert.equal(result.build.promotionEligible, false);
    assert.ok(Object.isFrozen(result.spec.workspace) && Object.isFrozen(result.policy.workspace));
    await result.recheck();
    await fs.appendFile(f.specPath, " ");
    await assert.rejects(result.recheck(), { code: "R3_CREATION_INPUT_UNAVAILABLE" });
    await result.close();
    await result.close();
    await assert.rejects(result.recheck(), { code: "R3_CREATION_INPUT_UNAVAILABLE" });
    noAuthorityAccess(f);
  }
);

test(
  "R3 CREATION rejects future facts candidate policy path and expired scope",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3CreationFixture(t);
    const input = { repoRoot: f.repoRoot, operationRef: f.operationRef };
    for (const mutate of [
      (s) => {
        s.engineId = "future-engine";
      },
      (s) => {
        s.destinationAdmissionDigest = digest("e");
      },
      (s) => {
        s.jobAdmissionDigest = digest("e");
      },
      (s) => {
        s.input = { inputReference: randomUUID() };
      },
      (s) => {
        s.buildProofDigest = digest("e");
      },
      (s) => {
        s.sourceSha = "e".repeat(40);
      },
      (s) => {
        s.targetPolicyDigest = digest("e");
      },
      (s) => {
        s.workspace.mountPath = "/tmp/escape";
      },
      (s) => {
        s.workspace.id = "e".repeat(32);
      },
      (s) => {
        s.workspace.capacityBytes++;
      },
      (s) => {
        s.workspace.capacityBytes = 63 * 1024 * 1024;
      },
      (s) => {
        s.expiresAt = new Date(Date.now() - 1).toISOString();
      }
    ]) {
      const spec = structuredClone(f.spec);
      mutate(spec);
      await fs.writeFile(f.specPath, encodeManualJson(spec));
      await assert.rejects(trust.readFixedR3CreationSpec(input), {
        code: "R3_CREATION_INPUT_UNAVAILABLE"
      });
    }
    noAuthorityAccess(f);
  }
);

async function r3JobFixture(t, options = {}) {
  const f = await r3CreationFixture(t, options);
  const phase = f.spec.phase,
    chain = f.spec.chain;
  const forwardingKeys = generateKeyPairSync("ed25519");
  const forwarding = forwardingKeys.publicKey;
  const generated = new Date(Date.now() - 100).toISOString();
  const ciRunId = "3801",
    jobId = "4801";
  const callerWorkflowPath = ".github/workflows/release-candidate-gate.yml";
  const signerWorkflowPath =
    phase === "source" ? callerWorkflowPath : ".github/workflows/release-final-chain.yml";
  const jobName = phase === "source" ? `source-${chain}` : `final-${chain} / execute`;
  const admission = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef: f.operationRef,
    profileDigest: sha256Canonical(f.profile),
    ownerId: f.profile.ownerId,
    creationSpecDigest: sha256Bytes(f.specBytes),
    buildProofDigest: sha256Canonical(f.proof),
    sourceSha: f.sourceSha,
    phase,
    chain,
    generatedAt: generated,
    expiresAt: f.spec.expiresAt,
    ci: {
      repository,
      repositoryId: "1253231368",
      runId: ciRunId,
      runAttempt: 1,
      workflowPath: signerWorkflowPath,
      callerWorkflowPath,
      jobKey: phase === "source" ? jobName : "execute",
      jobId,
      jobName,
      environment:
        phase === "source" ? "trusted-source-database-gate" : "trusted-release-execution",
      runnerClass: "github-hosted"
    },
    host: {
      machineIdFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${"b".repeat(32)}`)
      ),
      forwardingPublicKeyPem: forwarding.export({ type: "spki", format: "pem" }),
      forwardingKeyFingerprint: sha256Bytes(forwarding.export({ type: "spki", format: "der" })),
      runnerId: 5801,
      runnerName: "GitHub Actions synthetic hosted runner"
    }
  };
  const admissionPath = path.join(path.dirname(f.specPath), "job-admission.json");
  const admissionBytes = encodeManualJson(admission);
  await fs.writeFile(admissionPath, admissionBytes, { flag: "wx", mode: 0o600 });
  const attestation = [verifiedItem(admissionBytes, f.sourceSha, "job-admission.json", generated)];
  const certificate = attestation[0].verificationResult.signature.certificate;
  certificate.subjectAlternativeName.value = `https://github.com/${repository}/${signerWorkflowPath}@refs/heads/main`;
  certificate.buildSignerURI = certificate.subjectAlternativeName.value;
  certificate.buildConfigURI = `https://github.com/${repository}/${callerWorkflowPath}@refs/heads/main`;
  certificate.sourceRepositoryIdentifier = "1253231368";
  certificate.runInvocationURI = `https://github.com/${repository}/actions/runs/${ciRunId}/attempts/1`;
  const apiRun = {
    id: Number(ciRunId),
    run_attempt: 1,
    head_sha: f.sourceSha,
    head_branch: "main",
    path: callerWorkflowPath,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/${repository}/actions/runs/${ciRunId}`,
    repository: { full_name: repository, id: 1253231368 },
    head_repository: { full_name: repository, id: 1253231368 }
  };
  const apiJob = {
    id: Number(jobId),
    run_id: Number(ciRunId),
    run_attempt: 1,
    head_sha: f.sourceSha,
    name: jobName,
    runner_id: admission.host.runnerId,
    runner_name: admission.host.runnerName,
    status: "in_progress",
    conclusion: null,
    completed_at: null,
    started_at: f.spec.createdAt
  };
  f.gh.jobAdmission = { path: admissionPath, attestation, run: apiRun, job: apiJob };
  return {
    ...f,
    admission,
    admissionPath,
    admissionBytes,
    attestation,
    apiRun,
    apiJob,
    forwardingPrivateKey: forwardingKeys.privateKey
  };
}

test("R3 JOB API rejects overrides and accessors before native IO", async (t) => {
  assert.equal(typeof trust.readFixedR3JobAdmission, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected IO or accessor");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = { repoRoot: path.resolve("unused"), operationRef: randomUUID() };
  for (const value of [
    { ...input, admissionFile: "/caller/job.json" },
    { ...input, verifiedJob: { status: "in_progress" } },
    { ...input, operationRef: "../escape" },
    Object.defineProperty({ ...input }, "operationRef", { get: denied, enumerable: true })
  ])
    await assert.rejects(trust.readFixedR3JobAdmission(value), {
      code: "R3_JOB_ADMISSION_UNAVAILABLE"
    });
  assert.equal(effects, 0);
});

test(
  "R3 JOB source binds current hosted job and refuses terminal API recheck",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3JobFixture(t, { phase: "source", chain: "fresh" });
    const result = await trust.readFixedR3JobAdmission({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef
    });
    t.after(() => result.close());
    assert.deepEqual(result.admission, f.admission);
    assert.equal(result.jobAdmissionDigest, sha256Bytes(f.admissionBytes));
    assert.equal(result.creationSpecDigest, sha256Bytes(f.specBytes));
    assert.equal(result.build.buildProofDigest, sha256Canonical(f.proof));
    assert.equal(result.sourceSha, f.sourceSha);
    assert.equal(result.build.promotionEligible, false);
    assert.ok(Object.isFrozen(result.admission.host) && Object.isFrozen(result.observations));
    assert.ok(Object.isFrozen(result.verifiedAttestation));
    assert.deepEqual(result.rawInputs.admission, f.admissionBytes);
    result.rawInputs.admission.fill(0);
    const reread = await result.recheck();
    assert.ok(Object.isFrozen(reread.observations));
    assert.deepEqual(reread.rawInputs.admission, f.admissionBytes);
    f.apiJob.status = "completed";
    f.apiJob.conclusion = "success";
    f.apiJob.completed_at = new Date().toISOString();
    await assert.rejects(result.recheck(), { code: "R3_JOB_ADMISSION_UNAVAILABLE" });
    await result.close();
    await assert.rejects(result.recheck(), { code: "R3_JOB_ADMISSION_UNAVAILABLE" });
    noAuthorityAccess(f);
  }
);

test(
  "R3 JOB final binds reusable signer caller and refuses original drift",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3JobFixture(t, { phase: "final", chain: "snapshot" });
    const result = await trust.readFixedR3JobAdmission({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef
    });
    t.after(() => result.close());
    assert.equal(result.admission.ci.workflowPath, ".github/workflows/release-final-chain.yml");
    assert.equal(
      result.admission.ci.callerWorkflowPath,
      ".github/workflows/release-candidate-gate.yml"
    );
    assert.equal(result.admission.ci.jobName, "final-snapshot / execute");
    await result.recheck();
    await fs.appendFile(f.admissionPath, " ");
    await assert.rejects(result.recheck(), { code: "R3_JOB_ADMISSION_UNAVAILABLE" });
    await result.close();
    noAuthorityAccess(f);
  }
);

test(
  "R3 JOB rejects wrong signer source chain runner run job and expiry",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3JobFixture(t);
    const baseline = structuredClone({ attestation: f.attestation, run: f.apiRun, job: f.apiJob });
    for (const mutate of [
      (a, g) => {
        g.attestation[0].verificationResult.signature.certificate.buildSignerURI =
          "https://github.com/attacker/workflow";
      },
      (a) => {
        a.sourceSha = "e".repeat(40);
      },
      (a) => {
        a.chain = "fresh";
      },
      (a) => {
        a.ci.runnerClass = "self-hosted";
      },
      (a, g) => {
        g.job.runner_name = "different runner";
      },
      (a, g) => {
        g.job.run_id++;
      },
      (a, g) => {
        g.run.head_sha = "e".repeat(40);
      },
      (a) => {
        a.expiresAt = new Date(Date.now() - 1).toISOString();
      }
    ]) {
      const admission = structuredClone(f.admission),
        api = structuredClone(baseline);
      mutate(admission, api);
      await fs.writeFile(f.admissionPath, encodeManualJson(admission));
      Object.assign(f.gh.jobAdmission, api);
      await assert.rejects(
        trust.readFixedR3JobAdmission({ repoRoot: f.repoRoot, operationRef: f.operationRef }),
        { code: "R3_JOB_ADMISSION_UNAVAILABLE" }
      );
    }
    noAuthorityAccess(f);
  }
);

const r3WorkspaceIdentity = (kind, size = 0) => ({
  dev: "1",
  ino: "42",
  mode: String(
    kind === "directory"
      ? 0o40700
      : kind === "mapper"
        ? 0o120777
        : kind === "executable"
          ? 0o100755
          : 0o100600
  ),
  uid: "0",
  gid: "0",
  nlink: "1",
  size: String(size),
  mtimeNs: "1",
  ctimeNs: "1",
  rdev: "0"
});
const r3WorkspaceCommands = (w, state) => [
  [
    "mounts",
    "/usr/bin/findmnt",
    ["--json", "--list", "--kernel", "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"]
  ],
  [
    "loops",
    "/usr/sbin/losetup",
    ["--json", "--list", "--output", "NAME,BACK-FILE,OFFSET,SIZELIMIT"]
  ],
  [
    "blocks",
    "/usr/bin/lsblk",
    ["--json", "--list", "--paths", "--output", "NAME,KNAME,TYPE,MAJ:MIN,PKNAME"]
  ],
  ...(state === "active"
    ? [
        [
          "mapper",
          "/usr/sbin/dmsetup",
          [
            "info",
            "--columns",
            "--noheadings",
            "--separator",
            "|",
            "--options",
            "name,uuid,major,minor",
            w.mapperName
          ]
        ],
        ["header", "/usr/sbin/cryptsetup", ["luksDump", "--dump-json-metadata", w.backingFile]],
        ["uuid", "/usr/sbin/cryptsetup", ["luksUUID", w.backingFile]]
      ]
    : [])
];

async function r3WorkspaceFixture(t, state = "active") {
  const f = await r3JobFixture(t, { phase: "source", chain: "fresh" });
  const w = f.spec.workspace;
  const policyBytes = await fs.readFile(
    path.join(f.repoRoot, "release/contracts/manual-stage1-r3-target-policy.v1.json")
  );
  const json = (value) => Buffer.from(JSON.stringify(value) + "\n");
  const raw = {
    policy: policyBytes,
    machineId: Buffer.from("b".repeat(32) + "\n"),
    "mounts.stdout": json({
      filesystems: [
        {
          target: "/",
          source: "/dev/sda1",
          fstype: "ext4",
          options: "rw,relatime",
          "maj:min": "8:1"
        },
        {
          target: "/dev/shm",
          source: "tmpfs",
          fstype: "tmpfs",
          options: "rw,nosuid,nodev",
          "maj:min": "0:42"
        },
        ...(state === "active"
          ? [
              {
                target: w.mountPath,
                source: `/dev/mapper/${w.mapperName}`,
                fstype: "ext4",
                options: "rw,nosuid,nodev",
                "maj:min": "253:2"
              }
            ]
          : [])
      ]
    }),
    "loops.stdout": json({
      loopdevices:
        state === "active"
          ? [{ name: "/dev/loop4", "back-file": w.backingFile, offset: 0, sizelimit: 0 }]
          : []
    }),
    "blocks.stdout": json({
      blockdevices: [
        {
          name: "/dev/sda1",
          kname: "/dev/sda1",
          type: "part",
          "maj:min": "8:1",
          pkname: "/dev/sda"
        },
        ...(state === "active"
          ? [
              {
                name: "/dev/loop4",
                kname: "/dev/loop4",
                type: "loop",
                "maj:min": "7:4",
                pkname: null
              },
              {
                name: `/dev/mapper/${w.mapperName}`,
                kname: "/dev/dm-2",
                type: "crypt",
                "maj:min": "253:2",
                pkname: "/dev/loop4"
              }
            ]
          : [])
      ]
    })
  };
  if (state === "active") {
    const uuid = "2896e6bd-60c0-44f1-b3a0-14a2e1bc0d39";
    raw["mapper.stdout"] = Buffer.from(
      `${w.mapperName}|CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${w.mapperName}|253|2\n`
    );
    raw["header.stdout"] = json({
      keyslots: {
        0: {
          type: "luks2",
          key_size: 64,
          area: { type: "raw", encryption: "aes-xts-plain64", key_size: 64 }
        }
      },
      tokens: {},
      segments: {
        0: {
          type: "crypt",
          offset: "16777216",
          size: "dynamic",
          iv_tweak: "0",
          encryption: "aes-xts-plain64",
          sector_size: 4096
        }
      },
      digests: { 0: { type: "pbkdf2", keyslots: ["0"], segments: ["0"] } },
      config: {}
    });
    raw["uuid.stdout"] = Buffer.from(uuid + "\n");
    raw.swaps = Buffer.from("Filename\tType\tSize\tUsed\tPriority\n");
    raw.limits = Buffer.from(
      "Limit Soft Limit Hard Limit Units\nMax core file size        0                    0                    bytes\n"
    );
  }
  const commands = r3WorkspaceCommands(w, state);
  for (const [name] of commands) raw[`${name}.stderr`] = Buffer.alloc(0);
  const captured = Object.fromEntries(commands.map(([name]) => [name, raw[`${name}.stdout`]]));
  if (state === "active") Object.assign(captured, { swaps: raw.swaps, limits: raw.limits });
  const ref = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
  const startMs = Date.parse(f.admission.generatedAt) + 1;
  const startedAt = new Date(startMs).toISOString();
  const finishedAt = new Date(startMs + 30).toISOString();
  const processes = commands.map(([name, command, args], index) => ({
    name,
    command,
    args,
    executable: r3WorkspaceIdentity("executable", 1234),
    startedAt: new Date(startMs + index * 3).toISOString(),
    pid: 100 + index,
    closedAt: new Date(startMs + index * 3 + 1).toISOString(),
    exitCode: 0,
    signal: null,
    stdout: ref(raw[`${name}.stdout`]),
    stderr: ref(raw[`${name}.stderr`])
  }));
  const files = [
    {
      name: "policy",
      path: path.posix.join(
        f.repoRoot.replaceAll("\\", "/"),
        "release/contracts/manual-stage1-r3-target-policy.v1.json"
      ),
      observedAt: startedAt,
      ...ref(raw.policy)
    },
    { name: "machineId", path: "/etc/machine-id", observedAt: startedAt, ...ref(raw.machineId) },
    ...["backing", "key", "directory", "mapper"].map((name) => ({
      name,
      path:
        name === "mapper"
          ? `/dev/mapper/${w.mapperName}`
          : name === "backing"
            ? w.backingFile
            : name === "key"
              ? w.keyFile
              : w.mountPath,
      exists: state === "active",
      observedAt: startedAt,
      ...(state === "active"
        ? {
            identity: r3WorkspaceIdentity(
              name,
              name === "backing" ? w.capacityBytes : name === "key" ? 64 : 0
            )
          }
        : {})
    })),
    ...(state === "active"
      ? [
          { name: "swaps", path: "/proc/swaps", observedAt: finishedAt, ...ref(raw.swaps) },
          { name: "limits", path: "/proc/self/limits", observedAt: finishedAt, ...ref(raw.limits) }
        ]
      : [])
  ];
  const observation = {
    schemaVersion: "manual-r3-workspace-observation.v1",
    operationRef: f.operationRef,
    policyDigest: sha256Bytes(policyBytes),
    state,
    startedAt,
    finishedAt,
    hostFingerprint: f.admission.host.machineIdFingerprint,
    workspace: w,
    promotionEligible: false,
    status: "OBSERVED",
    facts: assessR3WorkspaceObservation({ workspace: w, state, captured }),
    processes,
    files
  };
  const observationBytes = encodeManualJson(observation);
  const binding = signR3WorkspaceBinding({
    observationBytes,
    jobAdmissionBytes: f.admissionBytes,
    privateKey: f.forwardingPrivateKey
  });
  const bindingBytes = encodeManualJson(binding);
  const opRoot = path.dirname(f.admissionPath);
  const observationPath = path.join(opRoot, `workspace-${state}.json`);
  const bindingPath = path.join(opRoot, `workspace-${state}.binding.json`);
  await fs.writeFile(observationPath, observationBytes, { flag: "wx", mode: 0o600 });
  await fs.writeFile(bindingPath, bindingBytes, { flag: "wx", mode: 0o600 });
  const rawDir = path.join(opRoot, "raw");
  await fs.mkdir(rawDir, { recursive: true, mode: 0o700 });
  const rawPaths = {};
  for (const [name, bytes] of Object.entries(raw)) {
    const file = path.join(rawDir, `${sha256Bytes(bytes).slice(7)}.bin`);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    rawPaths[name] = file;
  }
  return {
    ...f,
    observation,
    observationBytes,
    observationPath,
    binding,
    bindingBytes,
    bindingPath,
    raw,
    rawPaths
  };
}

test("R3 WORKSPACE API rejects overrides and accessors before native IO", async (t) => {
  assert.equal(typeof trust.readFixedR3WorkspaceObservation, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected IO or accessor");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = { repoRoot: path.resolve("unused"), operationRef: randomUUID(), state: "active" };
  for (const value of [
    { ...input, observationFile: "/caller/report.json" },
    { ...input, rawInputs: { policy: Buffer.from("{}") } },
    { ...input, state: "cleanup" },
    { ...input, operationRef: "../escape" },
    Object.defineProperty({ ...input }, "state", { get: denied, enumerable: true })
  ])
    await assert.rejects(trust.readFixedR3WorkspaceObservation(value), {
      code: "R3_WORKSPACE_INPUT_UNAVAILABLE"
    });
  assert.equal(effects, 0);
});

test(
  "R3 WORKSPACE active pins signed observation and raw bytes through recheck",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3WorkspaceFixture(t);
    const result = await trust.readFixedR3WorkspaceObservation({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef,
      state: "active"
    });
    t.after(() => result.close());
    assert.deepEqual(result.observation, f.observation);
    assert.equal(result.observationDigest, sha256Bytes(f.observationBytes));
    assert.equal(result.bindingDigest, sha256Bytes(f.bindingBytes));
    assert.equal(result.jobAdmissionDigest, sha256Bytes(f.admissionBytes));
    assert.equal(result.creationSpecDigest, sha256Bytes(f.specBytes));
    assert.equal(result.build.promotionEligible, false);
    assert.deepEqual(result.rawInputs["mounts.stdout"], f.raw["mounts.stdout"]);
    assert.deepEqual(result.rawInputs["mounts.stderr"], Buffer.alloc(0));
    result.rawInputs["mounts.stdout"].fill(0);
    result.rawInputs.observation.fill(0);
    assert.deepEqual((await result.recheck()).rawInputs["mounts.stdout"], f.raw["mounts.stdout"]);
    await fs.writeFile(f.rawPaths["mounts.stdout"], Buffer.from("changed raw source"));
    await assert.rejects(result.recheck(), { code: "R3_WORKSPACE_INPUT_UNAVAILABLE" });
    await assert.rejects(result.recheck(), { code: "R3_WORKSPACE_INPUT_UNAVAILABLE" });
    noAuthorityAccess(f);
  }
);

test(
  "R3 WORKSPACE absence remains job-bound and terminal job fails recheck",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3WorkspaceFixture(t, "absent");
    const result = await trust.readFixedR3WorkspaceObservation({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef,
      state: "absent"
    });
    t.after(() => result.close());
    assert.equal(result.observation.facts.state, "absent");
    assert.equal(result.observation.promotionEligible, false);
    assert.deepEqual(result.rawInputs["mounts.stderr"], Buffer.alloc(0));
    assert.deepEqual((await result.recheck()).rawInputs.binding, f.bindingBytes);
    f.apiJob.status = "completed";
    f.apiJob.conclusion = "success";
    f.apiJob.completed_at = new Date().toISOString();
    await assert.rejects(result.recheck(), { code: "R3_WORKSPACE_INPUT_UNAVAILABLE" });
    noAuthorityAccess(f);
  }
);

test(
  "R3 WORKSPACE refuses wrong binding, report facts and missing raw source",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3WorkspaceFixture(t);
    const input = { repoRoot: f.repoRoot, operationRef: f.operationRef, state: "active" };
    const wrong = structuredClone(f.binding);
    wrong.signature = Buffer.alloc(64).toString("base64");
    await fs.writeFile(f.bindingPath, encodeManualJson(wrong));
    await assert.rejects(trust.readFixedR3WorkspaceObservation(input), {
      code: "R3_WORKSPACE_INPUT_UNAVAILABLE"
    });
    await fs.writeFile(f.bindingPath, f.bindingBytes);
    const bad = structuredClone(f.observation);
    bad.facts.loop.name = "/dev/loop9";
    const badBytes = encodeManualJson(bad);
    await fs.writeFile(f.observationPath, badBytes);
    await fs.writeFile(
      f.bindingPath,
      encodeManualJson(
        signR3WorkspaceBinding({
          observationBytes: badBytes,
          jobAdmissionBytes: f.admissionBytes,
          privateKey: f.forwardingPrivateKey
        })
      )
    );
    await assert.rejects(trust.readFixedR3WorkspaceObservation(input), {
      code: "R3_WORKSPACE_INPUT_UNAVAILABLE"
    });
    await fs.writeFile(f.observationPath, f.observationBytes);
    await fs.writeFile(f.bindingPath, f.bindingBytes);
    await fs.unlink(f.rawPaths["loops.stdout"]);
    await assert.rejects(trust.readFixedR3WorkspaceObservation(input), {
      code: "R3_WORKSPACE_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  }
);

async function replaceReceipt(f, mutate) {
  mutate(f.receipt);
  f.receiptBytes = encodeManualJson(f.receipt);
  await fs.writeFile(f.receiptPath, f.receiptBytes);
  f.gh.receipt = [
    verifiedItem(f.receiptBytes, f.sourceSha, "custody-receipt.json", "2026-09-01T00:00:02.000Z")
  ];
}
async function verifyFixture(f) {
  return verifier()({
    repoRoot: f.repoRoot,
    proofBytes: f.proofBytes,
    materialBytes: f.materialBytes
  });
}

function producerInput(f) {
  const objects = new Map();
  const calls = [];
  const receiptId = randomUUID();
  const storedAt = "2026-09-01T00:00:01.000Z";
  const retainUntil = new Date(Date.parse(storedAt) + 210 * 86400000).toISOString();
  // Separate closures are offline writer/reader doubles, not evidence of IAM.
  const writer = {
    createOnly({ key, bytes, contentDigest }) {
      calls.push({ role: "writer", operation: "createOnly", key });
      assert.equal(contentDigest, sha256Bytes(bytes));
      if (objects.has(key)) return { created: false };
      const metadata = {
        storeRef: `memory://private/${key}`,
        contentSizeBytes: bytes.length,
        storedAt,
        retainUntil
      };
      objects.set(key, { bytes: Buffer.from(bytes), metadata });
      return { created: true, ...metadata };
    }
  };
  const auditReader = {
    readMetadata({ key, identity }) {
      assert.equal(identity, "audit-reader");
      calls.push({ role: identity, operation: "Head", key });
      return { ...objects.get(key).metadata };
    },
    read({ key, identity }) {
      assert.equal(identity, "audit-reader");
      calls.push({ role: identity, operation: "Get", key });
      return Buffer.from(objects.get(key).bytes);
    }
  };
  return {
    objects,
    calls,
    receiptId,
    input: {
      proofBytes: f.proofBytes,
      materialBytes: f.materialBytes,
      verifiedProofAttestation: f.gh.proof,
      buildIdentity: {
        sourceSha: f.sourceSha,
        repository,
        workflowPath,
        sourceRef: "refs/heads/main",
        runId: String(runId),
        runAttempt: 1,
        protectedEnvironment: "trusted-image-build"
      },
      storage: {
        trustPolicy: "immutable-content-addressed/v1",
        writerIdentity: "evidence-writer",
        auditReaderIdentity: "audit-reader",
        ...writer,
        ...auditReader
      },
      now: () => new Date(storedAt),
      createReceiptId: () => receiptId
    }
  };
}

const producerFixtureOptions = {
  canonicalProof: true,
  extraEntrypoints: ["scripts/release/manual-build-custody-producer.mjs"]
};

test("H2 PRODUCED accepts real producer custody through the fixed consumer with distinct raw subjects", async (t) => {
  const f = await buildFixture(t, producerFixtureOptions);
  const custody = producerInput(f);
  f.receipt = await produceManualBuildCustody(custody.input);
  f.receiptBytes = encodeManualJson(f.receipt);
  assert.ok(Object.isFrozen(f.receipt));
  assert.equal(f.receipt.receiptId, custody.receiptId);
  assert.equal(f.receipt.contentDigest, sha256Bytes(f.proofBytes));
  assert.equal(f.receipt.readbackDigest, sha256Bytes(f.proofBytes));
  assert.equal(f.receipt.contentSizeBytes, f.proofBytes.length);
  assert.equal(f.receipt.attestationRef, sha256Canonical(f.gh.proof[0].attestation.bundle));
  assert.notEqual(f.receipt.attestationRef, f.proof.provenance.attestationRef);
  const expectedObjects = [
    [`evidence/${sha256Bytes(f.proofBytes).slice(7)}.json`, f.proofBytes],
    [`receipts/${custody.receiptId}.json`, f.receiptBytes],
    [`evidence/${sha256Bytes(f.materialBytes).slice(7)}.json`, f.materialBytes]
  ];
  assert.equal(custody.objects.size, expectedObjects.length);
  for (const [key, bytes] of expectedObjects) {
    assert.deepEqual(custody.objects.get(key).bytes, bytes);
    assert.deepEqual(
      custody.calls.filter((call) => call.key === key),
      [
        { role: "writer", operation: "createOnly", key },
        { role: "audit-reader", operation: "Head", key },
        { role: "audit-reader", operation: "Get", key }
      ]
    );
  }
  // Import the receipt bytes produced and read back by real custodyEvidence.
  await fs.writeFile(f.receiptPath, f.receiptBytes, { mode: 0o600 });
  f.gh.receipt = [
    verifiedItem(f.receiptBytes, f.sourceSha, "custody-receipt.json", "2026-09-01T00:00:02.000Z")
  ];
  const result = await verifyFixture(f);
  assert.deepEqual(result, {
    buildProofDigest: sha256Canonical(f.proof),
    proofRawDigest: sha256Bytes(f.proofBytes),
    materialRawDigest: sha256Bytes(f.materialBytes),
    custodyReceiptRawDigest: sha256Bytes(f.receiptBytes),
    promotionEligible: false
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(
    f.gh.calls.filter(({ args }) => args[0] === "attestation").map(({ args }) => args[2]),
    [f.proofPath, f.receiptPath]
  );
  assert.notEqual(sha256Bytes(f.proofBytes), sha256Bytes(f.receiptBytes));
  noAuthorityAccess(f);
});

test("H2 PRODUCED rejects internally bound legacy github run reference before custody creation", async (t) => {
  const f = await buildFixture(t, producerFixtureOptions);
  const legacyRef = `github://${repository}/actions/runs/${runId}`;
  f.material.ciRunRef = legacyRef;
  for (const image of f.material.images) image.buildRunRef = legacyRef;
  f.proof.provenance.ciRunRef = legacyRef;
  f.proof.provenance.registryResolutionEvidenceDigest = sha256Canonical(f.material);
  f.proof.provenance.materials.find(({ name }) => name === "build-material-observation").reference =
    sha256Canonical(f.material);
  f.proofBytes = encodeManualJson(f.proof);
  f.materialBytes = Buffer.from(JSON.stringify(f.material, null, 2) + "\n");
  f.gh.proof = [verifiedItem(f.proofBytes, f.sourceSha, "build-proof.json")];
  const custody = producerInput(f);
  await assert.rejects(produceManualBuildCustody(custody.input), {
    code: "MANUAL_BUILD_CUSTODY_IDENTITY_INVALID"
  });
  assert.deepEqual(custody.calls, []);
  assert.equal(custody.objects.size, 0);
  assert.deepEqual(f.gh.calls, []);
  noAuthorityAccess(f);
});

test("H2 accepts two independently verified same-run subjects while separating raw and canonical proof digests", async (t) => {
  verifier();
  const f = await buildFixture(t);
  assert.notEqual(sha256Bytes(f.proofBytes), sha256Canonical(f.proof));
  const result = await verifyFixture(f);
  assert.deepEqual(result, {
    buildProofDigest: sha256Canonical(f.proof),
    proofRawDigest: sha256Bytes(f.proofBytes),
    materialRawDigest: sha256Bytes(f.materialBytes),
    custodyReceiptRawDigest: sha256Bytes(f.receiptBytes),
    promotionEligible: false
  });
  assert.ok(Object.isFrozen(result));
  for (const file of [f.proofPath, f.receiptPath]) {
    const call = f.gh.calls.find(({ args }) => args[2] === file);
    assert.deepEqual(call.args, [
      "attestation",
      "verify",
      file,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/${workflowPath}`,
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      f.sourceSha,
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners",
      "--format",
      "json"
    ]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 120000);
    assert.equal(call.options.maxBuffer, 1048576);
  }
  assert.equal(f.gh.calls.filter(({ args }) => args[0] === "attestation").length, 2);
  noAuthorityAccess(f);
});

for (const [name, mutate] of [
  ["missing proof", async (f) => fs.unlink(f.proofPath)],
  ["missing material", async (f) => fs.unlink(f.materialPath)],
  ["oversize proof", async (f) => fs.writeFile(f.proofPath, Buffer.alloc(1048577))],
  ["oversize material", async (f) => fs.writeFile(f.materialPath, Buffer.alloc(1048577))],
  ["oversize receipt", async (f) => fs.writeFile(f.receiptPath, Buffer.alloc(1048577))],
  [
    "caller proof differs",
    async (f) => {
      f.proofBytes = Buffer.concat([f.proofBytes, Buffer.from(" ")]);
    }
  ],
  [
    "caller material differs",
    async (f) => {
      f.materialBytes = Buffer.concat([f.materialBytes, Buffer.from(" ")]);
    }
  ],
  ["noncanonical receipt", async (f) => fs.appendFile(f.receiptPath, "\n")],
  [
    "receipt symlink",
    async (f) => {
      await fs.rename(f.receiptPath, f.receiptPath + ".original");
      await fs.symlink(f.receiptPath + ".original", f.receiptPath);
    }
  ],
  [
    "proof changes during verification",
    async (f) => {
      f.gh.before = async () => {
        await fs.appendFile(f.proofPath, " ");
      };
    }
  ],
  [
    "material changes during verification",
    async (f) => {
      f.gh.before = async () => {
        await fs.appendFile(f.materialPath, " ");
      };
    }
  ],
  [
    "receipt changes during verification",
    async (f) => {
      f.gh.before = async () => {
        await fs.appendFile(f.receiptPath, " ");
      };
    }
  ],
  [
    "path ABA during verification",
    async (f) => {
      let done = false;
      f.gh.before = async () => {
        if (done) return;
        done = true;
        await fs.rename(f.proofPath, f.proofPath + ".moved");
        await fs.rename(f.proofPath + ".moved", f.proofPath);
      };
    }
  ],
  [
    "unattested receipt",
    async (f) => {
      f.gh.receipt = [];
    }
  ],
  [
    "proof subject uses canonical digest",
    async (f) => {
      f.gh.proof[0].verificationResult.statement.subject[0].digest.sha256 = sha256Canonical(
        f.proof
      ).slice(7);
    }
  ],
  [
    "receipt subject mismatch",
    async (f) => {
      f.gh.receipt[0].verificationResult.statement.subject[0].digest.sha256 = "f".repeat(64);
    }
  ],
  [
    "untrusted issuer",
    async (f) => {
      f.gh.proof[0].verificationResult.signature.certificate.issuer = "https://untrusted.invalid";
    }
  ],
  [
    "receipt workflow mismatch",
    async (f) => {
      f.gh.receipt[0].verificationResult.signature.certificate.buildSignerURI =
        "https://github.com/other/repo/.github/workflows/other.yml@refs/heads/main";
    }
  ],
  [
    "receipt source mismatch",
    async (f) => {
      f.gh.receipt[0].verificationResult.signature.certificate.sourceRepositoryDigest = "f".repeat(
        40
      );
    }
  ],
  [
    "receipt run mismatch",
    async (f) => {
      f.gh.receipt[0].verificationResult.signature.certificate.runInvocationURI = `https://github.com/${repository}/actions/runs/2802/attempts/1`;
    }
  ],
  [
    "receipt self-hosted runner",
    async (f) => {
      f.gh.receipt[0].verificationResult.signature.certificate.runnerEnvironment = "self-hosted";
    }
  ],
  [
    "untrusted repository",
    async (f) => {
      f.gh.proof[0].verificationResult.signature.certificate.sourceRepositoryURI =
        "https://github.com/other/repository";
    }
  ],
  [
    "non-main source",
    async (f) => {
      f.gh.proof[0].verificationResult.signature.certificate.sourceRepositoryRef =
        "refs/heads/feature";
    }
  ],
  [
    "predicate cannot provide missing certificate",
    async (f) => {
      delete f.gh.proof[0].verificationResult.signature;
      f.gh.proof[0].verificationResult.statement.predicate.verified = true;
    }
  ],
  [
    "multiple matching attestations",
    async (f) => {
      f.gh.proof.push(structuredClone(f.gh.proof[0]));
    }
  ],
  [
    "bundle reference mismatch",
    async (f) => {
      f.gh.proof[0].attestation.bundle.dsseEnvelope.signatures[0].sig = Buffer.alloc(
        64,
        2
      ).toString("base64");
    }
  ],
  [
    "failed run",
    async (f) => {
      f.gh.run.conclusion = "failure";
    }
  ],
  [
    "incomplete run",
    async (f) => {
      f.gh.run.status = "in_progress";
    }
  ],
  [
    "run source mismatch",
    async (f) => {
      f.gh.run.head_sha = "f".repeat(40);
    }
  ],
  [
    "run workflow mismatch",
    async (f) => {
      f.gh.run.path = ".github/workflows/other.yml";
    }
  ],
  [
    "run attempt mismatch",
    async (f) => {
      f.gh.run.run_attempt = 2;
    }
  ],
  [
    "timeout",
    async (f) => {
      f.gh.error = Object.assign(new Error("synthetic timeout"), {
        killed: true,
        code: "ETIMEDOUT"
      });
    }
  ],
  [
    "oversize stdout",
    async (f) => {
      f.gh.raw = Buffer.alloc(1048577, 32);
    }
  ],
  [
    "oversize stderr",
    async (f) => {
      f.gh.stderr = Buffer.alloc(1048577, 32);
    }
  ],
  [
    "invalid UTF-8 gh output",
    async (f) => {
      f.gh.raw = Buffer.from([0xff]);
    }
  ],
  [
    "verifier source byte drift",
    async (f) => {
      await fs.appendFile(path.join(f.repoRoot, "scripts/release/verify-build-proof.mjs"), " ");
    }
  ],
  [
    "committed source drift",
    async (f) => {
      await fs.appendFile(path.join(f.repoRoot, "scripts/release/verify-build-proof.mjs"), " ");
      await git(f.repoRoot, "add", "--all");
      await git(f.repoRoot, "commit", "--no-verify", "-m", "Synthetic changed source");
    }
  ],
  [
    "migration catalog drift",
    async (f) => {
      const directory = path.join(
        f.repoRoot,
        "apps/api/prisma/migrations/20260901000000_synthetic"
      );
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "migration.sql"), "SELECT 1;\n");
    }
  ]
]) {
  test(`H2 rejects ${name} before authority access`, async (t) => {
    verifier();
    const f = await buildFixture(t);
    await mutate(f);
    await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
    noAuthorityAccess(f);
  });
}

for (const [name, mutate] of [
  [
    "raw rather than canonical content",
    (r, f) => {
      r.contentDigest = sha256Bytes(f.proofBytes);
      r.readbackDigest = r.contentDigest;
    }
  ],
  [
    "canonical proof size",
    (r) => {
      r.contentSizeBytes++;
    }
  ],
  [
    "owner",
    (r) => {
      r.owner = "other";
    }
  ],
  [
    "reader order",
    (r) => {
      r.readers.reverse();
    }
  ],
  [
    "retention below 90 days",
    (r) => {
      r.retainUntil = "2026-11-29T23:59:59.999Z";
    }
  ],
  [
    "expiry disposition",
    (r) => {
      r.expiryDisposition = "delete";
    }
  ],
  [
    "attestation reference",
    (r) => {
      r.attestationRef = digest("e");
    }
  ],
  [
    "legacy receipt version",
    (r) => {
      r.schemaVersion = "custody-receipt.v1";
    }
  ],
  [
    "self-selected policy",
    (r) => {
      r.retentionDays = 1;
    }
  ],
  [
    "public Actions artifact",
    (r) => {
      r.storeRef = `https://github.com/${repository}/actions/artifacts/123`;
    }
  ]
]) {
  test(`H2 rejects independently attested receipt with wrong ${name}`, async (t) => {
    verifier();
    const f = await buildFixture(t);
    await replaceReceipt(f, (receipt) => mutate(receipt, f));
    await assert.rejects(verifyFixture(f), { code: "TRUSTED_BUILD_UNAVAILABLE" });
    noAuthorityAccess(f);
  });
}

test("H2 requires the fixed retention90 receipt and never falls back to the old import filename", async (t) => {
  verifier();
  const f = await buildFixture(t);
  await fs.rename(
    f.receiptPath,
    f.receiptPath.replace(".custody-receipt.retention90.v1.json", ".custody-receipt.v1.json")
  );
  await assert.rejects(verifyFixture(f), { code: "MANUAL_BUILD_CUSTODY_INPUT_REQUIRED" });
  noAuthorityAccess(f);
});
test("H2 ignores nonauthoritative download URL changes and keeps builder-material provenance separate", async (t) => {
  verifier();
  const f = await buildFixture(t);
  f.gh.proof[0].attestation.bundle_url =
    "https://another.invalid/ephemeral-download?synthetic=only";
  assert.notEqual(f.proof.provenance.attestationRef, f.receipt.attestationRef);
  const result = await verifyFixture(f);
  assert.equal(result.buildProofDigest, sha256Canonical(f.proof));
  noAuthorityAccess(f);
});
test("H2 cannot accept a caller-selected custody policy", async (t) => {
  verifier();
  const f = await buildFixture(t);
  await assert.rejects(
    verifier()({
      repoRoot: f.repoRoot,
      proofBytes: f.proofBytes,
      materialBytes: f.materialBytes,
      trustRoot: { custody: { retentionDays: 1 } }
    }),
    { code: "TRUSTED_BUILD_UNAVAILABLE" }
  );
  noAuthorityAccess(f);
});

test("H1ROOT rejects a same-permissions root replacement after its initial ACL observation", async (t) => {
  const f = await fixture(t);
  const replacement = path.join(f.root, "replacement-key-root");
  await fs.mkdir(replacement, { mode: 0o700 });
  const open = fs.open.bind(fs);
  let replaced = false;
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.approvalPath && !replaced) {
      replaced = true;
      await fs.rename(f.profile.storage.keyRoot, f.profile.storage.keyRoot + "-old");
      await fs.rename(replacement, f.profile.storage.keyRoot);
    }
    return open(file, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
    code: "H1_INPUT_UNAVAILABLE"
  });
  noAuthorityAccess(f);
});

function bootstrap() {
  assert.equal(
    typeof production().openTrustedManualSession,
    "function",
    "trusted session bootstrap must exist"
  );
  return production().openTrustedManualSession;
}
test("R3 SESSION API rejects overrides and accessors before native IO", async (t) => {
  assert.equal(typeof production().openTrustedR3CreationSession, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected IO or accessor");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = { repoRoot: path.resolve("unused"), operationRef: randomUUID() };
  for (const value of [
    { ...input, privateKey: "caller-key" },
    { ...input, targetIntent: { endpointPolicyId: "caller" } },
    { ...input, jobAdmissionBytes: Buffer.from("{}") },
    { ...input, operationRef: "../escape" },
    Object.defineProperty({ ...input }, "operationRef", { get: denied, enumerable: true })
  ])
    await assert.rejects(production().openTrustedR3CreationSession(value), {
      code: "R3_CREATION_SESSION_UNAVAILABLE"
    });
  assert.equal(effects, 0);
});
test(
  "R3 SESSION refuses terminal job and changed H2 before H1 key access",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3JobFixture(t);
    const input = { repoRoot: f.repoRoot, operationRef: f.operationRef };
    f.apiJob.status = "completed";
    f.apiJob.conclusion = "success";
    f.apiJob.completed_at = new Date().toISOString();
    await assert.rejects(production().openTrustedR3CreationSession(input), {
      code: "R3_CREATION_SESSION_UNAVAILABLE"
    });
    noAuthorityAccess(f);
    f.apiJob.status = "in_progress";
    f.apiJob.conclusion = null;
    f.apiJob.completed_at = null;
    await fs.appendFile(f.specPath, " ");
    await assert.rejects(production().openTrustedR3CreationSession(input), {
      code: "R3_CREATION_SESSION_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  }
);
async function r3SessionFixture(t) {
  const f = await r3JobFixture(t, { phase: "source", chain: "fresh" });
  for (const role of ["journal", "archive", "backup"])
    await fs.mkdir(path.join(f.profile.storage[`${role}Root`], "objects"), { mode: 0o700 });
  for (const directory of ["locks", "consumptions", "revocations", "checkpoints"])
    await fs.mkdir(path.join(f.profile.storage.journalRoot, directory), { mode: 0o700 });
  await fs.mkdir(path.join(f.profile.storage.archiveRoot, "raw"), { mode: 0o700 });
  const profileDigest = sha256Canonical(f.profile);
  const genesis = {
    schemaVersion: "manual-operation-record.v2",
    kind: "revocation",
    profileDigest,
    recordedAt: generatedAt,
    promotionEligible: false,
    ownerId: f.profile.ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  for (const file of [
    path.join(
      f.profile.storage.journalRoot,
      "objects",
      `${sha256Canonical(genesis).slice(7)}.json`
    ),
    path.join(f.profile.storage.journalRoot, "revocations", `${profileDigest.slice(7)}-0.json`)
  ])
    await fs.writeFile(file, encodeManualJson(genesis), { mode: 0o600, flag: "wx" });
  const keyPath = path.join(f.profile.storage.keyRoot, f.profile.storage.keyRef);
  await fs.writeFile(keyPath, f.keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
    flag: "wx"
  });
  return { ...f, keyPath };
}
test(
  "R3 SESSION opens target creation scope and locally closes after job termination",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await r3SessionFixture(t);
    const session = await production().openTrustedR3CreationSession({
      repoRoot: f.repoRoot,
      operationRef: f.operationRef
    });
    t.after(() => session.close());
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/u);
    assert.match(session.sessionNonce, /^[0-9a-f]{64}$/u);
    assert.equal(session.profileDigest, sha256Canonical(f.profile));
    assert.equal(session.scope.targetPolicyDigest, f.spec.targetPolicyDigest);
    assert.equal(session.scope.creationSpecDigest, sha256Bytes(f.specBytes));
    assert.equal(session.scope.jobAdmissionDigest, sha256Bytes(f.admissionBytes));
    assert.equal(session.scope.buildProofDigest, sha256Canonical(f.proof));
    assert.equal(session.scope.sourceSha, f.sourceSha);
    assert.equal(session.scope.phase, "source");
    assert.equal(session.scope.chain, "fresh");
    for (const name of ["sign", "consume", "record", "close"])
      assert.equal(typeof session[name], "function");
    assert.ok(f.counters.privateKeyReads > 0);
    f.apiJob.status = "completed";
    f.apiJob.conclusion = "success";
    f.apiJob.completed_at = new Date().toISOString();
    await assert.rejects(session.sign({}), { code: "R3_CREATION_SESSION_UNAVAILABLE" });
    await session.close();
    await session.close();
    assert.deepEqual(await fs.readdir(path.join(f.profile.storage.journalRoot, "locks")), []);
  }
);
async function sessionFixture(t) {
  const f = await buildFixture(t);
  const operationRef = randomUUID();
  const operation = {
    schemaVersion: "manual-operation-input.v1",
    operationRef,
    runId: randomUUID(),
    createdAt: generatedAt,
    profileDigest: sha256Canonical(f.profile),
    buildProofDigest: sha256Canonical(f.proof),
    proofRawDigest: sha256Bytes(f.proofBytes),
    materialRawDigest: sha256Bytes(f.materialBytes),
    custodyReceiptRawDigest: sha256Bytes(f.receiptBytes),
    targetIntent: { endpointPolicyId: "synthetic-policy", databaseName: "synthetic-db" },
    purpose: "synthetic-fresh",
    scenario: "normal",
    operations: Object.fromEntries(
      ["observe", "migrate", "verify"].map((phase) => [
        phase,
        { operationId: randomUUID(), idempotencyKey: `manual-stage1:${operationRef}:${phase}` }
      ])
    ),
    promotionEligible: false
  };
  const indexPath = path.join(
    f.profile.storage.archiveRoot,
    "inputs",
    "operations",
    operationRef,
    "index.json"
  );
  await fs.mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(indexPath, encodeManualJson(operation), { mode: 0o600, flag: "wx" });
  for (const role of ["journal", "archive", "backup"])
    await fs.mkdir(path.join(f.profile.storage[`${role}Root`], "objects"), { mode: 0o700 });
  for (const directory of ["locks", "consumptions", "revocations", "checkpoints"])
    await fs.mkdir(path.join(f.profile.storage.journalRoot, directory), { mode: 0o700 });
  await fs.mkdir(path.join(f.profile.storage.archiveRoot, "raw"), { mode: 0o700 });
  const genesis = {
    schemaVersion: "manual-operation-record.v2",
    kind: "revocation",
    profileDigest: operation.profileDigest,
    recordedAt: generatedAt,
    promotionEligible: false,
    ownerId: f.profile.ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  for (const file of [
    path.join(
      f.profile.storage.journalRoot,
      "objects",
      `${sha256Canonical(genesis).slice(7)}.json`
    ),
    path.join(
      f.profile.storage.journalRoot,
      "revocations",
      `${operation.profileDigest.slice(7)}-0.json`
    )
  ])
    await fs.writeFile(file, encodeManualJson(genesis), { mode: 0o600, flag: "wx" });
  const keyPath = path.join(f.profile.storage.keyRoot, f.profile.storage.keyRef);
  await fs.writeFile(keyPath, f.keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
    flag: "wx"
  });
  return { ...f, operationRef, operation, indexPath, keyPath };
}
function openFixture(f, extra = {}) {
  return bootstrap()({
    repoRoot: f.repoRoot,
    proofBytes: f.proofBytes,
    materialBytes: f.materialBytes,
    operationRef: f.operationRef,
    ...extra
  });
}
test("OPEN opens and closes the existing native single-parent session only after fixed trust checks", async (t) => {
  bootstrap();
  const f = await sessionFixture(t);
  const session = await openFixture(f);
  assert.equal(session.profileDigest, sha256Canonical(f.profile));
  assert.deepEqual(session.targetIntent, f.operation.targetIntent);
  assert.equal(typeof session.sign, "function");
  assert.equal(typeof session.close, "function");
  assert.ok(f.counters.privateKeyReads > 0);
  assert.ok(f.counters.writes > 0);
  await session.close();
  assert.deepEqual(await fs.readdir(path.join(f.profile.storage.journalRoot, "locks")), []);
});
for (const [name, mutate] of [
  ["H1 approval failure", async (f) => fs.appendFile(f.approvalPath, " ")],
  [
    "receipt verification failure",
    async (f) => {
      f.gh.receipt = [];
    }
  ],
  [
    "caller bytes differ",
    async (f) => {
      f.proofBytes = Buffer.concat([f.proofBytes, Buffer.from(" ")]);
    }
  ],
  [
    "index receipt identity differs",
    async (f) => {
      f.operation.custodyReceiptRawDigest = digest("e");
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "index contains future approval",
    async (f) => {
      f.operation.approved = true;
      await fs.writeFile(f.indexPath, encodeManualJson(f.operation));
    }
  ],
  [
    "source changes during build verification",
    async (f) => {
      f.gh.before = async () => fs.appendFile(path.join(f.repoRoot, profileName), " ");
    }
  ]
]) {
  test(`OPEN rejects ${name} before private-key reads or session writes`, async (t) => {
    bootstrap();
    const f = await sessionFixture(t);
    await mutate(f);
    await assert.rejects(openFixture(f));
    noAuthorityAccess(f);
  });
}
for (const [name, mutate] of [
  [
    "wrong Ed25519 fingerprint",
    async (f) =>
      fs.writeFile(
        f.keyPath,
        generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
      )
  ],
  [
    "non-Ed25519 key",
    async (f) =>
      fs.writeFile(
        f.keyPath,
        generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          type: "pkcs8",
          format: "pem"
        })
      )
  ],
  [
    "linked key",
    async (f) => {
      await fs.rename(f.keyPath, f.keyPath + ".original");
      await fs.symlink(f.keyPath + ".original", f.keyPath);
    }
  ],
  ["key read permissions", async (f) => fs.chmod(f.keyPath, 0o644)],
  ["oversize key", async (f) => fs.writeFile(f.keyPath, Buffer.alloc(1048577))]
]) {
  test(`OPEN rejects ${name} without establishing a session`, async (t) => {
    bootstrap();
    const f = await sessionFixture(t);
    await mutate(f);
    await assert.rejects(openFixture(f));
    assert.equal(f.counters.writes, 0);
  });
}
for (const name of [
  "io",
  "ownerObservation",
  "signingKey",
  "targetIntent",
  "verified",
  "profileFile",
  "archiveRoot"
]) {
  test(`OPEN rejects caller-selected ${name}`, async (t) => {
    bootstrap();
    const f = await sessionFixture(t);
    await assert.rejects(openFixture(f, { [name]: true }));
    noAuthorityAccess(f);
  });
}

async function rebind(f) {
  f.approval.profileDigest = sha256Canonical(f.profile);
  f.approval.ownerId = f.profile.ownerId;
  const approvalBytes = encodeManualJson(f.approval),
    approvalDigest = sha256Bytes(approvalBytes);
  f.binding = {
    ...f.approval,
    schemaVersion: "manual-stage1-owner-binding.v1",
    approvalDigest,
    approvalReference: `inputs/h1/${approvalDigest.slice(7)}.approval.json`
  };
  f.approvalPath = path.join(f.profile.storage.archiveRoot, f.binding.approvalReference);
  await fs.writeFile(path.join(f.repoRoot, profileName), encodeManualJson(f.profile));
  await fs.writeFile(path.join(f.repoRoot, bindingName), encodeManualJson(f.binding));
  await fs.writeFile(f.approvalPath, approvalBytes, { mode: 0o600, flag: "wx" });
}
const syntheticSid = "S-1-5-21-111-222-333-1001";
const trustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const machineGuid = "01234567-89ab-4cde-8fab-0123456789ab";
async function windowsFixture(t) {
  const f = await fixture(t);
  f.approval.principal = { platform: "win32", sid: syntheticSid };
  f.approval.hostFingerprint = sha256Bytes(
    Buffer.from(`subscription-saas/win32-machine-guid/v1\n${machineGuid}`)
  );
  await rebind(f);
  const systemFiles = [
    "C:\\Windows\\System32\\reg.exe",
    "C:\\Windows\\System32\\whoami.exe",
    "C:\\Windows\\System32\\icacls.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  ];
  const mapped = (file) => path.join(f.root, "synthetic-system", ...file.slice(3).split("\\"));
  for (const file of systemFiles) {
    await fs.mkdir(path.dirname(mapped(file)), { recursive: true });
    await fs.writeFile(mapped(file), "synthetic OS executable", { mode: 0o755 });
  }
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const nativeLstat = fs.lstat.bind(fs),
    nativeRealpath = fs.realpath.bind(fs),
    open = fs.open.bind(fs);
  const isSystem = (file) => typeof file === "string" && file.startsWith("C:\\Windows");
  t.mock.method(fs, "lstat", (file, ...args) =>
    nativeLstat(isSystem(file) ? mapped(file) : file, ...args)
  );
  t.mock.method(fs, "realpath", (file, ...args) =>
    isSystem(file) ? Promise.resolve(file) : nativeRealpath(file, ...args)
  );
  t.mock.method(fs, "open", (file, ...args) => open(isSystem(file) ? mapped(file) : file, ...args));
  const windows = {
    guid: machineGuid,
    sid: syntheticSid,
    badSystemOwner: false,
    writableSystem: false,
    extraOutput: false,
    oversize: false,
    timeout: false,
    calls: [],
    before: null
  };
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    windows.calls.push({ file, args: [...args], options: { ...options } });
    let output;
    if (file === systemFiles[0])
      output = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    {${windows.guid}}\r\n`;
    else if (file === systemFiles[1])
      output = `"synthetic\\owner","${windows.sid}"\r\n${windows.extraOutput ? '"other","S-1-5-18"\r\n' : ""}`;
    else if (file === systemFiles[2])
      output = "Successfully processed 1 files; Failed processing 0 files\r\n";
    else if (file === systemFiles[3]) {
      const system = args.at(-1).includes("C:\\Windows");
      output = system
        ? `${windows.badSystemOwner ? syntheticSid : trustedInstallerSid}\n${trustedInstallerSid}|Allow|2032127\nS-1-5-18|Allow|2032127\nS-1-5-32-544|Allow|2032127\nS-1-5-32-545|Allow|${windows.writableSystem ? 2032127 : 1179817}\n`
        : `${syntheticSid}\n${syntheticSid}|Allow|2032127\n`;
      output += "attributes|0\n";
    } else {
      queueMicrotask(() =>
        callback(
          new Error("Unexpected synthetic Windows process"),
          Buffer.alloc(0),
          Buffer.alloc(0)
        )
      );
      return {};
    }
    Promise.resolve()
      .then(async () => {
        if (windows.before) await windows.before(file, args);
        callback(
          windows.timeout
            ? Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" })
            : null,
          windows.oversize && [systemFiles[0], systemFiles[1]].includes(file)
            ? Buffer.alloc(8193, 32)
            : Buffer.from(output),
          Buffer.alloc(0)
        );
      })
      .catch((error) => callback(error, Buffer.alloc(0), Buffer.alloc(0)));
    return { kill() {} };
  });
  syncBuiltinESMExports();
  return { ...f, windows, systemFiles, mapped };
}
test("WIN accepts fixed executable MachineGuid and unique SID observations with system ACL provenance", async (t) => {
  const f = await windowsFixture(t);
  const profile = await production().loadFixedManualProfile({ repoRoot: f.repoRoot });
  assert.deepEqual(profile, f.profile);
  const reg = f.windows.calls.find(({ file }) => file === f.systemFiles[0]);
  const whoami = f.windows.calls.find(({ file }) => file === f.systemFiles[1]);
  assert.deepEqual(reg.args, [
    "QUERY",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
    "/reg:64"
  ]);
  assert.deepEqual(whoami.args, ["/user", "/fo", "csv", "/nh"]);
  for (const call of [reg, whoami]) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 8192);
  }
  noAuthorityAccess(f);
});
for (const [name, mutate] of [
  [
    "wrong MachineGuid",
    (f) => {
      f.windows.guid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    }
  ],
  [
    "uppercase MachineGuid",
    (f) => {
      f.windows.guid = machineGuid.toUpperCase();
    }
  ],
  [
    "wrong SID",
    (f) => {
      f.windows.sid = "S-1-5-18";
    }
  ],
  [
    "ambiguous SID rows",
    (f) => {
      f.windows.extraOutput = true;
    }
  ],
  [
    "untrusted executable owner",
    (f) => {
      f.windows.badSystemOwner = true;
    }
  ],
  [
    "user-writable executable",
    (f) => {
      f.windows.writableSystem = true;
    }
  ],
  [
    "host probe output limit",
    (f) => {
      f.windows.oversize = true;
    }
  ],
  [
    "host probe timeout",
    (f) => {
      f.windows.timeout = true;
    }
  ]
]) {
  test(`WIN rejects ${name} before authority access`, async (t) => {
    const f = await windowsFixture(t);
    mutate(f);
    await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
      code: "H1_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  });
}

test("H1 tolerates an unrelated public sibling created while fixed inputs are held", async (t) => {
  const f = await fixture(t),
    sibling = path.join(tmpdir(), "r13-public-sibling-" + randomUUID()),
    open = fs.open.bind(fs);
  let created = false;
  t.after(async () => {
    if (created) await fs.rmdir(sibling);
  });
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === f.approvalPath && !created) {
      await fs.mkdir(sibling, { mode: 0o700 });
      created = true;
    }
    return open(file, ...args);
  });
  assert.deepEqual(await production().loadFixedManualProfile({ repoRoot: f.repoRoot }), f.profile);
  assert.equal(created, true);
  noAuthorityAccess(f);
});

test("H1 accepts independently published approval and returns a deep-frozen profile without authority access", async (t) => {
  const f = await fixture(t);
  const loaded = await production().loadFixedManualProfile({ repoRoot: f.repoRoot });
  assert.deepEqual(loaded, f.profile);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.allowedTargets[0].roles));
  assert.ok(Object.isFrozen(loaded.storage));
  noAuthorityAccess(f);
});

for (const mutation of [
  [
    "profile digest",
    async (f) => {
      f.profile.ownerId = "other";
      await fs.writeFile(path.join(f.repoRoot, profileName), encodeManualJson(f.profile));
    }
  ],
  [
    "closed sidecar",
    async (f) => {
      f.binding.approved = true;
      await fs.writeFile(path.join(f.repoRoot, bindingName), encodeManualJson(f.binding));
    }
  ],
  [
    "missing independent approval",
    async (f) => {
      await fs.unlink(f.approvalPath);
    }
  ],
  [
    "approval bytes",
    async (f) => {
      await fs.appendFile(f.approvalPath, "\n");
    }
  ],
  [
    "actual host",
    async (f) => {
      await fs.writeFile(f.machineFile, "f".repeat(32));
    }
  ],
  [
    "actual principal",
    async (f) => {
      f.binding.principal.uid++;
      await fs.writeFile(path.join(f.repoRoot, bindingName), encodeManualJson(f.binding));
    }
  ],
  ...rootNames.map((name) => [
    `${name} root ACL`,
    async (f) => {
      await fs.chmod(f.profile.storage[`${name}Root`], 0o755);
    }
  ])
]) {
  test(`H1 rejects ${mutation[0]} before key access or session writes`, async (t) => {
    const f = await fixture(t);
    await mutation[1](f);
    await assert.rejects(production().loadFixedManualProfile({ repoRoot: f.repoRoot }), {
      code: "H1_INPUT_UNAVAILABLE"
    });
    noAuthorityAccess(f);
  });
}
