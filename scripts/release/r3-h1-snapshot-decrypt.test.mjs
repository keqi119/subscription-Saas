import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { mock } from "node:test";
import { encryptSnapshotStream } from "../../packages/release-foundation/src/snapshot/envelope-crypto.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";

let publicReader;
mock.module(new URL("./manual-stage1-trust.mjs", import.meta.url), {
  namedExports: { readFixedH1SnapshotPublicKeyInputs: (input) => publicReader(input) }
});
const { decryptR3SnapshotCiphertext } = await import("./r3-h1-snapshot-decrypt.mjs");
const UUID = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const BACKING = "/var/lib/stage1-ciphertext/main.luks";
const MAPPER = "/dev/mapper/stage1-h1-main";
const d = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const keyPair = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const keyFingerprint = d(keyPair.publicKey.export({ type: "spki", format: "der" }));

function authorization(aad) {
  const now = Date.now();
  const context = Object.fromEntries(
    Object.entries(aad).filter(([key]) => !["snapshotAllocatedAt", "snapshotDigest"].includes(key))
  );
  const digest = `sha256:${"a".repeat(64)}`;
  const keyReadbackDigest = `sha256:${"b".repeat(64)}`;
  const recoveryReadbackDigest = `sha256:${"c".repeat(64)}`;
  return {
    schemaVersion: "producer-crypto-run-authorization.v2",
    authorizationId: "fixture-local-authorization",
    executionPurpose: "qualification",
    repository: { name: "keqi119/subscription-Saas", id: aad.repositoryId },
    sourceSha: aad.sourceSha,
    releaseAttemptId: aad.releaseAttemptId,
    snapshotRunId: aad.snapshotRunId,
    snapshotAllocatedAt: aad.snapshotAllocatedAt,
    producer: {
      workflowPath: ".github/workflows/sanitized-snapshot.yml",
      runId: aad.snapshotRunId,
      runAttempt: 1,
      jobId: "snapshot-data",
      phase: "encryption",
      pendingDeploymentId: "fixture-deployment",
      environment: {
        name: "stage1-snapshot-export",
        id: "fixture-environment",
        policyIdentityDigest: digest
      }
    },
    bindings: Object.fromEntries(
      [
        "dispatchAuthorizationDigest",
        "sourceGateEvidenceDigest",
        "buildProofDigest",
        "buildBundleDigest",
        "repositoryContractDigest",
        "adapterExecutableDigest",
        "cryptoExecutableDigest"
      ].map((key) => [key, digest])
    ),
    issuer: {
      issuerId: "fixture-issuer",
      principal: "fixture-approver",
      cryptoPrincipal: "fixture-producer",
      publisherBrokerPrincipal: "fixture-publisher"
    },
    localKey: {
      kind: "local-rsa-oaep-sha256.v1",
      keyFingerprint,
      keyReadbackDigest,
      recoveryReadbackDigest,
      action: "local:GenerateAndWrapDataKey",
      keySpec: "AES_256",
      maxCalls: 1,
      context,
      contextDigest: sha256Canonical(context)
    },
    execution: { requestedDurationSeconds: 600, maxDurationSeconds: 900 },
    handoff: { protocol: "public-key-object-v1", publicKeyOnly: true, privateKey: false },
    prerequisites: {
      ...Object.fromEntries(
        [
          "changePlanDigest",
          "externalChangeApprovalDigest",
          "applyProofDigest",
          "admissionPolicyReadbackDigest",
          "readbackDigest"
        ].map((key) => [key, digest])
      ),
      keyReadbackDigest,
      recoveryReadbackDigest,
      completedAt: new Date(now - 2000).toISOString()
    },
    issuedAt: new Date(now - 1000).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    notAfter: new Date(now + 899000).toISOString(),
    revocationPolicyDigest: digest,
    custodyAuthorizationDigest: digest
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r3-h1-decrypt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mainRoot = path.join(root, "main"),
    keyRoot = path.join(mainRoot, "key"),
    credentialRoot = path.join(mainRoot, "credential"),
    operationRef = randomUUID();
  const plaintext = path.join(credentialRoot, "r3", operationRef, "consumer", "plaintext");
  for (const directory of [mainRoot, keyRoot, plaintext])
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(keyRoot, "snapshot-rsa3072.pk8.der");
  await fs.writeFile(keyPath, keyPair.privateKey.export({ type: "pkcs8", format: "der" }), {
    mode: 0o600
  });
  const bytes = Buffer.from("authenticated sanitized snapshot fixture\n");
  const allocated = Date.now() - 86400000;
  const aad = {
    repositoryId: "1253231368",
    sourceSha: "b".repeat(40),
    releaseAttemptId: "attempt-20260903-001",
    snapshotRunId: "9001",
    sanitizationContractDigest: `sha256:${"1".repeat(64)}`,
    expiresAt: new Date(allocated + 30 * 86400000).toISOString(),
    snapshotAllocatedAt: new Date(allocated).toISOString(),
    snapshotDigest: d(bytes)
  };
  const auth = authorization(aad),
    encrypted = path.join(root, "ciphertext.enc");
  const envelope = await encryptSnapshotStream({
    source: { open: () => Readable.from([bytes]) },
    destination: encrypted,
    aad,
    authorization: auth,
    publicKey: keyPair.publicKey
  });
  const profile = { storage: { keyRoot, credentialRoot } };
  let publicChecks = 0,
    publicCloses = 0;
  publicReader = async (input) => {
    assert.equal(input.repoRoot, root);
    assert.equal(input.creationRawDigest, auth.localKey.keyReadbackDigest);
    assert.equal(input.recoveryRawDigest, auth.localKey.recoveryReadbackDigest);
    return {
      refs: {
        indexRawDigest: null,
        creationRawDigest: input.creationRawDigest,
        recoveryRawDigest: input.recoveryRawDigest
      },
      creation: {
        keyRef: "snapshot-rsa3072.pk8.der",
        keyFingerprint,
        profileDigest: sha256Canonical(profile),
        publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" })
      },
      recovery: {
        keyFingerprint,
        publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" })
      },
      async recheck() {
        publicChecks++;
      },
      async close() {
        publicCloses++;
      }
    };
  };
  return {
    root,
    mainRoot,
    keyRoot,
    credentialRoot,
    plaintext,
    keyPath,
    operationRef,
    bytes,
    aad,
    auth,
    envelope,
    profile,
    source: { open: () => fsNative.createReadStream(encrypted) },
    get publicChecks() {
      return publicChecks;
    },
    get publicCloses() {
      return publicCloses;
    }
  };
}

function majorMinor(device) {
  const value = BigInt(device);
  return `${((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n)}:${(value & 0xffn) | ((value >> 12n) & 0xffffff00n)}`;
}
async function installLiveGuard(t, f, { swap = false, core = true, coredump = null } = {}) {
  const originalOpen = fs.open.bind(fs),
    originalReal = fs.realpath.bind(fs),
    originalStat = fs.stat.bind(fs),
    originalLstat = fs.lstat.bind(fs);
  const mount = await fs.stat(f.mainRoot, { bigint: true });
  const device = majorMinor(mount.dev);
  const fakeMapper = { ...mount, rdev: mount.dev, isBlockDevice: () => true };
  const fakeBacking = {
    ...mount,
    size: 1073741824n,
    nlink: 1n,
    mode: 0o100600n,
    isFile: () => true,
    isSymbolicLink: () => false
  };
  let keyOpens = 0;
  t.mock.method(fs, "open", (file, ...args) => {
    if (file === f.keyPath) keyOpens++;
    const content =
      file === "/proc/swaps"
        ? Buffer.from(
            swap
              ? "Filename Type Size Used Priority\n/swapfile file 1024 0 -2\n"
              : "Filename Type Size Used Priority\n"
          )
        : file === "/proc/self/limits"
          ? Buffer.from(`Max core file size        ${core ? "0 0" : "unlimited unlimited"} bytes\n`)
          : null;
    if (!content) return originalOpen(file, ...args);
    let cursor = 0;
    return Promise.resolve({
      async read(buffer, offset, length) {
        const count = Math.min(length, content.length - cursor);
        content.copy(buffer, offset, cursor, cursor + count);
        cursor += count;
        return { bytesRead: count };
      },
      async close() {}
    });
  });
  t.mock.method(fs, "realpath", (file, ...args) =>
    file === MAPPER
      ? Promise.resolve("/dev/dm-7")
      : file === BACKING
        ? Promise.resolve(BACKING)
        : originalReal(file, ...args)
  );
  t.mock.method(fs, "stat", (file, ...args) =>
    file === "/dev/dm-7" ? Promise.resolve(fakeMapper) : originalStat(file, ...args)
  );
  t.mock.method(fs, "lstat", (file, ...args) =>
    file === BACKING ? Promise.resolve(fakeBacking) : originalLstat(file, ...args)
  );
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    let output;
    if (command.endsWith("findmnt")) {
      assert.deepEqual(args, [
        "--json",
        "--list",
        "--kernel",
        "--output",
        "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"
      ]);
      output = JSON.stringify({
        filesystems: [
          {
            target: f.mainRoot,
            source: "/dev/dm-7",
            fstype: "ext4",
            options: "rw,nosuid,nodev,noexec,relatime",
            "maj:min": device
          }
        ]
      });
    } else if (command.endsWith("dmsetup")) {
      assert.deepEqual(args, [
        "info",
        "--columns",
        "--noheadings",
        "--separator",
        "|",
        "--options",
        "name,uuid,major,minor",
        "stage1-h1-main"
      ]);
      output = `stage1-h1-main|CRYPT-LUKS2-${UUID.replaceAll("-", "")}-stage1--h1--main|${device.replace(":", "|")}\n`;
    } else if (command.endsWith("cryptsetup") && args[0] === "luksUUID") {
      assert.deepEqual(args, ["luksUUID", BACKING]);
      output = `${UUID}\n`;
    } else if (command.endsWith("cryptsetup") && args[0] === "status") {
      assert.deepEqual(args, ["status", "stage1-h1-main"]);
      output = `${MAPPER} is active and is in use.\n  type: LUKS2\n  device: /dev/loop7\n`;
    } else if (command.endsWith("losetup")) {
      assert.deepEqual(args, ["--json", "--list", "--output", "NAME,BACK-FILE,OFFSET,SIZELIMIT"]);
      output = JSON.stringify({
        loopdevices: [{ name: "/dev/loop7", "back-file": BACKING, offset: 0, sizelimit: 0 }]
      });
    } else if (command.endsWith("systemd-analyze")) {
      assert.deepEqual(args, ["cat-config", "systemd/coredump.conf"]);
      output =
        coredump ?? "# /etc/systemd/coredump.conf\n[Coredump]\nStorage=none\nProcessSizeMax=0\n";
    } else throw Error("unexpected native command");
    queueMicrotask(() => callback(null, Buffer.from(output), Buffer.alloc(0)));
    return { pid: 1234 };
  });
  return {
    get keyOpens() {
      return keyOpens;
    }
  };
}

function input(f) {
  return {
    repoRoot: f.root,
    profile: f.profile,
    operationRef: f.operationRef,
    cryptoInputs: { authorization: f.auth, envelope: f.envelope, aad: f.aad },
    source: f.source,
    recheck: async () => {},
    signal: new AbortController().signal
  };
}

test("authenticates a real ciphertext into the fixed private plaintext slot", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  const held = await decryptR3SnapshotCiphertext(input(f));
  t.after(() => held.close());
  assert.equal(held.facts.path, path.join(f.plaintext, "snapshot.dump"));
  assert.equal(held.facts.snapshotDigest, d(f.bytes));
  assert.equal(held.facts.plaintextSizeBytes, f.bytes.length);
  assert.equal(held.facts.keyFingerprint, keyFingerprint);
  assert.deepEqual(await fs.readFile(held.facts.path), f.bytes);
  assert.equal(Object.isFrozen(held.observations), true);
  assert.ok(
    held.observations.beforeKey.transcript.some(
      (item) => item.name === "mapper" && item.digest.startsWith("sha256:")
    )
  );
  assert.ok(
    held.observations.beforeKey.transcript.some(
      (item) =>
        item.name === "mapper" &&
        item.command === "/usr/sbin/dmsetup" &&
        item.exitCode === 0 &&
        item.rawOutput.includes("CRYPT-LUKS2-") &&
        Object.isFrozen(item.args)
    )
  );
  assert.ok(
    held.observations.afterGuard.transcript.some(
      (item) =>
        item.name === "swaps" &&
        item.path === "/proc/swaps" &&
        item.rawOutput.startsWith("Filename")
    )
  );
  assert.equal(JSON.stringify(held.observations).includes("PRIVATE KEY"), false);
  await held.recheck();
  await held.close();
  assert.equal(f.publicCloses, 1);
});

test("unsafe live swap refuses before opening the RSA key", async (t) => {
  const f = await fixture(t);
  const guard = await installLiveGuard(t, f, { swap: true });
  await assert.rejects(decryptR3SnapshotCiphertext(input(f)), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.equal(guard.keyOpens, 0);
  assert.deepEqual(await fs.readdir(f.plaintext), []);
});

test("plaintext replay uses verified bytes and closes every owned reader", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  const held = await decryptR3SnapshotCiphertext(input(f));
  t.after(() => held.close());
  const chunks = [];
  for await (const chunk of await held.source.open()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  await held.recheck();
  const outstanding = await held.source.open();
  await held.close();
  assert.equal(outstanding.closed, true);
  assert.equal(outstanding.destroyed, true);
  await assert.rejects(held.source.open(), { code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE" });
});

test("plaintext close waits for a pending file open and closes its descriptor", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  const held = await decryptR3SnapshotCiphertext(input(f));
  t.after(() => held.close());
  const originalOpen = fs.open.bind(fs);
  let release, entered, opened;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const openingFile = new Promise((resolve) => {
    entered = resolve;
  });
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === held.facts.path) {
      opened = handle;
      entered();
      await blocked;
    }
    return handle;
  });
  const pending = held.source.open();
  const refused = assert.rejects(pending, { code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE" });
  await openingFile;
  const closing = held.close();
  release();
  await Promise.all([refused, closing]);
  assert.equal(opened.fd, -1);
});

test("a later spaced coredump size overrides an earlier zero before key open", async (t) => {
  const f = await fixture(t);
  const guard = await installLiveGuard(t, f, {
    coredump:
      "# /etc/systemd/coredump.conf\n[Coredump]\nStorage=none\nProcessSizeMax=0\nProcessSizeMax=1 G\n"
  });
  await assert.rejects(decryptR3SnapshotCiphertext(input(f)), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.equal(guard.keyOpens, 0);
  assert.deepEqual(await fs.readdir(f.plaintext), []);
});

test("mismatched public key readback refuses without plaintext", async (t) => {
  const f = await fixture(t);
  const guard = await installLiveGuard(t, f);
  const original = publicReader;
  publicReader = async (selection) => {
    const result = await original(selection);
    return { ...result, refs: { ...result.refs, creationRawDigest: `sha256:${"f".repeat(64)}` } };
  };
  await assert.rejects(decryptR3SnapshotCiphertext(input(f)), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.equal(guard.keyOpens, 0);
  assert.deepEqual(await fs.readdir(f.plaintext), []);
});

test("a post-decrypt replacement cannot be pinned as authenticated plaintext", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  let checks = 0;
  const request = input(f);
  request.recheck = async () => {
    if (++checks !== 3) return;
    const replacement = path.join(f.plaintext, "replacement.tmp");
    await fs.writeFile(replacement, Buffer.alloc(f.bytes.length, 0x58), { mode: 0o600 });
    await fs.rename(replacement, path.join(f.plaintext, "snapshot.dump"));
  };
  await assert.rejects(decryptR3SnapshotCiphertext(request), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.equal(checks, 3);
});

test("the passed profile must match the validated public creation profile", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  const request = input(f);
  request.profile = { ...f.profile, ownerId: "different" };
  await assert.rejects(decryptR3SnapshotCiphertext(request), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.deepEqual(await fs.readdir(f.plaintext), []);
});

test("a different fixed RSA key cannot publish plaintext", async (t) => {
  const f = await fixture(t);
  await installLiveGuard(t, f);
  const other = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
  await fs.writeFile(f.keyPath, other.privateKey.export({ type: "pkcs8", format: "der" }), {
    mode: 0o600
  });
  await assert.rejects(decryptR3SnapshotCiphertext(input(f)), {
    code: "R3_H1_SNAPSHOT_DECRYPT_UNAVAILABLE"
  });
  assert.deepEqual(await fs.readdir(f.plaintext), []);
});
