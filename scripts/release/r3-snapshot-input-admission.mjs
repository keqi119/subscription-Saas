// Read owner-imported historical declarations. This is not a consume decision,
// a live storage observation, or verification of ciphertext/plaintext bytes.
import path from "node:path";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";
import { validateManualSnapshotConsumerRequest } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { verifySnapshotMetadataDeclarations } from "../../packages/release-foundation/src/snapshot/export-sanitized.mjs";
import { validateSnapshotEncryptionEnvelope } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import { validateSnapshotCustody } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";
import { loadFixedManualProfile } from "./manual-stage1-trust.mjs";
import { pinPrivateInput, readCapturedOssXml } from "./manual-runner-source-inputs.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LIMIT = 1048576;
const subjects = [
  "permission",
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
function fail(code = "R3_SNAPSHOT_INPUT_INVALID") {
  throw Object.assign(new Error(code), { code });
}
function requireThat(value) {
  if (!value) fail("R3_SNAPSHOT_INPUT_BINDING_INVALID");
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return d?.enumerable && "value" in d;
    })
  );
}
function text(value, max = 2048) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function instant(value) {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  requireThat(Number.isFinite(n) && new Date(n).toISOString() === value);
  return n;
}
function rawRef(value, limit = LIMIT) {
  requireThat(
    exact(value, ["digest", "bytes"]) &&
      DIGEST.test(value.digest) &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      value.bytes <= limit
  );
  return value;
}
function json(bytes) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  requireThat(encodeManualJson(value).equals(bytes));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function checkSources(s, now) {
  const {
    metadata: m,
    sanitizationContract: contract,
    ownershipMap,
    scan,
    sourcePrivilege: privilege
  } = s;
  validateContract("ownership-map.v1", ownershipMap);
  verifySnapshotMetadataDeclarations({
    metadata: m,
    contract,
    ownershipMap,
    scan,
    now: new Date(now)
  });
  requireThat(
    instant(m.reviewAt) === instant(m.createdAt) + contract.lifecycle.reviewAfterDays * 86400000 &&
      instant(m.expiresAt) === instant(m.createdAt) + contract.lifecycle.expiresAfterDays * 86400000
  );
  requireThat(
    exact(scan, [
      "schemaVersion",
      "subjectDigest",
      "contractDigest",
      "scannerVersion",
      "status",
      "findingsCount",
      "scannedAt"
    ]) &&
      scan.schemaVersion === "sanitization-scan.v1" &&
      scan.scannerVersion === m.scanToolVersion &&
      scan.scannerVersion === contract.tools.scannerVersion &&
      m.exportToolVersion === contract.tools.exporterVersion &&
      instant(scan.scannedAt) <= now
  );
  for (const [name, digest] of [
    ["beforeFingerprint", m.sourceFingerprintBeforeDigest],
    ["afterFingerprint", m.sourceFingerprintAfterDigest]
  ]) {
    const f = s[name],
      i = f?.identity;
    requireThat(
      exact(f, ["schemaVersion", "identity", "provenance"]) &&
        f.schemaVersion === "source-fingerprint.v1" &&
        exact(f.provenance, ["observedAt"]) &&
        instant(f.provenance.observedAt) <= now &&
        exact(i, [
          "snapshotIdFingerprint",
          "migrationHead",
          "databaseIdentityFingerprint",
          "roleIdentityFingerprint",
          "tables"
        ]) &&
        [i.snapshotIdFingerprint, i.databaseIdentityFingerprint, i.roleIdentityFingerprint].every(
          (x) => DIGEST.test(x)
        ) &&
        i.migrationHead === m.sourceMigrationHead &&
        sha256Canonical(i) === digest &&
        Array.isArray(i.tables) &&
        i.tables.length === contract.source.keyTables.length
    );
    requireThat(
      i.tables.every(
        (row, n) =>
          exact(row, ["table", "rowCount", "checksum"]) &&
          row.table === contract.source.keyTables[n] &&
          Number.isSafeInteger(row.rowCount) &&
          row.rowCount >= 0 &&
          DIGEST.test(row.checksum)
      )
    );
  }
  const caps = privilege?.capabilities;
  const flags = [
    "superuser",
    "createDatabase",
    "createRole",
    "bypassRls",
    "schemaOwner",
    "canCreateSchema"
  ];
  const counts = [
    "tableWritePrivilegeCount",
    "tableTruncatePrivilegeCount",
    "writableFunctionExecutePrivilegeCount"
  ];
  requireThat(
    exact(privilege, [
      "schemaVersion",
      "secretReferenceFingerprint",
      "roleIdentityFingerprint",
      "databaseIdentityFingerprint",
      "capabilities",
      "observedAt"
    ]) &&
      privilege.schemaVersion === "source-privilege-observation.v1" &&
      DIGEST.test(privilege.secretReferenceFingerprint) &&
      sha256Canonical(privilege) === m.sourcePrivilegeObservationDigest &&
      instant(privilege.observedAt) <= now &&
      exact(caps, [...flags, ...counts, "objectOwnerCount", "objectOwnerSetDigest"]) &&
      flags.every((k) => caps[k] === false) &&
      counts.every((k) => caps[k] === 0) &&
      Number.isSafeInteger(caps.objectOwnerCount) &&
      caps.objectOwnerCount > 0 &&
      caps.objectOwnerCount <= ownershipMap.sourceOwners.length &&
      DIGEST.test(caps.objectOwnerSetDigest)
  );
  for (const key of ["databaseIdentityFingerprint", "roleIdentityFingerprint"])
    requireThat(privilege[key] === s.beforeFingerprint.identity[key]);
}

async function checkPermission(s, index, profile, raw, now) {
  const p = s.permission;
  requireThat(
    exact(p, [
      "recordVersion",
      "inputReference",
      "ownerId",
      "profileDigest",
      "sourceAuthority",
      "sourceIdentity",
      "allowedPurpose",
      "allowedUses",
      "validUntil",
      "restrictionOriginals"
    ]) &&
      p.recordVersion === "r3-snapshot-input-permission.v1" &&
      p.inputReference === index.inputReference &&
      p.ownerId === profile.ownerId &&
      p.profileDigest === index.profileDigest &&
      p.allowedPurpose === "sanitized-snapshot-test-input" &&
      instant(p.validUntil) > now
  );
  const authority = json(await raw(p.sourceAuthority));
  requireThat(
    exact(authority, [
      "recordVersion",
      "ownerId",
      "profileDigest",
      "capacity",
      "controllerId",
      "statement",
      "originals"
    ]) &&
      authority.recordVersion === "r3-snapshot-source-authority.v1" &&
      authority.ownerId === p.ownerId &&
      authority.profileDigest === p.profileDigest &&
      ["controller", "representative"].includes(authority.capacity) &&
      text(authority.controllerId) &&
      text(authority.statement, 16384) &&
      Array.isArray(authority.originals) &&
      authority.originals.length <= 16 &&
      (authority.capacity !== "representative" || authority.originals.length > 0)
  );
  const identity = json(await raw(p.sourceIdentity)),
    fingerprint = s.beforeFingerprint.identity;
  requireThat(
    exact(identity, [
      "databaseIdentityFingerprint",
      "roleIdentityFingerprint",
      "migrationHead",
      "sourceEnvironment",
      "objectOwners"
    ]) &&
      identity.sourceEnvironment === s.sanitizationContract.source.allowedEnvironment &&
      ["databaseIdentityFingerprint", "roleIdentityFingerprint", "migrationHead"].every(
        (k) => identity[k] === fingerprint[k]
      )
  );
  requireThat(
    Array.isArray(identity.objectOwners) &&
      identity.objectOwners.length === s.sourcePrivilege.capabilities.objectOwnerCount &&
      identity.objectOwners.every(
        (owner, n) =>
          s.ownershipMap.sourceOwners.includes(owner) &&
          (n === 0 || identity.objectOwners[n - 1] < owner)
      ) &&
      sha256Canonical(identity.objectOwners) === s.sourcePrivilege.capabilities.objectOwnerSetDigest
  );
  requireThat(
    Array.isArray(p.allowedUses) &&
      p.allowedUses.length > 0 &&
      p.allowedUses.length <= 2 &&
      new Set(p.allowedUses.map((u) => u.phase)).size === p.allowedUses.length
  );
  for (const use of p.allowedUses)
    requireThat(
      exact(use, [
        "phase",
        "destinationAdmissionDigest",
        "readerPrincipal",
        "decryptorPrincipal",
        "userPrincipal"
      ]) &&
        ["source", "final"].includes(use.phase) &&
        DIGEST.test(use.destinationAdmissionDigest) &&
        [use.readerPrincipal, use.decryptorPrincipal, use.userPrincipal].every((v) => text(v))
    );
  requireThat(Array.isArray(p.restrictionOriginals) && p.restrictionOriginals.length <= 16);
  // Preserve underlying statements/restrictions without claiming automated legal
  // interpretation. The later manual scope must match these exact originals.
  for (const ref of [...authority.originals, ...p.restrictionOriginals]) await raw(ref);
}

async function checkStorage(s, raw, now) {
  const c = s.custody,
    storage = s.storageReadback,
    object = c.object;
  const calls = {
    conditionalCreate: "PutObject",
    head: "HeadObject",
    get: "GetObject",
    bucketAcl: "GetBucketAcl",
    objectAcl: "GetObjectAcl",
    versioning: "GetBucketVersioning",
    worm: "GetBucketWorm"
  };
  requireThat(
    exact(storage, [
      "recordVersion",
      "bucket",
      "objectKey",
      "writerIdentity",
      "readerIdentity",
      "writerIdentityOriginal",
      "readerIdentityOriginal",
      ...Object.keys(calls)
    ]) &&
      storage.recordVersion === "r3-snapshot-storage-readback.v1" &&
      storage.bucket === c.bucket.name &&
      storage.objectKey === object.key &&
      storage.writerIdentity === c.identities.writer &&
      storage.readerIdentity === c.identities.reader &&
      sha256Canonical(storage) === c.authoritativeObservationDigest
  );
  let account;
  for (const kind of ["writer", "reader"]) {
    const identity = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await raw(storage[`${kind}IdentityOriginal`])
      )
    );
    requireThat(
      identity &&
        text(identity.Arn) &&
        /^\d+$/u.test(identity.AccountId) &&
        identity.Arn === storage[`${kind}Identity`] &&
        identity.Arn.startsWith(`acs:ram::${identity.AccountId}:`)
    );
    account ??= identity.AccountId;
    requireThat(identity.AccountId === account);
  }
  const responses = {};
  for (const [name, operation] of Object.entries(calls)) {
    const v = json(await raw(storage[name])),
      isObject = ["PutObject", "HeadObject", "GetObject", "GetObjectAcl"].includes(operation);
    requireThat(
      exact(v, [
        "recordVersion",
        "operation",
        "bucket",
        "objectKey",
        "principal",
        "observedAt",
        "requestHeaders",
        "response"
      ]) &&
        v.recordVersion === "r3-snapshot-oss-response.v1" &&
        v.operation === operation &&
        v.bucket === c.bucket.name &&
        v.objectKey === (isObject ? object.key : null) &&
        v.principal === c.identities[operation === "PutObject" ? "writer" : "reader"] &&
        instant(v.observedAt) <= now &&
        instant(v.observedAt) <= instant(c.worm.readbackAt) &&
        exact(v.response, ["status", "headers", "body"]) &&
        v.response.status === 200
    );
    requireThat(
      exact(v.requestHeaders, operation === "PutObject" ? ["x-oss-forbid-overwrite"] : []) &&
        (operation !== "PutObject" || v.requestHeaders["x-oss-forbid-overwrite"] === "true")
    );
    const h = v.response.headers;
    requireThat(
      h &&
        typeof h === "object" &&
        !Array.isArray(h) &&
        Object.entries(h).every(
          ([k, value]) =>
            /^[a-z0-9-]+$/u.test(k) &&
            typeof value === "string" &&
            value.length <= 2048 &&
            !/[\r\n\0]/u.test(value)
        ) &&
        text(h["x-oss-request-id"]) &&
        text(h.date) &&
        Number.isFinite(Date.parse(h.date)) &&
        Date.parse(h.date) <= instant(v.observedAt)
    );
    rawRef(v.response.body, operation === "GetObject" ? 1073741824 : LIMIT);
    if (operation === "GetObject") {
      // Deliberately do not open this reference: it names the ciphertext payload,
      // not one of the pinned <=1 MiB declaration originals.
      requireThat(
        v.response.body.digest === object.ciphertextDigest &&
          v.response.body.bytes === object.ciphertextSizeBytes
      );
    } else responses[name] = { value: v, body: await raw(v.response.body) };
    responses[name] ??= { value: v };
    if (["HeadObject", "GetObject"].includes(operation))
      requireThat(
        h["content-length"] === String(object.ciphertextSizeBytes) &&
          h.etag?.replace(/^"|"$/gu, "") === object.etag &&
          Date.parse(h["last-modified"]) === instant(c.worm.lastModified) &&
          h["x-oss-server-side-encryption"] === "AES256" &&
          h["content-range"] === undefined &&
          h["content-encoding"] === undefined &&
          instant(v.observedAt) >= instant(c.worm.lastModified)
      );
    if (operation === "HeadObject") requireThat(v.response.body.bytes === 0);
    if (operation === "PutObject")
      requireThat(
        h["x-oss-request-id"] === c.conditionalCreate.requestId &&
          h.etag?.replace(/^"|"$/gu, "") === object.etag
      );
  }
  const putAt = instant(responses.conditionalCreate.value.observedAt);
  requireThat(instant(c.worm.lastModified) <= putAt && putAt <= instant(c.terminalAt));
  for (const key of Object.keys(calls).filter((key) => key !== "conditionalCreate"))
    requireThat(instant(responses[key].value.observedAt) >= instant(c.terminalAt));
  for (const key of ["bucketAcl", "objectAcl"]) {
    const acl = await readCapturedOssXml(responses[key].body, "AccessControlPolicy");
    requireThat(
      exact(acl, ["Owner", "AccessControlList"]) &&
        exact(acl.Owner, ["ID", "DisplayName"]) &&
        acl.Owner.ID === account &&
        typeof acl.Owner.DisplayName === "string" &&
        exact(acl.AccessControlList, ["Grant"]) &&
        acl.AccessControlList.Grant === "private"
    );
  }
  const worm = await readCapturedOssXml(responses.worm.body, "WormConfiguration");
  requireThat(
    exact(worm, ["WormId", "State", "RetentionPeriodInDays", "CreationDate"]) &&
      worm.WormId === c.worm.id &&
      worm.State === "Locked" &&
      worm.RetentionPeriodInDays === String(c.worm.retentionDays) &&
      Number.isFinite(Date.parse(worm.CreationDate)) &&
      Date.parse(worm.CreationDate) <= instant(c.worm.lastModified)
  );
  const versioning = await readCapturedOssXml(responses.versioning.body, "VersioningConfiguration");
  const disabled =
    (typeof versioning === "string" && versioning.trim() === "") ||
    ((exact(versioning, []) || exact(versioning, ["Status"])) &&
      (versioning.Status === undefined || versioning.Status === ""));
  requireThat(
    disabled ||
      (exact(versioning, ["Status"]) && ["Enabled", "Suspended"].includes(versioning.Status))
  );
  for (const key of ["conditionalCreate", "head", "get"]) {
    const version = responses[key].value.response.headers["x-oss-version-id"];
    requireThat(
      disabled
        ? object.version === "null-version-disabled" && version === undefined
        : text(version) && version === object.version
    );
  }
}

export async function readR3SnapshotInput(input) {
  if (
    !exact(input, ["repoRoot", "inputReference", "now"]) ||
    typeof input.repoRoot !== "string" ||
    !path.isAbsolute(input.repoRoot) ||
    path.resolve(input.repoRoot) !== input.repoRoot ||
    typeof input.inputReference !== "string" ||
    !UUID.test(input.inputReference) ||
    !(input.now instanceof Date) ||
    Object.getPrototypeOf(input.now) !== Date.prototype ||
    Reflect.ownKeys(input.now).length !== 0
  )
    fail();
  const { repoRoot, inputReference } = input;
  let now;
  try {
    now = Date.prototype.getTime.call(input.now);
  } catch {
    fail();
  }
  if (!Number.isFinite(now)) fail();
  // H1 for this implementation is the approved Linux signing host. Never accept
  // a caller-provided uid, root, filesystem adapter or authority callback.
  if (process.platform !== "linux") fail("R3_SNAPSHOT_INPUT_UNAVAILABLE");
  const opened = [],
    refs = new Map();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled(opened.map((x) => x.close()));
    if (outcomes.some((x) => x.status === "rejected")) fail("R3_SNAPSHOT_INPUT_UNAVAILABLE");
  };
  try {
    const profile = await loadFixedManualProfile({ repoRoot }),
      profileDigest = sha256Canonical(profile);
    requireThat(instant(profile.validFrom) <= now && now < instant(profile.expiresAt));
    const options = {
      principal: { platform: "posix", uid: process.getuid() },
      privateRoot: profile.storage.archiveRoot
    };
    const pin = async (file) => {
      const item = await pinPrivateInput(file, options);
      opened.push(item);
      return item.bytes;
    };
    const indexBytes = await pin(
        path.join(profile.storage.archiveRoot, "inputs", "snapshots", inputReference, "index.json")
      ),
      index = json(indexBytes);
    requireThat(
      exact(index, ["recordVersion", "inputReference", "profileDigest", "ownerId", ...subjects]) &&
        index.recordVersion === "r3-snapshot-input-index.v1" &&
        index.inputReference === inputReference &&
        index.profileDigest === profileDigest &&
        index.ownerId === profile.ownerId
    );
    const raw = async (ref) => {
      rawRef(ref);
      if (refs.has(ref.digest)) {
        const bytes = refs.get(ref.digest);
        requireThat(bytes.length === ref.bytes);
        return bytes;
      }
      requireThat(refs.size < 128);
      const bytes = await pin(
        path.join(profile.storage.archiveRoot, "raw", `${ref.digest.slice(7)}.bin`)
      );
      requireThat(bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest);
      refs.set(ref.digest, bytes);
      return bytes;
    };
    const s = {};
    for (const name of subjects) s[name] = json(await raw(index[name]));
    checkSources(s, now);
    validateSnapshotEncryptionEnvelope(s.envelope);
    validateSnapshotCustody(s.custody);
    const e = s.envelope,
      c = s.custody,
      m = s.metadata;
    requireThat(
      e.snapshotDigest === m.dumpDigest &&
        e.sanitizationContractDigest === m.sanitizationContractDigest &&
        e.expiresAt === m.expiresAt &&
        c.expiresAt === m.expiresAt &&
        c.object.envelopeDigest === sha256Canonical(e) &&
        c.object.ciphertextDigest === e.ciphertextDigest &&
        c.object.ciphertextSizeBytes === e.ciphertextSizeBytes &&
        c.object.key === e.slotObjectKey &&
        ["sourceSha", "releaseAttemptId", "snapshotRunId"].every((key) => c[key] === e[key])
    );
    await checkPermission(s, index, profile, raw, now);
    await checkStorage(s, raw, now);
    const deadline = Math.min(
      instant(m.expiresAt),
      instant(s.permission.validUntil),
      instant(profile.expiresAt)
    );
    const recheck = async () => {
      if (closed) fail("R3_SNAPSHOT_INPUT_UNAVAILABLE");
      try {
        requireThat(Date.now() < deadline);
        for (const item of opened) await item.recheck();
        requireThat(sha256Canonical(await loadFixedManualProfile({ repoRoot })) === profileDigest);
      } catch {
        fail("R3_SNAPSHOT_INPUT_UNAVAILABLE");
      }
    };
    await recheck();
    // This checks a declaration's resource boundary, not a consume decision.
    // The session separately verifies allocation, creation, revocation and slot.
    const assertConsumerBinding = async (input) => {
      requireThat(exact(input, ["request", "scope"]));
      const request = validateManualSnapshotConsumerRequest(input.request),
        scope = input.scope;
      requireThat(
        exact(scope, [
          "targetPolicyDigest",
          "creationSpecDigest",
          "jobAdmissionDigest",
          "buildProofDigest",
          "sourceSha",
          "phase",
          "chain"
        ])
      );
      requireThat(
        request.schemaVersion === "manual-runner-request.v3" &&
          request.profileDigest === profileDigest &&
          request.ownerId === profile.ownerId &&
          request.input.inputReference === inputReference &&
          request.input.inputIndexDigest === sha256Bytes(indexBytes) &&
          request.scopeAuthorizationDigest === index.permission.digest &&
          scope.chain === "snapshot" &&
          request.phase === scope.phase &&
          request.sourceSha === scope.sourceSha &&
          request.candidate.buildProofDigest === scope.buildProofDigest &&
          typeof scope.jobAdmissionDigest === "string" &&
          DIGEST.test(scope.jobAdmissionDigest)
      );
      const use = s.permission.allowedUses.find((value) => value.phase === request.phase);
      requireThat(
        use &&
          use.destinationAdmissionDigest === request.destinationAdmissionDigest &&
          use.readerPrincipal === `manual-h1:${profileDigest}` &&
          use.decryptorPrincipal === `manual-h1:${profileDigest}` &&
          use.userPrincipal === `manual-r3-job:${scope.jobAdmissionDigest}`
      );
      await recheck();
    };
    return freeze({
      inputId: inputReference,
      inputIndexDigest: sha256Bytes(indexBytes),
      permissionDigest: index.permission.digest,
      metadataDigest: index.metadata.digest,
      ciphertextDigest: e.ciphertextDigest,
      objectVersion: c.object.version,
      expiresAt: new Date(deadline).toISOString(),
      allowedUses: s.permission.allowedUses,
      rawReferences: [...refs]
        .map(([digest, bytes]) => ({ digest, bytes: bytes.length }))
        .sort((a, b) => a.digest.localeCompare(b.digest)),
      assertConsumerBinding,
      recheck,
      close
    });
  } catch (error) {
    await close();
    if (error?.code?.startsWith("R3_SNAPSHOT_INPUT_")) throw error;
    fail("R3_SNAPSHOT_INPUT_UNAVAILABLE");
  }
}
