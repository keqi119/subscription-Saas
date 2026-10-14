// Fixed, read-only producer verification followed by local preparation publication.
// Runs from the authenticated H1 candidate checkout; never imports R3 into the key control bundle.
import { Buffer } from "node:buffer";
import { createPublicKey, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { validateProducerCryptoAuthorization } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import { assertH1KeyVolume } from "./snapshot-h1-key-volume.mjs";
import { buildH1SnapshotCompletion } from "./snapshot-h1-completion.mjs";
import {
  verifyH1SnapshotDestruction,
  verifyH1SnapshotPublisherUse
} from "./snapshot-h1-publication.mjs";
import { verifyH1SnapshotFinalReaderTerminal } from "./snapshot-h1-signing.mjs";
import { verifySnapshotOssOriginals } from "./snapshot-oss-originals.mjs";
import {
  loadFixedManualProfile,
  readFixedR3CreationSpec,
  withFixedR3BuildAttestationScope
} from "./manual-stage1-trust.mjs";
import { assembleR3SnapshotPreparation } from "./r3-snapshot-input-install.mjs";

const CODE = "H1_SNAPSHOT_PREPARATION_REJECTED";
const MAIN = "/var/lib/stage1-volumes/main";
const AUTHORITY = `${MAIN}/snapshot-authority`;
const PROFILE = "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541";
const OWNER = "sha256:68a627061f135ee52f811f81e9c39283aa3adc9c00a01be566b08a76ec82c9c2";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const identity = (a, b) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (k) => a[k] === b[k]
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

function readFixed(
  file,
  { privateFile = false, readOnly = false, max = 8192, allowEmpty = false } = {}
) {
  const before = checkedPath(file, privateFile, readOnly);
  requireThat((before.size > 0 || (allowEmpty && before.size === 0)) && before.size <= max);
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

function privateJson(name, max = 1048576) {
  const file = `${AUTHORITY}/${name}.json`;
  const raw = readFixed(file, { privateFile: true, max });
  try {
    requireThat(lstatSync(file).dev === lstatSync(MAIN).dev);
    const value = JSON.parse(raw.toString("utf8"));
    requireThat(Buffer.from(canonicalJson(value)).equals(raw));
    return snapshotKernelData(value, CODE);
  } finally {
    raw.fill(0);
  }
}

function writeNewPublicationFile(file, bytes) {
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function requireAbsent(file) {
  try {
    lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail();
  }
  fail();
}

function archiveJson(file, max = 8388608) {
  const raw = readFixed(file, { privateFile: true, max });
  const value = JSON.parse(raw.toString("utf8"));
  requireThat(raw.equals(Buffer.from(canonicalJson(value))));
  return snapshotKernelData(value, CODE);
}

async function admittedIdentity() {
  requireThat(
    process.platform === "linux" &&
      process.getuid() === 0 &&
      process.getgid() === 0 &&
      /^\/opt\/stage1-r3-candidate-[a-f0-9]{7}$/.test(REPOSITORY_ROOT)
  );
  await assertH1KeyVolume();
  const profile = await loadFixedManualProfile({ repoRoot: REPOSITORY_ROOT });
  const owner = JSON.parse(
    readFixed(`${REPOSITORY_ROOT}/release/contracts/manual-stage1-owner-binding.v1.json`)
  );
  requireThat(sha256Canonical(profile) === PROFILE && sha256Canonical(owner) === OWNER);
  return {
    profile,
    profileDigest: PROFILE,
    signer: {
      issuer: profile.ownerId,
      keyId: profile.keyFingerprint,
      publicKey: profile.publicKeyPem
    }
  };
}

async function readH1SnapshotProductionInputs(...args) {
  requireThat(args.length === 0);
  const input = privateJson("producer-inputs");
  assertKernelFrame(input, ["authorization", "publicKey"], CODE);
  validateProducerCryptoAuthorization(input.authorization);
  requireThat(
    input.authorization.schemaVersion === "producer-crypto-run-authorization.v2" &&
      typeof input.publicKey === "string" &&
      input.publicKey.startsWith("-----BEGIN PUBLIC KEY-----\n")
  );
  const key = createPublicKey(input.publicKey);
  const fingerprint = sha256Bytes(key.export({ type: "spki", format: "der" }));
  requireThat(
    key.asymmetricKeyType === "rsa" &&
      key.asymmetricKeyDetails?.modulusLength === 3072 &&
      key.asymmetricKeyDetails?.publicExponent === 65537n &&
      fingerprint === "sha256:97dd86420772ba557ce9ddeaef1e762f79cebebe39cf0319d7195ede273ada01" &&
      fingerprint === input.authorization.localKey.keyFingerprint
  );
  return input;
}

function completionOriginals(auth, trusted) {
  const directory = `/var/lib/subscription-saas/snapshot-output/${auth.releaseAttemptId}`;
  for (const name of ["publisher-failure.json", "publisher-failure.json.pending"])
    requireAbsent(`${directory}/${name}`);
  requireAbsent(`${AUTHORITY}/publisher-session.json`);
  const files = {
    dataResultBytes: "data-result.json",
    proofBytes: "snapshot-proof.json",
    publicationBytes: "diagnostics.redacted.json",
    terminalBytes: "publisher-terminal.json",
    destructionBytes: "snapshot-destruction-proof.json",
    publisherUseBytes: "publisher-use-proof.json"
  };
  const input = {
    expected: {
      releaseAttemptId: auth.releaseAttemptId,
      snapshotRunId: auth.snapshotRunId,
      sourceSha: auth.sourceSha,
      dispatchAuthorizationDigest: auth.bindings.dispatchAuthorizationDigest
    },
    signer: trusted.signer,
    ...Object.fromEntries(
      Object.entries(files).map(([field, name]) => [
        field,
        readFixed(`${directory}/${name}`, { privateFile: true, max: 1048576 })
      ])
    )
  };
  requireThat(same(JSON.parse(input.dataResultBytes.toString("utf8")).cryptoAuthorization, auth));
  const destruction = verifyH1SnapshotDestruction(input);
  verifyH1SnapshotPublisherUse(input);
  return { directory, input, destruction };
}

async function finalSnapshotRecords(directory) {
  for (const name of [
    "snapshot-final-readback-failure.json",
    "snapshot-final-readback-failure.json.pending",
    "snapshot-final-readback.json.pending",
    "snapshot-final-reader-terminal.json.pending"
  ])
    requireAbsent(`${directory}/${name}`);
  requireAbsent(`${AUTHORITY}/snapshot-final-reader-session.json`);
  const io = verifyH1SnapshotFinalReaderTerminal({
    io: archiveJson(`${directory}/snapshot-final-readback.json`),
    terminal: archiveJson(`${directory}/snapshot-final-reader-terminal.json`),
    now: new Date().toISOString(),
    configuration: privateJson("snapshot-final-inputs"),
    accessPolicyReadback: privateJson("snapshot-access-policy-readback")
  });
  const key = `snapshot-slots/v2/${io.releaseAttemptId}/${io.snapshotRunId}/snapshot.enc`;
  const matching = io.finalSnapshotReadback.observations.filter((value) => value.get.key === key);
  requireThat(matching.length === 1);
  const summary = matching[0],
    raw = io.storageOriginals.observation;
  const expected = { key, contentDigest: summary.get.digest, sizeBytes: summary.get.sizeBytes };
  await verifySnapshotOssOriginals({
    observation: raw,
    expected,
    ciphertext: readFixed(`${directory}/snapshot.enc`, { privateFile: true, max: 134217728 }),
    startedAt: io.githubTerminalReadback.observedAt,
    observedAt: io.observedAt
  });
  requireThat(
    same(raw.bucket, summary.bucket) &&
      raw.readerArn === summary.readerArn &&
      raw.expectedWriterArn === summary.expectedWriterArn &&
      same(raw.readerIdentityOriginal, io.finalSnapshotReadback.readerIdentityOriginal)
  );
  for (const name of ["head", "get"]) {
    const { requestId: rawRequestId, ...rawFacts } = raw[name];
    const { requestId: summaryRequestId, ...summaryFacts } = summary[name];
    requireThat(rawRequestId && summaryRequestId && same(rawFacts, summaryFacts));
  }
  return io;
}

// Freeze verified producer originals before opening a live R3 session. This
// issues no permission, performs no consume/sign operation, and accepts no
// caller-supplied authority or filesystem adapter.
export async function prepareH1R3SnapshotInputPackage(request) {
  assertKernelFrame(request, ["releaseAttemptId", "snapshotRunId", "operationRef"], CODE);
  request = snapshotKernelData(request, CODE);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  requireThat(
    typeof request.releaseAttemptId === "string" &&
      uuid.test(request.releaseAttemptId) &&
      typeof request.operationRef === "string" &&
      uuid.test(request.operationRef) &&
      typeof request.snapshotRunId === "string" &&
      /^[1-9][0-9]*$/u.test(request.snapshotRunId)
  );
  const trusted = await admittedIdentity();
  const { authorization: auth } = await readH1SnapshotProductionInputs();
  requireThat(
    request.releaseAttemptId === auth.releaseAttemptId &&
      request.snapshotRunId === auth.snapshotRunId
  );
  const { directory, input } = completionOriginals(auth, trusted);
  const io = await finalSnapshotRecords(directory);
  const rebuilt = buildH1SnapshotCompletion({
    ...input,
    githubTerminalReadback: io.githubTerminalReadback,
    finalSnapshotReadback: io.finalSnapshotReadback,
    storageOriginals: io.storageOriginals,
    accessPolicyDigest: io.accessPolicyDigest
  });
  requireThat(
    same(archiveJson(`${directory}/snapshot-producer-completion.json`), rebuilt.completion) &&
      same(archiveJson(`${directory}/snapshot-private-custody.json`), rebuilt.finalCustody)
  );
  // Producer authentication is already performed by buildH1SnapshotCompletion.
  const data = JSON.parse(input.dataResultBytes.toString("utf8")).data;
  const prefix = `r3-inputs/${request.operationRef}`;
  const approval = privateJson(`${prefix}/approval`),
    pins = privateJson("r3-input-pins");
  assertKernelFrame(pins, ["schemaVersion", "approvals"], CODE);
  requireThat(
    pins.schemaVersion === "h1-r3-snapshot-input-pins.v1" && Array.isArray(pins.approvals)
  );
  const seen = new Set();
  for (const pin of pins.approvals) {
    assertKernelFrame(pin, ["operationRef", "approvalDigest"], CODE);
    requireThat(
      uuid.test(pin.operationRef) &&
        /^sha256:[0-9a-f]{64}$/u.test(pin.approvalDigest) &&
        !seen.has(pin.operationRef)
    );
    seen.add(pin.operationRef);
  }
  requireThat(
    pins.approvals.find((pin) => pin.operationRef === request.operationRef)?.approvalDigest ===
      sha256Canonical(approval)
  );
  assertKernelFrame(
    approval,
    [
      "schemaVersion",
      "releaseAttemptId",
      "snapshotRunId",
      "sourceSha",
      "profileDigest",
      "ownerId",
      "operationRef",
      "phase",
      "validUntil",
      "sourceAuthority",
      "sourceIdentity",
      "restrictionOriginals"
    ],
    CODE
  );
  requireThat(
    approval.schemaVersion === "h1-r3-snapshot-input-approval.v1" &&
      approval.releaseAttemptId === auth.releaseAttemptId &&
      approval.snapshotRunId === auth.snapshotRunId &&
      approval.sourceSha === auth.sourceSha &&
      approval.profileDigest === trusted.profileDigest &&
      approval.ownerId === trusted.signer.issuer &&
      approval.operationRef === request.operationRef &&
      ["source", "final"].includes(approval.phase)
  );
  // This entry runs from the actual candidate checkout, not the H1 control
  // bundle. The fixed reader authenticates the full SHA and clean source tree.
  const repoRoot = REPOSITORY_ROOT;
  requireThat(repoRoot === `/opt/stage1-r3-candidate-${auth.sourceSha.slice(0, 7)}`);
  const profile = trusted.profile;
  requireThat(
    sha256Canonical(profile) === PROFILE && profile.storage.archiveRoot === `${MAIN}/archive`
  );
  const originals = new Map();
  const remember = (bytes) => {
    requireThat(Buffer.isBuffer(bytes) && bytes.length <= 1048576);
    const digest = sha256Bytes(bytes),
      held = originals.get(digest);
    requireThat(!held || held.equals(bytes));
    originals.set(digest, Buffer.from(bytes));
    return { digest, bytes: bytes.length };
  };
  for (const original of io.storageOriginals.originals) {
    const bytes = Buffer.from(original.bytesBase64, "base64");
    requireThat(
      bytes.toString("base64") === original.bytesBase64 && sha256Bytes(bytes) === original.digest
    );
    remember(bytes);
  }
  const bundleRoot = repoRoot;
  const subjects = {
    metadata: data.metadata,
    sanitizationContract: JSON.parse(
      readFixed(`${bundleRoot}/release/contracts/sanitization-contract.v1.json`, { max: 1048576 })
    ),
    ownershipMap: JSON.parse(
      readFixed(`${bundleRoot}/release/contracts/snapshot-ownership-map.v1.json`, { max: 1048576 })
    ),
    scan: data.scan,
    sourcePrivilege: data.privilegeObservation,
    beforeFingerprint: data.fingerprintObservationBefore,
    afterFingerprint: data.fingerprintObservation,
    envelope: data.envelope,
    custody: rebuilt.finalCustody,
    storageReadback: io.storageOriginals.storageReadback
  };
  const subjectRefs = Object.fromEntries(
    Object.entries(subjects).map(([name, value]) => [
      name,
      remember(Buffer.from(canonicalJson(value)))
    ])
  );
  remember(Buffer.from(canonicalJson(auth)));
  const readRaw = async (digest) => {
    requireThat(typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest));
    if (!originals.has(digest)) {
      const bytes = readFixed(`${AUTHORITY}/${prefix}/raw/${digest.slice(7)}.bin`, {
        privateFile: true,
        max: 1048576,
        allowEmpty: true
      });
      requireThat(sha256Bytes(bytes) === digest);
      remember(bytes);
    }
    return Buffer.from(originals.get(digest));
  };
  let prepared;
  await withFixedR3BuildAttestationScope(
    { repoRoot, operationRef: request.operationRef },
    async (scope) => {
      const creation = await readFixedR3CreationSpec(
        { repoRoot, operationRef: request.operationRef },
        scope
      );
      try {
        const spec = creation.spec;
        requireThat(
          spec.sourceSha === auth.sourceSha &&
            spec.profileDigest === PROFILE &&
            spec.ownerId === approval.ownerId &&
            spec.phase === approval.phase &&
            spec.chain === "snapshot" &&
            spec.operationRef === request.operationRef
        );
        const limits = [
          approval.validUntil,
          spec.expiresAt,
          profile.expiresAt,
          data.metadata.expiresAt
        ].map((value) => {
          const time = Date.parse(value);
          requireThat(
            typeof value === "string" &&
              Number.isFinite(time) &&
              new Date(time).toISOString() === value
          );
          return time;
        });
        prepared = await assembleR3SnapshotPreparation({
          profile,
          observedAt: new Date().toISOString(),
          readRaw,
          preparation: {
            recordVersion: "r3-snapshot-input-preparation.v1",
            inputReference: randomUUID(),
            operationRef: request.operationRef,
            creationSpecDigest: creation.creationSpecDigest,
            sourceSha: auth.sourceSha,
            phase: spec.phase,
            profileDigest: PROFILE,
            ownerId: profile.ownerId,
            releaseAttemptId: auth.releaseAttemptId,
            snapshotRunId: auth.snapshotRunId,
            validUntil: new Date(Math.min(...limits)).toISOString(),
            sourceAuthority: approval.sourceAuthority,
            sourceIdentity: approval.sourceIdentity,
            restrictionOriginals: approval.restrictionOriginals,
            ...subjectRefs
          }
        });
        await creation.recheck();
      } finally {
        await creation.close();
      }
    }
  );
  // All creation/raw captures have closed before mutating archive ancestors.
  requireThat(
    same(privateJson(`${prefix}/approval`), approval) && same(privateJson("r3-input-pins"), pins)
  );
  requireThat(
    Date.now() < Date.parse(JSON.parse(prepared.preparationBytes.toString("utf8")).validUntil)
  );
  const archiveRoot = profile.storage.archiveRoot;
  const ensureDirectory = (target, exclusive = false) => {
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (exclusive || error?.code !== "EEXIST") throw error;
    }
    const info = lstatSync(target);
    requireThat(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === 0 &&
        info.gid === 0 &&
        (info.mode & 0o777) === 0o700 &&
        info.dev === lstatSync(MAIN).dev
    );
  };
  for (const parent of [
    archiveRoot,
    `${archiveRoot}/raw`,
    `${archiveRoot}/inputs`,
    `${archiveRoot}/inputs/snapshots`,
    `${archiveRoot}/inputs/snapshots/prepared`
  ])
    ensureDirectory(parent);
  const destination = `${archiveRoot}/inputs/snapshots/prepared/${request.operationRef}`;
  ensureDirectory(destination, true);
  ensureDirectory(`${destination}/raw`, true);
  for (const original of prepared.rawOriginals) {
    requireThat(
      /^sha256:[0-9a-f]{64}$/u.test(original.digest) &&
        sha256Bytes(original.bytes) === original.digest
    );
    writeNewPublicationFile(`${destination}/raw/${original.digest.slice(7)}.bin`, original.bytes);
  }
  writeNewPublicationFile(`${destination}/package.json`, prepared.preparationBytes);
  const reread = readFixed(`${destination}/package.json`, { privateFile: true, max: 1048576 });
  requireThat(
    reread.equals(prepared.preparationBytes) && sha256Bytes(reread) === prepared.preparationDigest
  );
  for (const original of prepared.rawOriginals)
    requireThat(
      readFixed(`${destination}/raw/${original.digest.slice(7)}.bin`, {
        privateFile: true,
        max: 1048576,
        allowEmpty: true
      }).equals(original.bytes)
    );
  for (const parent of [`${destination}/raw`, destination, path.posix.dirname(destination)]) {
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return {
    status: "R3_SNAPSHOT_INPUT_PREPARED",
    ...request,
    inputReference: JSON.parse(reread.toString("utf8")).inputReference,
    preparationDigest: prepared.preparationDigest
  };
}
