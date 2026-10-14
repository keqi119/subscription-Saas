import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { publishR3SnapshotFixture } from "../../packages/release-foundation/test/r3-snapshot-input-fixture.mjs";
import * as admission from "./r3-snapshot-input-admission.mjs";
const d = (x) => "sha256:" + x.repeat(64);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "snapshot-prepare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = JSON.parse(
    await fs.readFile(
      new URL("../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
    )
  );
  profile.validFrom = "2020-01-01T00:00:00.000Z";
  profile.expiresAt = "2099-01-01T00:00:00.000Z";
  for (const key of ["key", "journal", "archive", "backup", "credential"])
    profile.storage[key + "Root"] = path.join(root, key);
  const f = await publishR3SnapshotFixture({ root, profile });
  const { permission, ...index } = f.index;
  const { recordVersion, ...refs } = index;
  const preparation = {
    recordVersion: "r3-snapshot-input-preparation.v1",
    ...refs,
    operationRef: randomUUID(),
    creationSpecDigest: d("c"),
    sourceSha: f.s.envelope.sourceSha,
    phase: "source",
    releaseAttemptId: f.s.envelope.releaseAttemptId,
    snapshotRunId: f.s.envelope.snapshotRunId,
    validUntil: f.declarations.permission.validUntil,
    sourceAuthority: f.declarations.permission.sourceAuthority,
    sourceIdentity: f.declarations.permission.sourceIdentity,
    restrictionOriginals: []
  };
  return {
    ...f,
    preparation,
    args: {
      profile,
      preparationBytes: encodeManualJson(preparation),
      observedAt: "2026-09-28T00:00:00.000Z",
      readRaw: (digest) => fs.readFile(f.rawPath({ digest }))
    }
  };
}
test("snapshot preparation validates the real declaration closure without a permission or destination", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof admission.readR3SnapshotPreparationDeclarations, "function");
  const checked = await admission.readR3SnapshotPreparationDeclarations(f.args);
  assert.equal(checked.preparationDigest, sha256Bytes(f.args.preparationBytes));
  assert.equal(checked.inputReference, f.preparation.inputReference);
  assert.equal(Object.hasOwn(checked, "assertConsumerBinding"), false);
  assert.equal(Object.hasOwn(checked, "permissionDigest"), false);
  assert.ok(checked.rawReferences.some((x) => x.digest === f.preparation.sourceAuthority.digest));
  assert.ok(!checked.rawReferences.some((x) => x.digest === f.s.envelope.ciphertextDigest));
  for (const patch of [
    { sourceAuthority: { digest: d("0"), bytes: 10 } },
    { sourceSha: "f".repeat(40) },
    { permission: f.index.permission },
    { validUntil: "2098-01-01T00:00:00.000Z" }
  ]) {
    await assert.rejects(
      admission.readR3SnapshotPreparationDeclarations({
        ...f.args,
        preparationBytes: encodeManualJson({ ...f.preparation, ...patch })
      })
    );
  }
  const badIdentity = await f.publish({ ...f.identity, databaseIdentityFingerprint: d("0") });
  await assert.rejects(
    admission.readR3SnapshotPreparationDeclarations({
      ...f.args,
      preparationBytes: encodeManualJson({ ...f.preparation, sourceIdentity: badIdentity })
    })
  );
});
export { fixture };

test("snapshot assembler and destination index preserve originals and bind one actual phase/job", async (t) => {
  const f = await fixture(t);
  const mod = await import("./r3-snapshot-input-install.mjs").catch((e) => {
    if (e.code === "ERR_MODULE_NOT_FOUND") return {};
    throw e;
  });
  assert.equal(typeof mod.assembleR3SnapshotPreparation, "function");
  const assembled = await mod.assembleR3SnapshotPreparation({
    profile: f.profile,
    preparation: f.preparation,
    observedAt: f.args.observedAt,
    readRaw: f.args.readRaw
  });
  assert.deepEqual(assembled.preparationBytes, f.args.preparationBytes);
  assert.equal(assembled.preparationDigest, sha256Bytes(assembled.preparationBytes));
  const indexed = await mod.assembleR3SnapshotIndex({
    profile: f.profile,
    preparationBytes: assembled.preparationBytes,
    preparationDigest: assembled.preparationDigest,
    destinationDigest: d("7"),
    jobAdmissionDigest: d("6"),
    observedAt: f.args.observedAt,
    readRaw: f.args.readRaw
  });
  const finalPreparation = {
    ...f.preparation,
    phase: "final",
    inputReference: randomUUID(),
    operationRef: randomUUID()
  };
  const finalBytes = encodeManualJson(finalPreparation);
  const finalIndex = await mod.assembleR3SnapshotIndex({
    profile: f.profile,
    preparationBytes: finalBytes,
    preparationDigest: sha256Bytes(finalBytes),
    destinationDigest: d("5"),
    jobAdmissionDigest: d("4"),
    observedAt: f.args.observedAt,
    readRaw: f.args.readRaw
  });
  assert.equal(JSON.parse(finalIndex.permissionBytes).allowedUses[0].phase, "final");
  assert.notEqual(finalIndex.inputReference, indexed.inputReference);
  const permission = JSON.parse(indexed.permissionBytes);
  assert.deepEqual(permission.allowedUses, [
    {
      phase: "source",
      destinationAdmissionDigest: d("7"),
      readerPrincipal: `manual-h1:${sha256Canonical(f.profile)}`,
      decryptorPrincipal: `manual-h1:${sha256Canonical(f.profile)}`,
      userPrincipal: `manual-r3-job:${d("6")}`
    }
  ]);
  const raws = new Map(indexed.rawOriginals.map((x) => [x.digest, x.bytes]));
  const full = await admission.readR3SnapshotDeclarations({
    profile: f.profile,
    indexBytes: indexed.indexBytes,
    inputReference: f.preparation.inputReference,
    observedAt: f.args.observedAt,
    readRaw: async (d) => raws.get(d)
  });
  assert.equal(full.permissionDigest, sha256Bytes(indexed.permissionBytes));
  for (const patch of [
    { preparationDigest: d("0") },
    { destinationDigest: "not-a-digest" },
    { jobAdmissionDigest: "not-a-digest" }
  ])
    await assert.rejects(
      mod.assembleR3SnapshotIndex({
        profile: f.profile,
        preparationBytes: assembled.preparationBytes,
        preparationDigest: assembled.preparationDigest,
        destinationDigest: d("7"),
        jobAdmissionDigest: d("6"),
        observedAt: f.args.observedAt,
        readRaw: f.args.readRaw,
        ...patch
      })
    );
});

test(
  "local snapshot installation reuses identical raw, refuses replay and preserves a phase-specific index",
  { skip: process.platform !== "linux" },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T00:00:00.000Z") });
    const f = await fixture(t),
      mod = await import("./r3-snapshot-input-install.mjs");
    await fs.rm(path.dirname(f.indexPath), { recursive: true });
    const assembly = await mod.assembleR3SnapshotPreparation({
      profile: f.profile,
      preparation: f.preparation,
      observedAt: f.args.observedAt,
      readRaw: f.args.readRaw
    });
    const dir = path.join(
      f.profile.storage.archiveRoot,
      "inputs",
      "snapshots",
      "prepared",
      f.preparation.operationRef
    );
    await fs.mkdir(path.join(dir, "raw"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, "package.json"), assembly.preparationBytes, {
      flag: "wx",
      mode: 0o600
    });
    for (const x of assembly.rawOriginals)
      await fs.writeFile(path.join(dir, "raw", `${x.digest.slice(7)}.bin`), x.bytes, {
        flag: "wx",
        mode: 0o600
      });
    const scope = {
      phase: "source",
      chain: "snapshot",
      sourceSha: f.preparation.sourceSha,
      creationSpecDigest: f.preparation.creationSpecDigest,
      jobAdmissionDigest: d("6")
    };
    const preflight = await mod.readPreparedR3SnapshotInput({
      profile: f.profile,
      scope,
      operationRef: f.preparation.operationRef
    });
    assert.equal(preflight.preparationDigest, assembly.preparationDigest);
    const raw = f.rawPath(f.index.metadata),
      before = await fs.stat(raw, { bigint: true });
    const args = {
      profile: f.profile,
      scope,
      operationRef: f.preparation.operationRef,
      preparationDigest: assembly.preparationDigest,
      destinationDigest: d("7"),
      deadlineAtMs: Date.now() + 30000,
      deadlineAtMonoMs: performance.now() + 30000
    };
    await assert.rejects(
      mod.installR3SnapshotInputForCreatedTarget({ ...args, deadlineAtMs: Date.now() })
    );
    await assert.rejects(
      mod.installR3SnapshotInputForCreatedTarget({
        ...args,
        deadlineAtMonoMs: performance.now() - 1
      })
    );
    await assert.rejects(
      mod.readPreparedR3SnapshotInput({ profile: f.profile, scope, operationRef: randomUUID() })
    );
    const packageFile = path.join(dir, "package.json");
    await fs.writeFile(
      packageFile,
      encodeManualJson({ ...f.preparation, inputReference: randomUUID() })
    );
    await assert.rejects(mod.installR3SnapshotInputForCreatedTarget(args));
    await assert.rejects(fs.stat(path.join(dir, "install-started.json")), { code: "ENOENT" });
    await fs.writeFile(packageFile, assembly.preparationBytes);
    const result = await mod.installR3SnapshotInputForCreatedTarget(args);
    assert.equal(result.inputReference, f.preparation.inputReference);
    const after = await fs.stat(raw, { bigint: true });
    assert.equal(before.ino, after.ino);
    assert.equal(before.mtimeNs, after.mtimeNs);
    assert.equal(sha256Bytes(await fs.readFile(f.indexPath)), result.inputIndexDigest);
    await assert.rejects(mod.installR3SnapshotInputForCreatedTarget(args), { code: "EEXIST" });
    await assert.rejects(
      mod.installR3SnapshotInputForCreatedTarget({ ...args, preparationDigest: d("0") })
    );
    await assert.rejects(
      mod.readPreparedR3SnapshotInput({
        profile: f.profile,
        scope: { ...scope, phase: "final" },
        operationRef: f.preparation.operationRef
      })
    );
    // A distinct final phase installs after all source captures have closed;
    // the retained source declarations still authenticate from the same originals.
    const oldIndexBytes = await fs.readFile(f.indexPath);
    const finalPreparation = {
      ...f.preparation,
      phase: "final",
      operationRef: randomUUID(),
      inputReference: randomUUID()
    };
    const finalAssembly = await mod.assembleR3SnapshotPreparation({
      profile: f.profile,
      preparation: finalPreparation,
      observedAt: f.args.observedAt,
      readRaw: f.args.readRaw
    });
    const finalDir = path.join(
      f.profile.storage.archiveRoot,
      "inputs",
      "snapshots",
      "prepared",
      finalPreparation.operationRef
    );
    await fs.mkdir(path.join(finalDir, "raw"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(finalDir, "package.json"), finalAssembly.preparationBytes, {
      flag: "wx",
      mode: 0o600
    });
    for (const x of finalAssembly.rawOriginals)
      await fs.writeFile(path.join(finalDir, "raw", `${x.digest.slice(7)}.bin`), x.bytes, {
        flag: "wx",
        mode: 0o600
      });
    const finalResult = await mod.installR3SnapshotInputForCreatedTarget({
      ...args,
      scope: { ...scope, phase: "final", jobAdmissionDigest: d("4") },
      operationRef: finalPreparation.operationRef,
      preparationDigest: finalAssembly.preparationDigest,
      destinationDigest: d("5"),
      deadlineAtMonoMs: performance.now() + 30000
    });
    assert.notEqual(finalResult.inputReference, result.inputReference);
    assert.deepEqual(await fs.readFile(f.indexPath), oldIndexBytes);
    await admission.readR3SnapshotDeclarations({
      profile: f.profile,
      indexBytes: oldIndexBytes,
      inputReference: result.inputReference,
      observedAt: f.args.observedAt,
      readRaw: f.args.readRaw
    });
    await fs.appendFile(raw, " ");
    await assert.rejects(
      admission.readR3SnapshotDeclarations({
        profile: f.profile,
        indexBytes: oldIndexBytes,
        inputReference: result.inputReference,
        observedAt: f.args.observedAt,
        readRaw: f.args.readRaw
      })
    );
  }
);
