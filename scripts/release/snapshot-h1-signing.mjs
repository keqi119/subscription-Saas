// Fixed H1 key binding. No key/path/domain input and no private-key export.
// This preserves the existing approved manual profile; it does not promote it
// or replace the snapshot dispatch, custody, revocation or GitHub decisions.
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { verifyAndSignSnapshotAdmission } from "../../packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs";
import { assertH1KeyMemory, assertH1KeyVolume } from "./snapshot-h1-key-volume.mjs";

const CODE = "H1_SNAPSHOT_SIGNING_REJECTED";
const MAIN = "/var/lib/stage1-volumes/main";
const KEY = `${MAIN}/key/signing-ed25519.pk8.pem`;
const PROFILE = "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541";
const OWNER = "sha256:68a627061f135ee52f811f81e9c39283aa3adc9c00a01be566b08a76ec82c9c2";
const FINGERPRINT = "sha256:7146f2e00f4a8e70183a64f3e8c7ebfa8e66926f60d18442e3d5ac4a09e408ef";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const identity = (a, b) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key] === b[key]
  );

function checkedPath(file, privateFile, readOnly) {
  const original = lstatSync(file);
  requireThat(
    original.isFile() &&
      original.uid === 0 &&
      original.gid === 0 &&
      original.nlink === 1 &&
      (original.mode & (privateFile ? 0o077 : 0o022)) === 0 &&
      (!readOnly || (original.mode & 0o222) === 0)
  );
  let parent = path.posix.dirname(file);
  while (true) {
    const info = lstatSync(parent);
    requireThat(
      info.isDirectory() && info.uid === 0 && info.gid === 0 && (info.mode & 0o022) === 0
    );
    if (privateFile && (parent === MAIN || parent.startsWith(`${MAIN}/`)))
      requireThat((info.mode & 0o777) === 0o700);
    if (parent === "/") break;
    parent = path.posix.dirname(parent);
  }
  return original;
}

function readFixed(file, { privateFile = false, readOnly = false, max = 8192 } = {}) {
  const before = checkedPath(file, privateFile, readOnly);
  requireThat(before.size > 0 && before.size <= max);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const raw = Buffer.alloc(before.size + 1);
  let success = false;
  try {
    requireThat(identity(before, fstatSync(fd)));
    let length = 0;
    while (length < raw.length) {
      const read = readSync(fd, raw, length, raw.length - length, length);
      if (!read) break;
      length += read;
    }
    requireThat(
      length === before.size &&
        identity(before, fstatSync(fd)) &&
        identity(before, checkedPath(file, privateFile, readOnly))
    );
    success = true;
    return raw.subarray(0, length);
  } finally {
    if (!success) raw.fill(0);
    closeSync(fd);
  }
}

function fixedIdentity() {
  assertH1KeyMemory();
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  requireThat(
    /^\/opt\/subscription-saas\/snapshot-adapter\/v2\/bundles\/[a-f0-9]{64}$/.test(repoRoot)
  );
  const profile = JSON.parse(
    readFixed(`${repoRoot}/release/contracts/manual-stage1-profile.v2.json`, { readOnly: true })
  );
  const owner = JSON.parse(
    readFixed(`${repoRoot}/release/contracts/manual-stage1-owner-binding.v1.json`, {
      readOnly: true
    })
  );
  requireThat(sha256Canonical(profile) === PROFILE && sha256Canonical(owner) === OWNER);
  const now = Date.now();
  requireThat(Date.parse(profile.validFrom) <= now && now < Date.parse(profile.expiresAt));
  requireThat(
    profile.ownerId === "keqi119" &&
      profile.keyFingerprint === FINGERPRINT &&
      profile.storage.keyRoot + "/" + profile.storage.keyRef === KEY &&
      owner.profileDigest === PROFILE &&
      owner.ownerId === profile.ownerId &&
      same(owner.principal, { platform: "posix", uid: 0 }) &&
      owner.promotionEligible === false
  );
  const machineId = readFixed("/etc/machine-id").toString("utf8").trim();
  requireThat(
    /^[a-f0-9]{32}$/.test(machineId) &&
      sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)) ===
        owner.hostFingerprint
  );
  const approvalBytes = readFixed(`${MAIN}/archive/${owner.approvalReference}`, {
    privateFile: true
  });
  requireThat(sha256Bytes(approvalBytes) === owner.approvalDigest);
  const approval = JSON.parse(approvalBytes);
  const { approvalDigest, approvalReference, ...binding } = owner;
  requireThat(
    approvalDigest &&
      approvalReference &&
      same(approval, { ...binding, schemaVersion: "manual-stage1-owner-approval.v1" })
  );
  const publicKey = createPublicKey(profile.publicKeyPem);
  requireThat(
    publicKey.asymmetricKeyType === "ed25519" &&
      sha256Bytes(publicKey.export({ type: "spki", format: "der" })) === FINGERPRINT
  );
  return snapshotKernelData(
    {
      signer: { issuer: profile.ownerId, keyId: FINGERPRINT, publicKey: profile.publicKeyPem },
      profileDigest: PROFILE,
      ownerBindingDigest: OWNER,
      hostFingerprint: owner.hostFingerprint
    },
    CODE
  );
}

async function admittedIdentity() {
  try {
    await assertH1KeyVolume();
    return fixedIdentity();
  } catch {
    fail();
  }
}

function readSigningKey(expectedIdentity) {
  let raw;
  try {
    // Called only at the verifier's final signing boundary, after fresh actual
    // observations and dispatch verification. No key bytes are loaded earlier.
    requireThat(same(fixedIdentity(), expectedIdentity));
    raw = readFixed(KEY, { privateFile: true });
    requireThat(lstatSync(KEY).dev === lstatSync(MAIN).dev);
    const key = createPrivateKey(raw);
    requireThat(
      key.asymmetricKeyType === "ed25519" &&
        sha256Bytes(createPublicKey(key).export({ type: "spki", format: "der" })) === FINGERPRINT
    );
    assertH1KeyMemory();
    return key;
  } catch {
    fail();
  } finally {
    raw?.fill(0);
  }
}

export async function verifyAndSignH1SnapshotAdmission(input) {
  assertKernelFrame(
    input,
    ["admission", "dispatchVerification", "githubObservations", "rootPolicy"],
    CODE
  );
  const captured = snapshotKernelData(input, CODE, true);
  assertKernelFrame(captured.rootPolicy.rootSigner, ["issuer", "keyId", "publicKey"], CODE);
  requireThat(
    captured.rootPolicy.rootSigner.issuer === "keqi119" &&
      captured.rootPolicy.rootSigner.keyId === FINGERPRINT
  );
  const trusted = await admittedIdentity();
  requireThat(same(captured.rootPolicy.rootSigner, trusted.signer));
  let active = true,
    consumed = false;
  try {
    return await verifyAndSignSnapshotAdmission({
      ...captured,
      privateKeyFd: {
        publicKey: trusted.signer.publicKey,
        readPrivateKey() {
          requireThat(active && !consumed);
          consumed = true;
          return readSigningKey(trusted);
        }
      }
    });
  } finally {
    active = false;
  }
}

// A local possession challenge is diagnostic, not dispatch/admission authority.
// The nonce and signed body are generated here; callers cannot select a payload.
export async function challengeH1SnapshotSigningKey(...args) {
  requireThat(args.length === 0);
  const trusted = await admittedIdentity();
  const challenge = {
    ...trusted,
    nonce: randomBytes(32).toString("hex"),
    observedAt: new Date().toISOString()
  };
  const signature = sign(
    null,
    Buffer.from(
      canonicalJson({
        domain: "h1-snapshot-key-challenge.v1",
        challenge
      })
    ),
    readSigningKey(trusted)
  ).toString("base64");
  return snapshotKernelData({ challenge, signature }, CODE);
}
