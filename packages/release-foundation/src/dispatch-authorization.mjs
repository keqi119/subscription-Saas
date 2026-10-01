import { createPublicKey, randomBytes, verify } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { verifyAuthoritativeCustodyObservation } from "./evidence-custody.mjs";
import { validateContract } from "./schema-registry.mjs";

const decisions = new WeakSet();
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const bindingKeys = [
  "executionPurpose",
  "releaseAttemptId",
  "sourceSha",
  "producerWorkflow",
  "rcWorkflow",
  "buildProofDigest",
  "buildBundleDigest",
  "repositoryContractDigest",
  "adapterDigest",
  "revocationPolicyDigest"
];
const archiveKeys = [
  "reference",
  "objectKey",
  "objectVersion",
  "terminalAt",
  "snapshotExpiresAt",
  "downstreamRetainUntil",
  "legalHoldUntil"
];
const signatureKeys = ["algorithm", "issuer", "keyId", "subjectDigest", "signature"];
const coded = (code) => Object.assign(new Error(code), { code });
const fail = (code = "DISPATCH_EVIDENCE_INVALID") => {
  throw coded(code);
};
const bytes = (value) => Buffer.from(canonicalJson(value));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 2048;
const digest = (value) => typeof value === "string" && digestPattern.test(value);

function closed(value, keys, code = "DISPATCH_EVIDENCE_INVALID") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  )
    fail(code);
}

// Snapshot data before the first await. Accessors, symbols, exotic objects and sparse
// arrays are not input frames. A caller cannot swap a key/policy/body during readback.
function snapshot(value, seen = new WeakSet()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || seen.has(value)) fail();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) fail();
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) fail();
          return snapshot(descriptor.value, seen);
        })
      );
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) fail();
      Object.defineProperty(result, key, {
        value: snapshot(descriptor.value, seen),
        enumerable: true
      });
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function instant(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail("DISPATCH_EVIDENCE_EXPIRED");
  return time;
}

function positive(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function signer(policy) {
  closed(policy, ["issuer", "keyId", "publicKey"]);
  if (!Object.values(policy).every(id)) fail();
  const key = createPublicKey(policy.publicKey);
  if (key.asymmetricKeyType !== "ed25519") fail();
  return key;
}

function signatureValid(value, detached, policy, domain, name) {
  closed(detached, signatureKeys);
  const key = signer(policy);
  if (
    detached.algorithm !== "Ed25519" ||
    detached.issuer !== policy.issuer ||
    detached.keyId !== policy.keyId ||
    detached.subjectDigest !== sha256Canonical(value) ||
    typeof detached.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(detached.signature) ||
    Buffer.from(detached.signature, "base64").toString("base64") !== detached.signature ||
    !verify(null, bytes({ domain, [name]: value }), key, Buffer.from(detached.signature, "base64"))
  )
    fail();
}

function archiveValid(archive) {
  closed(archive, archiveKeys);
  if (![archive.reference, archive.objectKey, archive.objectVersion].every(id)) fail();
  for (const field of ["terminalAt", "downstreamRetainUntil"]) instant(archive[field]);
  for (const field of ["snapshotExpiresAt", "legalHoldUntil"])
    if (archive[field] !== null) instant(archive[field]);
}

function expectedValid(expected) {
  closed(expected, [...bindingKeys, "authorizationCustody"], "DISPATCH_BINDING_MISMATCH");
  archiveValid(expected.authorizationCustody);
}

function checkpointValid(checkpoint) {
  closed(checkpoint, ["sequence", "headDigest"], "DISPATCH_REVOCATION_ROLLBACK");
  if (
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    !digest(checkpoint.headDigest)
  )
    fail("DISPATCH_REVOCATION_ROLLBACK");
}

function monotonic(head, checkpoint) {
  checkpointValid(checkpoint);
  if (
    head.sequence < checkpoint.sequence ||
    (head.sequence === checkpoint.sequence && head.headDigest !== checkpoint.headDigest)
  )
    fail("DISPATCH_REVOCATION_ROLLBACK");
}

function policyValid(policy, expected, source, journal, clock) {
  closed(policy, [
    "repository",
    "actorId",
    "dispatchSigner",
    "workflow",
    "maxAuthorizationLifetimeMs",
    "custody",
    "revocation"
  ]);
  closed(policy.repository, ["id", "name"]);
  if (
    policy.repository.id !== "1253231368" ||
    policy.repository.name !== "keqi119/subscription-Saas" ||
    policy.actorId !== "275060624"
  )
    fail();
  closed(policy.workflow, ["executionPurpose", "producerWorkflow", "rcWorkflow"]);
  if (
    !same(policy.workflow, {
      executionPurpose: expected.executionPurpose,
      producerWorkflow: expected.producerWorkflow,
      rcWorkflow: expected.rcWorkflow
    })
  )
    fail("DISPATCH_BINDING_MISMATCH");
  if (!positive(policy.maxAuthorizationLifetimeMs, 86400000)) fail();
  closed(policy.custody, [
    "signer",
    "writerIdentity",
    "readerIdentity",
    "storeRef",
    "owner",
    "readers"
  ]);
  signer(policy.custody.signer);
  if (
    ![
      policy.custody.writerIdentity,
      policy.custody.readerIdentity,
      policy.custody.storeRef,
      policy.custody.owner
    ].every(id) ||
    policy.custody.writerIdentity === policy.custody.readerIdentity ||
    !Array.isArray(policy.custody.readers) ||
    !policy.custody.readers.length ||
    !policy.custody.readers.every(id) ||
    new Set(policy.custody.readers).size !== policy.custody.readers.length
  )
    fail();
  const revocation = policy.revocation;
  closed(revocation, [
    "policyDigest",
    "signer",
    "reader",
    "initialCheckpoint",
    "timeoutMs",
    "maxAgeMs"
  ]);
  if (
    !digest(revocation.policyDigest) ||
    revocation.policyDigest !== expected.revocationPolicyDigest ||
    !positive(revocation.timeoutMs, 30000) ||
    !positive(revocation.maxAgeMs, 300000)
  )
    fail();
  signer(revocation.signer);
  checkpointValid(revocation.initialCheckpoint);
  closed(revocation.reader, ["identity", "endpoint"]);
  if (!Object.values(revocation.reader).every(id)) fail();
  closed(source, ["identity", "endpoint", "readExact", "readRevocationHead"]);
  if (
    source.identity !== revocation.reader.identity ||
    source.endpoint !== revocation.reader.endpoint ||
    typeof source.readExact !== "function" ||
    typeof source.readRevocationHead !== "function"
  )
    fail();
  closed(journal, ["readCheckpoint", "recordVerifiedHead"]);
  if (
    typeof journal.readCheckpoint !== "function" ||
    typeof journal.recordVerifiedHead !== "function"
  )
    fail();
  closed(clock, ["now"]);
  if (typeof clock.now !== "function") fail();
}

export function dispatchAuthorizationSigningBytes(authorization) {
  try {
    const accepted = snapshot(authorization);
    validateContract("rc-dispatch-authorization.v1", accepted);
    return bytes({ domain: "rc-dispatch-authorization.v1", authorization: accepted });
  } catch {
    fail("DISPATCH_SIGNATURE_INVALID");
  }
}

function responseValid(response, signature, request, policy, now) {
  closed(response, [
    "schemaVersion",
    "issuer",
    "keyId",
    "policyDigest",
    "nonce",
    "authorizationDigest",
    "sequence",
    "headDigest",
    "issuedAt",
    "notAfter",
    "revokedAuthorizationIds",
    "revokedAuthorizationDigests",
    "archive"
  ]);
  signatureValid(response, signature, policy.signer, "i0-revocation-read.v1", "response");
  if (
    response.schemaVersion !== "i0-revocation-read.v1" ||
    response.issuer !== policy.signer.issuer ||
    response.keyId !== policy.signer.keyId ||
    response.policyDigest !== request.policyDigest ||
    response.nonce !== request.nonce ||
    response.authorizationDigest !== request.authorizationDigest ||
    !Number.isSafeInteger(response.sequence) ||
    response.sequence < 0 ||
    !digest(response.headDigest)
  )
    fail();
  for (const [field, check] of [
    ["revokedAuthorizationIds", id],
    ["revokedAuthorizationDigests", digest]
  ]) {
    const values = response[field];
    if (
      !Array.isArray(values) ||
      values.length > 10000 ||
      !values.every(check) ||
      new Set(values).size !== values.length
    )
      fail();
  }
  const state = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest: response.policyDigest,
    sequence: response.sequence,
    revokedAuthorizationIds: response.revokedAuthorizationIds,
    revokedAuthorizationDigests: response.revokedAuthorizationDigests
  };
  if (sha256Canonical(state) !== response.headDigest) fail();
  archiveValid(response.archive);
  const issued = instant(response.issuedAt);
  const expiry = instant(response.notAfter);
  if (
    issued > now ||
    expiry <= now ||
    expiry <= issued ||
    expiry - issued > policy.maxAgeMs ||
    now - issued >= policy.maxAgeMs
  )
    fail("DISPATCH_EVIDENCE_EXPIRED");
  return { state: snapshot(state), expiresAt: Math.min(expiry, issued + policy.maxAgeMs) };
}

function captureCapabilities(value, keys) {
  closed(value, keys);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

// The reader is a controlled FD/file handoff, not a URL-fetch facility. Its pinned
// endpoint is an identity only. I0 must serialize this read behind prior revocations;
// signatures cannot prove server scheduling, so provisioning that reader remains gated.
export async function verifyDispatchAuthorization(input) {
  let authorization, signature, authorizationDigest, expected, trust;
  try {
    closed(input, [
      "authorization",
      "signature",
      "expected",
      "trustPolicy",
      "evidenceSource",
      "revocationJournal",
      "clock"
    ]);
    authorization = snapshot(input.authorization);
    signature = snapshot(input.signature);
    trust = snapshot(input.trustPolicy);
    const signingBytes = dispatchAuthorizationSigningBytes(authorization);
    signer(trust.dispatchSigner);
    signatureValid(
      authorization,
      signature,
      trust.dispatchSigner,
      "rc-dispatch-authorization.v1",
      "authorization"
    );
    if (authorization.issuer !== trust.dispatchSigner.issuer || signingBytes.byteLength > 1048576)
      fail();
    authorizationDigest = sha256Canonical(authorization);
  } catch {
    fail("DISPATCH_SIGNATURE_INVALID");
  }
  try {
    expected = snapshot(input.expected);
    expectedValid(expected);
  } catch {
    fail("DISPATCH_BINDING_MISMATCH");
  }
  for (const field of bindingKeys)
    if (!same(authorization[field], expected[field])) fail("DISPATCH_BINDING_MISMATCH");
  const source = captureCapabilities(input.evidenceSource, [
    "identity",
    "endpoint",
    "readExact",
    "readRevocationHead"
  ]);
  const journal = captureCapabilities(input.revocationJournal, [
    "readCheckpoint",
    "recordVerifiedHead"
  ]);
  const clock = captureCapabilities(input.clock, ["now"]);
  try {
    policyValid(trust, expected, source, journal, clock);
  } catch (error) {
    if (error.code) throw error;
    fail();
  }
  const startedAt = instant(clock.now());
  const issuedAt = instant(authorization.issuedAt);
  const notAfter = instant(authorization.notAfter);
  if (
    issuedAt > startedAt ||
    notAfter <= startedAt ||
    notAfter <= issuedAt ||
    notAfter - issuedAt > trust.maxAuthorizationLifetimeMs
  )
    fail("DISPATCH_EVIDENCE_EXPIRED");
  const elapsedStart = performance.now();
  const remaining = () => trust.revocation.timeoutMs - (performance.now() - elapsedStart);
  async function bounded(call) {
    const timeout = remaining();
    if (timeout <= 0) fail("DISPATCH_EVIDENCE_UNAVAILABLE");
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(call),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(coded("DISPATCH_EVIDENCE_UNAVAILABLE")), timeout);
        })
      ]);
    } catch (error) {
      if (error?.code === "DISPATCH_REVOCATION_ROLLBACK") throw error;
      fail("DISPATCH_EVIDENCE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
  const checkpoint = snapshot(
    await bounded(() => journal.readCheckpoint(trust.revocation.policyDigest))
  );
  monotonic(checkpoint, trust.revocation.initialCheckpoint);
  const request = Object.freeze({
    policyDigest: trust.revocation.policyDigest,
    authorizationDigest,
    nonce: randomBytes(32).toString("hex")
  });
  const online = snapshot(await bounded(() => source.readRevocationHead(request)));
  closed(online, ["response", "signature"]);
  let verifiedHead;
  try {
    verifiedHead = responseValid(
      online.response,
      online.signature,
      request,
      trust.revocation,
      instant(clock.now())
    );
  } catch (error) {
    if (error.code === "DISPATCH_EVIDENCE_EXPIRED") throw error;
    fail();
  }
  monotonic(online.response, checkpoint);
  const revoked =
    online.response.revokedAuthorizationIds.includes(authorization.authorizationId) ||
    online.response.revokedAuthorizationDigests.includes(authorizationDigest);
  const expiresAt = Math.min(notAfter, verifiedHead.expiresAt);
  function currentTime() {
    const now = instant(clock.now());
    if (now < startedAt || now >= expiresAt) fail("DISPATCH_EVIDENCE_EXPIRED");
    if (remaining() <= 0) fail("DISPATCH_EVIDENCE_UNAVAILABLE");
    return now;
  }
  async function archived(body, detached, archive, root, domain, name) {
    const expectedDigest = sha256Canonical(body);
    const raw = await bounded(() =>
      source.readExact(Object.freeze({ reference: archive.reference, expectedDigest }))
    );
    try {
      closed(raw, ["originalBytes", "signature", "receipt", "observation", "observationSignature"]);
      if (!(raw.originalBytes instanceof Uint8Array) || raw.originalBytes.byteLength > 1048576)
        fail();
      const originalBytes = Buffer.from(raw.originalBytes);
      const frame = snapshot({
        signature: raw.signature,
        receipt: raw.receipt,
        observation: raw.observation,
        observationSignature: raw.observationSignature
      });
      if (sha256Bytes(originalBytes) !== expectedDigest || !originalBytes.equals(bytes(body)))
        fail();
      signatureValid(body, frame.signature, root, domain, name);
      if (detached && !same(frame.signature, detached)) fail();
      const { reference, ...object } = archive;
      verifyAuthoritativeCustodyObservation({
        originalBytes,
        receipt: frame.receipt,
        observation: frame.observation,
        signature: frame.observationSignature,
        expected: { ...object, contentDigest: expectedDigest, storeRef: trust.custody.storeRef },
        trustPolicy: trust.custody,
        now: new Date(currentTime()).toISOString()
      });
    } catch (error) {
      if (
        error.code === "DISPATCH_EVIDENCE_EXPIRED" ||
        error.code === "DISPATCH_EVIDENCE_UNAVAILABLE"
      )
        throw error;
      fail();
    }
  }
  await archived(
    verifiedHead.state,
    null,
    online.response.archive,
    trust.revocation.signer,
    "i0-revocation-state.v1",
    "state"
  );
  await archived(
    authorization,
    signature,
    expected.authorizationCustody,
    trust.dispatchSigner,
    "rc-dispatch-authorization.v1",
    "authorization"
  );
  currentTime();
  // The injected launcher journal must atomically compare-and-record: reject missing
  // initialization, sequence downgrade and equal-sequence different digest. It must
  // preserve that high-water mark across process restarts. No remote writes occur here.
  const latest = snapshot(
    await bounded(() => journal.readCheckpoint(trust.revocation.policyDigest))
  );
  monotonic(latest, checkpoint);
  monotonic(online.response, latest);
  await bounded(() =>
    journal.recordVerifiedHead(
      Object.freeze({
        policyDigest: trust.revocation.policyDigest,
        sequence: online.response.sequence,
        headDigest: online.response.headDigest
      })
    )
  );
  const recorded = snapshot(
    await bounded(() => journal.readCheckpoint(trust.revocation.policyDigest))
  );
  monotonic(recorded, {
    sequence: online.response.sequence,
    headDigest: online.response.headDigest
  });
  monotonic(online.response, recorded);
  const verifiedAt = currentTime();
  if (revoked) fail("DISPATCH_REVOKED");
  const decision = snapshot({
    authorization,
    authorizationDigest,
    expected,
    verifiedAt: new Date(verifiedAt).toISOString(),
    notAfter: new Date(expiresAt).toISOString(),
    revocationSequence: recorded.sequence,
    revocationHeadDigest: recorded.headDigest
  });
  decisions.add(decision);
  return decision;
}

// An assertion within the same trusted verification/reconstruction flow, not a
// consumable token and not a fresh revocation check. Every later sensitive boundary
// must call verifyDispatchAuthorization again before using its newly returned decision.
export function assertVerifiedDispatchAuthorization(decision, { expected, now }) {
  if (!decision || !decisions.has(decision)) fail("DISPATCH_DECISION_UNVERIFIED");
  try {
    const accepted = snapshot(expected);
    expectedValid(accepted);
    if (!same(decision.expected, accepted)) fail();
  } catch {
    fail("DISPATCH_BINDING_MISMATCH");
  }
  const at = instant(now);
  if (at < instant(decision.verifiedAt) || at >= instant(decision.notAfter))
    fail("DISPATCH_EVIDENCE_EXPIRED");
  return decision;
}
