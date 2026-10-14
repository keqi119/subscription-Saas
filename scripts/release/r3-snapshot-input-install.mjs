// Local owner preparation/installation. Authentication is supplied only by the fixed H1 wrapper/session.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { checkedPrivatePath, pinPrivateInput } from "./manual-runner-source-inputs.mjs";
import {
  readR3SnapshotPreparationDeclarations,
  readR3SnapshotDeclarations
} from "./r3-snapshot-input-admission.mjs";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const subjects = [
  "metadata",
  "sanitizationContract",
  "ownershipMap",
  "scan",
  "sourcePrivilege",
  "beforeFingerprint",
  "afterFingerprint",
  "envelope",
  "custody",
  "storageReadback"
];
const fail = () => {
  throw Object.assign(new Error("R3_SNAPSHOT_INSTALL_UNAVAILABLE"), {
    code: "R3_SNAPSHOT_INSTALL_UNAVAILABLE"
  });
};
const need = (value) => {
  if (!value) fail();
};
function exact(value, keys) {
  need(
    value &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((k) => {
        const d = Object.getOwnPropertyDescriptor(value, k);
        return d?.enumerable && "value" in d;
      })
  );
}
// Pure assembler, not an authority or a filesystem selector.
export async function assembleR3SnapshotPreparation(input) {
  exact(input, ["profile", "preparation", "observedAt", "readRaw"]);
  const { profile, preparation, observedAt, readRaw } = input;
  const preparationBytes = encodeManualJson(preparation),
    originals = new Map();
  const checked = await readR3SnapshotPreparationDeclarations({
    profile,
    preparationBytes,
    observedAt,
    readRaw: async (digest) => {
      const bytes = await readRaw(digest);
      need(Buffer.isBuffer(bytes));
      originals.set(digest, Buffer.from(bytes));
      return bytes;
    }
  });
  return {
    preparationBytes,
    preparationDigest: checked.preparationDigest,
    rawOriginals: checked.rawReferences.map((ref) => ({
      digest: ref.digest,
      bytes: originals.get(ref.digest)
    }))
  };
}
export async function assembleR3SnapshotIndex(input) {
  exact(input, [
    "profile",
    "preparationBytes",
    "preparationDigest",
    "destinationDigest",
    "jobAdmissionDigest",
    "observedAt",
    "readRaw"
  ]);
  const {
    profile,
    preparationBytes,
    preparationDigest,
    destinationDigest,
    jobAdmissionDigest,
    observedAt,
    readRaw
  } = input;
  need(
    Buffer.isBuffer(preparationBytes) &&
      DIGEST.test(preparationDigest) &&
      sha256Bytes(preparationBytes) === preparationDigest &&
      DIGEST.test(destinationDigest) &&
      DIGEST.test(jobAdmissionDigest)
  );
  const preparation = JSON.parse(preparationBytes.toString("utf8"));
  const assembled = await assembleR3SnapshotPreparation({
    profile,
    preparation,
    observedAt,
    readRaw
  });
  need(assembled.preparationBytes.equals(preparationBytes));
  const permission = {
    recordVersion: "r3-snapshot-input-permission.v1",
    inputReference: preparation.inputReference,
    ownerId: preparation.ownerId,
    profileDigest: preparation.profileDigest,
    sourceAuthority: preparation.sourceAuthority,
    sourceIdentity: preparation.sourceIdentity,
    allowedPurpose: "sanitized-snapshot-test-input",
    allowedUses: [
      {
        phase: preparation.phase,
        destinationAdmissionDigest: destinationDigest,
        readerPrincipal: `manual-h1:${preparation.profileDigest}`,
        decryptorPrincipal: `manual-h1:${preparation.profileDigest}`,
        userPrincipal: `manual-r3-job:${jobAdmissionDigest}`
      }
    ],
    validUntil: preparation.validUntil,
    restrictionOriginals: preparation.restrictionOriginals
  };
  const permissionBytes = encodeManualJson(permission),
    permissionDigest = sha256Bytes(permissionBytes);
  const index = {
    recordVersion: "r3-snapshot-input-index.v1",
    inputReference: preparation.inputReference,
    profileDigest: preparation.profileDigest,
    ownerId: preparation.ownerId,
    permission: { digest: permissionDigest, bytes: permissionBytes.length },
    ...Object.fromEntries(subjects.map((k) => [k, preparation[k]]))
  };
  const indexBytes = encodeManualJson(index),
    raws = new Map(assembled.rawOriginals.map((x) => [x.digest, x.bytes]));
  raws.set(permissionDigest, permissionBytes);
  await readR3SnapshotDeclarations({
    profile,
    indexBytes,
    inputReference: preparation.inputReference,
    observedAt,
    readRaw: async (digest) => raws.get(digest)
  });
  return {
    inputReference: preparation.inputReference,
    indexBytes,
    permissionBytes,
    indexDigest: sha256Bytes(indexBytes),
    permissionDigest,
    rawOriginals: [...raws].map(([digest, bytes]) => ({ digest, bytes }))
  };
}
function options(profile) {
  need(process.platform === "linux" && typeof process.getuid === "function");
  return {
    principal: { platform: "posix", uid: process.getuid() },
    privateRoot: profile.storage.archiveRoot
  };
}
function paths(profile, operationRef) {
  need(UUID.test(operationRef));
  const root = profile.storage.archiveRoot;
  need(typeof root === "string" && path.isAbsolute(root) && path.resolve(root) === root);
  const snapshots = path.join(root, "inputs", "snapshots"),
    prepared = path.join(snapshots, "prepared", operationRef);
  return {
    root,
    snapshots,
    prepared,
    raw: path.join(root, "raw"),
    package: path.join(prepared, "package.json")
  };
}
function checkBinding(p, profile, scope, operationRef) {
  need(
    p.operationRef === operationRef &&
      p.creationSpecDigest === scope.creationSpecDigest &&
      p.sourceSha === scope.sourceSha &&
      p.phase === scope.phase &&
      scope.chain === "snapshot" &&
      p.profileDigest === sha256Canonical(profile) &&
      p.ownerId === profile.ownerId
  );
}
// Captures never escape this call: installation changes raw/snapshot directory entries.
export async function readPreparedR3SnapshotInput(input) {
  exact(input, ["profile", "scope", "operationRef"]);
  const { profile, scope, operationRef } = input,
    where = paths(profile, operationRef),
    opts = options(profile),
    held = [];
  const pin = async (file) => {
    const item = await pinPrivateInput(file, opts);
    held.push(item);
    return Buffer.from(item.bytes);
  };
  try {
    for (const directory of [
      where.raw,
      where.snapshots,
      where.prepared,
      path.join(where.prepared, "raw")
    ])
      await checkedPrivatePath(directory, { ...opts, directory: true });
    const preparationBytes = await pin(where.package),
      preparation = JSON.parse(preparationBytes.toString("utf8"));
    checkBinding(preparation, profile, scope, operationRef);
    const assembled = await assembleR3SnapshotPreparation({
      profile,
      preparation,
      observedAt: new Date().toISOString(),
      readRaw: (digest) => pin(path.join(where.prepared, "raw", `${digest.slice(7)}.bin`))
    });
    need(preparationBytes.equals(assembled.preparationBytes));
    for (const item of held) await item.recheck();
    return assembled;
  } finally {
    const results = await Promise.allSettled(held.map((item) => item.close()));
    if (results.some((x) => x.status !== "fulfilled")) fail();
  }
}
const sameIdentity = (a, b) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink"].every((k) => a[k] === b[k]);
async function writeOriginal(file, bytes, opts, reuse, check) {
  check();
  await checkedPrivatePath(path.dirname(file), { ...opts, directory: true });
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try {
      const chain = await checkedPrivatePath(file, opts);
      need(sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })));
      check();
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST" || !reuse) throw error;
  }
  const pinned = await pinPrivateInput(file, opts);
  try {
    need(pinned.bytes.equals(bytes));
    await pinned.recheck();
    check();
  } finally {
    await pinned.close();
  }
}
// Called only with authenticated session closure values, never a public CLI request.
export async function installR3SnapshotInputForCreatedTarget(input) {
  exact(input, [
    "profile",
    "scope",
    "operationRef",
    "preparationDigest",
    "destinationDigest",
    "deadlineAtMs",
    "deadlineAtMonoMs"
  ]);
  const {
    profile,
    scope,
    operationRef,
    preparationDigest,
    destinationDigest,
    deadlineAtMs,
    deadlineAtMonoMs
  } = input;
  need(
    DIGEST.test(preparationDigest) &&
      DIGEST.test(destinationDigest) &&
      DIGEST.test(scope.jobAdmissionDigest) &&
      Number.isSafeInteger(deadlineAtMs) &&
      Number.isFinite(deadlineAtMonoMs)
  );
  const expires = Math.min(deadlineAtMs, Date.now() + 30000),
    mono = Math.min(deadlineAtMonoMs, performance.now() + 30000);
  const check = () => need(Date.now() < expires && performance.now() < mono);
  check();
  const assembled = await readPreparedR3SnapshotInput({ profile, scope, operationRef });
  need(assembled.preparationDigest === preparationDigest);
  check();
  const rawMap = new Map(assembled.rawOriginals.map((x) => [x.digest, x.bytes]));
  const indexed = await assembleR3SnapshotIndex({
    profile,
    preparationBytes: assembled.preparationBytes,
    preparationDigest,
    destinationDigest,
    jobAdmissionDigest: scope.jobAdmissionDigest,
    observedAt: new Date().toISOString(),
    readRaw: async (digest) => rawMap.get(digest)
  });
  const where = paths(profile, operationRef),
    opts = options(profile);
  // Preserve directory identity across our intentional additions; no capture is held across writes.
  const directories = [where.raw, where.snapshots, where.prepared];
  const chains = [];
  for (const dir of directories)
    chains.push(await checkedPrivatePath(dir, { ...opts, directory: true }));
  const recheckDirectories = async () => {
    check();
    for (let n = 0; n < directories.length; n++) {
      const after = await checkedPrivatePath(directories[n], { ...opts, directory: true });
      need(after.length === chains[n].length);
      for (let i = 0; i < after.length; i++) {
        const before = chains[n][i],
          current = after[i];
        need(before.path === current.path);
        const privateAncestor =
          before.path === where.root || before.path.startsWith(where.root + path.sep);
        const fields = [
          "dev",
          "ino",
          "mode",
          "uid",
          "gid",
          ...(privateAncestor && !directories.includes(before.path)
            ? ["nlink", "size", "mtimeNs", "ctimeNs"]
            : [])
        ];
        need(fields.every((k) => before.stat[k] === current.stat[k]));
      }
    }
  };
  const marker = encodeManualJson({
    recordVersion: "r3-snapshot-input-install-started.v1",
    operationRef,
    inputReference: indexed.inputReference,
    preparationDigest,
    destinationDigest,
    jobAdmissionDigest: scope.jobAdmissionDigest,
    phase: scope.phase
  });
  await writeOriginal(
    path.join(where.prepared, "install-started.json"),
    marker,
    opts,
    false,
    check
  );
  await recheckDirectories();
  const directory = path.join(where.snapshots, indexed.inputReference);
  await fs.mkdir(directory, { mode: 0o700 }); // EEXIST is terminal, including partially installed indexes.
  await recheckDirectories();
  for (const item of indexed.rawOriginals) {
    need(sha256Bytes(item.bytes) === item.digest);
    await writeOriginal(
      path.join(where.raw, `${item.digest.slice(7)}.bin`),
      item.bytes,
      opts,
      true,
      check
    );
    await recheckDirectories();
  }
  await writeOriginal(path.join(directory, "index.json"), indexed.indexBytes, opts, false, check);
  await recheckDirectories();
  const captures = [];
  const read = async (file) => {
    const item = await pinPrivateInput(file, opts);
    captures.push(item);
    return item.bytes;
  };
  try {
    const bytes = await read(path.join(directory, "index.json"));
    need(bytes.equals(indexed.indexBytes));
    const full = await readR3SnapshotDeclarations({
      profile,
      indexBytes: bytes,
      inputReference: indexed.inputReference,
      observedAt: new Date().toISOString(),
      readRaw: (digest) => read(path.join(where.raw, `${digest.slice(7)}.bin`))
    });
    need(
      full.allowedUses.length === 1 &&
        full.allowedUses[0].phase === scope.phase &&
        full.allowedUses[0].destinationAdmissionDigest === destinationDigest &&
        full.allowedUses[0].readerPrincipal === `manual-h1:${sha256Canonical(profile)}` &&
        full.allowedUses[0].decryptorPrincipal === `manual-h1:${sha256Canonical(profile)}` &&
        full.allowedUses[0].userPrincipal === `manual-r3-job:${scope.jobAdmissionDigest}`
    );
    for (const capture of captures) await capture.recheck();
    check();
    return Object.freeze({
      inputReference: indexed.inputReference,
      inputIndexDigest: indexed.indexDigest,
      permissionDigest: indexed.permissionDigest,
      preparationDigest,
      rawReferences: full.rawReferences
    });
  } finally {
    const results = await Promise.allSettled(captures.map((x) => x.close()));
    if (results.some((x) => x.status !== "fulfilled")) fail();
  }
}
