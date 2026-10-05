// Fixed H1 key binding. No key/path/domain input and no private-key export.
// This preserves the existing approved manual profile; it does not promote it
// or replace the snapshot dispatch, custody, revocation or GitHub decisions.
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { verifyAuthoritativeCustodyObservation } from "../../packages/release-foundation/src/evidence-custody.mjs";
import { validateProducerCryptoAuthorization } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { verifyAndSignSnapshotAdmission } from "../../packages/release-foundation/src/snapshot/snapshot-admission-verification.mjs";
import { assertH1KeyMemory, assertH1KeyVolume } from "./snapshot-h1-key-volume.mjs";
import { buildH1CryptoUseProof } from "./snapshot-h1-data-proof.mjs";
import {
  prepareH1SnapshotObjects,
  verifyH1SnapshotPublication
} from "./snapshot-h1-publication.mjs";
import {
  assertSnapshotPublicationObject,
  createSnapshotPublisherTransport
} from "./snapshot-oss-storage.mjs";

const CODE = "H1_SNAPSHOT_SIGNING_REJECTED";
const MAIN = "/var/lib/stage1-volumes/main";
const KEY = `${MAIN}/key/signing-ed25519.pk8.pem`;
const PROFILE = "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541";
const OWNER = "sha256:68a627061f135ee52f811f81e9c39283aa3adc9c00a01be566b08a76ec82c9c2";
const FINGERPRINT = "sha256:7146f2e00f4a8e70183a64f3e8c7ebfa8e66926f60d18442e3d5ac4a09e408ef";
const AUTHORITY = `${MAIN}/snapshot-authority`;
const READER = {
  identity: "keqi119-h1-current-revocation",
  endpoint: "h1://139.196.227.195/stage1/current-revocation"
};
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

function authority(identity) {
  const value = privateJson("authority");
  assertKernelFrame(value, ["rootPolicy", "expected", "trustPolicy"], CODE);
  for (const signer of [
    value.rootPolicy.rootSigner,
    value.trustPolicy.dispatchSigner,
    value.trustPolicy.revocation.signer,
    value.trustPolicy.custody.signer
  ])
    requireThat(same(signer, identity.signer));
  requireThat(same(value.trustPolicy.revocation.reader, READER));
  const custody = value.trustPolicy.custody;
  requireThat(
    custody.writerIdentity ===
      "acs:ram::1457643390906675:role/subscription-saas-stage1-archive-writer" &&
      custody.readerIdentity ===
        "acs:ram::1457643390906675:role/subscription-saas-stage1-archive-reader" &&
      custody.storeRef === "oss://subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai"
  );
  return value;
}

// Verification only: this cannot issue an original or a custody observation.
// Production callers supply packets read from the fixed protected directory.
export function verifyH1ArchivedDispatchPacket({ packet, trustPolicy, kind, now }) {
  try {
    const captured = snapshotKernelData({ packet, trustPolicy, kind, now }, CODE);
    ({ packet, trustPolicy, kind, now } = captured);
    requireThat(kind === "authorization" || kind === "state");
    assertKernelFrame(
      packet,
      ["body", "signature", "archive", "receipt", "observation", "observationSignature"],
      CODE
    );
    const domain =
      kind === "authorization" ? "rc-dispatch-authorization.v1" : "i0-revocation-state.v1";
    validateContract(domain, packet.body);
    const signer =
      kind === "authorization" ? trustPolicy.dispatchSigner : trustPolicy.revocation.signer;
    const detached = packet.signature;
    assertKernelFrame(
      detached,
      ["algorithm", "issuer", "keyId", "subjectDigest", "signature"],
      CODE
    );
    const raw = Buffer.from(canonicalJson(packet.body));
    const digest = sha256Bytes(raw);
    const key = createPublicKey(signer.publicKey);
    requireThat(
      key.asymmetricKeyType === "ed25519" &&
        detached.algorithm === "Ed25519" &&
        detached.issuer === signer.issuer &&
        detached.keyId === signer.keyId &&
        detached.subjectDigest === digest &&
        typeof detached.signature === "string" &&
        /^[A-Za-z0-9+/]{86}==$/.test(detached.signature) &&
        Buffer.from(detached.signature, "base64").toString("base64") === detached.signature &&
        verify(
          null,
          Buffer.from(canonicalJson({ domain, [kind]: packet.body })),
          key,
          Buffer.from(detached.signature, "base64")
        )
    );
    requireThat(
      (kind === "authorization" ? packet.body.revocationPolicyDigest : packet.body.policyDigest) ===
        trustPolicy.revocation.policyDigest
    );
    assertKernelFrame(
      packet.archive,
      [
        "reference",
        "objectKey",
        "objectVersion",
        "terminalAt",
        "snapshotExpiresAt",
        "downstreamRetainUntil",
        "legalHoldUntil"
      ],
      CODE
    );
    requireThat(
      packet.archive.reference === packet.archive.objectKey &&
        packet.archive.objectKey === `control-evidence/v1/${domain}/${digest}` &&
        packet.archive.objectVersion === "null-version-disabled"
    );
    const { reference, ...object } = packet.archive;
    requireThat(reference.length > 0);
    verifyAuthoritativeCustodyObservation({
      originalBytes: raw,
      receipt: packet.receipt,
      observation: packet.observation,
      signature: packet.observationSignature,
      expected: { ...object, contentDigest: digest, storeRef: trustPolicy.custody.storeRef },
      trustPolicy: trustPolicy.custody,
      now
    });
    return captured.packet;
  } catch {
    fail();
  }
}

function archived(name, trusted, kind, now) {
  return verifyH1ArchivedDispatchPacket({
    packet: privateJson(name),
    trustPolicy: trusted.trustPolicy,
    kind,
    now
  });
}

// No caller paths, keys or evidence sources. Missing originals/receipts fail;
// setup must install real signed, archived records and a live independent STS session.
export async function readH1SnapshotDispatchInputs(...args) {
  requireThat(args.length === 0);
  const identity = await admittedIdentity();
  const trusted = authority(identity);
  const now = new Date().toISOString();
  const authorization = archived("authorization", trusted, "authorization", now);
  const state = archived("current-revocation", trusted, "state", now);
  requireThat(same(authorization.archive, trusted.expected.authorizationCustody));
  return snapshotKernelData(
    { ...trusted, authorization, state, session: privateJson("reader-session", 32768) },
    CODE
  );
}

export async function readH1SnapshotProductionInputs(...args) {
  requireThat(args.length === 0);
  await admittedIdentity();
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

// A read is linearized at the checked read of current-revocation.json. The root
// authority commits a new fully archived/signed head by atomic rename of that
// one file. There is no cached response, timer, network revocation service or
// caller-supplied state. The verifier's durable journal independently rejects rollback.
export async function readAndSignH1CurrentRevocation(input) {
  assertKernelFrame(input, ["policyDigest", "authorizationDigest", "nonce"], CODE);
  const request = snapshotKernelData(input, CODE);
  requireThat(
    /^sha256:[a-f0-9]{64}$/.test(request.policyDigest) &&
      /^sha256:[a-f0-9]{64}$/.test(request.authorizationDigest) &&
      typeof request.nonce === "string" &&
      /^[a-f0-9]{64}$/.test(request.nonce)
  );
  const identity = await admittedIdentity();
  const trusted = authority(identity);
  const now = new Date().toISOString();
  const authorization = archived("authorization", trusted, "authorization", now);
  const state = archived("current-revocation", trusted, "state", now);
  requireThat(
    request.policyDigest === trusted.trustPolicy.revocation.policyDigest &&
      request.authorizationDigest === sha256Canonical(authorization.body)
  );
  const at = Date.parse(now);
  const age = trusted.trustPolicy.revocation.maxAgeMs;
  requireThat(
    Number.isSafeInteger(age) &&
      age > 0 &&
      age <= 300000 &&
      Date.parse(authorization.body.issuedAt) <= at &&
      at < Date.parse(authorization.body.notAfter)
  );
  const response = {
    schemaVersion: "i0-revocation-read.v1",
    ...request,
    issuer: identity.signer.issuer,
    keyId: identity.signer.keyId,
    sequence: state.body.sequence,
    headDigest: sha256Canonical(state.body),
    issuedAt: now,
    notAfter: new Date(
      Math.min(at + Math.min(age, 30000), Date.parse(authorization.body.notAfter))
    ).toISOString(),
    revokedAuthorizationIds: state.body.revokedAuthorizationIds,
    revokedAuthorizationDigests: state.body.revokedAuthorizationDigests,
    archive: state.archive
  };
  const signature = {
    algorithm: "Ed25519",
    issuer: identity.signer.issuer,
    keyId: identity.signer.keyId,
    subjectDigest: sha256Canonical(response),
    signature: sign(
      null,
      Buffer.from(canonicalJson({ domain: "i0-revocation-read.v1", response })),
      readSigningKey(identity)
    ).toString("base64")
  };
  return snapshotKernelData({ response, signature }, CODE);
}

function readSigningKey(expectedIdentity) {
  let raw;
  try {
    // Called at a fixed operation's signing boundary: verified admission, an
    // archived current-head read, or the explicitly diagnostic key challenge.
    // No arbitrary caller-selected signing domain or key export is available.
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

// Only the fixed root controller calls this after fresh dispatch verification.
// The caller selects no payload or path: both are read from the protected
// production authorization and the completed, root-owned attempt output.
export async function sealH1SnapshotDataProof(...args) {
  requireThat(args.length === 0);
  const trusted = await admittedIdentity();
  const production = await readH1SnapshotProductionInputs();
  const auth = production.authorization;
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      auth.releaseAttemptId
    ) && auth.issuer.issuerId === trusted.signer.issuer
  );
  const directory = `/var/lib/subscription-saas/snapshot-output/${auth.releaseAttemptId}`;
  const raw = readFixed(`${directory}/data-result.json`, { privateFile: true, max: 4194304 });
  const result = JSON.parse(raw.toString("utf8"));
  requireThat(raw.equals(Buffer.from(canonicalJson(result))) && result.status === "DATA_PREPARED");
  requireThat(same(result.cryptoAuthorization, auth));
  validateContract("snapshot-admission.v1", result.admission);
  requireThat(
    result.admission.releaseAttemptId === auth.releaseAttemptId &&
      result.admission.producerRun.runId === auth.snapshotRunId &&
      result.admission.producerRun.sourceSha === auth.sourceSha &&
      result.admission.dispatchAuthorizationDigest === auth.bindings.dispatchAuthorizationDigest &&
      result.admission.adapterDigest === auth.bindings.adapterExecutableDigest &&
      result.terminalObservation.runningJobObservationDigest ===
        sha256Canonical(result.runningJobObservation)
  );
  const ciphertext = readFixed(`${directory}/snapshot.enc`, { privateFile: true, max: 134217728 });
  requireThat(
    ciphertext.length === result.data.envelope.ciphertextSizeBytes &&
      sha256Bytes(ciphertext) === result.data.envelope.ciphertextDigest
  );
  const proof = buildH1CryptoUseProof({
    authorization: auth,
    data: result.data,
    observation: result.executionObservation,
    terminal: result.terminalObservation,
    cleanup: result.cleanup,
    volume: result.volumeObservation,
    disposal: result.disposalObservation
  });
  const subject = { proof, dataResultDigest: sha256Bytes(raw) };
  const signature = sign(
    null,
    Buffer.from(canonicalJson({ domain: "h1-snapshot-data-proof.v1", subject })),
    readSigningKey(trusted)
  ).toString("base64");
  return snapshotKernelData(
    {
      ...subject,
      signature: {
        algorithm: "Ed25519",
        issuer: trusted.signer.issuer,
        keyId: trusted.signer.keyId,
        subjectDigest: sha256Canonical(subject),
        signature
      }
    },
    CODE
  );
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

// The approved controller invokes this separate fixed operation only after
// crypto cleanup and issuance of the one-off publisher STS. Never retry an
// unknown PUT by overwriting or mint the STS before the crypto process exits.
export async function publishH1SnapshotData(verified) {
  assertKernelFrame(
    verified,
    ["authorizationDigest", "dispatchAuthorizationDigest", "notAfter"],
    CODE
  );
  const trusted = await admittedIdentity();
  const production = await readH1SnapshotProductionInputs(),
    auth = production.authorization;
  requireThat(
    sha256Canonical(auth) === verified.authorizationDigest &&
      auth.bindings.dispatchAuthorizationDigest === verified.dispatchAuthorizationDigest
  );
  const expected = {
    releaseAttemptId: auth.releaseAttemptId,
    snapshotRunId: auth.snapshotRunId,
    sourceSha: auth.sourceSha,
    dispatchAuthorizationDigest: auth.bindings.dispatchAuthorizationDigest
  };
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      auth.releaseAttemptId
    )
  );
  const directory = `/var/lib/subscription-saas/snapshot-output/${auth.releaseAttemptId}`;
  const prepared = prepareH1SnapshotObjects({
    dataResultBytes: readFixed(`${directory}/data-result.json`, {
      privateFile: true,
      max: 1048576
    }),
    proofBytes: readFixed(`${directory}/snapshot-proof.json`, { privateFile: true, max: 1048576 }),
    ciphertext: readFixed(`${directory}/snapshot.enc`, { privateFile: true, max: 134217728 }),
    expected,
    signer: trusted.signer
  });
  requireThat(same(prepared.result.cryptoAuthorization, auth));
  const identity = { releaseAttemptId: auth.releaseAttemptId, snapshotRunId: auth.snapshotRunId };
  for (const object of prepared.objects)
    assertSnapshotPublicationObject({ ...identity, ...object });
  const session = privateJson("publisher-session", 32768);
  requireThat(
    typeof session.arn === "string" &&
      session.arn.replace(":role/", ":assumed-role/") ===
        `acs:ram::1457643390906675:assumed-role/subscription-saas-stage1-snapshot-publisher/stage1-publisher-${auth.snapshotRunId}-attempt-1`
  );
  requireThat(
    Date.parse(session.issuedAt) >= Date.parse(prepared.sealed.proof.cleanup.processExitedAt)
  );
  const writer = await createSnapshotPublisherTransport({ ...identity, session });
  const receipts = [];
  for (const object of prepared.objects) {
    requireThat(Date.now() < Date.parse(verified.notAfter));
    receipts.push(await writer.createOnly(object));
  }
  const publication = {
    ...expected,
    writerArn: session.arn,
    writerIdentityOriginal: writer.identityOriginal,
    writerIssuedAt: session.issuedAt,
    writerExpiresAt: session.expiresAt,
    cryptoExitedAt: prepared.sealed.proof.cleanup.processExitedAt,
    publishedAt: new Date().toISOString(),
    objects: receipts
  };
  const signature = {
    algorithm: "Ed25519",
    issuer: trusted.signer.issuer,
    keyId: trusted.signer.keyId,
    subjectDigest: sha256Canonical(publication),
    signature: sign(
      null,
      Buffer.from(canonicalJson({ domain: "h1-snapshot-publication.v1", subject: publication })),
      readSigningKey(trusted)
    ).toString("base64")
  };
  const marker = Buffer.from(canonicalJson({ publication, signature }));
  verifyH1SnapshotPublication({ bytes: marker, expected, signer: trusted.signer });
  writeNewPublicationFile(`${directory}/encryption-envelope.json`, prepared.objects[1].bytes);
  // Preserve local evidence before the final conditional write. On an unknown
  // result the operator must inspect exact objects, never blindly retry.
  writeNewPublicationFile(`${directory}/diagnostics.redacted.json`, marker);
  requireThat(Date.now() < Date.parse(verified.notAfter));
  const final = await writer.createOnly({
    key: `snapshot-slots/v2/${auth.releaseAttemptId}/${auth.snapshotRunId}/diagnostics.redacted.json`,
    bytes: marker,
    contentDigest: sha256Bytes(marker)
  });
  return {
    status: "PUBLISHED",
    releaseAttemptId: auth.releaseAttemptId,
    snapshotRunId: auth.snapshotRunId,
    publicationDigest: sha256Bytes(marker),
    writer: {
      arn: publication.writerArn,
      issuedAt: publication.writerIssuedAt,
      expiresAt: publication.writerExpiresAt
    },
    publishedAt: publication.publishedAt,
    objects: [...receipts, final]
  };
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
