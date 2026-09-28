import * as nativeFs from "node:fs/promises";
import path from "node:path";
import {
  createPublicKey,
  KeyObject,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  encodeManualJson,
  signManualAuthorization,
  verifyManualAuthorization,
  verifyManualHandoff,
  validateManualTargetCreationRequest
} from "./manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";
import {
  validateManualRunnerRequest,
  assessManualRunnerEvidence
} from "./manual-runner-evidence.mjs";
import {
  createExecutionState,
  transitionExecution,
  assertApplyAllowed
} from "./execution-state-machine.mjs";
import { deterministicPlanDigest } from "./proof-builders.mjs";
import { planManualR3TargetLocks } from "./manual-r3-target-locks.mjs";
import { verifyR3HostedEvidence } from "./r3-hosted-evidence.mjs";

const STORAGE = "MANUAL_STORAGE_UNVERIFIED";
const SESSION = "MANUAL_SESSION_UNVERIFIED";
const REVOCATION = "MANUAL_REVOCATION_UNVERIFIED";
const BINDING = "MANUAL_BINDING_MISMATCH";
const EVIDENCE = "MANUAL_EVIDENCE_BINDING_MISMATCH";
const REQUIRED = "MANUAL_EVIDENCE_INPUT_REQUIRED";
const LIMIT = 1048576;
const MS2_STDOUT_LIMIT = 2097152;
const nativeIO = Object.freeze({ fs: nativeFs, execFile: promisify(execFile) });
const manualPolicies = Object.freeze({
  "manual-stage1-profile.v1": Object.freeze({
    recordSchema: "manual-operation-record.v1",
    retentionDays: 180
  }),
  "manual-stage1-profile.v2": Object.freeze({
    recordSchema: "manual-operation-record.v2",
    retentionDays: 90
  })
});
const manualRecordSchemas = new Set(
  Object.values(manualPolicies).map((policy) => policy.recordSchema)
);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const requireThat = (condition, code = BINDING) => {
  if (!condition) fail(code);
};
const equal = (a, b) => encodeManualJson(a).equals(encodeManualJson(b));
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => JSON.parse(encodeManualJson(value));
function instant(value) {
  const n = Date.parse(value);
  requireThat(
    typeof value === "string" && Number.isFinite(n) && new Date(n).toISOString() === value,
    "MANUAL_TIME_INVALID"
  );
  return n;
}
function exact(value, keys, code = BINDING) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      equal(Object.keys(value).sort(), [...keys].sort()),
    code
  );
}
const objectPath = (root, digest) => {
  requireThat(/^sha256:[0-9a-f]{64}$/.test(digest), STORAGE);
  return path.join(root, "objects", `${digest.slice(7)}.json`);
};

// Byte selection only, not evidence admission. The session supplies these
// digest sets only after independently replaying its R3 destination originals.
export function projectManualR2Archive(
  { artifactBytes, rawBlobs },
  verifiedArtifactDigests = new Set(),
  verifiedRawDigests = new Set()
) {
  return {
    artifactBytes: artifactBytes.filter(
      (bytes) => !verifiedArtifactDigests.has(sha256Bytes(bytes))
    ),
    rawBlobs: rawBlobs.filter((bytes) => !verifiedRawDigests.has(sha256Bytes(bytes)))
  };
}

// These are low-level filesystem/process operations, not a public evidence or
// success adapter. R1.3 uses the defaults; controlled tests inject the same
// shape directly. No environment/module/CLI-selected adapter is loaded.
function fileStore(profile, principal, io) {
  exact(io, ["fs", "execFile"], STORAGE);
  const fs = io.fs;
  async function checkedPath(file, ownerOnly = true) {
    requireThat(
      typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file,
      STORAGE
    );
    const parsed = path.parse(file);
    let current = parsed.root;
    for (const segment of file.slice(parsed.root.length).split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      const info = await fs.lstat(current);
      requireThat(!info.isSymbolicLink(), STORAGE);
      const real = await fs.realpath(current);
      requireThat(real.toLowerCase() === current.toLowerCase(), STORAGE);
    }
    if (ownerOnly) await ownerRights(file);
    return fs.lstat(file);
  }
  async function ownerRights(file) {
    if (process.platform !== "win32") {
      requireThat(principal.platform === "posix" && principal.uid === process.getuid(), STORAGE);
      const info = await fs.lstat(file);
      requireThat(info.uid === principal.uid && (info.mode & 0o077) === 0, STORAGE);
      return;
    }
    requireThat(principal.platform === "win32" && /^S-1-[0-9-]+$/.test(principal.sid), STORAGE);
    // icacls is always invoked with fixed argument boundaries, never via a
    // shell. The OS security descriptor supplies numeric owner/ACE SIDs, avoiding locale/name
    // guesses in icacls's human-readable output. Unknown ACLs fail closed.
    await io.execFile("icacls.exe", [file], { windowsHide: true, maxBuffer: LIMIT });
    const literal = `'${file.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl(${literal}); [Console]::WriteLine($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); foreach($e in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [Console]::WriteLine($e.IdentityReference.Value+'|'+$e.AccessControlType+'|'+[int]$e.FileSystemRights) }`;
    const { stdout } = await io.execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: LIMIT }
    );
    const lines = stdout.trim().split(/\r?\n/);
    const acl = {
      owner: lines.shift(),
      entries: lines.map((line) => {
        const [sid, access, rights] = line.split("|");
        return { sid, allow: access === "Allow", rights: Number(rights) };
      })
    };
    requireThat(
      acl.owner === principal.sid && Array.isArray(acl.entries) && acl.entries.length > 0,
      STORAGE
    );
    requireThat(
      acl.entries.every(
        (entry) =>
          entry.sid === principal.sid && entry.allow === true && Number.isInteger(entry.rights)
      ),
      STORAGE
    );
    requireThat(
      acl.entries.some((entry) => (entry.rights & 2032127) === 2032127),
      STORAGE
    );
  }
  async function read(file, raw = false, limit = LIMIT) {
    try {
      const before = await checkedPath(file);
      requireThat(before.isFile() && before.nlink === 1 && before.size <= limit, STORAGE);
      const handle = await fs.open(file, "r");
      try {
        const actual = await handle.stat();
        requireThat(
          actual.ino === before.ino && actual.dev === before.dev && actual.size <= limit,
          STORAGE
        );
        const bytes = Buffer.alloc(limit + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        requireThat(offset <= limit, "MANUAL_JSON_LIMIT");
        const result = Buffer.from(bytes.subarray(0, offset));
        const after = await checkedPath(file, false);
        requireThat(
          after.ino === actual.ino && after.dev === actual.dev && after.size === offset,
          STORAGE
        );
        if (!raw) {
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
          requireThat(encodeManualJson(value).equals(result), STORAGE);
        }
        return result;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === "MANUAL_JSON_LIMIT") throw error;
      fail(STORAGE);
    }
  }
  async function create(file, bytes, duplicateCode = STORAGE) {
    let handle;
    try {
      await checkedPath(path.dirname(file));
      requireThat(bytes.length <= LIMIT, "MANUAL_JSON_LIMIT");
      handle = await fs.open(file, "wx", 0o600);
      await setNewOwner(file);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (error.code === "EEXIST") fail(duplicateCode);
      fail(STORAGE);
    } finally {
      await handle?.close();
    }
    const readback = await read(file);
    requireThat(readback.equals(bytes), STORAGE);
    return readback;
  }
  async function setNewOwner(file) {
    if (process.platform === "win32")
      await io.execFile("icacls.exe", [file, "/setowner", `*${principal.sid}`], {
        windowsHide: true,
        maxBuffer: LIMIT
      });
  }
  async function put(value, role = "archive") {
    const bytes = encodeManualJson(value),
      digest = sha256Bytes(bytes);
    await create(objectPath(profile.storage[`${role}Root`], digest), bytes);
    return Object.freeze({ recordDigest: digest });
  }
  async function roots() {
    const roots = ["keyRoot", "journalRoot", "archiveRoot", "backupRoot", "credentialRoot"].map(
      (key) => profile.storage[key]
    );
    for (const root of roots) requireThat((await checkedPath(root)).isDirectory(), STORAGE);
    for (let i = 0; i < roots.length; i++)
      for (let j = i + 1; j < roots.length; j++) {
        const relative = path.relative(roots[i], roots[j]);
        const reverse = path.relative(roots[j], roots[i]);
        requireThat(
          relative !== "" &&
            (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) &&
            (reverse.startsWith(`..${path.sep}`) || path.isAbsolute(reverse)),
          STORAGE
        );
      }
    for (const role of ["journal", "archive", "backup"])
      await checkedPath(path.join(profile.storage[`${role}Root`], "objects"));
    for (const name of ["locks", "consumptions", "revocations", "checkpoints"])
      await checkedPath(path.join(profile.storage.journalRoot, name));
    await checkedPath(path.join(profile.storage.archiveRoot, "raw"));
  }
  async function objects() {
    const objects = new Map();
    for (const role of ["journal", "archive"]) {
      const dir = path.join(profile.storage[`${role}Root`], "objects");
      await checkedPath(dir);
      for (const name of await fs.readdir(dir)) {
        requireThat(/^[0-9a-f]{64}\.json$/.test(name), STORAGE);
        const bytes = await read(path.join(dir, name));
        requireThat(sha256Bytes(bytes) === `sha256:${name.slice(0, -5)}`, STORAGE);
        objects.set(sha256Bytes(bytes), { value: JSON.parse(bytes), bytes });
      }
    }
    return objects;
  }
  return { fs, checkedPath, read, create, put, roots, setNewOwner, objects };
}

export async function openManualSession({
  profile: inputProfile,
  ownerObservation: inputOwner,
  io = nativeIO,
  now,
  signingKey,
  r3CreationContext
}) {
  const r3 = r3CreationContext !== undefined;
  const profile = snapshot(inputProfile),
    owner = snapshot(inputOwner),
    profileSchema =
      typeof profile?.schemaVersion === "string" &&
      Object.hasOwn(manualPolicies, profile.schemaVersion)
        ? profile.schemaVersion
        : "manual-stage1-profile.v1";
  validateContract(profileSchema, profile);
  const { retentionDays } = manualPolicies[profileSchema],
    recordSchema = r3 ? "manual-operation-record.v3" : manualPolicies[profileSchema].recordSchema,
    revocationSchema = r3 ? "manual-operation-record.v2" : recordSchema,
    profileBytes = encodeManualJson(profile);
  exact(owner, ["ownerId", "principal", r3 ? "scope" : "targetIntent", "observedAt"], SESSION);
  exact(
    owner.principal,
    owner.principal.platform === "win32" ? ["platform", "sid"] : ["platform", "uid"],
    SESSION
  );
  requireThat(owner.ownerId === profile.ownerId, SESSION);
  let r3Context = null;
  if (r3) {
    requireThat(profileSchema === "manual-stage1-profile.v2", SESSION);
    r3Context = snapshot(r3CreationContext);
    exact(
      r3Context,
      r3Context.destinationInputs
        ? ["scope", "creationSpec", "jobAdmission", "destinationInputs"]
        : ["scope", "creationSpec", "jobAdmission"],
      SESSION
    );
    if (r3Context.destinationInputs) {
      exact(
        r3Context.destinationInputs,
        ["manifest", "manifestRawDigest", "policy", "policyBytesBase64"],
        SESSION
      );
      const raw = r3Context.destinationInputs.policyBytesBase64;
      requireThat(
        typeof raw === "string" &&
          /^[A-Za-z0-9+/]*={0,2}$/u.test(raw) &&
          Buffer.from(raw, "base64").toString("base64") === raw &&
          sha256Bytes(Buffer.from(raw, "base64")) === r3Context.scope.targetPolicyDigest,
        SESSION
      );
      requireThat(
        /^sha256:[0-9a-f]{64}$/u.test(r3Context.destinationInputs.manifestRawDigest),
        SESSION
      );
    }
    exact(
      r3Context.scope,
      [
        "targetPolicyDigest",
        "creationSpecDigest",
        "jobAdmissionDigest",
        "buildProofDigest",
        "sourceSha",
        "phase",
        "chain"
      ],
      SESSION
    );
    validateContract("manual-operation-record.v3", {
      schemaVersion: "manual-operation-record.v3",
      kind: "session",
      profileDigest: sha256Canonical(profile),
      recordedAt: owner.observedAt,
      promotionEligible: false,
      sessionId: randomUUID(),
      sessionNonce: randomBytes(32).toString("hex"),
      ownerId: profile.ownerId,
      scope: r3Context.scope,
      status: "OPEN",
      openedAt: owner.observedAt,
      previousSessionRecordDigest: null,
      reasonCode: null
    });
    requireThat(equal(owner.scope, r3Context.scope), SESSION);
    const spec = r3Context.creationSpec,
      job = r3Context.jobAdmission,
      scope = r3Context.scope;
    exact(
      spec,
      [
        "schemaVersion",
        "operationRef",
        "profileDigest",
        "ownerId",
        "sourceSha",
        "buildProofDigest",
        "proofRawDigest",
        "materialRawDigest",
        "targetPolicyDigest",
        "phase",
        "chain",
        "createdAt",
        "expiresAt",
        "workspace",
        "cleanup"
      ],
      SESSION
    );
    exact(
      job,
      [
        "schemaVersion",
        "operationRef",
        "profileDigest",
        "ownerId",
        "creationSpecDigest",
        "buildProofDigest",
        "sourceSha",
        "phase",
        "chain",
        "generatedAt",
        "expiresAt",
        "ci",
        "host"
      ],
      SESSION
    );
    requireThat(
      spec.schemaVersion === "manual-r3-creation-spec.v1" &&
        job.schemaVersion === "manual-r3-job-admission.v1" &&
        sha256Canonical(spec) === scope.creationSpecDigest &&
        sha256Canonical(job) === scope.jobAdmissionDigest &&
        spec.targetPolicyDigest === scope.targetPolicyDigest &&
        job.creationSpecDigest === scope.creationSpecDigest &&
        spec.profileDigest === sha256Canonical(profile) &&
        job.profileDigest === spec.profileDigest &&
        spec.ownerId === profile.ownerId &&
        job.ownerId === spec.ownerId &&
        spec.operationRef === job.operationRef &&
        ["sourceSha", "buildProofDigest", "phase", "chain"].every(
          (field) => scope[field] === spec[field] && scope[field] === job[field]
        ) &&
        spec.cleanup === "stop-owned-engine-and-remove-workspace",
      SESSION
    );
    exact(
      spec.workspace,
      ["id", "capacityBytes", "backingFile", "mountPath", "keyFile", "mapperName"],
      SESSION
    );
    const id = spec.operationRef.replaceAll("-", "");
    requireThat(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        spec.operationRef
      ) &&
        spec.workspace.id === id &&
        Number.isSafeInteger(spec.workspace.capacityBytes) &&
        spec.workspace.capacityBytes >= 64 * 1048576 &&
        spec.workspace.capacityBytes % 1048576 === 0 &&
        spec.workspace.backingFile === `/var/lib/stage1-snapshots/${id}.luks` &&
        spec.workspace.mountPath === `/srv/stage1-snapshot/${id}` &&
        spec.workspace.keyFile === `/dev/shm/stage1-keys/${id}.key` &&
        spec.workspace.mapperName === `s1snap_${id}`,
      SESSION
    );
  }
  requireThat(typeof now === "function", "MANUAL_TIME_INVALID");
  const openedAt = now();
  requireThat(
    instant(owner.observedAt) <= instant(openedAt) &&
      instant(profile.validFrom) <= instant(openedAt) &&
      instant(openedAt) < instant(profile.expiresAt),
    "MANUAL_TIME_INVALID"
  );
  if (r3) {
    const spec = r3Context.creationSpec,
      job = r3Context.jobAdmission;
    requireThat(
      instant(profile.validFrom) <= instant(spec.createdAt) &&
        instant(spec.createdAt) <= instant(job.generatedAt) &&
        instant(job.generatedAt) <= instant(openedAt) &&
        instant(openedAt) < instant(job.expiresAt) &&
        instant(job.expiresAt) <= instant(spec.expiresAt) &&
        instant(spec.expiresAt) <= instant(profile.expiresAt),
      "MANUAL_TIME_INVALID"
    );
  }
  requireThat(
    signingKey instanceof KeyObject &&
      signingKey.type === "private" &&
      signingKey.asymmetricKeyType === "ed25519",
    "MANUAL_SIGNATURE_INVALID"
  );
  requireThat(
    sha256Bytes(createPublicKey(signingKey).export({ type: "spki", format: "der" })) ===
      profile.keyFingerprint &&
      sha256Bytes(createPublicKey(profile.publicKeyPem).export({ type: "spki", format: "der" })) ===
        profile.keyFingerprint,
    "MANUAL_SIGNATURE_INVALID"
  );
  const target = r3
    ? null
    : profile.allowedTargets.find((item) =>
        equal(
          { endpointPolicyId: item.endpointPolicyId, databaseName: item.databaseName },
          owner.targetIntent
        )
      );
  if (!r3) requireThat(target, BINDING);
  // Exact normalized endpoint strings are the approved alias map. We never do
  // DNS resolution or invent equivalence between differently spelled hosts.
  requireThat(
    r3 ||
      (target.endpoint === target.endpoint.trim() &&
        target.endpoint === target.endpoint.toLowerCase()),
    STORAGE
  );
  const store = fileStore(profile, owner.principal, io);
  try {
    await store.roots();
  } catch {
    fail(STORAGE);
  }
  const profileDigest = sha256Canonical(profile),
    sessionId = randomUUID(),
    sessionNonce = randomBytes(32).toString("hex");
  const identity = {
    sessionId,
    sessionNonce,
    profileDigest,
    ...(r3 ? { scope: snapshot(owner.scope) } : { targetIntent: snapshot(owner.targetIntent) })
  };
  const lockDigest = r3
    ? sha256Canonical({ slot: "tcp://127.0.0.1:55440", kind: "r3-forward-slot" })
    : sha256Canonical({ endpoint: target.endpoint, databaseName: target.databaseName });
  const lockPath = path.join(profile.storage.journalRoot, "locks", `${lockDigest.slice(7)}.json`);
  const lockBytes = encodeManualJson({ ...identity, pid: process.pid });
  const observerLockPath = r3
    ? path.join(
        profile.storage.journalRoot,
        "locks",
        `${sha256Canonical({ slot: "127.0.0.1:55441", kind: "r3-forward-slot" }).slice(7)}.json`
      )
    : null;
  let lockHandle,
    observerLockHandle,
    current,
    closed = false,
    queue = Promise.resolve(),
    key = signingKey;
  let checkpoint = null;
  const issued = new Map();
  const targetLocks = new Map();
  const closeTargetHandles = async () => {
    const outcomes = await Promise.allSettled(
      [...targetLocks.values()].map((entry) => entry.handle.close())
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) fail(STORAGE);
  };
  const stamp = () => {
    const value = now();
    requireThat(instant(value) >= instant(openedAt), "MANUAL_TIME_INVALID");
    return value;
  };
  const r3Live = () =>
    requireThat(
      instant(stamp()) < instant(r3Context.jobAdmission.expiresAt),
      "MANUAL_TIME_INVALID"
    );
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const sessionRecord = (status, previous, reasonCode, recordedAt) => ({
    schemaVersion: recordSchema,
    kind: "session",
    profileDigest,
    recordedAt,
    promotionEligible: false,
    sessionId,
    sessionNonce,
    ownerId: profile.ownerId,
    ...(r3 ? { scope: identity.scope } : { targetIntent: identity.targetIntent }),
    status,
    openedAt,
    previousSessionRecordDigest: previous,
    reasonCode
  });
  async function active() {
    requireThat(!closed && key && lockHandle, SESSION);
    let bytes;
    try {
      bytes = await store.read(lockPath);
    } catch {
      fail(SESSION);
    }
    const held = await lockHandle.stat(),
      visible = await store.fs.lstat(lockPath);
    requireThat(
      held.ino === visible.ino && held.dev === visible.dev && bytes.equals(lockBytes),
      SESSION
    );
    if (r3) {
      const observerBytes = await store.read(observerLockPath);
      const observedHeld = await observerLockHandle.stat(),
        observedVisible = await store.fs.lstat(observerLockPath);
      requireThat(
        observedHeld.ino === observedVisible.ino &&
          observedHeld.dev === observedVisible.dev &&
          observerBytes.equals(lockBytes),
        SESSION
      );
      for (const entry of targetLocks.values()) {
        const bytes = await store.read(entry.file);
        const held = await entry.handle.stat(),
          visible = await store.fs.lstat(entry.file);
        requireThat(
          held.ino === visible.ino && held.dev === visible.dev && bytes.equals(entry.bytes),
          SESSION
        );
      }
    }
    const actual = JSON.parse(
      await store.read(objectPath(profile.storage.journalRoot, sha256Canonical(current)))
    );
    requireThat(equal(actual, current) && current.status === "OPEN", SESSION);
  }
  async function revocations() {
    const dir = path.join(profile.storage.journalRoot, "revocations");
    try {
      await store.checkedPath(dir);
      const names = (await store.fs.readdir(dir)).filter((name) =>
        name.startsWith(`${profileDigest.slice(7)}-`)
      );
      requireThat(names.length > 0, REVOCATION);
      const records = [];
      for (let sequence = 0; sequence < names.length; sequence++) {
        const name = `${profileDigest.slice(7)}-${sequence}.json`;
        requireThat(names.includes(name), REVOCATION);
        const record = JSON.parse(await store.read(path.join(dir, name)));
        validateContract(revocationSchema, record);
        requireThat(
          record.kind === "revocation" &&
            record.sequence === sequence &&
            record.profileDigest === profileDigest &&
            record.ownerId === profile.ownerId &&
            record.previousRevocationDigest ===
              (sequence ? sha256Canonical(records[sequence - 1]) : null) &&
            (sequence ? record.action !== "GENESIS" : record.action === "GENESIS"),
          REVOCATION
        );
        requireThat(
          instant(record.recordedAt) <= instant(stamp()) &&
            (!sequence || instant(record.recordedAt) >= instant(records[sequence - 1].recordedAt)),
          REVOCATION
        );
        requireThat(
          (
            await store.read(objectPath(profile.storage.journalRoot, sha256Canonical(record)))
          ).equals(encodeManualJson(record)),
          REVOCATION
        );
        records.push(record);
      }
      // A failed append can leave the canonical revocation before its unique
      // sequence slot. That is uncertainty, not permission to ignore revocation.
      const originalDir = path.join(profile.storage.journalRoot, "objects");
      for (const name of await store.fs.readdir(originalDir)) {
        requireThat(/^[0-9a-f]{64}\.json$/.test(name), REVOCATION);
        const bytes = await store.read(path.join(originalDir, name));
        requireThat(sha256Bytes(bytes) === `sha256:${name.slice(0, -5)}`, REVOCATION);
        const original = JSON.parse(bytes);
        if (original.kind === "revocation" && original.profileDigest === profileDigest)
          requireThat(
            records[original.sequence] && equal(records[original.sequence], original),
            REVOCATION
          );
      }
      const checkpointDir = path.join(profile.storage.journalRoot, "checkpoints");
      await store.checkedPath(checkpointDir);
      for (const name of (await store.fs.readdir(checkpointDir)).filter((name) =>
        name.startsWith(`${profileDigest.slice(7)}-`)
      )) {
        const saved = JSON.parse(await store.read(path.join(checkpointDir, name)));
        requireThat(
          saved.kind === "revocation" &&
            saved.profileDigest === profileDigest &&
            records[saved.sequence] &&
            equal(records[saved.sequence], saved),
          REVOCATION
        );
      }
      if (checkpoint)
        requireThat(
          records[checkpoint.sequence] &&
            sha256Canonical(records[checkpoint.sequence]) === checkpoint.digest,
          REVOCATION
        );
      const head = records.at(-1),
        digest = sha256Canonical(head);
      const checkpointFile = path.join(
        checkpointDir,
        `${profileDigest.slice(7)}-${head.sequence}.json`
      );
      try {
        await store.fs.lstat(checkpointFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await store.create(checkpointFile, encodeManualJson(head));
      }
      requireThat((await store.read(checkpointFile)).equals(encodeManualJson(head)), REVOCATION);
      checkpoint = { sequence: head.sequence, digest };
      return records;
    } catch {
      fail(REVOCATION);
    }
  }
  async function checkedRequest(input) {
    exact(input, ["binding", "canonicalBytes"]);
    requireThat(Buffer.isBuffer(input.canonicalBytes));
    const request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.canonicalBytes)
    );
    validateManualRunnerRequest(request);
    requireThat(encodeManualJson(request).equals(input.canonicalBytes));
    const binding = { ...request };
    for (const field of [
      "schemaVersion",
      "attemptId",
      "runId",
      "attemptAllocationDigest",
      "domainInput",
      "expectedSchemaEvidenceDigest"
    ])
      delete binding[field];
    requireThat(equal(binding, input.binding));
    for (const field of ["profileDigest", "sessionId", "sessionNonce", "targetIntent"])
      requireThat(equal(request[field], identity[field]));
    requireThat(request.ownerId === profile.ownerId);
    const original = await store.read(
      objectPath(profile.storage.archiveRoot, sha256Bytes(input.canonicalBytes))
    );
    requireThat(original.equals(input.canonicalBytes), STORAGE);
    const allocation = JSON.parse(
      await store.read(objectPath(profile.storage.archiveRoot, request.attemptAllocationDigest))
    );
    validateContract("manual-runner-evidence.v1", allocation);
    requireThat(allocation.kind === "attempt-allocation", "MANUAL_EVIDENCE_INPUT_REQUIRED");
    for (const field of [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "attemptId",
      "runId",
      "stage",
      "targetIntent"
    ])
      requireThat(equal(allocation[field], request[field]));
    requireThat(
      allocation.phaseKey === (request.phase ?? "target-observe") &&
        instant(allocation.recordedAt) <= instant(stamp())
    );
    return { request, binding, canonicalBytes: Buffer.from(input.canonicalBytes) };
  }
  async function context(request) {
    await active();
    const records = await revocations(),
      readAt = stamp();
    let predecessor = null;
    const digest = request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest;
    if (digest) {
      const graph = await store.objects();
      predecessor = graph.get(digest)?.value;
      requireThat(predecessor?.kind === "execution", "MANUAL_EVIDENCE_INPUT_REQUIRED");
    }
    return {
      session: { record: current, recordDigest: sha256Canonical(current), readAt, predecessor },
      revocation: {
        records,
        headDigest: sha256Canonical(records.at(-1)),
        checkpoint: { ...checkpoint },
        readAt
      },
      now: readAt
    };
  }
  function reducedExecution(value, graph, assessment = null, seen = new Set()) {
    const digest = sha256Canonical(value);
    requireThat(!seen.has(digest), EVIDENCE);
    seen.add(digest);
    const request = graph.get(value.requestDigest)?.value;
    requireThat(request, REQUIRED);
    if (request.stage === "target-observe" || request.phase === "verify") return null;
    const result = value.resultDigest ? graph.get(value.resultDigest)?.value : null;
    const original = value.predecessorExecutionRecordDigest
      ? graph.get(value.predecessorExecutionRecordDigest)?.value
      : null;
    let state = original
      ? reducedExecution(original, graph, null, seen)
      : createExecutionState(request);
    requireThat(state, EVIDENCE);
    const identity = {
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      attemptId: request.attemptId
    };
    if (request.phase === "dry-run") {
      if (value.status === "SUCCEEDED") {
        requireThat(result?.plan, REQUIRED);
        return transitionExecution(state, {
          type: "DRY_RUN_SUCCEEDED",
          attemptId: request.attemptId,
          planDigest: deterministicPlanDigest(result.plan),
          proofDigest: value.resultDigest
        });
      }
      return state;
    }
    if (request.phase === "apply") {
      const event = {
        type: "APPLY_STARTED",
        ...identity,
        approvedPlanDigest: request.approvedPlanDigest,
        recomputedPlanDigest: state.approvedPlanDigest
      };
      assertApplyAllowed({ state, ...event });
      state = transitionExecution(state, event);
      if (value.status === "SUCCEEDED") {
        state = transitionExecution(state, { type: "APPLY_COMMITTED" });
        return transitionExecution(state, {
          type: "ATTEMPT_PROVED",
          proofDigest: value.resultDigest
        });
      }
      if (value.status === "INTERRUPTED_UNKNOWN")
        return transitionExecution(state, {
          type: "PROCESS_LOST",
          commitState:
            assessment?.originalDatabaseOutcome === "committed"
              ? "committed-result-unproved"
              : "unknown"
        });
      if (assessment?.originalDatabaseOutcome === "not-committed")
        return transitionExecution(state, { type: "PROCESS_LOST", commitState: "not-committed" });
      fail(EVIDENCE);
    }
    if (request.phase === "replay") {
      // The transient REPLAYING value is never a durable checkpoint. A lost
      // replay adds its manual UNKNOWN record while retaining the apply state.
      if (value.status !== "SUCCEEDED") return state;
      state = transitionExecution(state, { type: "REPLAY_STARTED", ...identity });
      return transitionExecution(state, {
        type: "ATTEMPT_PROVED",
        proofDigest: value.resultDigest
      });
    }
    if (request.phase === "reconcile") {
      if (
        assessment?.executionStatus !== "SUCCEEDED" ||
        !["committed", "not-committed"].includes(assessment.originalDatabaseOutcome)
      )
        return state;
      state = transitionExecution(state, { type: "RECONCILE_STARTED", ...identity });
      return transitionExecution(state, {
        type: "RECONCILE_RESOLVED",
        databaseOutcome: assessment.originalDatabaseOutcome,
        proofDigest: assessment.proofDigest
      });
    }
    fail(EVIDENCE);
  }
  async function preflightRequest(request, graph) {
    if (request.stage === "target-observe") return;
    const get = (digest, schema, kind = null) => {
      const value = graph.get(digest)?.value;
      requireThat(value, REQUIRED);
      if (schema) validateContract(schema, value);
      requireThat(!kind || value.kind === kind, EVIDENCE);
      return value;
    };
    const baseline = get(request.baselineManifestDigest, "manual-baseline-manifest.v1");
    const build = get(request.buildProofDigest, "build-proof.v1");
    const observed = get(
      request.targetObservationDigest,
      "manual-runner-evidence.v1",
      "observation"
    );
    const expected = get(
      request.expectedSchemaEvidenceDigest,
      "manual-runner-evidence.v1",
      "schema-expectation"
    );
    for (const field of [
      "buildProofDigest",
      "purpose",
      "targetObservationDigest",
      "physicalIdentity"
    ])
      requireThat(equal(request[field], baseline.identity[field]), EVIDENCE);
    requireThat(
      equal(request.physicalIdentity, observed.physicalIdentity) &&
        request.roleObservation.schemaObservationDigest === sha256Canonical(observed.catalog),
      EVIDENCE
    );
    requireThat(
      expected.buildProofDigest === request.buildProofDigest &&
        expected.script.digest === request.domainInput.expectedSchemaDigest &&
        request.runnerImageDigest === build.identity.images.runner.imageDigest,
      EVIDENCE
    );
    requireThat(
      request.domainInput.baselineManifestIdentityDigest === sha256Canonical(baseline.identity),
      EVIDENCE
    );
    for (const digest of [expected.script.digest, expected.sourceSchemaDigest]) {
      const bytes = await store.read(
        path.join(profile.storage.archiveRoot, "raw", `${digest.slice(7)}.bin`),
        true
      );
      requireThat(sha256Bytes(bytes) === digest, STORAGE);
    }
    const predecessorDigest =
      request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest;
    if (!predecessorDigest) return;
    const predecessor = get(predecessorDigest, null, "execution");
    const priorRequest = graph.get(predecessor.requestDigest)?.value;
    requireThat(priorRequest, REQUIRED);
    requireThat(priorRequest.attemptId !== request.attemptId, EVIDENCE);
    for (const field of [
      "profileDigest",
      "purpose",
      "buildProofDigest",
      "baselineManifestDigest",
      "physicalIdentity"
    ])
      requireThat(equal(request[field], priorRequest[field]), EVIDENCE);
    validateContract(recordSchema, predecessor);
    if (request.phase !== "verify")
      for (const field of ["operationId", "idempotencyKey"])
        requireThat(request[field] === priorRequest[field], EVIDENCE);
    const assessment = assessManualRunnerEvidence(await archiveInput(priorRequest, graph));
    const state = reducedExecution(predecessor, graph, assessment);
    if (request.phase === "apply") {
      requireThat(
        priorRequest.phase === "dry-run" &&
          assessment.executionStatus === "SUCCEEDED" &&
          equal(request.domainInput, priorRequest.domainInput),
        EVIDENCE
      );
      assertApplyAllowed({
        state,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        approvedPlanDigest: request.approvedPlanDigest,
        recomputedPlanDigest: assessment.planDigest
      });
    } else if (request.phase === "replay") {
      requireThat(
        priorRequest.phase === "apply" &&
          predecessor.status === "SUCCEEDED" &&
          assessment.executionStatus === "SUCCEEDED" &&
          assessment.originalDatabaseOutcome === "committed",
        EVIDENCE
      );
      transitionExecution(state, {
        type: "REPLAY_STARTED",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        attemptId: request.attemptId
      });
    } else if (request.phase === "reconcile") {
      requireThat(
        priorRequest.phase === "apply" &&
          predecessor.status === "INTERRUPTED_UNKNOWN" &&
          state.status === "INTERRUPTED_UNKNOWN",
        EVIDENCE
      );
      transitionExecution(state, {
        type: "RECONCILE_STARTED",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        attemptId: request.attemptId
      });
    } else
      requireThat(
        priorRequest.phase === "apply" &&
          assessment.executionStatus === "SUCCEEDED" &&
          assessment.originalDatabaseOutcome === "committed",
        EVIDENCE
      );
  }
  async function archiveInput(
    request,
    graph = null,
    historicalConsumption = null,
    r3Validated = null,
    r3Originals = null
  ) {
    graph ??= await store.objects();
    // R2's evidence assessor predates the disjoint R3 record/request schema.
    // Validate those originals before projecting the R2 graph; a consumed R3
    // operation is never interpreted as a local target authorization.
    const r2Artifacts = [];
    for (const entry of graph.values()) {
      const value = entry.value;
      if (value.schemaVersion === "manual-operation-record.v3") {
        validateContract("manual-operation-record.v3", value);
        requireThat(
          ["session", "custody"].includes(value.kind) ||
            (value.kind === "consumption" && r3Validated?.has(sha256Canonical(value))) ||
            (value.kind === "execution" && r3Validated?.has(value.consumptionRecordDigest)),
          SESSION
        );
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-request.v4") {
        validateManualTargetCreationRequest(value);
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-evidence.v2") {
        validateContract("manual-runner-evidence.v2", value);
        r2Artifacts.push(null);
      } else if (value.payload?.schemaVersion === "manual-launch-authorization.v4") {
        validateContract("manual-launch-authorization.v4", value);
        r2Artifacts.push(null);
      } else r2Artifacts.push(entry.bytes);
    }
    // Only existing process references can enter the bounded candidate read.
    // The shared assessor subsequently validates protocol/direction/binding and
    // every ordinary usage before this input can authorize any transition.
    const prefixDigests = new Set();
    for (const { value } of graph.values()) {
      if (value.kind !== "process") continue;
      validateContract("manual-runner-evidence.v1", value);
      const bound = graph.get(value.requestDigest)?.value;
      if (!bound || bound.schemaVersion !== "manual-runner-request.v1") continue;
      validateManualRunnerRequest(bound);
      if (
        [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId",
          "runId"
        ].every((key) => value[key] === bound[key]) &&
        value.attemptAllocationDigest === bound.attemptAllocationDigest
      )
        prefixDigests.add(value.protocol.stdoutPrefix.digest);
    }
    const rawDir = path.join(profile.storage.archiveRoot, "raw"),
      raws = new Map();
    await store.checkedPath(rawDir);
    for (const name of await store.fs.readdir(rawDir)) {
      requireThat(/^[0-9a-f]{64}\.bin$/.test(name), STORAGE);
      const bytes = await store.read(
          path.join(rawDir, name),
          true,
          prefixDigests.has(`sha256:${name.slice(0, -4)}`) ? MS2_STDOUT_LIMIT : LIMIT
        ),
        digest = sha256Bytes(bytes);
      requireThat(digest === `sha256:${name.slice(0, -4)}`, STORAGE);
      raws.set(digest, bytes);
    }
    const requestBytes = graph.get(sha256Canonical(request))?.bytes;
    requireThat(requestBytes, REQUIRED);
    const input = {
      requestBytes,
      ...projectManualR2Archive(
        { artifactBytes: r2Artifacts.filter(Boolean), rawBlobs: [...raws.values()] },
        r3Originals?.artifacts,
        r3Originals?.raws
      )
    };
    if (request.profileDigest === profileDigest)
      return { ...input, profileBytes: Buffer.from(profileBytes) };
    requireThat(
      historicalConsumption?.kind === "consumption" &&
        historicalConsumption.schemaVersion === "manual-operation-record.v1" &&
        historicalConsumption.profileDigest === request.profileDigest &&
        historicalConsumption.requestDigest === sha256Canonical(request),
      SESSION
    );
    return input;
  }
  async function history(
    request,
    ignoreRequest = null,
    targetFilter = target,
    r3Validated = null,
    r3Originals = null
  ) {
    const graph = await store.objects(),
      values = [...graph.values()].map((item) => item.value);
    const sessions = values.filter(
      (value) => value.kind === "session" && value.sessionId === sessionId
    );
    requireThat(!sessions.some((value) => value.status !== "OPEN"), SESSION);
    const dir = path.join(profile.storage.journalRoot, "consumptions");
    await store.checkedPath(dir);
    const consumptions = new Map(
      values
        .filter(
          (value) => value.kind === "consumption" && !r3Validated?.has(sha256Canonical(value))
        )
        .map((value) => [sha256Canonical(value), value])
    );
    const slotDigests = new Set();
    for (const name of await store.fs.readdir(dir)) {
      requireThat(/^[0-9a-f]{64}-[0-9a-f-]{36}\.json$/.test(name), SESSION);
      let consumed;
      try {
        consumed = JSON.parse(await store.read(path.join(dir, name)));
        requireThat(
          typeof consumed?.schemaVersion === "string" &&
            (manualRecordSchemas.has(consumed.schemaVersion) ||
              (r3 &&
                consumed.schemaVersion === "manual-operation-record.v3" &&
                r3Validated?.has(sha256Canonical(consumed)))),
          SESSION
        );
        validateContract(
          r3
            ? consumed.schemaVersion
            : consumed.profileDigest === profileDigest
              ? recordSchema
              : consumed.schemaVersion,
          consumed
        );
      } catch {
        fail(SESSION);
      }
      requireThat(consumed.kind === "consumption", SESSION);
      if (r3Validated?.has(sha256Canonical(consumed))) continue;
      const auth = graph.get(consumed.authorizationDigest)?.value;
      requireThat(
        auth?.payload &&
          name === `${consumed.profileDigest.slice(7)}-${auth.payload.authorizationId}.json`,
        SESSION
      );
      consumptions.set(sha256Canonical(consumed), consumed);
      slotDigests.add(sha256Canonical(consumed));
    }
    const unresolved = [],
      completedApplies = [];
    for (const consumed of consumptions.values()) {
      const original = graph.get(consumed.requestDigest)?.value;
      requireThat(original?.schemaVersion === "manual-runner-request.v1", SESSION);
      requireThat(
        consumed.requestDigest === sha256Canonical(original) &&
          consumed.profileDigest === original.profileDigest,
        SESSION
      );
      if (original.targetIntent.databaseName !== targetFilter.databaseName) continue;
      const historicalTarget = profile.allowedTargets.find(
        (item) =>
          item.endpointPolicyId === original.targetIntent.endpointPolicyId &&
          item.databaseName === original.targetIntent.databaseName
      );
      requireThat(historicalTarget, SESSION);
      if (historicalTarget.endpoint !== targetFilter.endpoint) continue;
      requireThat(slotDigests.has(sha256Canonical(consumed)), SESSION);
      if (consumed.requestDigest === ignoreRequest) continue;
      requireThat(request.attemptId !== original.attemptId, SESSION);
      const executions = values.filter(
        (value) => value.kind === "execution" && value.requestDigest === consumed.requestDigest
      );
      requireThat(executions.length <= 1, SESSION);
      if (!executions.length || executions[0].status === "INTERRUPTED_UNKNOWN")
        unresolved.push({ consumed, original, execution: executions[0] });
      else if (original.phase === "apply" && original.operationId === request.operationId)
        completedApplies.push({ consumed, original, execution: executions[0] });
    }
    // This gate precedes assessing any old successful subset. In particular a
    // replay UNKNOWN never turns the original apply success into permission.
    if (unresolved.some((entry) => entry.original.phase === "replay")) fail(SESSION);
    if (
      unresolved.length === 1 &&
      unresolved[0].original.phase === "apply" &&
      unresolved[0].execution
    ) {
      const originalDigest = sha256Canonical(unresolved[0].execution);
      const candidates = values.filter(
        (value) =>
          value.kind === "execution" &&
          value.status === "SUCCEEDED" &&
          value.predecessorExecutionRecordDigest === originalDigest
      );
      for (const candidate of candidates) {
        const recoveryRequest = graph.get(candidate.requestDigest)?.value;
        if (recoveryRequest?.phase !== "reconcile") continue;
        const recoveryConsumption = consumptions.get(candidate.consumptionRecordDigest);
        requireThat(
          recoveryConsumption &&
            slotDigests.has(candidate.consumptionRecordDigest) &&
            recoveryConsumption.requestDigest === candidate.requestDigest &&
            recoveryConsumption.profileDigest === recoveryRequest.profileDigest,
          SESSION
        );
        const assessment = assessManualRunnerEvidence(
          await archiveInput(recoveryRequest, graph, recoveryConsumption, r3Validated, r3Originals)
        );
        if (
          assessment.executionStatus === "SUCCEEDED" &&
          ["committed", "not-committed"].includes(assessment.originalDatabaseOutcome) &&
          assessment.proofDigest === candidate.resultDigest
        ) {
          const resolved = reducedExecution(candidate, graph, assessment);
          requireThat(["SUCCEEDED", "FAILED"].includes(resolved.status), EVIDENCE);
          // Resolving uncertainty never resets an executed operation to a new
          // migration plan. A failed resolution also cannot authorize replay.
          requireThat(
            !(
              request.operationId === resolved.operationId &&
              (["dry-run", "apply"].includes(request.phase) ||
                (resolved.status === "FAILED" && request.phase === "replay"))
            ),
            SESSION
          );
          unresolved.length = 0;
          break;
        }
      }
    }
    if (unresolved.length) {
      const recovery =
        request.phase === "reconcile" &&
        unresolved.length === 1 &&
        unresolved[0].original.phase === "apply" &&
        unresolved[0].execution &&
        request.predecessorExecutionRecordDigest === sha256Canonical(unresolved[0].execution) &&
        request.operationId === unresolved[0].original.operationId &&
        request.idempotencyKey === unresolved[0].original.idempotencyKey;
      requireThat(recovery, SESSION);
    }
    // Unresolved target history is checked first. A completed apply is not
    // permission to replay its old dry-run as a fresh apply: derive its real
    // operation state using the same evidence and reducer used for recording.
    // sign, consume and successful record/signoff all pass this shared gate.
    if (["dry-run", "apply"].includes(request.phase)) {
      for (const prior of completedApplies) {
        const assessment = assessManualRunnerEvidence(
          await archiveInput(prior.original, graph, prior.consumed, r3Validated, r3Originals)
        );
        const state = reducedExecution(prior.execution, graph, assessment);
        requireThat(state?.status === "DRY_RUN_SUCCEEDED", SESSION);
      }
    }
    return graph;
  }
  async function recordValue(kind, input) {
    await active();
    const readAt = stamp(),
      value = snapshot(input);
    validateContract(recordSchema, value);
    requireThat(value.kind === kind && value.profileDigest === profileDigest, EVIDENCE);
    requireThat(instant(value.recordedAt) <= instant(readAt), "MANUAL_TIME_INVALID");
    for (const name of ["openedAt", "observedAt", "startedAt", "finishedAt", "issuedAt"])
      if (value[name] != null)
        requireThat(instant(value[name]) <= instant(value.recordedAt), "MANUAL_TIME_INVALID");
    if (value.startedAt && value.finishedAt)
      requireThat(instant(value.startedAt) <= instant(value.finishedAt), "MANUAL_TIME_INVALID");
    if (kind === "revocation") {
      const records = await revocations(),
        head = records.at(-1);
      requireThat(
        value.ownerId === profile.ownerId &&
          value.action !== "GENESIS" &&
          value.sequence === head.sequence + 1 &&
          value.previousRevocationDigest === sha256Canonical(head) &&
          instant(value.recordedAt) >= instant(head.recordedAt),
        REVOCATION
      );
      const ref = await store.put(value, "journal");
      await store.create(
        path.join(
          profile.storage.journalRoot,
          "revocations",
          `${profileDigest.slice(7)}-${value.sequence}.json`
        ),
        encodeManualJson(value)
      );
      await revocations();
      return ref;
    }
    const graph = await store.objects();
    const get = (digest, kinds = null) => {
      requireThat(digest !== sha256Canonical(value), EVIDENCE);
      const item = graph.get(digest)?.value;
      requireThat(item, REQUIRED);
      if (kinds)
        requireThat(
          kinds.includes(item.kind ?? (item.payload ? "authorization" : item.schemaVersion)),
          EVIDENCE
        );
      const time = item.recordedAt ?? item.payload?.issuedAt ?? item.createdAt;
      if (time) requireThat(instant(time) <= instant(value.recordedAt), "MANUAL_TIME_INVALID");
      return item;
    };
    const same = (a, b, fields) =>
      fields.forEach((field) => requireThat(equal(a[field], b[field]), EVIDENCE));
    const scoped = ["profileDigest", "sessionId", "sessionNonce", "operationId", "idempotencyKey"];
    let request,
      executionState = null;
    if (Object.hasOwn(value, "requestDigest")) {
      request = get(value.requestDigest, ["manual-runner-request.v1"]);
      validateManualRunnerRequest(request);
      same(value, request, scoped);
      const recordTarget = profile.allowedTargets.find(
        (item) =>
          item.endpointPolicyId === request.targetIntent.endpointPolicyId &&
          item.databaseName === request.targetIntent.databaseName
      );
      requireThat(
        recordTarget &&
          recordTarget.endpoint === target.endpoint &&
          recordTarget.databaseName === target.databaseName,
        EVIDENCE
      );
      get(request.attemptAllocationDigest, ["attempt-allocation"]);
    }
    if (value.ownerId) requireThat(value.ownerId === profile.ownerId, EVIDENCE);
    if (kind === "session") {
      requireThat(
        value.sessionId === sessionId &&
          value.sessionNonce === sessionNonce &&
          value.status === "INTERRUPTED_UNKNOWN" &&
          value.previousSessionRecordDigest === sha256Canonical(current),
        EVIDENCE
      );
      same(value, current, ["ownerId", "targetIntent", "openedAt"]);
      const ref = await store.put(value, "journal");
      current = value;
      closed = true;
      key = null;
      return ref;
    }
    if (kind === "post-state") {
      const consumed = get(value.consumptionRecordDigest, ["consumption"]);
      same(value, consumed, [...scoped, "requestDigest"]);
      if (value.outcome === "OBSERVED") {
        const observation = get(value.observationDigest, ["observation"]);
        same(value, observation, [...scoped, "requestDigest", "observedAt"]);
        requireThat(observation.attemptId === request.attemptId, EVIDENCE);
      }
    } else if (kind === "custody") {
      const subject = value.subjectType === "profile" ? profile : get(value.subjectDigest);
      requireThat(subject.kind !== "custody", EVIDENCE);
      if (subject.profileDigest) requireThat(subject.profileDigest === profileDigest, EVIDENCE);
      if (value.subjectType === "profile")
        requireThat(value.subjectDigest === profileDigest, EVIDENCE);
      else if (value.subjectType === "record")
        requireThat(subject.schemaVersion === recordSchema, EVIDENCE);
      else if (value.subjectType === "authorization")
        requireThat(subject.payload?.schemaVersion === "manual-launch-authorization.v1", EVIDENCE);
      else
        requireThat(!manualRecordSchemas.has(subject.schemaVersion) && !subject.payload, EVIDENCE);
      if (value.purpose === "consumption-readback")
        requireThat(subject.kind === "consumption" && value.storageRole === "journal", EVIDENCE);
      if (value.purpose === "handoff-readback")
        requireThat(
          subject.kind === "consumption-handoff" && value.storageRole === "archive",
          EVIDENCE
        );
      if (value.purpose === "backup-readback")
        requireThat(value.storageRole === "backup", EVIDENCE);
      // MATCH is derived from a new handle read, never the write response or
      // caller's observedDigest. No recursive custody is manufactured.
      if (value.outcome === "MATCH") {
        // Mirror the shared E artifact birth rule. In particular validFrom is
        // not a profile creation time, and a request's allocation must exist.
        const producedAt =
          subject.recordedAt ??
          subject.createdAt ??
          subject.payload?.issuedAt ??
          subject.provenance?.generatedAt ??
          (subject.schemaVersion === "manual-runner-request.v1"
            ? get(subject.attemptAllocationDigest, ["attempt-allocation"]).allocatedAt
            : null);
        if (producedAt !== null)
          requireThat(instant(producedAt) <= instant(value.observedAt), "MANUAL_TIME_INVALID");
        const bytes = await store.read(
          objectPath(profile.storage[`${value.storageRole}Root`], value.subjectDigest)
        );
        requireThat(
          sha256Bytes(bytes) === value.subjectDigest &&
            value.observedDigest === value.subjectDigest &&
            bytes.equals(encodeManualJson(subject)),
          STORAGE
        );
      }
    } else if (kind === "execution") {
      requireThat(value.attemptId === request.attemptId, EVIDENCE);
      requireThat(
        value.predecessorExecutionRecordDigest ===
          (request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null),
        EVIDENCE
      );
      for (const [field, expectedKind] of [
        ["authorizationDigest", "authorization"],
        ["consumptionRecordDigest", "consumption"],
        ["handoffRecordDigest", "consumption-handoff"],
        ["handoffReadbackDigest", "custody"],
        ["postStateRecordDigest", "post-state"],
        ["predecessorExecutionRecordDigest", "execution"],
        ["resultDigest", "manual-command-result"],
        ["processEvidenceDigest", "process"]
      ]) {
        if (value[field] === null) continue;
        const subject = get(value[field], [expectedKind]);
        if (!["predecessorExecutionRecordDigest", "handoffReadbackDigest"].includes(field))
          requireThat(
            (subject.payload?.requestDigest ?? subject.requestDigest) === value.requestDigest,
            EVIDENCE
          );
      }
      if (value.handoffReadbackDigest) {
        const readback = get(value.handoffReadbackDigest, ["custody"]);
        requireThat(
          readback.outcome === "MATCH" &&
            readback.purpose === "handoff-readback" &&
            readback.subjectDigest === value.handoffRecordDigest,
          EVIDENCE
        );
      }
      requireThat(
        ![...graph.values()].some(
          ({ value: old }) => old.kind === "execution" && old.requestDigest === value.requestDigest
        ),
        EVIDENCE
      );
      if (value.startedAt !== null)
        requireThat(
          value.resultDigest &&
            get(value.resultDigest, ["manual-command-result"]).startedAt === value.startedAt,
          EVIDENCE
        );
      if (value.finishedAt !== null) {
        const source =
          request.stage === "target-observe"
            ? value.resultDigest && get(value.resultDigest, ["manual-command-result"]).finishedAt
            : value.processEvidenceDigest && get(value.processEvidenceDigest, ["process"]).closedAt;
        requireThat(source === value.finishedAt, EVIDENCE);
      }
      if (value.status === "SUCCEEDED") await history(request, value.requestDigest);
      const assessment = assessManualRunnerEvidence(await archiveInput(request, graph));
      requireThat(
        value.status === assessment.executionStatus || value.status === "INTERRUPTED_UNKNOWN",
        EVIDENCE
      );
      if (value.status === "SUCCEEDED") {
        requireThat(value.resultDigest === assessment.proofDigest, EVIDENCE);
        const post = get(value.postStateRecordDigest, ["post-state"]);
        requireThat(post.outcome === "OBSERVED", EVIDENCE);
        const result = get(value.resultDigest, ["manual-command-result"]);
        requireThat(
          result.outcome === "RETURNED" &&
            result.phaseKey === (request.phase ?? request.stage) &&
            post.observationDigest === result.observationDigest &&
            value.startedAt === result.startedAt,
          EVIDENCE
        );
        if (request.stage === "target-observe")
          requireThat(
            value.handoffRecordDigest === null &&
              value.handoffReadbackDigest === null &&
              value.processEvidenceDigest === null &&
              value.finishedAt === result.finishedAt,
            EVIDENCE
          );
        else {
          requireThat(
            value.handoffRecordDigest && value.handoffReadbackDigest && value.processEvidenceDigest,
            EVIDENCE
          );
          requireThat(
            value.finishedAt === get(value.processEvidenceDigest, ["process"]).closedAt,
            EVIDENCE
          );
        }
      }
      if (
        value.status === "INTERRUPTED_UNKNOWN" &&
        !value.processEvidenceDigest &&
        !value.resultDigest
      )
        requireThat(value.finishedAt === null, EVIDENCE);
      executionState = reducedExecution(value, graph, assessment);
    } else if (kind === "signoff") {
      const execution = get(value.executionRecordDigest, ["execution"]);
      same(value, execution, scoped);
      for (const [field, purpose, role] of [
        ["executionReadbackDigest", "archive-readback", "archive"],
        ["backupReadbackDigest", "backup-readback", "backup"]
      ]) {
        const readback = get(value[field], ["custody"]);
        requireThat(
          readback.outcome === "MATCH" &&
            readback.subjectDigest === value.executionRecordDigest &&
            readback.observedDigest === value.executionRecordDigest &&
            readback.purpose === purpose &&
            readback.storageRole === role,
          EVIDENCE
        );
        requireThat(
          (
            await store.read(
              objectPath(profile.storage[`${role}Root`], value.executionRecordDigest)
            )
          ).equals(encodeManualJson(execution)),
          STORAGE
        );
      }
      if (value.decision === "ACCEPTED") {
        requireThat(execution.status === "SUCCEEDED", EVIDENCE);
        const request = get(execution.requestDigest, ["manual-runner-request.v1"]);
        await history(request, execution.requestDigest);
        const assessment = assessManualRunnerEvidence(await archiveInput(request, graph));
        requireThat(
          assessment.executionStatus === "SUCCEEDED" &&
            assessment.proofDigest === execution.resultDigest,
          EVIDENCE
        );
      }
    } else fail(EVIDENCE);
    const ref = await store.put(value);
    if (
      executionState &&
      !(request.phase === "replay" && value.status !== "SUCCEEDED") &&
      !(request.phase === "reconcile" && value.status !== "SUCCEEDED")
    ) {
      const file = path.join(
        profile.storage.journalRoot,
        "checkpoints",
        `execution-${request.operationId}-${sha256Canonical(executionState).slice(7)}.json`
      );
      try {
        await store.fs.lstat(file);
        requireThat((await store.read(file)).equals(encodeManualJson(executionState)), STORAGE);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await store.create(file, encodeManualJson(executionState));
      }
    }
    return ref;
  }
  async function retainPending() {
    const graph = await store.objects(),
      values = [...graph.values()].map((item) => item.value);
    const dir = path.join(profile.storage.journalRoot, "consumptions");
    for (const name of await store.fs.readdir(dir)) {
      const bytes = await store.read(path.join(dir, name)),
        consumed = JSON.parse(bytes);
      if (consumed.sessionId !== sessionId || consumed.sessionNonce !== sessionNonce) continue;
      if (
        values.some(
          (value) => value.kind === "execution" && value.requestDigest === consumed.requestDigest
        )
      )
        continue;
      const request = graph.get(consumed.requestDigest)?.value;
      requireThat(request && graph.get(request.attemptAllocationDigest), REQUIRED);
      if (!graph.has(sha256Canonical(consumed))) {
        await store.put(consumed, "journal");
        graph.set(sha256Canonical(consumed), { value: consumed, bytes });
      }
      const value = {
        ...common("execution", stamp()),
        sessionId,
        sessionNonce,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        attemptId: request.attemptId,
        requestDigest: consumed.requestDigest,
        authorizationDigest: consumed.authorizationDigest,
        consumptionRecordDigest: sha256Canonical(consumed),
        handoffRecordDigest: null,
        handoffReadbackDigest: null,
        postStateRecordDigest: null,
        predecessorExecutionRecordDigest:
          request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null,
        startedAt: null,
        finishedAt: null,
        status: "INTERRUPTED_UNKNOWN",
        reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
        resultDigest: null,
        processEvidenceDigest: null
      };
      const existing = values.filter((item) => item.requestDigest === consumed.requestDigest);
      value.handoffRecordDigest = existing.find((item) => item.kind === "consumption-handoff")
        ? sha256Canonical(existing.find((item) => item.kind === "consumption-handoff"))
        : null;
      const readback = values.find(
        (item) =>
          item.kind === "custody" &&
          item.purpose === "handoff-readback" &&
          item.subjectDigest === value.handoffRecordDigest &&
          item.outcome === "MATCH"
      );
      value.handoffReadbackDigest = readback ? sha256Canonical(readback) : null;
      await recordValue("execution", value);
    }
  }
  function verify(authorization, request, ctx) {
    return verifyManualAuthorization({
      authorization,
      profile,
      request: { binding: request.binding, canonicalBytes: request.canonicalBytes },
      ...ctx
    });
  }
  const consumptionSlot = (authorizationId) =>
    path.join(
      profile.storage.journalRoot,
      "consumptions",
      `${profileDigest.slice(7)}-${authorizationId}.json`
    );
  async function unused(authorizationId) {
    requireThat(/^[0-9a-f-]{36}$/.test(authorizationId), BINDING);
    try {
      await store.fs.lstat(consumptionSlot(authorizationId));
    } catch (error) {
      if (error.code === "ENOENT") return;
      fail(STORAGE);
    }
    fail("MANUAL_AUTHORIZATION_CONSUMED");
  }
  function common(kind, recordedAt) {
    return {
      schemaVersion: recordSchema,
      kind,
      profileDigest,
      recordedAt,
      promotionEligible: false
    };
  }
  async function consumptionReadback(consumption) {
    const digest = sha256Canonical(consumption);
    requireThat(
      (await store.read(objectPath(profile.storage.journalRoot, digest))).equals(
        encodeManualJson(consumption)
      ),
      STORAGE
    );
    const recordedAt = stamp();
    const custody = {
      ...common("custody", recordedAt),
      ownerId: profile.ownerId,
      subjectDigest: digest,
      subjectType: "record",
      purpose: "consumption-readback",
      outcome: "MATCH",
      observedDigest: digest,
      observedAt: recordedAt,
      storageRole: "journal",
      retentionDays,
      reasonCode: null
    };
    return store.put(custody);
  }
  async function r3CheckedRequest(input) {
    exact(input, ["binding", "canonicalBytes"]);
    requireThat(Buffer.isBuffer(input.canonicalBytes), BINDING);
    const canonicalBytes = Buffer.from(input.canonicalBytes);
    const request = validateManualTargetCreationRequest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes))
    );
    requireThat(encodeManualJson(request).equals(canonicalBytes), BINDING);
    const fields = [
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
      "chain",
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest"
    ];
    const binding = Object.fromEntries(fields.map((field) => [field, request[field]]));
    requireThat(equal(binding, input.binding), BINDING);
    for (const field of ["profileDigest", "sessionId", "sessionNonce"])
      requireThat(request[field] === identity[field], BINDING);
    requireThat(
      request.ownerId === profile.ownerId &&
        request.operationId === r3Context.creationSpec.operationRef &&
        request.stage === "target-create" &&
        request.sourceSha === identity.scope.sourceSha &&
        request.candidate.buildProofDigest === identity.scope.buildProofDigest,
      BINDING
    );
    for (const field of [
      "phase",
      "chain",
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest"
    ])
      requireThat(request[field] === identity.scope[field], BINDING);
    requireThat(
      (
        await store.read(objectPath(profile.storage.archiveRoot, sha256Bytes(canonicalBytes)))
      ).equals(canonicalBytes),
      STORAGE
    );
    const allocation = JSON.parse(
      await store.read(objectPath(profile.storage.archiveRoot, request.attemptAllocationDigest))
    );
    validateContract("manual-runner-evidence.v2", allocation);
    requireThat(
      allocation.kind === "attempt-allocation" &&
        allocation.sessionRecordDigest === sha256Canonical(current) &&
        allocation.predecessorExecutionRecordDigest === null &&
        instant(current.openedAt) <= instant(allocation.recordedAt) &&
        instant(allocation.recordedAt) <= instant(allocation.allocatedAt) &&
        instant(allocation.allocatedAt) <= instant(stamp()),
      BINDING
    );
    for (const field of [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "attemptId",
      "runId",
      "stage",
      "phase",
      "chain",
      "sourceSha",
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest"
    ])
      requireThat(allocation[field] === request[field], BINDING);
    requireThat(allocation.buildProofDigest === request.candidate.buildProofDigest, BINDING);
    return { request, binding, canonicalBytes };
  }
  async function r3StoredDestination(graph, destinationDigest, initialExecution) {
    requireThat(r3Context.destinationInputs, SESSION);
    const destinationBytes = await store.read(
      objectPath(profile.storage.archiveRoot, destinationDigest)
    );
    const destination = JSON.parse(destinationBytes);
    requireThat(sha256Bytes(destinationBytes) === destinationDigest, EVIDENCE);
    const observationDigest = destination.observationEvidenceDigest;
    requireThat(/^sha256:[0-9a-f]{64}$/u.test(observationDigest), EVIDENCE);
    const observationBytes = await store.read(
      objectPath(profile.storage.archiveRoot, observationDigest)
    );
    const observations = JSON.parse(observationBytes);
    requireThat(sha256Bytes(observationBytes) === observationDigest, EVIDENCE);
    for (const [digest, bytes] of [
      [destinationDigest, destinationBytes],
      [observationDigest, observationBytes]
    ]) {
      requireThat(graph.get(digest)?.bytes.equals(bytes), EVIDENCE);
      requireThat(
        (await store.read(objectPath(profile.storage.backupRoot, digest))).equals(bytes),
        STORAGE
      );
    }
    const operationRef = r3Context.creationSpec.operationRef;
    const bundlePath = (role) =>
      path.join(
        profile.storage[`${role}Root`],
        "inputs",
        "r3",
        operationRef,
        "observations",
        "active",
        "hosted-evidence.json"
      );
    const bundleBytes = await store.read(bundlePath("archive"));
    requireThat((await store.read(bundlePath("backup"))).equals(bundleBytes), STORAGE);
    const policyBytes = Buffer.from(r3Context.destinationInputs.policyBytesBase64, "base64");
    requireThat(sha256Bytes(policyBytes) === identity.scope.targetPolicyDigest, EVIDENCE);
    const verified = verifyR3HostedEvidence({
      bundleBytes,
      jobAdmissionBytes: encodeManualJson(r3Context.jobAdmission),
      spec: r3Context.creationSpec,
      policyBytes,
      now: stamp()
    });
    const { buildR3Destination } = await import("../../../scripts/release/r3-destination.mjs");
    const rebuilt = await buildR3Destination({
      spec: r3Context.creationSpec,
      jobAdmissionDigest: identity.scope.jobAdmissionDigest,
      hostedEvidence: {
        bundleDigest: verified.bundleDigest,
        engine: verified.engine,
        workspaceObservation: JSON.parse(verified.workspace.observationBytes),
        jobAdmissionDigest: identity.scope.jobAdmissionDigest,
        spec: r3Context.creationSpec
      },
      session: { profileDigest, sessionId, sessionNonce, scope: identity.scope },
      initialExecution,
      manifest: r3Context.destinationInputs.manifest,
      manifestRawDigest: r3Context.destinationInputs.manifestRawDigest,
      policy: r3Context.destinationInputs.policy,
      postgresReadback: observations.postgres,
      databaseTargetSet: destination.databaseTargetSet,
      databaseReadback: observations.databases,
      observedAt: destination.observedAt
    });
    requireThat(
      encodeManualJson(rebuilt.destination).equals(destinationBytes) &&
        encodeManualJson(rebuilt.observations).equals(observationBytes) &&
        destination.initialExecutionRecordDigest === sha256Canonical(initialExecution),
      EVIDENCE
    );
    const expectedLocks = rebuilt.destination.databaseTargetSet.targetLocks;
    requireThat(
      expectedLocks.length === targetLocks.size &&
        expectedLocks.every((entry) => targetLocks.has(entry.lockDigest)),
      SESSION
    );
    await active();
    return {
      destination,
      destinationDigest,
      observationDigest,
      streamDigest: sha256Bytes(Buffer.from(observations.postgres.streamBase64, "base64"))
    };
  }
  async function r3History(request, pendingDigest = null, pendingDestination = null) {
    const r3Originals = { artifacts: new Set(), raws: new Set() };
    const graph = await store.objects();
    const values = [...graph.values()].map((entry) => entry.value);
    const r3Validated = new Set();
    const legacy = [];
    let r3Count = 0;
    for (const value of values.filter(
      (entry) => entry.schemaVersion === "manual-operation-record.v3"
    ))
      validateContract("manual-operation-record.v3", value);
    const dir = path.join(profile.storage.journalRoot, "consumptions");
    await store.checkedPath(dir);
    const slots = new Map();
    for (const name of await store.fs.readdir(dir)) {
      requireThat(/^[0-9a-f]{64}-[0-9a-f-]{36}\.json$/u.test(name), SESSION);
      const consumed = JSON.parse(await store.read(path.join(dir, name)));
      requireThat(
        [
          "manual-operation-record.v1",
          "manual-operation-record.v2",
          "manual-operation-record.v3"
        ].includes(consumed.schemaVersion),
        SESSION
      );
      validateContract(consumed.schemaVersion, consumed);
      requireThat(consumed.kind === "consumption", SESSION);
      const digest = sha256Canonical(consumed);
      requireThat(graph.has(digest) && equal(graph.get(digest).value, consumed), SESSION);
      const authorization = graph.get(consumed.authorizationDigest)?.value;
      requireThat(
        authorization?.payload &&
          name ===
            `${consumed.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json` &&
          authorization.payload.requestDigest === consumed.requestDigest,
        SESSION
      );
      validateContract(authorization.payload.schemaVersion, authorization);
      slots.set(digest, consumed);
    }
    for (const consumed of values.filter((value) => value.kind === "consumption")) {
      const digest = sha256Canonical(consumed),
        request = graph.get(consumed.requestDigest)?.value;
      requireThat(
        slots.has(digest) &&
          request &&
          consumed.requestDigest === sha256Canonical(request) &&
          consumed.profileDigest === request.profileDigest,
        SESSION
      );
      for (const field of ["sessionId", "sessionNonce", "operationId", "idempotencyKey", "stage"])
        requireThat(consumed[field] === request[field], SESSION);
      const r3Request = request.schemaVersion === "manual-runner-request.v4";
      if (r3Request) validateManualTargetCreationRequest(request);
      else {
        requireThat(request.schemaVersion === "manual-runner-request.v1", SESSION);
        validateManualRunnerRequest(request);
      }
      const allocation = graph.get(request.attemptAllocationDigest)?.value;
      requireThat(allocation, REQUIRED);
      validateContract(
        r3Request ? "manual-runner-evidence.v2" : "manual-runner-evidence.v1",
        allocation
      );
      requireThat(
        allocation.kind === "attempt-allocation" &&
          allocation.profileDigest === consumed.profileDigest &&
          allocation.sessionId === consumed.sessionId &&
          allocation.sessionNonce === consumed.sessionNonce &&
          (!r3Request || allocation.sessionRecordDigest === consumed.sessionRecordDigest) &&
          allocation.operationId === request.operationId &&
          allocation.attemptId === request.attemptId &&
          allocation.runId === request.runId,
        SESSION
      );
      const session = graph.get(consumed.sessionRecordDigest)?.value;
      requireThat(session, REQUIRED);
      validateContract(consumed.schemaVersion, session);
      requireThat(
        session.kind === "session" &&
          session.status === "OPEN" &&
          session.profileDigest === consumed.profileDigest &&
          session.sessionId === consumed.sessionId &&
          session.sessionNonce === consumed.sessionNonce,
        SESSION
      );
      const linked = values.filter(
        (value) => value.kind === "execution" && value.requestDigest === consumed.requestDigest
      );
      requireThat(linked.length >= 1 && linked.length <= (r3Request ? 2 : 1), SESSION);
      const execution = r3Request
        ? linked.find((value) => value.status === "INTERRUPTED_UNKNOWN")
        : linked[0];
      requireThat(execution, SESSION);
      validateContract(consumed.schemaVersion, execution);
      requireThat(
        execution.consumptionRecordDigest === digest &&
          execution.authorizationDigest === consumed.authorizationDigest &&
          execution.profileDigest === consumed.profileDigest &&
          execution.sessionId === consumed.sessionId &&
          execution.sessionNonce === consumed.sessionNonce &&
          execution.operationId === request.operationId &&
          execution.attemptId === request.attemptId,
        SESSION
      );
      if (r3Request) {
        r3Count++;
        const authorization = graph.get(consumed.authorizationDigest)?.value;
        const liveRevocations = await revocations();
        requireThat(
          liveRevocations[consumed.revocationSequence] &&
            sha256Canonical(liveRevocations[consumed.revocationSequence]) ===
              consumed.revocationRecordDigest &&
            !liveRevocations.some(
              (record) =>
                record.action === "REVOKE_PROFILE" ||
                (record.action === "REVOKE_AUTHORIZATION" &&
                  record.authorizationId === authorization.payload.authorizationId)
            ),
          REVOCATION
        );
        requireThat(
          consumed.schemaVersion === "manual-operation-record.v3" &&
            consumed.sessionId === sessionId &&
            consumed.sessionNonce === sessionNonce &&
            consumed.profileDigest === profileDigest &&
            consumed.stage === "target-create" &&
            consumed.operationId === r3Context.creationSpec.operationRef &&
            consumed.sessionRecordDigest === sha256Canonical(current) &&
            equal(session.scope, identity.scope) &&
            request.sessionId === sessionId &&
            request.sessionNonce === sessionNonce &&
            request.operationId === consumed.operationId &&
            request.stage === "target-create" &&
            request.attemptAllocationDigest === sha256Canonical(allocation) &&
            allocation.sessionRecordDigest === consumed.sessionRecordDigest &&
            execution.status === "INTERRUPTED_UNKNOWN" &&
            execution.predecessorExecutionRecordDigest === null &&
            execution.startedAt === null &&
            execution.finishedAt === null &&
            execution.resultDigest === null &&
            execution.processEvidenceDigest === null,
          SESSION
        );
        requireThat(
          authorization?.payload?.schemaVersion === "manual-launch-authorization.v4" &&
            authorization.payload.authorizationId &&
            authorization.payload.requestDigest === consumed.requestDigest &&
            authorization.payload.sessionId === sessionId &&
            authorization.payload.sessionNonce === sessionNonce &&
            authorization.payload.operationId === request.operationId &&
            authorization.payload.idempotencyKey === request.idempotencyKey &&
            authorization.payload.profileDigest === profileDigest &&
            authorization.payload.ownerId === profile.ownerId &&
            authorization.payload.stage === "target-create" &&
            authorization.payload.creationSpecDigest === identity.scope.creationSpecDigest &&
            authorization.payload.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
            authorization.payload.targetPolicyDigest === identity.scope.targetPolicyDigest &&
            cryptoVerify(
              null,
              Buffer.concat([
                Buffer.from("subscription-saas/manual-launch/v1\n"),
                encodeManualJson(authorization.payload)
              ]),
              createPublicKey(profile.publicKeyPem),
              Buffer.from(authorization.signature, "base64")
            ),
          SESSION
        );
        const linkedDigest = sha256Canonical(execution);
        let original;
        if (linked.length === 2) {
          const completed = linked.find((value) => value !== execution);
          requireThat(
            completed?.status === "SUCCEEDED" &&
              completed.stage === "target-create" &&
              completed.predecessorExecutionRecordDigest === linkedDigest &&
              completed.consumptionRecordDigest === digest &&
              completed.authorizationDigest === consumed.authorizationDigest &&
              completed.profileDigest === profileDigest &&
              completed.sessionId === sessionId &&
              completed.sessionNonce === sessionNonce &&
              completed.operationId === request.operationId &&
              completed.idempotencyKey === request.idempotencyKey &&
              completed.attemptId === request.attemptId &&
              completed.startedAt === execution.recordedAt,
            SESSION
          );
          original = await r3StoredDestination(graph, completed.resultDigest, execution);
          requireThat(
            completed.processEvidenceDigest === original.observationDigest &&
              instant(completed.finishedAt) >= instant(original.destination.observedAt) &&
              instant(completed.recordedAt) >= instant(completed.finishedAt),
            SESSION
          );
          const completedBytes = encodeManualJson(completed);
          for (const role of ["journal", "archive", "backup"])
            requireThat(
              (
                await store.read(
                  objectPath(profile.storage[`${role}Root`], sha256Canonical(completed))
                )
              ).equals(completedBytes),
              STORAGE
            );
          const expected = new Set(
            [completed.resultDigest, completed.processEvidenceDigest].flatMap((subject) =>
              ["archive", "backup"].map((role) => `${subject}:${role}`)
            )
          );
          const custody = values.filter(
            (value) =>
              value.kind === "custody" &&
              value.schemaVersion === "manual-operation-record.v3" &&
              [completed.resultDigest, completed.processEvidenceDigest].includes(
                value.subjectDigest
              )
          );
          requireThat(custody.length === 4, SESSION);
          for (const value of custody) {
            const pair = `${value.subjectDigest}:${value.storageRole}`;
            requireThat(
              expected.delete(pair) &&
                value.profileDigest === profileDigest &&
                value.ownerId === profile.ownerId &&
                value.subjectType === "record" &&
                value.purpose === `${value.storageRole}-readback` &&
                value.outcome === "MATCH" &&
                value.observedDigest === value.subjectDigest &&
                value.retentionDays === 90 &&
                instant(value.observedAt) <= instant(completed.recordedAt),
              SESSION
            );
          }
          requireThat(expected.size === 0, SESSION);
        } else {
          requireThat(
            pendingDigest === linkedDigest &&
              pendingDestination?.destination.initialExecutionRecordDigest === linkedDigest,
            SESSION
          );
          original = pendingDestination;
        }
        r3Originals.artifacts.add(original.destinationDigest);
        r3Originals.artifacts.add(original.observationDigest);
        r3Originals.raws.add(original.streamDigest);
        r3Validated.add(digest);
        continue;
      }
      requireThat(
        profile.allowedTargets.some(
          (target) =>
            target.endpointPolicyId === request.targetIntent.endpointPolicyId &&
            target.databaseName === request.targetIntent.databaseName
        ),
        SESSION
      );
      legacy.push({ request, consumed, execution });
    }
    for (const { request: oldRequest, consumed, execution } of legacy) {
      if (execution.status === "INTERRUPTED_UNKNOWN") continue;
      const assessment = assessManualRunnerEvidence(
        await archiveInput(oldRequest, graph, consumed, r3Validated, r3Originals)
      );
      requireThat(assessment.executionStatus === execution.status, SESSION);
      if (execution.status === "SUCCEEDED")
        requireThat(assessment.proofDigest === execution.resultDigest, SESSION);
    }
    for (const execution of values.filter(
      (value) => value.kind === "execution" && value.profileDigest === profileDigest
    ))
      requireThat(slots.has(execution.consumptionRecordDigest), SESSION);
    for (const execution of values.filter(
      (value) => value.kind === "execution" && value.schemaVersion === "manual-operation-record.v3"
    ))
      requireThat(
        r3Validated.has(execution.consumptionRecordDigest) &&
          execution.requestDigest === slots.get(execution.consumptionRecordDigest)?.requestDigest,
        SESSION
      );
    requireThat(r3Count <= 1, SESSION);
    // Reuse the existing R2 reducer, including its independent reconcile
    // readback. An original apply UNKNOWN stays in the graph after resolution.
    for (const historicalTarget of profile.allowedTargets)
      await history(request, null, historicalTarget, r3Validated, r3Originals);
    // A consumed target-create slot is never authorization to sign another one.
    requireThat(r3Count === 0 || pendingDigest !== null, SESSION);
    return graph;
  }
  try {
    try {
      lockHandle = await store.fs.open(lockPath, "wx", 0o600);
    } catch {
      fail(SESSION);
    }
    await store.setNewOwner(lockPath);
    await lockHandle.writeFile(lockBytes);
    await lockHandle.sync();
    requireThat((await store.read(lockPath)).equals(lockBytes), STORAGE);
    if (r3) {
      try {
        observerLockHandle = await store.fs.open(observerLockPath, "wx", 0o600);
      } catch {
        fail(SESSION);
      }
      await store.setNewOwner(observerLockPath);
      await observerLockHandle.writeFile(lockBytes);
      await observerLockHandle.sync();
      requireThat((await store.read(observerLockPath)).equals(lockBytes), STORAGE);
    }
    await revocations();
    current = sessionRecord("OPEN", null, null, openedAt);
    await store.put(current, "journal");
  } catch (error) {
    if (observerLockHandle) {
      await observerLockHandle.close().catch(() => {});
      await store.fs.unlink(observerLockPath).catch(() => {});
    }
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      await store.fs.unlink(lockPath).catch(() => {});
    }
    throw error;
  }
  if (r3) {
    let consumedOrUncertain = false,
      creationReceipt = null,
      targetLocksAttempted = false,
      completionAttempted = false,
      closeRef = null;
    return freeze({
      ...identity,
      sign(input) {
        return serial(async () => {
          await active();
          r3Live();
          const request = await r3CheckedRequest(input);
          await r3History(request.request);
          const issuedAt = stamp(),
            ctx = await context(request.request),
            expiresAt = new Date(
              Math.min(
                instant(profile.expiresAt),
                instant(r3Context.jobAdmission.expiresAt),
                instant(issuedAt) + 300000
              )
            ).toISOString();
          requireThat(instant(issuedAt) < instant(expiresAt), "MANUAL_TIME_INVALID");
          const authorization = signManualAuthorization({
            payload: {
              schemaVersion: "manual-launch-authorization.v4",
              authorizationId: randomUUID(),
              issuedAt,
              expiresAt,
              requestDigest: sha256Bytes(request.canonicalBytes),
              ...request.binding
            },
            privateKey: key
          });
          verify(authorization, request, ctx);
          await store.put(authorization);
          issued.set(authorization.payload.authorizationId, sha256Canonical(authorization));
          return freeze(authorization);
        });
      },
      consume(input) {
        return serial(async () => {
          await active();
          r3Live();
          exact(input, ["authorization", "request"]);
          const authorization = snapshot(input.authorization),
            request = await r3CheckedRequest(input.request);
          await unused(authorization.payload.authorizationId);
          await r3History(request.request);
          const ctx = await context(request.request),
            parentDecision = verify(authorization, request, ctx);
          requireThat(
            issued.get(authorization.payload.authorizationId) === sha256Canonical(authorization),
            SESSION
          );
          requireThat(
            (
              await store.read(
                objectPath(profile.storage.archiveRoot, sha256Canonical(authorization))
              )
            ).equals(encodeManualJson(authorization)),
            STORAGE
          );
          const consumption = {
            ...common("consumption", stamp()),
            sessionId,
            sessionNonce,
            operationId: request.binding.operationId,
            idempotencyKey: request.binding.idempotencyKey,
            ownerId: profile.ownerId,
            authorizationDigest: sha256Canonical(authorization),
            requestDigest: sha256Bytes(request.canonicalBytes),
            stage: "target-create",
            sessionRecordDigest: sha256Canonical(current),
            revocationRecordDigest: ctx.revocation.headDigest,
            revocationSequence: ctx.revocation.records.at(-1).sequence,
            status: "CONSUMED"
          };
          validateContract(recordSchema, consumption);
          // Once create-only slot insertion begins, every failure retains both
          // forward slots. A missing execution is reconstructed as uncertainty.
          consumedOrUncertain = true;
          await store.create(
            consumptionSlot(authorization.payload.authorizationId),
            encodeManualJson(consumption),
            "MANUAL_AUTHORIZATION_CONSUMED"
          );
          await store.put(consumption, "journal");
          const readback = await consumptionReadback(consumption);
          const execution = {
            ...common("execution", stamp()),
            stage: "target-create",
            sessionId,
            sessionNonce,
            operationId: request.request.operationId,
            idempotencyKey: request.request.idempotencyKey,
            attemptId: request.request.attemptId,
            requestDigest: consumption.requestDigest,
            authorizationDigest: consumption.authorizationDigest,
            consumptionRecordDigest: sha256Canonical(consumption),
            predecessorExecutionRecordDigest: null,
            startedAt: null,
            finishedAt: null,
            status: "INTERRUPTED_UNKNOWN",
            reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
            resultDigest: null,
            processEvidenceDigest: null
          };
          validateContract(recordSchema, execution);
          const executionRef = await store.put(execution, "journal");
          requireThat(
            (
              await store.read(objectPath(profile.storage.journalRoot, executionRef.recordDigest))
            ).equals(encodeManualJson(execution)),
            STORAGE
          );
          requireThat(
            (await store.read(consumptionSlot(authorization.payload.authorizationId))).equals(
              encodeManualJson(consumption)
            ),
            STORAGE
          );
          const final = await context(request.request);
          verify(authorization, request, final);
          creationReceipt = freeze({
            stage: "target-create",
            parentDecision,
            consumptionReadbackDigest: readback.recordDigest,
            executionRecordDigest: executionRef.recordDigest
          });
          return creationReceipt;
        });
      },
      holdTargets(input) {
        return serial(async () => {
          await active();
          r3Live();
          requireThat(creationReceipt && !targetLocksAttempted, SESSION);
          exact(input, ["engineId", "systemIdentifier", "targets"]);
          const plan = planManualR3TargetLocks({
            operationRef: r3Context.creationSpec.operationRef,
            ...snapshot(input)
          });
          targetLocksAttempted = true;
          for (const entry of plan.entries) {
            const file = path.join(
              profile.storage.journalRoot,
              "locks",
              `${entry.lockDigest.slice(7)}.json`
            );
            const bytes = encodeManualJson({
              ...identity,
              pid: process.pid,
              operationRef: plan.operationRef,
              executionRecordDigest: creationReceipt.executionRecordDigest,
              databaseName: entry.databaseName,
              target: entry.identity
            });
            let handle;
            try {
              await store.checkedPath(path.dirname(file));
              handle = await store.fs.open(file, "wx", 0o600);
            } catch {
              fail(SESSION);
            }
            // Retain every successfully created pathname, including a partial
            // write, until the later verified cleanup path resolves UNKNOWN.
            targetLocks.set(entry.lockDigest, { file, bytes, handle });
            await store.setNewOwner(file);
            await handle.writeFile(bytes);
            await handle.sync();
            requireThat((await store.read(file)).equals(bytes), STORAGE);
          }
          await active();
          r3Live();
          return Object.freeze({
            locks: plan.entries,
            // This checks exclusion only, not H1/job/destination authority.
            recheck: () =>
              serial(async () => {
                await active();
                r3Live();
              })
          });
        });
      },
      completeCreation(input) {
        return serial(async () => {
          await active();
          r3Live();
          exact(input, ["destinationDigest"], SESSION);
          requireThat(
            /^sha256:[0-9a-f]{64}$/u.test(input.destinationDigest) &&
              r3Context.destinationInputs &&
              creationReceipt &&
              targetLocksAttempted &&
              !completionAttempted,
            SESSION
          );
          completionAttempted = true;
          const graph = await store.objects();
          const initial = graph.get(creationReceipt.executionRecordDigest)?.value;
          requireThat(initial?.kind === "execution", SESSION);
          const request = graph.get(initial.requestDigest)?.value;
          requireThat(request?.schemaVersion === "manual-runner-request.v4", SESSION);
          const original = await r3StoredDestination(graph, input.destinationDigest, initial);
          await r3History(request, creationReceipt.executionRecordDigest, original);
          const consumed = graph.get(initial.consumptionRecordDigest)?.value;
          requireThat(
            consumed?.kind === "consumption" &&
              consumed.requestDigest === sha256Canonical(request) &&
              consumed.authorizationDigest === initial.authorizationDigest &&
              consumed.sessionId === sessionId &&
              consumed.sessionNonce === sessionNonce,
            SESSION
          );
          const authorization = graph.get(consumed.authorizationDigest)?.value;
          requireThat(
            (await store.read(consumptionSlot(authorization.payload.authorizationId))).equals(
              encodeManualJson(consumed)
            ),
            STORAGE
          );
          const records = await revocations();
          requireThat(
            records[consumed.revocationSequence] &&
              sha256Canonical(records[consumed.revocationSequence]) ===
                consumed.revocationRecordDigest &&
              !records.some(
                (record) =>
                  record.action === "REVOKE_PROFILE" ||
                  (record.action === "REVOKE_AUTHORIZATION" &&
                    record.authorizationId === authorization.payload.authorizationId)
              ),
            REVOCATION
          );
          const custodyRecordDigests = [];
          for (const subjectDigest of [original.observationDigest, original.destinationDigest]) {
            const subject = graph.get(subjectDigest)?.value;
            requireThat(subject && !subject.kind && !subject.payload, EVIDENCE);
            for (const role of ["archive", "backup"]) {
              const bytes = await store.read(
                objectPath(profile.storage[`${role}Root`], subjectDigest)
              );
              requireThat(
                sha256Bytes(bytes) === subjectDigest && bytes.equals(encodeManualJson(subject)),
                STORAGE
              );
              const readAt = stamp();
              const custody = {
                ...common("custody", readAt),
                ownerId: profile.ownerId,
                subjectDigest,
                subjectType: "record",
                purpose: `${role}-readback`,
                outcome: "MATCH",
                observedDigest: subjectDigest,
                observedAt: readAt,
                storageRole: role,
                retentionDays,
                reasonCode: null
              };
              validateContract(recordSchema, custody);
              custodyRecordDigests.push((await store.put(custody)).recordDigest);
            }
          }
          await active();
          r3Live();
          const finalRevocations = await revocations();
          requireThat(
            !finalRevocations.some(
              (record) =>
                record.action === "REVOKE_PROFILE" ||
                (record.action === "REVOKE_AUTHORIZATION" &&
                  record.authorizationId === authorization.payload.authorizationId)
            ),
            REVOCATION
          );
          const finishedAt = stamp();
          requireThat(instant(finishedAt) >= instant(original.destination.observedAt), SESSION);
          const execution = {
            ...common("execution", finishedAt),
            stage: "target-create",
            sessionId,
            sessionNonce,
            operationId: initial.operationId,
            idempotencyKey: initial.idempotencyKey,
            attemptId: initial.attemptId,
            requestDigest: initial.requestDigest,
            authorizationDigest: initial.authorizationDigest,
            consumptionRecordDigest: initial.consumptionRecordDigest,
            predecessorExecutionRecordDigest: creationReceipt.executionRecordDigest,
            startedAt: initial.recordedAt,
            finishedAt,
            status: "SUCCEEDED",
            reasonCode: null,
            resultDigest: original.destinationDigest,
            processEvidenceDigest: original.observationDigest
          };
          validateContract(recordSchema, execution);
          const executionDigest = sha256Canonical(execution);
          await store.put(execution, "journal");
          await store.put(execution);
          await store.create(
            objectPath(profile.storage.backupRoot, executionDigest),
            encodeManualJson(execution)
          );
          for (const role of ["journal", "archive", "backup"])
            requireThat(
              (
                await store.read(objectPath(profile.storage[`${role}Root`], executionDigest))
              ).equals(encodeManualJson(execution)),
              STORAGE
            );
          await r3History(request, creationReceipt.executionRecordDigest);
          return freeze({ executionRecordDigest: executionDigest, custodyRecordDigests });
        });
      },
      record(kind, input) {
        return serial(async () => {
          await active();
          r3Live();
          requireThat(kind === "revocation", EVIDENCE);
          const value = snapshot(input),
            records = await revocations(),
            head = records.at(-1);
          validateContract("manual-operation-record.v2", value);
          requireThat(
            value.kind === kind &&
              value.profileDigest === profileDigest &&
              value.ownerId === profile.ownerId &&
              value.action !== "GENESIS" &&
              value.sequence === head.sequence + 1 &&
              value.previousRevocationDigest === sha256Canonical(head) &&
              instant(head.recordedAt) <= instant(value.recordedAt) &&
              instant(value.recordedAt) <= instant(stamp()),
            REVOCATION
          );
          const ref = await store.put(value, "journal");
          await store.create(
            path.join(
              profile.storage.journalRoot,
              "revocations",
              `${profileDigest.slice(7)}-${value.sequence}.json`
            ),
            encodeManualJson(value)
          );
          await revocations();
          return ref;
        });
      },
      close() {
        return serial(async () => {
          if (closed) return closeRef;
          try {
            await active();
            const uncertain = consumedOrUncertain;
            const value = sessionRecord(
              uncertain ? "INTERRUPTED_UNKNOWN" : "CLOSED",
              sha256Canonical(current),
              uncertain ? "MANUAL_EVIDENCE_INCOMPLETE" : null,
              stamp()
            );
            closeRef = await store.put(value, "journal");
            current = value;
            closed = true;
            key = null;
            await closeTargetHandles();
            await observerLockHandle.close();
            await lockHandle.close();
            observerLockHandle = null;
            lockHandle = null;
            if (!uncertain) {
              await store.fs.unlink(observerLockPath);
              await store.fs.unlink(lockPath);
            }
            return closeRef;
          } catch (error) {
            consumedOrUncertain = true;
            closed = true;
            key = null;
            await closeTargetHandles().catch(() => {});
            await observerLockHandle?.close().catch(() => {});
            await lockHandle?.close().catch(() => {});
            observerLockHandle = null;
            lockHandle = null;
            throw error;
          }
        });
      }
    });
  }
  return freeze({
    ...identity,
    sign(input) {
      return serial(async () => {
        await active();
        const request = await checkedRequest(input);
        const graph = await history(request.request);
        await preflightRequest(request.request, graph);
        const issuedAt = stamp(),
          ctx = await context(request.request);
        const expiresAt = new Date(
          Math.min(instant(profile.expiresAt), instant(issuedAt) + 300000)
        ).toISOString();
        requireThat(instant(issuedAt) < instant(expiresAt), "MANUAL_TIME_INVALID");
        const authorization = signManualAuthorization({
          payload: {
            schemaVersion: "manual-launch-authorization.v1",
            authorizationId: randomUUID(),
            issuedAt,
            expiresAt,
            requestDigest: sha256Bytes(request.canonicalBytes),
            ...request.binding
          },
          privateKey: key
        });
        verify(authorization, request, ctx);
        await store.put(authorization);
        issued.set(authorization.payload.authorizationId, sha256Canonical(authorization));
        return freeze(authorization);
      });
    },
    consume(input) {
      return serial(async () => {
        await active();
        stamp();
        exact(
          input,
          input?.request?.binding?.stage === "runner-command"
            ? ["authorization", "request", "childObservation"]
            : ["authorization", "request"]
        );
        const authorization = snapshot(input.authorization),
          request = await checkedRequest(input.request);
        await unused(authorization.payload.authorizationId);
        const graph = await history(request.request);
        await preflightRequest(request.request, graph);
        const ctx = await context(request.request),
          parentDecision = verify(authorization, request, ctx);
        requireThat(
          issued.get(authorization.payload.authorizationId) === sha256Canonical(authorization),
          SESSION
        );
        requireThat(
          (
            await store.read(
              objectPath(profile.storage.archiveRoot, sha256Canonical(authorization))
            )
          ).equals(encodeManualJson(authorization)),
          STORAGE
        );
        if (request.request.stage === "runner-command") {
          exact(input.childObservation, ["containerId", "runnerImageDigest", "childChallenge"]);
          for (const field of ["containerId", "runnerImageDigest", "childChallenge"])
            requireThat(input.childObservation[field] === request.request[field]);
        }
        const consumption = {
          ...common("consumption", stamp()),
          sessionId,
          sessionNonce,
          operationId: request.binding.operationId,
          idempotencyKey: request.binding.idempotencyKey,
          ownerId: profile.ownerId,
          authorizationDigest: sha256Canonical(authorization),
          requestDigest: sha256Bytes(request.canonicalBytes),
          stage: request.binding.stage,
          sessionRecordDigest: sha256Canonical(current),
          revocationRecordDigest: ctx.revocation.headDigest,
          revocationSequence: ctx.revocation.records.at(-1).sequence,
          status: "CONSUMED"
        };
        validateContract(recordSchema, consumption);
        try {
          await store.create(
            consumptionSlot(authorization.payload.authorizationId),
            encodeManualJson(consumption),
            "MANUAL_AUTHORIZATION_CONSUMED"
          );
          await store.put(consumption, "journal");
          const readback = await consumptionReadback(consumption);
          // Complete the potentially expensive all-history proof before starting
          // the short receipt window. The lock, slot, revocation and receipt are
          // still independently checked at the actual capability-release boundary.
          await history(request.request, consumption.requestDigest);
          let handoffReceipt = null;
          if (request.request.stage === "runner-command") {
            const issuedAt = stamp(),
              expiresAt = new Date(
                Math.min(instant(authorization.payload.expiresAt), instant(issuedAt) + 30000)
              ).toISOString();
            requireThat(instant(issuedAt) < instant(expiresAt), "MANUAL_TIME_INVALID");
            const receipt = {
              ...common("consumption-handoff", issuedAt),
              sessionId,
              sessionNonce,
              operationId: request.binding.operationId,
              idempotencyKey: request.binding.idempotencyKey,
              authorizationDigest: consumption.authorizationDigest,
              requestDigest: consumption.requestDigest,
              containerId: request.request.containerId,
              runnerImageDigest: request.request.runnerImageDigest,
              childChallenge: request.request.childChallenge,
              consumptionRecordDigest: sha256Canonical(consumption),
              consumptionReadbackDigest: readback.recordDigest,
              revocationSequence: consumption.revocationSequence,
              issuedAt,
              expiresAt
            };
            const signature = cryptoSign(
              null,
              Buffer.concat([
                Buffer.from("subscription-saas/manual-consumption/v1\n"),
                encodeManualJson(receipt)
              ]),
              key
            ).toString("base64");
            handoffReceipt = { ...receipt, signature };
            verifyManualHandoff({
              authorization,
              receipt: handoffReceipt,
              profile,
              request: { binding: request.binding, canonicalBytes: request.canonicalBytes },
              childObservation: input.childObservation,
              now: stamp()
            });
            const ref = await store.put(handoffReceipt);
            requireThat(
              (await store.read(objectPath(profile.storage.archiveRoot, ref.recordDigest))).equals(
                encodeManualJson(handoffReceipt)
              ),
              STORAGE
            );
            const readAt = stamp();
            await store.put({
              ...common("custody", readAt),
              ownerId: profile.ownerId,
              subjectDigest: ref.recordDigest,
              subjectType: "record",
              purpose: "handoff-readback",
              outcome: "MATCH",
              observedDigest: ref.recordDigest,
              observedAt: readAt,
              storageRole: "archive",
              retentionDays,
              reasonCode: null
            });
          }
          requireThat(
            (await store.read(consumptionSlot(authorization.payload.authorizationId))).equals(
              encodeManualJson(consumption)
            ),
            STORAGE
          );
          const final = await context(request.request);
          verify(authorization, request, final);
          if (handoffReceipt)
            verifyManualHandoff({
              authorization,
              receipt: handoffReceipt,
              profile,
              request: { binding: request.binding, canonicalBytes: request.canonicalBytes },
              childObservation: input.childObservation,
              now: stamp()
            });
          return handoffReceipt
            ? freeze({ stage: "runner-command", parentDecision, handoffReceipt })
            : freeze({
                stage: "target-observe",
                parentDecision,
                consumptionReadbackDigest: readback.recordDigest
              });
        } catch (error) {
          // An exclusive-create failure may already have left bytes. Never retry
          // the slot or the receipt; recover only the original allocated attempt.
          await retainPending().catch(() => {});
          throw error;
        }
      });
    },
    record(kind, input) {
      return serial(() => recordValue(kind, input));
    },
    close() {
      return serial(async () => {
        await active();
        const value = sessionRecord("CLOSED", sha256Canonical(current), null, stamp());
        try {
          await retainPending();
          const ref = await store.put(value, "journal");
          current = value;
          closed = true;
          key = null;
          await lockHandle.close();
          lockHandle = null;
          await store.fs.unlink(lockPath);
          return ref;
        } catch (error) {
          const unknown = sessionRecord(
            "INTERRUPTED_UNKNOWN",
            sha256Canonical(current),
            "MANUAL_STORAGE_UNVERIFIED",
            stamp()
          );
          await store.put(unknown, "journal").catch(() => {});
          current = unknown;
          closed = true;
          key = null;
          await lockHandle?.close().catch(() => {});
          lockHandle = null;
          // The lock pathname remains as durable uncertainty; do not advertise
          // a closed session or make another parent silently reclaim it.
          throw error;
        }
      });
    }
  });
}
