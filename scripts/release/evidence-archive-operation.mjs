// Finite archive proof verification. Live host/cloud observations come only from
// the fixed H1 operation; these pure functions never confer signing authority.
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import {
  validateEvidenceArchiveAuthorization,
  validateEvidenceArchiveAccessReceipt
} from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";
import { verifyEvidenceArchiveReaderObservation } from "./evidence-archive-storage.mjs";

const CODE = "H1_EVIDENCE_ARCHIVE_REJECTED";
const ACCOUNT = "1457643390906675";
export const ARCHIVE_BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
export const ARCHIVE_ROLES = Object.freeze({
  writer: `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-writer`,
  reader: `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-reader`
});
export const ARCHIVE_PROFILES = Object.freeze({
  writer: "archive-create-only-writer",
  reader: "archive-readback-reader"
});
const check = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const frame = (value, names) => assertKernelFrame(value, names, CODE);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const digest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const time = (value) => {
  check(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  );
  const at = Date.parse(value);
  check(Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19));
  return at;
};
const normalized = (arn) =>
  typeof arn === "string" ? arn.replace(":role/", ":assumed-role/") : "";

function signed(domain, name, body, signature, signer) {
  frame(signer, ["issuer", "keyId", "publicKey"]);
  frame(signature, ["algorithm", "issuer", "keyId", "subjectDigest", "signature"]);
  const key = createPublicKey(signer.publicKey);
  check(
    key.asymmetricKeyType === "ed25519" &&
      signature.algorithm === "Ed25519" &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === signer.keyId &&
      signature.issuer === signer.issuer &&
      signature.keyId === signer.keyId &&
      signature.subjectDigest === sha256Canonical(body) &&
      typeof signature.signature === "string" &&
      /^[A-Za-z0-9+/]{86}==$/u.test(signature.signature) &&
      Buffer.from(signature.signature, "base64").toString("base64") === signature.signature &&
      verify(
        null,
        Buffer.from(canonicalJson({ domain, [name]: body })),
        key,
        Buffer.from(signature.signature, "base64")
      )
  );
}

export function verifyArchiveOperationAuthorization(input) {
  frame(input, [
    "packet",
    "policy",
    "revocation",
    "chainOriginals",
    "expected",
    "signer",
    "now",
    "active"
  ]);
  const { packet, policy, revocation, chainOriginals, expected, signer, now, active } =
    snapshotKernelData(input, CODE);
  frame(packet, ["authorization", "signature"]);
  frame(expected, ["authorizationDigest", "kind", "sourceDigest", "runtimeDigest"]);
  frame(policy, [
    "managementIdentity",
    "revocationPolicyDigest",
    "owner",
    "readers",
    "downstreamRetainUntil",
    "snapshotExpiresAt",
    "legalHoldUntil"
  ]);
  const authorization = packet.authorization;
  validateEvidenceArchiveAuthorization(authorization);
  const kind = expected.kind;
  check(Object.hasOwn(ARCHIVE_PROFILES, kind) && typeof active === "boolean");
  check(
    sha256Canonical(authorization) === expected.authorizationDigest &&
      authorization.profile === ARCHIVE_PROFILES[kind] &&
      authorization.executor.principal === ARCHIVE_ROLES[kind] &&
      authorization.executor.sourceDigest === expected.sourceDigest &&
      authorization.executor.runtimeDigest === expected.runtimeDigest &&
      authorization.executor.publicKeyDigest === signer.keyId &&
      authorization.issuer.id === signer.issuer &&
      authorization.issuer.keyId === signer.keyId &&
      authorization.identities.writer === ARCHIVE_ROLES.writer &&
      authorization.identities.reader === ARCHIVE_ROLES.reader &&
      policy.managementIdentity === `acs:ram::${ACCOUNT}:root` &&
      authorization.identities.management === policy.managementIdentity &&
      policy.owner === signer.issuer &&
      same(policy.readers, [ARCHIVE_ROLES.reader]) &&
      authorization.resource.region === "oss-cn-shanghai" &&
      authorization.resource.bucket === ARCHIVE_BUCKET &&
      authorization.custodyPolicyDigest === sha256Canonical(policy) &&
      authorization.revocationPolicyDigest === policy.revocationPolicyDigest &&
      time(authorization.issuedAt) <= time(now) &&
      (!active || time(now) < time(authorization.notAfter))
  );
  for (const value of [
    policy.downstreamRetainUntil,
    policy.snapshotExpiresAt,
    policy.legalHoldUntil
  ])
    if (value !== null) time(value);
  check(policy.downstreamRetainUntil !== null);
  signed(
    "evidence-archive-authorization.v1",
    "authorization",
    authorization,
    packet.signature,
    signer
  );
  frame(revocation, ["state", "signature"]);
  validateContract("i0-revocation-state.v1", revocation.state);
  signed("i0-revocation-state.v1", "state", revocation.state, revocation.signature, signer);
  check(
    revocation.state.policyDigest === authorization.revocationPolicyDigest &&
      !revocation.state.revokedAuthorizationIds.includes(authorization.authorizationId) &&
      !revocation.state.revokedAuthorizationDigests.includes(expected.authorizationDigest)
  );
  const chainFields = [
    "changePlanDigest",
    "externalChangeApprovalDigest",
    "applyProofDigest",
    "resourceReadbackDigest"
  ];
  frame(chainOriginals, chainFields);
  for (const name of chainFields)
    check(
      chainOriginals[name] &&
        typeof chainOriginals[name] === "object" &&
        !Array.isArray(chainOriginals[name]) &&
        sha256Canonical(chainOriginals[name]) === authorization.chain[name]
    );
  return authorization;
}

export function archiveSessionFingerprint(session, identity) {
  frame(identity, ["AccountId", "Arn", "IdentityType", "RequestId"]);
  check(
    identity.AccountId === ACCOUNT &&
      identity.IdentityType === "AssumedRoleUser" &&
      identity.Arn === normalized(session.arn) &&
      typeof identity.RequestId === "string" &&
      /^[A-Za-z0-9-]{1,256}$/u.test(identity.RequestId)
  );
  return sha256Canonical({
    arn: identity.Arn,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    identityRequestId: identity.RequestId
  });
}

export async function buildArchiveAccessSubject(input) {
  frame(input, ["authorization", "io", "terminal", "signer", "issuedAt"]);
  const { authorization, io, terminal, signer, issuedAt } = snapshotKernelData(input, CODE);
  validateEvidenceArchiveAuthorization(authorization);
  const kind = authorization.profile === ARCHIVE_PROFILES.writer ? "writer" : "reader";
  const authDigest = sha256Canonical(authorization);
  frame(io, [
    "status",
    "authorizationDigest",
    "profile",
    "operationId",
    "session",
    "identityOriginal",
    "startedAt",
    "observedAt",
    "objects"
  ]);
  frame(terminal, [
    "status",
    "authorizationDigest",
    "profile",
    "operationId",
    "ioDigest",
    "session",
    "ioObservedAt",
    "authority",
    "sessionDisposal"
  ]);
  frame(io.session, ["arn", "issuedAt", "expiresAt", "fingerprint"]);
  frame(terminal.authority, ["startedAt", "finishedAt", "exited", "exitCode"]);
  frame(terminal.sessionDisposal, [
    "path",
    "removed",
    "removedAt",
    "absent",
    "expiresAt",
    "observedAt"
  ]);
  const session = io.session,
    process = terminal.authority,
    disposed = terminal.sessionDisposal;
  const prefix = ARCHIVE_ROLES[kind].replace(":role/", ":assumed-role/") + "/";
  check(
    io.status === "ARCHIVE_IO_OBSERVED" &&
      terminal.status === "ARCHIVE_TERMINAL_OBSERVED" &&
      [io, terminal].every(
        (v) =>
          v.authorizationDigest === authDigest &&
          v.profile === authorization.profile &&
          v.operationId === authorization.operationId
      ) &&
      terminal.ioDigest === sha256Canonical(io) &&
      terminal.ioObservedAt === io.observedAt &&
      same(terminal.session, session) &&
      normalized(session.arn).startsWith(prefix) &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(normalized(session.arn).slice(prefix.length)) &&
      session.fingerprint === archiveSessionFingerprint(session, io.identityOriginal) &&
      process.exited === true &&
      process.exitCode === 0 &&
      disposed.removed === true &&
      disposed.absent === true &&
      disposed.path ===
        `/var/lib/stage1-volumes/main/snapshot-authority/archive-${kind}-session.json` &&
      disposed.expiresAt === session.expiresAt
  );
  check(
    time(authorization.issuedAt) <= time(session.issuedAt) &&
      time(session.issuedAt) <= time(process.startedAt) &&
      time(process.startedAt) <= time(io.startedAt) &&
      time(io.startedAt) <= time(io.observedAt) &&
      time(io.observedAt) <= time(process.finishedAt) &&
      time(io.observedAt) < time(session.expiresAt) &&
      time(io.observedAt) < time(authorization.notAfter) &&
      time(process.finishedAt) <= time(disposed.removedAt) &&
      time(disposed.removedAt) <= time(disposed.observedAt) &&
      time(session.expiresAt) <= time(disposed.observedAt) &&
      time(disposed.observedAt) <= time(issuedAt)
  );
  check(Array.isArray(io.objects) && io.objects.length === authorization.objects.length);
  const actions = [],
    objectResults = [];
  for (let index = 0; index < authorization.objects.length; index++) {
    const object = authorization.objects[index],
      entry = io.objects[index];
    frame(entry, ["exactKey", "result"]);
    check(entry.exactKey === object.exactKey);
    const result = entry.result;
    let etag;
    if (kind === "writer") {
      const record = result?.putObservation?.record;
      check(
        result.exactKey === object.exactKey &&
          result.contentDigest === object.contentDigest &&
          result.contentSizeBytes === object.contentSizeBytes &&
          record?.operation === "PutObject" &&
          record.objectKey === object.exactKey &&
          record.bucket === ARCHIVE_BUCKET &&
          record.principal === normalized(session.arn) &&
          record.response?.status === 200 &&
          record.requestHeaders?.["x-oss-forbid-overwrite"] === "true" &&
          record.requestHeaders["x-oss-object-acl"] === "private" &&
          record.requestHeaders["x-oss-server-side-encryption"] === "AES256" &&
          result.putObservation.bodyBase64 === "" &&
          record.response.headers["x-oss-request-id"] === result.requestId &&
          record.response.body?.bytes === 0 &&
          record.response.body.digest === sha256Bytes(Buffer.alloc(0)) &&
          time(io.startedAt) <= time(record.observedAt) &&
          time(record.observedAt) <= time(io.observedAt)
      );
      etag = record.response.headers.etag;
      actions.push({
        objectKey: object.exactKey,
        action: "oss:PutObject",
        result: "SUCCESS",
        conditionalCreate: true,
        requestId: result.requestId
      });
    } else {
      await verifyEvidenceArchiveReaderObservation({
        result,
        object,
        identityOriginal: io.identityOriginal,
        startedAt: io.startedAt,
        observedAt: io.observedAt
      });
      check(
        same(result.identityOriginal, io.identityOriginal) &&
          result.bucket?.acl === "private" &&
          result.bucket.ownerId === ACCOUNT &&
          result.bucket.versioning === "Disabled" &&
          result.bucket.worm?.state === "Locked" &&
          result.bucket.worm.retentionDays === 210 &&
          time(io.startedAt) <= time(result.observedAt) &&
          time(result.observedAt) <= time(io.observedAt)
      );
      for (const [field, action] of [
        ["head", "oss:HeadObject"],
        ["get", "oss:GetObject"]
      ]) {
        const fact = result[field];
        check(
          fact?.key === object.exactKey &&
            fact.digest === object.contentDigest &&
            fact.sizeBytes === object.contentSizeBytes &&
            fact.version === "null-version-disabled"
        );
        actions.push({
          objectKey: object.exactKey,
          action,
          result: "SUCCESS",
          conditionalCreate: false,
          requestId: fact.requestId
        });
      }
      check(
        result.head.etag === result.get.etag && result.head.lastModified === result.get.lastModified
      );
      etag = result.get.etag;
    }
    check(typeof etag === "string" && etag.length > 0 && etag.length <= 2048);
    objectResults.push({
      objectKey: object.exactKey,
      objectVersion: "null-version-disabled",
      etag,
      contentDigest: object.contentDigest,
      contentSizeBytes: object.contentSizeBytes
    });
  }
  const receipt = {
    schemaVersion: "evidence-archive-access-receipt.v1",
    receiptId: `h1-archive-${authDigest.slice(7)}`,
    authorizationDigest: authDigest,
    operationId: authorization.operationId,
    profile: authorization.profile,
    session: {
      fingerprint: session.fingerprint,
      principal: ARCHIVE_ROLES[kind],
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      terminalState: "EXPIRED",
      terminalAt: disposed.observedAt,
      terminalReceiptDigest: sha256Canonical(terminal)
    },
    actions,
    objectResults,
    observationDigest: kind === "reader" ? sha256Canonical(io) : null,
    issuer: signer.issuer,
    issuedAt
  };
  validateEvidenceArchiveAccessReceipt(receipt, { authorization });
  return {
    receipt,
    ioDigest: sha256Canonical(io),
    terminalDigest: sha256Canonical(terminal),
    identityDigest: sha256Canonical(io.identityOriginal)
  };
}

export async function verifyArchiveAccessProof({ proof, ...input }) {
  frame(proof, ["receipt", "ioDigest", "terminalDigest", "identityDigest", "signature"]);
  const { signature, ...subject } = proof;
  check([subject.ioDigest, subject.terminalDigest, subject.identityDigest].every(digest));
  signed("h1-evidence-archive-access.v1", "subject", subject, signature, input.signer);
  const rebuilt = await buildArchiveAccessSubject({ ...input, issuedAt: proof.receipt.issuedAt });
  check(same(subject, rebuilt));
  return subject;
}

// The caller verifies the predecessor signature and its original IO/terminal
// before passing its receipt. A read session must begin after writer disposal.
export function verifyArchiveReadPredecessor(input) {
  frame(input, ["authorization", "predecessor", "predecessorAuthorization", "sessionIssuedAt"]);
  const { authorization, predecessor, predecessorAuthorization, sessionIssuedAt } =
    snapshotKernelData(input, CODE);
  validateEvidenceArchiveAuthorization(authorization);
  validateEvidenceArchiveAccessReceipt(predecessor, { authorization: predecessorAuthorization });
  check(
    authorization.profile === ARCHIVE_PROFILES.reader &&
      predecessor.profile === ARCHIVE_PROFILES.writer &&
      authorization.chain.predecessorTerminalReceiptDigest === sha256Canonical(predecessor) &&
      same(authorization.objects, predecessorAuthorization.objects) &&
      same(authorization.identities, predecessorAuthorization.identities) &&
      authorization.resource.bucket === predecessorAuthorization.resource.bucket &&
      authorization.custodyPolicyDigest === predecessorAuthorization.custodyPolicyDigest &&
      time(predecessor.session.terminalAt) <= time(predecessor.issuedAt) &&
      time(predecessor.issuedAt) <= time(sessionIssuedAt)
  );
  return predecessor;
}
