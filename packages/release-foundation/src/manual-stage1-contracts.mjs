import { KeyObject, createPublicKey, sign, verify } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";

const LIMIT = 1048576;
const manualVersions = Object.freeze({
  "manual-stage1-profile.v1": "manual-operation-record.v1",
  "manual-stage1-profile.v2": "manual-operation-record.v2"
});
const parentDecisions = new WeakSet();
const childDecisions = new WeakSet();
const commonKeys = [
  "profileDigest",
  "ownerId",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "purpose",
  "targetIntent",
  "stage",
  "capability"
];
const runnerKeys = [
  "commandId",
  "commandVersion",
  "phase",
  "buildProofDigest",
  "baselineManifestDigest",
  "targetObservationDigest",
  "physicalIdentity",
  "roleObservation",
  "containerId",
  "runnerImageDigest",
  "childChallenge"
];
const conditionalKeys = [
  "dryRunRecordDigest",
  "approvedPlanDigest",
  "predecessorExecutionRecordDigest",
  "originalIdempotencyKey"
];
const allBindingKeys = [...commonKeys, ...runnerKeys, ...conditionalKeys];
const childKeys = ["containerId", "runnerImageDigest", "childChallenge"];
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const requireThat = (condition, code = "MANUAL_BINDING_MISMATCH") => {
  if (!condition) fail(code);
};
const isDigest = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

function closed(value, keys, code = "MANUAL_BINDING_MISMATCH") {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && "value" in descriptor;
      }),
    code
  );
}

// Snapshot only inert own JSON data. Never invoke getters/toJSON or validate one
// object and subsequently sign/hash a caller-controlled second view of it.
function snapshot(value, seen = new WeakSet()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  requireThat(value && typeof value === "object" && !seen.has(value), "CANONICAL_JSON_REFUSED");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      requireThat(Reflect.ownKeys(value).length === value.length + 1, "CANONICAL_JSON_REFUSED");
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          requireThat(descriptor?.enumerable && "value" in descriptor, "CANONICAL_JSON_REFUSED");
          return snapshot(descriptor.value, seen);
        })
      );
    }
    requireThat(
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
      "CANONICAL_JSON_REFUSED"
    );
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireThat(
        typeof key === "string" && descriptor.enumerable && "value" in descriptor,
        "CANONICAL_JSON_REFUSED"
      );
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

function limit(bytes, maximum = LIMIT) {
  requireThat(bytes.length <= maximum, "MANUAL_JSON_LIMIT");
  return bytes;
}

function encodeBoundedJson(value, maximum) {
  const data = snapshot(value);
  limit(Buffer.from(JSON.stringify(data), "utf8"), maximum);
  return limit(Buffer.from(canonicalJson(data), "utf8"), maximum);
}

export function encodeManualJson(value) {
  return encodeBoundedJson(value, LIMIT);
}

// Private source process originals can aggregate multiple bounded outputs.
// This encoder is not used for signed requests, records or protocol frames.
export function encodePrivateObservationJson(value) {
  return encodeBoundedJson(value, 33554432);
}

function jsonInput(value) {
  return JSON.parse(encodeManualJson(value).toString("utf8"));
}

function instant(value) {
  const epoch = typeof value === "string" ? Date.parse(value) : NaN;
  requireThat(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(epoch) &&
      new Date(epoch).toISOString() === value,
    "MANUAL_TIME_INVALID"
  );
  return epoch;
}

function recordTimes(record) {
  for (const key of [
    "recordedAt",
    "openedAt",
    "issuedAt",
    "expiresAt",
    "observedAt",
    "startedAt",
    "finishedAt"
  ]) {
    if (record[key] !== undefined && record[key] !== null) instant(record[key]);
  }
  for (const key of ["openedAt", "observedAt", "startedAt", "finishedAt"]) {
    if (record[key] !== undefined && record[key] !== null)
      requireThat(instant(record[key]) <= instant(record.recordedAt), "MANUAL_TIME_INVALID");
  }
  if (record.kind === "session" && record.status === "OPEN")
    requireThat(record.openedAt === record.recordedAt, "MANUAL_TIME_INVALID");
  if (record.startedAt && record.finishedAt)
    requireThat(instant(record.startedAt) <= instant(record.finishedAt), "MANUAL_TIME_INVALID");
}

function signatureBytes(body, domain) {
  return Buffer.concat([
    Buffer.from(`subscription-saas/${domain}/v1\n`, "utf8"),
    encodeManualJson(body)
  ]);
}

function verifySignature(body, signature, key, domain) {
  requireThat(
    typeof signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(signature),
    "MANUAL_SIGNATURE_INVALID"
  );
  const bytes = Buffer.from(signature, "base64");
  requireThat(
    bytes.length === 64 && bytes.toString("base64") === signature,
    "MANUAL_SIGNATURE_INVALID"
  );
  try {
    requireThat(verify(null, signatureBytes(body, domain), key, bytes), "MANUAL_SIGNATURE_INVALID");
  } catch (error) {
    if (error.code === "MANUAL_JSON_LIMIT") throw error;
    fail("MANUAL_SIGNATURE_INVALID");
  }
}

function profileKey(profile, now) {
  const from = instant(profile.validFrom),
    expires = instant(profile.expiresAt);
  requireThat(from < expires && from <= now && now < expires, "MANUAL_TIME_INVALID");
  let key;
  try {
    requireThat(
      /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(
        profile.publicKeyPem
      ),
      "MANUAL_SIGNATURE_INVALID"
    );
    key = createPublicKey({ key: profile.publicKeyPem, type: "spki", format: "pem" });
    requireThat(
      key.asymmetricKeyType === "ed25519" &&
        sha256Bytes(key.export({ type: "spki", format: "der" })) === profile.keyFingerprint,
      "MANUAL_SIGNATURE_INVALID"
    );
  } catch {
    fail("MANUAL_SIGNATURE_INVALID");
  }
  requireThat(
    new Set(profile.allowedTargets.map((target) => target.endpointPolicyId)).size ===
      profile.allowedTargets.length
  );
  // Lexical independence only: realpath, aliases, ACLs and encryption are IO gates.
  const normalize = (value) =>
    /^[A-Za-z]:/.test(value)
      ? path.win32.normalize(value).toLowerCase().replaceAll("\\", "/")
      : path.posix.normalize(value);
  const backup = normalize(profile.storage.backupRoot);
  for (const field of ["keyRoot", "journalRoot", "archiveRoot", "credentialRoot"]) {
    const root = normalize(profile.storage[field]);
    requireThat(
      backup !== root && !backup.startsWith(`${root}/`) && !root.startsWith(`${backup}/`)
    );
  }
  return key;
}

export function signManualAuthorization(input) {
  closed(input, ["payload", "privateKey"]);
  const payload = jsonInput(input.payload);
  const forward = [
    "manual-launch-authorization.v2",
    "manual-launch-authorization.v3",
    "manual-launch-authorization.v4"
  ].includes(payload.schemaVersion);
  validateContract(forward ? payload.schemaVersion : "manual-launch-authorization.v1", {
    payload,
    signature: forward ? Buffer.alloc(64).toString("base64") : ""
  });
  instant(payload.issuedAt);
  instant(payload.expiresAt);
  const key = input.privateKey;
  requireThat(
    key instanceof KeyObject && key.type === "private" && key.asymmetricKeyType === "ed25519",
    "MANUAL_SIGNATURE_INVALID"
  );
  const authorization = {
    payload,
    signature: sign(null, signatureBytes(payload, "manual-launch"), key).toString("base64")
  };
  encodeManualJson(authorization);
  return authorization;
}

function requestInput(request) {
  closed(request, ["canonicalBytes", "binding"]);
  requireThat(Buffer.isBuffer(request.canonicalBytes));
  const bytes = limit(Buffer.from(request.canonicalBytes));
  const binding = jsonInput(request.binding);
  let full;
  try {
    full = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("MANUAL_BINDING_MISMATCH");
  }
  requireThat(full && typeof full === "object" && !Array.isArray(full));
  requireThat(encodeManualJson(full).equals(bytes));
  return { full, binding };
}

// These checks only bind inert bytes and signatures. Missing scope, destination
// and allocation originals remain IO admission stops; no decision is branded.
export function validateManualSnapshotConsumerRequest(request) {
  const captured = snapshot(jsonInput(request));
  validateContract(
    captured.schemaVersion === "manual-runner-request.v3"
      ? "manual-runner-request.v3"
      : "manual-runner-request.v2",
    captured
  );
  requireThat(captured.attemptId !== captured.runId);
  return captured;
}

export function validateManualTargetCreationRequest(request) {
  const captured = snapshot(jsonInput(request));
  validateContract("manual-runner-request.v4", captured);
  requireThat(captured.attemptId !== captured.runId);
  return captured;
}

export function verifyManualSnapshotConsumerAuthorizationBinding(input) {
  return verifyManualScopedAuthorizationBinding(input, false);
}

export function verifyManualTargetCreationAuthorizationBinding(input) {
  return verifyManualScopedAuthorizationBinding(input, true);
}

function verifyManualScopedAuthorizationBinding(input, creation) {
  closed(input, ["authorization", "profile", "requestBytes", "now"]);
  const authorization = jsonInput(input.authorization),
    profile = jsonInput(input.profile),
    parsed = requestInput({ canonicalBytes: input.requestBytes, binding: {} }),
    request = creation
      ? validateManualTargetCreationRequest(parsed.full)
      : validateManualSnapshotConsumerRequest(parsed.full),
    epoch = instant(input.now);
  validateContract("manual-stage1-profile.v2", profile);
  validateContract(
    creation
      ? "manual-launch-authorization.v4"
      : request.schemaVersion === "manual-runner-request.v3"
        ? "manual-launch-authorization.v3"
        : "manual-launch-authorization.v2",
    authorization
  );
  const payload = authorization.payload,
    key = profileKey(profile, epoch),
    issued = instant(payload.issuedAt),
    expires = instant(payload.expiresAt);
  verifySignature(payload, authorization.signature, key, "manual-launch");
  requireThat(
    instant(profile.validFrom) <= issued &&
      issued <= epoch &&
      epoch < expires &&
      expires <= instant(profile.expiresAt) &&
      expires <= issued + 300000,
    "MANUAL_TIME_INVALID"
  );
  for (const field of [
    "profileDigest",
    "ownerId",
    "sessionId",
    "sessionNonce",
    "operationId",
    "idempotencyKey",
    "stage",
    "capability",
    "purpose",
    "phase",
    ...(creation
      ? ["chain", "targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest"]
      : ["scopeAuthorizationDigest"])
  ])
    requireThat(same(payload[field], request[field]));
  requireThat(payload.requestDigest === sha256Canonical(request));
  requireThat(
    payload.profileDigest === sha256Canonical(profile) && payload.ownerId === profile.ownerId
  );
  // Deliberately return undefined, without issuing a parent/child decision.
}

function bindingKeys(payload) {
  return allBindingKeys.filter((key) => Object.hasOwn(payload, key));
}

function verifyBase(authorization, profile, request, now) {
  validateContract(
    typeof profile?.schemaVersion === "string" &&
      Object.hasOwn(manualVersions, profile.schemaVersion)
      ? profile.schemaVersion
      : "manual-stage1-profile.v1",
    profile
  );
  validateContract("manual-launch-authorization.v1", authorization);
  const epoch = instant(now),
    key = profileKey(profile, epoch),
    payload = authorization.payload;
  verifySignature(payload, authorization.signature, key, "manual-launch");
  const issued = instant(payload.issuedAt),
    expires = instant(payload.expiresAt);
  requireThat(
    instant(profile.validFrom) <= issued &&
      issued <= epoch &&
      epoch < expires &&
      expires <= instant(profile.expiresAt) &&
      expires <= issued + 300000,
    "MANUAL_TIME_INVALID"
  );
  const keys = bindingKeys(payload);
  closed(request.binding, keys);
  for (const field of keys)
    requireThat(
      Object.hasOwn(request.full, field) &&
        same(request.full[field], payload[field]) &&
        same(request.binding[field], payload[field])
    );
  for (const field of allBindingKeys.filter((field) => !keys.includes(field)))
    requireThat(!Object.hasOwn(request.full, field));
  requireThat(
    !Object.hasOwn(request.full, "requestDigest") &&
      sha256Canonical(request.full) === payload.requestDigest
  );
  requireThat(
    payload.profileDigest === sha256Canonical(profile) && payload.ownerId === profile.ownerId
  );
  const target = profile.allowedTargets.find(
    (item) =>
      item.endpointPolicyId === payload.targetIntent.endpointPolicyId &&
      item.databaseName === payload.targetIntent.databaseName
  );
  requireThat(target && target.purposes.includes(payload.purpose));
  if (payload.stage === "runner-command") {
    requireThat(
      payload.physicalIdentity.endpointPolicyId === payload.targetIntent.endpointPolicyId &&
        payload.physicalIdentity.databaseName === payload.targetIntent.databaseName
    );
    requireThat(
      payload.roleObservation.role === target.roles[payload.capability] &&
        payload.roleObservation.tls === true &&
        target.tls === "required"
    );
    requireThat(
      profile.allowedCommands.some(
        (command) =>
          command.commandId === payload.commandId &&
          command.commandVersion === payload.commandVersion &&
          command.capability === payload.capability
      )
    );
    if (["replay", "reconcile"].includes(payload.phase))
      requireThat(payload.originalIdempotencyKey === payload.idempotencyKey);
  }
  return { payload, key, epoch, recordSchema: manualVersions[profile.schemaVersion] };
}

function verifyR3Base(authorization, profile, request, now) {
  const creation = authorization.payload.schemaVersion === "manual-launch-authorization.v4";
  verifyManualScopedAuthorizationBinding(
    {
      authorization,
      profile,
      requestBytes: encodeManualJson(request.full),
      now
    },
    creation
  );
  const payload = authorization.payload,
    excluded = new Set([
      "schemaVersion",
      "authorizationId",
      "issuedAt",
      "expiresAt",
      "requestDigest"
    ]),
    keys = Object.keys(payload).filter((field) => !excluded.has(field));
  closed(request.binding, keys);
  for (const field of keys) requireThat(same(request.binding[field], payload[field]));
  // Scoped signature checks bind the full request. The native session still
  // owns original-graph, target-fact and one-shot consumption admission.
  return { payload, epoch: instant(now), recordSchema: "manual-operation-record.v3" };
}

function r3SessionValid(session, payload, request, now) {
  const record = session.record,
    readAt = instant(session.readAt),
    scope = record.scope;
  requireThat(
    record.kind === "session" &&
      record.status === "OPEN" &&
      isDigest(session.recordDigest) &&
      sha256Canonical(record) === session.recordDigest,
    "MANUAL_SESSION_UNVERIFIED"
  );
  for (const field of ["profileDigest", "ownerId", "sessionId", "sessionNonce"])
    requireThat(same(record[field], payload[field]));
  requireThat(
    instant(record.openedAt) <= instant(payload.issuedAt) &&
      instant(payload.issuedAt) <= readAt &&
      instant(record.recordedAt) <= readAt &&
      readAt <= now,
    "MANUAL_SESSION_UNVERIFIED"
  );
  requireThat(
    request.sourceSha === scope.sourceSha &&
      request.candidate.buildProofDigest === scope.buildProofDigest &&
      request.phase === scope.phase
  );
  if (payload.stage === "target-create") {
    for (const field of ["chain", "targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest"])
      requireThat(request[field] === scope[field]);
    requireThat(session.predecessor === null);
  } else {
    const predecessor = session.predecessor;
    requireThat(scope.chain === "snapshot");
    requireThat(
      predecessor !== null &&
        predecessor.kind === "execution" &&
        predecessor.stage === "target-create" &&
        predecessor.status === "SUCCEEDED" &&
        predecessor.profileDigest === payload.profileDigest &&
        predecessor.sessionId === payload.sessionId &&
        predecessor.sessionNonce === payload.sessionNonce &&
        instant(predecessor.recordedAt) <= instant(payload.issuedAt) &&
        predecessor.resultDigest === request.destinationAdmissionDigest
    );
  }
}

function predecessorValid(predecessor, payload) {
  const expectedDigest =
    payload.phase === "apply"
      ? payload.dryRunRecordDigest
      : payload.predecessorExecutionRecordDigest;
  if (!expectedDigest) {
    requireThat(predecessor === null);
    return;
  }
  requireThat(predecessor !== null && predecessor.kind === "execution");
  requireThat(
    sha256Canonical(predecessor) === expectedDigest &&
      predecessor.profileDigest === payload.profileDigest
  );
  requireThat(instant(predecessor.recordedAt) <= instant(payload.issuedAt));
  if (payload.phase !== "verify") {
    requireThat(
      predecessor.operationId === payload.operationId &&
        predecessor.idempotencyKey === payload.idempotencyKey
    );
  }
  if (payload.phase === "apply")
    requireThat(
      predecessor.sessionId === payload.sessionId &&
        predecessor.sessionNonce === payload.sessionNonce
    );
  requireThat(
    predecessor.status === (payload.phase === "reconcile" ? "INTERRUPTED_UNKNOWN" : "SUCCEEDED")
  );
  // No phase/build/target/plan exists on this closed execution record. Their
  // request/result originals and state-machine checks belong to R1.2/R2.
}

function sessionValid(session, payload, now) {
  closed(session, ["record", "recordDigest", "readAt", "predecessor"], "MANUAL_SESSION_UNVERIFIED");
  const record = session.record,
    readAt = instant(session.readAt);
  requireThat(
    record.kind === "session" &&
      record.status === "OPEN" &&
      isDigest(session.recordDigest) &&
      sha256Canonical(record) === session.recordDigest,
    "MANUAL_SESSION_UNVERIFIED"
  );
  for (const field of ["profileDigest", "ownerId", "sessionId", "sessionNonce", "targetIntent"])
    requireThat(same(record[field], payload[field]));
  requireThat(
    instant(record.openedAt) <= instant(payload.issuedAt) &&
      instant(payload.issuedAt) <= readAt &&
      instant(record.recordedAt) <= readAt &&
      readAt <= now,
    "MANUAL_SESSION_UNVERIFIED"
  );
  predecessorValid(session.predecessor, payload);
}

function revocationValid(revocation, payload, now) {
  const code = "MANUAL_REVOCATION_UNVERIFIED";
  closed(revocation, ["records", "headDigest", "checkpoint", "readAt"], code);
  closed(revocation.checkpoint, ["sequence", "digest"], code);
  const readAt = instant(revocation.readAt);
  requireThat(
    Array.isArray(revocation.records) &&
      revocation.records.length > 0 &&
      readAt <= now &&
      readAt >= instant(payload.issuedAt),
    code
  );
  requireThat(
    Number.isSafeInteger(revocation.checkpoint.sequence) &&
      revocation.checkpoint.sequence >= 0 &&
      isDigest(revocation.checkpoint.digest),
    code
  );
  let previous = null,
    previousTime = -Infinity,
    revoked = false;
  const digests = [];
  for (const [sequence, record] of revocation.records.entries()) {
    requireThat(
      record.kind === "revocation" &&
        record.profileDigest === payload.profileDigest &&
        record.ownerId === payload.ownerId &&
        record.sequence === sequence &&
        record.previousRevocationDigest === previous &&
        (sequence === 0 ? record.action === "GENESIS" : record.action !== "GENESIS"),
      code
    );
    const time = instant(record.recordedAt);
    requireThat(previousTime <= time && time <= readAt, code);
    previousTime = time;
    previous = sha256Canonical(record);
    digests.push(previous);
    revoked ||=
      record.action === "REVOKE_PROFILE" ||
      (record.action === "REVOKE_AUTHORIZATION" &&
        record.authorizationId === payload.authorizationId);
  }
  requireThat(
    revocation.headDigest === previous &&
      digests[revocation.checkpoint.sequence] === revocation.checkpoint.digest,
    code
  );
  requireThat(!revoked, "MANUAL_AUTHORIZATION_REVOKED");
}

export function verifyManualAuthorization(input) {
  closed(input, ["authorization", "profile", "request", "session", "revocation", "now"]);
  const authorization = jsonInput(input.authorization),
    profile = jsonInput(input.profile),
    request = requestInput(input.request),
    session = jsonInput(input.session),
    revocation = jsonInput(input.revocation),
    now = input.now;
  closed(session, ["record", "recordDigest", "readAt", "predecessor"], "MANUAL_SESSION_UNVERIFIED");
  closed(
    revocation,
    ["records", "headDigest", "checkpoint", "readAt"],
    "MANUAL_REVOCATION_UNVERIFIED"
  );
  const r3 = ["manual-launch-authorization.v3", "manual-launch-authorization.v4"].includes(
    authorization.payload?.schemaVersion
  );
  const { payload, epoch, recordSchema } = r3
    ? verifyR3Base(authorization, profile, request, now)
    : verifyBase(authorization, profile, request, now);
  validateContract(recordSchema, session.record);
  if (session.predecessor !== null) validateContract(recordSchema, session.predecessor);
  requireThat(Array.isArray(revocation.records), "MANUAL_REVOCATION_UNVERIFIED");
  for (const record of revocation.records)
    validateContract(r3 ? "manual-operation-record.v2" : recordSchema, record);
  recordTimes(session.record);
  if (session.predecessor !== null) recordTimes(session.predecessor);
  if (r3) r3SessionValid(session, payload, request.full, epoch);
  else sessionValid(session, payload, epoch);
  revocationValid(revocation, payload, epoch);
  const decision = Object.freeze({
    kind: "manual-parent-decision",
    authorizationDigest: sha256Canonical(authorization),
    requestDigest: payload.requestDigest,
    profileDigest: payload.profileDigest,
    stage: payload.stage,
    sessionId: payload.sessionId,
    sessionNonce: payload.sessionNonce,
    operationId: payload.operationId,
    idempotencyKey: payload.idempotencyKey,
    promotionEligible: false
  });
  parentDecisions.add(decision);
  return decision;
}

export function assertManualDecision(decision) {
  requireThat(parentDecisions.has(decision), "MANUAL_DECISION_UNTRUSTED");
}

export function verifyManualHandoff(input) {
  closed(input, ["authorization", "receipt", "profile", "request", "childObservation", "now"]);
  const authorization = jsonInput(input.authorization),
    receipt = jsonInput(input.receipt),
    profile = jsonInput(input.profile),
    request = requestInput(input.request),
    observation = jsonInput(input.childObservation),
    now = input.now;
  closed(observation, childKeys);
  const { payload, key, epoch, recordSchema } = verifyBase(authorization, profile, request, now);
  validateContract(recordSchema, receipt);
  requireThat(payload.stage === "runner-command" && receipt.kind === "consumption-handoff");
  const { signature, ...body } = receipt;
  verifySignature(body, signature, key, "manual-consumption");
  for (const field of [
    "profileDigest",
    "requestDigest",
    "sessionId",
    "sessionNonce",
    "operationId",
    "idempotencyKey",
    ...childKeys
  ])
    requireThat(same(receipt[field], payload[field]));
  requireThat(receipt.authorizationDigest === sha256Canonical(authorization));
  for (const field of childKeys) requireThat(same(observation[field], payload[field]));
  recordTimes(receipt);
  const issued = instant(receipt.issuedAt),
    expires = instant(receipt.expiresAt);
  requireThat(
    receipt.recordedAt === receipt.issuedAt &&
      issued >= instant(payload.issuedAt) &&
      issued <= epoch &&
      epoch < expires &&
      expires === Math.min(instant(payload.expiresAt), issued + 30000),
    "MANUAL_TIME_INVALID"
  );
  // Receipt signature is a parent commitment, not independent journal/custody IO.
  const decision = Object.freeze({
    kind: "manual-child-decision",
    authorizationDigest: sha256Canonical(authorization),
    requestDigest: payload.requestDigest,
    profileDigest: payload.profileDigest,
    receiptDigest: sha256Canonical(receipt),
    containerId: receipt.containerId,
    runnerImageDigest: receipt.runnerImageDigest,
    childChallenge: receipt.childChallenge,
    promotionEligible: false
  });
  childDecisions.add(decision);
  return decision;
}

export function assertManualHandoffDecision(decision) {
  requireThat(childDecisions.has(decision), "MANUAL_HANDOFF_UNTRUSTED");
}
