import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkR3ConnectedWindow,
  connectedChildTimeout,
  connectedChildSignal,
  connectedStopReason,
  settledR3ExecFile
} from "./r3-connected-window.mjs";
import {
  assertR3StartupActive,
  currentR3StartupScope,
  settledR3StartupExecFile
} from "./r3-startup-deadline.mjs";
import {
  inheritR3FailureCause,
  markR3FailureCause,
  markR3JobAdmissionCause
} from "./r3-failure-diagnostic.mjs";
import { runR3StartupTiming } from "./r3-startup-detail-timing.mjs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  validateContract,
  computeRepositoryContract,
  computeMigrationCatalog,
  openManualSession
} from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity, assertProofCustody } from "./verify-build-proof.mjs";
import { validateH1SnapshotPublicKeyReadbacks } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import {
  verifyR3WorkspaceBinding,
  assessR3WorkspaceReport
} from "../../packages/release-foundation/src/r3-workspace-report.mjs";
import {
  verifyR3HostedEvidence,
  verifyR3HostedCleanupEvidence
} from "../../packages/release-foundation/src/r3-hosted-evidence.mjs";
import {
  approvedR3HistoricalSourceBinding,
  approvedR3HistoricalContractCompatibility
} from "../../packages/release-foundation/src/manual-r3-incident.mjs";

const LIMIT = 1048576;
const H1 = "H1_INPUT_UNAVAILABLE";
const OPERATION = "MANUAL_OPERATION_INPUT_UNAVAILABLE";
const PUBLIC_INPUT = "H1_SNAPSHOT_PUBLIC_INPUT_UNAVAILABLE";
const BUILD = "TRUSTED_BUILD_UNAVAILABLE";
const CUSTODY_REQUIRED = "MANUAL_BUILD_CUSTODY_INPUT_REQUIRED";
const PROFILE = "release/contracts/manual-stage1-profile.v2.json";
const OWNER = "release/contracts/manual-stage1-owner-binding.v1.json";
const ROOTS = ["keyRoot", "journalRoot", "archiveRoot", "backupRoot", "credentialRoot"];
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPOSITORY = "keqi119/subscription-Saas";
const fixedR3JobOwners = new WeakMap();
const WORKFLOW = ".github/workflows/docker-images.yml";
const ISSUER = "https://token.actions.githubusercontent.com";
const SYSTEM = "C:\\Windows\\System32\\";
const SYSTEM_WRITERS = new Set([
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
]);
const CUSTODY_POLICY = Object.freeze({
  owner: "release-engineering",
  readers: Object.freeze(["release", "qa", "security", "audit"]),
  retentionDays: 90,
  expiryDisposition: "review",
  receiptContract: "custody-receipt.retention90.v1"
});
const fail = (code = H1) => {
  throw Object.assign(new Error(code), { code });
};
const failWithCause = (code, cause) => {
  throw inheritR3FailureCause(Object.assign(new Error(code), { code }), cause);
};
const requireThat = (condition, code = H1) => {
  if (!condition) fail(code);
};
const equal = (left, right) => encodeManualJson(left).equals(encodeManualJson(right));
function exact(value, keys) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
  requireThat(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && "value" in descriptor;
      })
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function instant(value) {
  const result = Date.parse(value);
  requireThat(
    typeof value === "string" && Number.isFinite(result) && new Date(result).toISOString() === value
  );
  return result;
}
function absolute(file) {
  const paths = pathStyle(file);
  requireThat(
    typeof file === "string" &&
      paths.isAbsolute(file) &&
      paths.normalize(file) === file &&
      !file.includes("\0")
  );
  return file;
}
function pathStyle(file) {
  return process.platform === "win32" && /^[A-Za-z]:\\/u.test(file ?? "") ? path.win32 : path;
}
function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
function sameIdentity(left, right, contents = true) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    (left.nlink === right.nlink || (!contents && left.isDirectory() && right.isDirectory())) &&
    (!contents ||
      (left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs))
  );
}
async function checkedPath(file, { principal, privateRoot, sourceRoot, system = false } = {}) {
  absolute(file);
  const paths = pathStyle(file);
  const segments = [];
  let current = paths.parse(file).root;
  for (const segment of file.slice(current.length).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    const real = await fs.realpath(current);
    requireThat(
      !stat.isSymbolicLink() &&
        (process.platform === "win32"
          ? real.toLowerCase() === current.toLowerCase()
          : real === current)
    );
    const isPrivate = privateRoot && within(privateRoot, current);
    const isSource = sourceRoot && within(sourceRoot, current);
    if (process.platform === "win32") {
      if (system || isPrivate || isSource || (current === file && principal))
        await windowsAcl(current, { principal, privateOnly: Boolean(isPrivate), system });
    } else if (isPrivate || isSource || (current === file && principal)) {
      requireThat(
        process.platform === "linux" &&
          principal?.platform === "posix" &&
          stat.uid === BigInt(principal.uid)
      );
      requireThat((stat.mode & BigInt(isPrivate ? 0o077 : 0o022)) === 0n);
    }
    segments.push({ path: current, stat, isPrivate: Boolean(isPrivate) });
  }
  return segments;
}
async function processOutput(file, args, { timeout = 120000, maxBuffer = LIMIT, env } = {}) {
  checkR3ConnectedWindow();
  timeout = connectedChildTimeout(timeout);
  const startup = currentR3StartupScope(),
    startupActive = Boolean(startup && !startup.connected),
    options = {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      timeout,
      ...(connectedChildSignal() ? { signal: connectedChildSignal() } : {}),
      maxBuffer,
      ...(env ? { env } : {})
    };
  if (startupActive) assertR3StartupActive();
  const result = startupActive
    ? await settledR3StartupExecFile(file, args, options)
    : await settledR3ExecFile(file, args, options);
  if (startupActive) assertR3StartupActive();
  if (result.error) {
    if (result.error.code === "ABORT_ERR" && connectedStopReason())
      markR3FailureCause(result.error, connectedStopReason());
    throw result.error;
  }
  checkR3ConnectedWindow();
  const stdout = Buffer.from(result.stdout),
    stderr = Buffer.from(result.stderr);
  requireThat(stdout.length <= maxBuffer && stderr.length <= maxBuffer);
  return stdout;
}
async function windowsAcl(file, { principal, privateOnly, system }) {
  await processOutput(`${SYSTEM}icacls.exe`, [file], { timeout: 5000, maxBuffer: 8192 });
  const literal = `'${file.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath ${literal}; [Console]::WriteLine($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); foreach($e in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [Console]::WriteLine($e.IdentityReference.Value+'|'+$e.AccessControlType+'|'+[int]$e.FileSystemRights) }; [Console]::WriteLine('attributes|'+[int][System.IO.File]::GetAttributes(${literal}))`;
  const bytes = await processOutput(
    `${SYSTEM}WindowsPowerShell\\v1.0\\powershell.exe`,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5000, maxBuffer: 8192 }
  );
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().split(/\r?\n/u);
  const owner = lines.shift(),
    attributes = lines.pop()?.match(/^attributes\|([0-9]+)$/u);
  requireThat(
    attributes &&
      Number.isSafeInteger(Number(attributes[1])) &&
      (Number(attributes[1]) & 1024) === 0
  );
  requireThat(lines.length > 0 && /^S-1-[0-9]+(?:-[0-9]+)+$/u.test(owner));
  const entries = lines.map((line) => {
    const match = line.match(/^(S-1-[0-9]+(?:-[0-9]+)+)\|(Allow|Deny)\|([0-9]+)$/u);
    requireThat(match && Number.isSafeInteger(Number(match[3])));
    return { sid: match[1], access: match[2], rights: Number(match[3]) };
  });
  const writeMask =
    0x0002 |
    0x0004 |
    0x0010 |
    0x0040 |
    0x0100 |
    0x10000 |
    0x40000 |
    0x80000 |
    0x40000000 |
    0x10000000;
  if (system) {
    requireThat(
      SYSTEM_WRITERS.has(owner) &&
        entries.every(
          (entry) =>
            entry.access === "Allow" &&
            ((entry.rights & writeMask) === 0 || SYSTEM_WRITERS.has(entry.sid))
        )
    );
  } else {
    requireThat(principal?.platform === "win32" && owner === principal.sid);
    requireThat(
      entries.every(
        (entry) =>
          entry.access === "Allow" &&
          (entry.sid === principal.sid || (!privateOnly && (entry.rights & writeMask) === 0))
      )
    );
    requireThat(
      entries.some((entry) => entry.sid === principal.sid && (entry.rights & 2032127) === 2032127)
    );
  }
}
async function readHandle(handle, limit = LIMIT, expected) {
  const before = await handle.stat({ bigint: true });
  requireThat(before.isFile() && before.nlink === 1n && before.size <= BigInt(limit));
  requireThat(!expected || sameIdentity(expected, before));
  const buffer = Buffer.alloc(Number(before.size) + 1);
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    requireThat(offset <= limit && BigInt(offset) === before.size);
    requireThat(sameIdentity(before, await handle.stat({ bigint: true })));
    return { bytes: Buffer.from(buffer.subarray(0, offset)), stat: before };
  } finally {
    buffer.fill(0);
  }
}
// Every read holds the original handle and independently reopens the fixed path.
// Private directory timestamps close rename-out-and-back (ABA) during a check;
// unrelated writes to public ancestors such as /tmp are not file authority.
async function openInput(file, options = {}) {
  const before = await checkedPath(file, options);
  const pathStat = before.at(-1)?.stat;
  requireThat(pathStat?.isFile() && pathStat.nlink === 1n && pathStat.size <= BigInt(LIMIT));
  const handle = await fs.open(file, "r");
  let initial;
  try {
    initial = await readHandle(handle, LIMIT, pathStat);
    requireThat(sameIdentity(before.at(-1).stat, initial.stat));
    const recheck = async () => {
      const after = await checkedPath(file, options);
      requireThat(
        after.length === before.length &&
          before.every(
            (entry, index) =>
              entry.path === after[index].path &&
              sameIdentity(
                entry.stat,
                after[index].stat,
                entry.isPrivate || index === before.length - 1
              )
          )
      );
      const held = await readHandle(handle, LIMIT, initial.stat);
      try {
        requireThat(sameIdentity(initial.stat, held.stat) && initial.bytes.equals(held.bytes));
      } finally {
        held.bytes.fill(0);
      }
      const independent = await fs.open(file, "r");
      let readback;
      try {
        readback = await readHandle(independent, LIMIT, initial.stat);
        requireThat(
          sameIdentity(initial.stat, readback.stat) && initial.bytes.equals(readback.bytes)
        );
      } finally {
        readback?.bytes.fill(0);
        await independent.close();
      }
    };
    await recheck();
    return { bytes: initial.bytes, recheck, close: () => handle.close() };
  } catch (error) {
    initial?.bytes.fill(0);
    await handle.close();
    throw error;
  }
}
function json(bytes, canonical = false) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const canonicalBytes = encodeManualJson(value);
  requireThat(canonicalBytes.length <= LIMIT && (!canonical || canonicalBytes.equals(bytes)));
  return value;
}
async function actualHost() {
  if (process.platform === "win32") {
    const executables = [
      `${SYSTEM}reg.exe`,
      `${SYSTEM}whoami.exe`,
      `${SYSTEM}icacls.exe`,
      `${SYSTEM}WindowsPowerShell\\v1.0\\powershell.exe`
    ];
    const snapshots = [];
    for (const file of executables) snapshots.push(await checkedPath(file, { system: true }));
    const regBytes = await processOutput(
      executables[0],
      ["QUERY", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { timeout: 5000, maxBuffer: 8192 }
    );
    const sidBytes = await processOutput(executables[1], ["/user", "/fo", "csv", "/nh"], {
      timeout: 5000,
      maxBuffer: 8192
    });
    const reg = new TextDecoder("utf-8", { fatal: true })
      .decode(regBytes)
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    requireThat(
      reg.length === 2 && reg[0] === "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography"
    );
    const guidMatch = reg[1].match(/^MachineGuid\s+REG_SZ\s+(\{?[0-9a-f-]+\}?)$/u);
    requireThat(guidMatch);
    const guidText = guidMatch[1];
    requireThat(guidText.startsWith("{") === guidText.endsWith("}"));
    const guid = guidText.replace(/^\{|\}$/gu, "");
    requireThat(UUID.test(guid));
    const sidText = new TextDecoder("utf-8", { fatal: true }).decode(sidBytes).trim();
    const sid = sidText.match(/^"[^"\r\n]+","(S-1-[0-9]+(?:-[0-9]+)+)"$/u)?.[1];
    requireThat(sid);
    for (let index = 0; index < executables.length; index++) {
      const after = await checkedPath(executables[index], { system: true });
      requireThat(
        snapshots[index].length === after.length &&
          snapshots[index].every((entry, i) => sameIdentity(entry.stat, after[i].stat))
      );
    }
    return {
      principal: { platform: "win32", sid },
      hostFingerprint: sha256Bytes(Buffer.from(`subscription-saas/win32-machine-guid/v1\n${guid}`))
    };
  }
  requireThat(process.platform === "linux" && typeof process.getuid === "function");
  const uid = process.getuid();
  requireThat(Number.isSafeInteger(uid) && uid >= 0);
  const handle = await fs.open("/etc/machine-id", "r");
  try {
    const { bytes } = await readHandle(handle, 8192);
    const machineId = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    requireThat(/^[0-9a-f]{32}$/u.test(machineId));
    return {
      principal: { platform: "posix", uid },
      hostFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)
      )
    };
  } finally {
    await handle.close();
  }
}
function validateOwner(value, binding = false) {
  exact(value, [
    "schemaVersion",
    "profileDigest",
    "ownerId",
    "principal",
    "hostFingerprint",
    "approvedAt",
    "promotionEligible",
    ...(binding ? ["approvalReference", "approvalDigest"] : [])
  ]);
  requireThat(
    value.schemaVersion === `manual-stage1-owner-${binding ? "binding" : "approval"}.v1` &&
      DIGEST.test(value.profileDigest) &&
      DIGEST.test(value.hostFingerprint) &&
      typeof value.ownerId === "string" &&
      value.ownerId.length > 0 &&
      value.ownerId.length <= 256 &&
      value.promotionEligible === false
  );
  exact(
    value.principal,
    value.principal?.platform === "posix" ? ["platform", "uid"] : ["platform", "sid"]
  );
  requireThat(
    value.principal.platform === "posix"
      ? Number.isSafeInteger(value.principal.uid) && value.principal.uid >= 0
      : value.principal.platform === "win32" &&
          /^S-1-[0-9]+(?:-[0-9]+)+$/u.test(value.principal.sid)
  );
  requireThat(instant(value.approvedAt) <= Date.now());
  if (binding)
    requireThat(
      DIGEST.test(value.approvalDigest) &&
        value.approvalReference === `inputs/h1/${value.approvalDigest.slice(7)}.approval.json`
    );
}

export async function loadFixedManualProfile(input) {
  return loadManualProfile(input, true);
}

// Only the historical reader below uses event-time profile validity. Live
// callers cannot select this policy through their input or exported API.
async function loadManualProfile(input, requireCurrentValidity) {
  const opened = [];
  try {
    exact(input, ["repoRoot"]);
    const repoRoot = absolute(input.repoRoot);
    const sourceOptions = {};
    const read = async (file, options) => {
      const item = await openInput(file, options);
      opened.push(item);
      return item.bytes;
    };
    const profile = json(await read(path.join(repoRoot, PROFILE), sourceOptions));
    validateContract("manual-stage1-profile.v2", profile);
    requireThat(instant(profile.validFrom) < instant(profile.expiresAt));
    if (requireCurrentValidity)
      requireThat(
        instant(profile.validFrom) <= Date.now() && Date.now() < instant(profile.expiresAt)
      );
    requireThat(
      /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u.test(
        profile.publicKeyPem
      )
    );
    const publicKey = createPublicKey(profile.publicKeyPem);
    requireThat(
      publicKey.asymmetricKeyType === "ed25519" &&
        sha256Bytes(publicKey.export({ type: "spki", format: "der" })) === profile.keyFingerprint
    );
    const binding = json(await read(path.join(repoRoot, OWNER), sourceOptions), true);
    validateOwner(binding, true);
    requireThat(
      binding.profileDigest === sha256Canonical(profile) && binding.ownerId === profile.ownerId
    );
    const actual = await actualHost();
    requireThat(
      equal(binding.principal, actual.principal) &&
        binding.hostFingerprint === actual.hostFingerprint
    );
    Object.assign(sourceOptions, { principal: actual.principal, sourceRoot: repoRoot });
    for (const name of [PROFILE, OWNER])
      await checkedPath(path.join(repoRoot, name), sourceOptions);
    const roots = ROOTS.map((name) => absolute(profile.storage[name]));
    const rootSnapshots = [];
    for (let i = 0; i < roots.length; i++) {
      const checked = await checkedPath(roots[i], {
        principal: actual.principal,
        privateRoot: roots[i]
      });
      requireThat(checked.at(-1).stat.isDirectory());
      rootSnapshots.push(checked);
      for (let j = 0; j < i; j++)
        requireThat(!within(roots[i], roots[j]) && !within(roots[j], roots[i]));
    }
    const approvalBytes = await read(
      path.join(profile.storage.archiveRoot, binding.approvalReference),
      { principal: actual.principal, privateRoot: profile.storage.archiveRoot }
    );
    const approval = json(approvalBytes, true);
    validateOwner(approval);
    requireThat(sha256Bytes(approvalBytes) === binding.approvalDigest);
    for (const key of [
      "profileDigest",
      "ownerId",
      "principal",
      "hostFingerprint",
      "approvedAt",
      "promotionEligible"
    ])
      requireThat(equal(binding[key], approval[key]));
    for (const item of opened) await item.recheck();
    for (let index = 0; index < roots.length; index++) {
      const after = await checkedPath(roots[index], {
        principal: actual.principal,
        privateRoot: roots[index]
      });
      requireThat(
        rootSnapshots[index].length === after.length &&
          rootSnapshots[index].every((entry, i) =>
            sameIdentity(entry.stat, after[i].stat, i === after.length - 1)
          )
      );
    }
    return freeze(profile);
  } catch {
    fail(H1);
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}

function operationIndex(value, operationRef, profile) {
  exact(value, [
    "schemaVersion",
    "operationRef",
    "runId",
    "createdAt",
    "profileDigest",
    "buildProofDigest",
    "proofRawDigest",
    "materialRawDigest",
    "custodyReceiptRawDigest",
    "targetIntent",
    "purpose",
    "scenario",
    "operations",
    "promotionEligible"
  ]);
  requireThat(
    value.schemaVersion === "manual-operation-input.v1" &&
      value.operationRef === operationRef &&
      UUID.test(value.runId) &&
      value.profileDigest === sha256Canonical(profile) &&
      value.purpose === "synthetic-fresh" &&
      ["normal", "apply-interrupted"].includes(value.scenario) &&
      value.promotionEligible === false &&
      instant(value.createdAt) <= Date.now()
  );
  for (const name of [
    "buildProofDigest",
    "proofRawDigest",
    "materialRawDigest",
    "custodyReceiptRawDigest"
  ])
    requireThat(DIGEST.test(value[name]));
  exact(value.targetIntent, ["endpointPolicyId", "databaseName"]);
  requireThat(
    profile.allowedTargets.some(
      (target) =>
        target.endpointPolicyId === value.targetIntent.endpointPolicyId &&
        target.databaseName === value.targetIntent.databaseName &&
        target.purposes.includes(value.purpose)
    )
  );
  const phases = ["observe", "migrate", "verify"];
  exact(value.operations, phases);
  for (const phase of phases) {
    exact(value.operations[phase], ["operationId", "idempotencyKey"]);
    requireThat(
      UUID.test(value.operations[phase].operationId) &&
        value.operations[phase].idempotencyKey === `manual-stage1:${operationRef}:${phase}`
    );
  }
  requireThat(
    new Set(phases.map((phase) => value.operations[phase].operationId)).size === phases.length
  );
}

export async function readFixedManualOperation(input) {
  const opened = [];
  try {
    exact(input, ["repoRoot", "operationRef"]);
    requireThat(typeof input.operationRef === "string" && UUID.test(input.operationRef));
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    const { principal } = await actualHost();
    const archiveRoot = profile.storage.archiveRoot;
    const read = async (file) => {
      const item = await openInput(file, { principal, privateRoot: archiveRoot });
      opened.push(item);
      return item.bytes;
    };
    const operation = json(
      await read(path.join(archiveRoot, "inputs", "operations", input.operationRef, "index.json")),
      true
    );
    operationIndex(operation, input.operationRef, profile);
    const proofBytes = await read(
      path.join(archiveRoot, "inputs", "build", `${operation.proofRawDigest.slice(7)}.proof.json`)
    );
    const materialBytes = await read(
      path.join(
        archiveRoot,
        "inputs",
        "build",
        `${operation.materialRawDigest.slice(7)}.material.json`
      )
    );
    requireThat(
      sha256Bytes(proofBytes) === operation.proofRawDigest &&
        sha256Bytes(materialBytes) === operation.materialRawDigest &&
        sha256Canonical(json(proofBytes)) === operation.buildProofDigest
    );
    json(materialBytes);
    for (const item of opened) await item.recheck();
    return Object.freeze({
      operation: freeze(operation),
      indexDigest: sha256Canonical(operation),
      proofBytes: Buffer.from(proofBytes),
      materialBytes: Buffer.from(materialBytes)
    });
  } catch {
    fail(OPERATION);
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}

// Public historical records only. Holding these inputs grants no consumer authority.
export async function readFixedH1SnapshotPublicKeyInputs(input) {
  const opened = [];
  const copies = [];
  let closed = false;
  let closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled(opened.map((item) => item.close()));
      for (const item of opened) item.bytes.fill(0);
      for (const copy of copies) copy.fill(0);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(PUBLIC_INPUT);
    })();
    return closing;
  };
  try {
    const byDigest =
      input && typeof input === "object" && Object.hasOwn(input, "creationRawDigest");
    exact(
      input,
      byDigest
        ? ["repoRoot", "creationRawDigest", "recoveryRawDigest"]
        : ["repoRoot", "operationRef"]
    );
    const repoRoot = absolute(input.repoRoot);
    // Capture closed primitive selectors before the first asynchronous read.
    const operationRef = byDigest ? null : input.operationRef;
    const selected = byDigest
      ? { creationRawDigest: input.creationRawDigest, recoveryRawDigest: input.recoveryRawDigest }
      : null;
    requireThat(
      byDigest
        ? Object.values(selected).every((value) => typeof value === "string" && DIGEST.test(value))
        : typeof operationRef === "string" && UUID.test(operationRef)
    );
    const profile = await loadFixedManualProfile({ repoRoot });
    const actual = await actualHost();
    requireThat(actual.principal.platform === "posix");
    const profileDigest = sha256Canonical(profile);
    const archiveRoot = profile.storage.archiveRoot;
    const privateOptions = { principal: actual.principal, privateRoot: archiveRoot };
    const sourceOptions = { principal: actual.principal, sourceRoot: repoRoot };
    const read = async (file, options = privateOptions) => {
      requireThat(!closed);
      const item = await openInput(file, options);
      opened.push(item);
      requireThat(item.bytes.length > 0 && !closed);
      return item.bytes;
    };
    // Retain original owner/profile inputs, not just the loader's projected profile.
    const profileBytes = await read(path.join(repoRoot, PROFILE), sourceOptions);
    requireThat(equal(json(profileBytes), profile));
    const binding = json(await read(path.join(repoRoot, OWNER), sourceOptions), true);
    validateOwner(binding, true);
    requireThat(
      binding.profileDigest === profileDigest &&
        binding.ownerId === profile.ownerId &&
        equal(binding.principal, actual.principal) &&
        binding.hostFingerprint === actual.hostFingerprint
    );
    const approvalBytes = await read(path.join(archiveRoot, binding.approvalReference));
    const approval = json(approvalBytes, true);
    validateOwner(approval);
    requireThat(sha256Bytes(approvalBytes) === binding.approvalDigest);
    for (const key of [
      "profileDigest",
      "ownerId",
      "principal",
      "hostFingerprint",
      "approvedAt",
      "promotionEligible"
    ])
      requireThat(equal(binding[key], approval[key]));
    const root = path.join(archiveRoot, "inputs", "h1-snapshot-key");
    let indexBytes = null;
    let index = selected;
    if (!byDigest) {
      indexBytes = await read(path.join(root, operationRef, "index.json"));
      index = json(indexBytes, true);
      exact(index, [
        "schemaVersion",
        "operationRef",
        "profileDigest",
        "creationRawDigest",
        "recoveryRawDigest"
      ]);
      requireThat(
        index.schemaVersion === "h1-snapshot-key-input-index.v1" &&
          index.operationRef === operationRef &&
          index.profileDigest === profileDigest &&
          DIGEST.test(index.creationRawDigest) &&
          DIGEST.test(index.recoveryRawDigest)
      );
    }
    const creationBytes = await read(
      path.join(root, "raw", `${index.creationRawDigest.slice(7)}.creation.json`)
    );
    const recoveryBytes = await read(
      path.join(root, "raw", `${index.recoveryRawDigest.slice(7)}.recovery.json`)
    );
    requireThat(
      sha256Bytes(creationBytes) === index.creationRawDigest &&
        sha256Bytes(recoveryBytes) === index.recoveryRawDigest
    );
    // Native originals use JSON.stringify insertion order, not canonical ordering.
    const creation = json(creationBytes),
      recovery = json(recoveryBytes);
    validateH1SnapshotPublicKeyReadbacks({
      creation,
      recovery,
      creationRawDigest: index.creationRawDigest,
      profile,
      hostFingerprint: actual.hostFingerprint,
      principal: actual.principal
    });
    const checkWindow = () => {
      const now = Date.now();
      requireThat(
        instant(profile.validFrom) <= now &&
          now < instant(profile.expiresAt) &&
          instant(creation.createdAt) < instant(recovery.verifiedAt) &&
          instant(recovery.verifiedAt) <= now
      );
    };
    const check = async () => {
      requireThat(!closed);
      const currentHost = await actualHost();
      requireThat(equal(currentHost, actual));
      const currentProfile = await loadFixedManualProfile({ repoRoot });
      requireThat(sha256Canonical(currentProfile) === profileDigest);
      checkWindow();
      for (const item of opened) await item.recheck();
      checkWindow();
      requireThat(!closed);
    };
    const recheck = async () => {
      try {
        await check();
      } catch {
        await close();
        fail(PUBLIC_INPUT);
      }
    };
    await recheck();
    const creationRawBytes = Buffer.from(creationBytes),
      recoveryRawBytes = Buffer.from(recoveryBytes);
    copies.push(creationRawBytes, recoveryRawBytes);
    return Object.freeze({
      creation: freeze(creation),
      recovery: freeze(recovery),
      creationRawBytes,
      recoveryRawBytes,
      refs: freeze({
        indexRawDigest: indexBytes === null ? null : sha256Bytes(indexBytes),
        creationRawDigest: index.creationRawDigest,
        recoveryRawDigest: index.recoveryRawDigest
      }),
      recheck,
      close
    });
  } catch {
    await close();
    fail(PUBLIC_INPUT);
  }
}

function inputBytes(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
  return Buffer.from(bytes);
}
async function checkoutSource(repoRoot, sourceSha) {
  const output = async (...args) =>
    new TextDecoder("utf-8", { fatal: true })
      .decode(
        await processOutput(
          "git",
          ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repoRoot, ...args],
          { timeout: 10000, env: fixedProcessEnvironment("git") }
        )
      )
      .trim();
  const top = await output("rev-parse", "--show-toplevel");
  requireThat((await fs.realpath(top)) === (await fs.realpath(repoRoot)));
  requireThat((await output("rev-parse", "--verify", "HEAD")) === sourceSha);
  requireThat((await output("status", "--porcelain=v1", "--untracked-files=all")) === "");
}

// Only the fixed historical reader supplies this source-pinned compatibility.
// Discovery still runs; exactly one known unlisted entrypoint is tolerated.
async function repositoryContractForSource(repoRoot, sourceSha, compatibility = null) {
  if (compatibility === null) return computeRepositoryContract(repoRoot);
  requireThat(
    compatibility.sourceRoot === repoRoot &&
      compatibility.sourceSha === sourceSha &&
      compatibility.unlistedEntrypoint === "scripts/release/retire-r3-incident-0af9c545.mjs"
  );
  await checkoutSource(repoRoot, sourceSha);
  let current, drift;
  try {
    current = await computeRepositoryContract(repoRoot);
  } catch (error) {
    drift = error;
  }
  if (current) {
    await checkoutSource(repoRoot, sourceSha);
    return current;
  }
  requireThat(drift?.code === "CONTRACT_FILE_SET_DRIFT");
  const { declared, discovered } = drift.details ?? {};
  requireThat(
    Array.isArray(declared) &&
      Array.isArray(discovered) &&
      !declared.includes(compatibility.unlistedEntrypoint) &&
      equal(discovered, [...declared, compatibility.unlistedEntrypoint].sort())
  );
  const entries = await Promise.all(
    declared.map(async (file) => ({
      path: file,
      sha256: sha256Bytes(await fs.readFile(path.join(repoRoot, ...file.split("/"))))
    }))
  );
  const identity = {
    catalogVersion: "repository-contract.v1",
    canonicalization: "RFC8785",
    entries
  };
  await checkoutSource(repoRoot, sourceSha);
  return Object.freeze({ ...identity, digest: sha256Canonical(identity) });
}
async function checkoutCurrentVerifier(repoRoot) {
  const sourceSha = new TextDecoder("utf-8", { fatal: true })
    .decode(
      await processOutput(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          repoRoot,
          "rev-parse",
          "--verify",
          "HEAD"
        ],
        { timeout: 10000, env: fixedProcessEnvironment("git") }
      )
    )
    .trim();
  requireThat(/^[0-9a-f]{40}$/u.test(sourceSha));
  await checkoutSource(repoRoot, sourceSha);
  return sourceSha;
}
function fixedProcessEnvironment(kind) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      kind === "git"
        ? !name.toUpperCase().startsWith("GIT_")
        : !["GH_HOST", "GH_REPO"].includes(name.toUpperCase())
    )
  );
  if (kind === "git") {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  } else {
    env.GH_HOST = "github.com";
    env.GH_PROMPT_DISABLED = "1";
  }
  return env;
}
function attestation(
  outputBytes,
  expectedDigest,
  sourceSha,
  earliest,
  workflow = {
    signer: WORKFLOW,
    caller: WORKFLOW
  }
) {
  const output = json(outputBytes);
  // Refuse ambiguity rather than selecting a statement from one item and a
  // bundle/certificate from another successful verification result.
  requireThat(Array.isArray(output) && output.length === 1);
  const item = output[0],
    result = item?.verificationResult;
  const cert = result?.signature?.certificate,
    statement = result?.statement;
  const signer = `https://github.com/${REPOSITORY}/${workflow.signer}@refs/heads/main`,
    caller = `https://github.com/${REPOSITORY}/${workflow.caller}@refs/heads/main`;
  requireThat(
    cert?.issuer === ISSUER &&
      (cert?.subjectAlternativeName === signer ||
        (cert?.subjectAlternativeName?.type === "URI" &&
          cert.subjectAlternativeName.value === signer)) &&
      cert.buildSignerURI === signer &&
      cert.buildSignerDigest === sourceSha &&
      cert.runnerEnvironment === "github-hosted" &&
      cert.sourceRepositoryURI === `https://github.com/${REPOSITORY}` &&
      cert.sourceRepositoryDigest === sourceSha &&
      cert.sourceRepositoryRef === "refs/heads/main" &&
      cert.buildConfigURI === caller &&
      cert.buildConfigDigest === sourceSha &&
      (workflow.repositoryId === undefined ||
        cert.sourceRepositoryIdentifier === workflow.repositoryId)
  );
  const runPrefix = `https://github.com/${REPOSITORY}/actions/runs/`;
  requireThat(
    typeof cert.runInvocationURI === "string" && cert.runInvocationURI.startsWith(runPrefix)
  );
  const runMatch = cert.runInvocationURI
    .slice(runPrefix.length)
    .match(/^([1-9][0-9]*)\/attempts\/1$/u);
  requireThat(runMatch && Number.isSafeInteger(Number(runMatch[1])));
  requireThat(
    statement?._type === "https://in-toto.io/Statement/v1" &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1 &&
      statement.subject[0]?.digest?.sha256 === expectedDigest.slice(7)
  );
  requireThat(
    Array.isArray(result.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0 &&
      result.verifiedTimestamps.every(
        ({ timestamp }) =>
          typeof timestamp === "string" &&
          Number.isFinite(Date.parse(timestamp)) &&
          Date.parse(timestamp) >= earliest &&
          Date.parse(timestamp) <= Date.now()
      )
  );
  const bundle = item.attestation?.bundle;
  requireThat(
    bundle &&
      typeof bundle === "object" &&
      !Array.isArray(bundle) &&
      bundle.dsseEnvelope?.payloadType === "application/vnd.in-toto+json" &&
      typeof bundle.dsseEnvelope.payload === "string"
  );
  const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64");
  requireThat(
    payload.toString("base64") === bundle.dsseEnvelope.payload && equal(json(payload), statement)
  );
  // gh's bundle_url is an unauthoritative, potentially signed download URL.
  // The private reference is the canonical digest of this verified item's
  // bundle, never that URL or proof.provenance's separate material reference.
  return Object.freeze({
    subjectDigest: expectedDigest,
    sourceSha,
    issuer: ISSUER,
    repository: REPOSITORY,
    workflowPath: workflow.signer,
    workflowRef: "refs/heads/main",
    workflowRunId: runMatch[1],
    runAttempt: 1,
    runnerClass: "github-hosted",
    attestationRef: sha256Canonical(bundle)
  });
}
function attestationArgs(file, sourceSha, workflowPath = WORKFLOW) {
  return [
    "attestation",
    "verify",
    file,
    "--repo",
    REPOSITORY,
    "--signer-workflow",
    `${REPOSITORY}/${workflowPath}`,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    sourceSha,
    "--cert-oidc-issuer",
    ISSUER,
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
}
async function verifyAttestedInput(file, bytes, sourceSha, earliest) {
  const output = await processOutput("gh", attestationArgs(file, sourceSha), {
    env: fixedProcessEnvironment("gh")
  });
  return attestation(output, sha256Bytes(bytes), sourceSha, earliest);
}
async function successfulRun(proof, verified) {
  const runRef = `https://github.com/${REPOSITORY}/actions/runs/${verified.workflowRunId}`;
  requireThat(proof.provenance.ciRunRef === runRef);
  const run = json(
    await processOutput(
      "gh",
      ["api", `repos/${REPOSITORY}/actions/runs/${verified.workflowRunId}/attempts/1`],
      { env: fixedProcessEnvironment("gh") }
    )
  );
  requireThat(
    run.id === Number(verified.workflowRunId) &&
      run.run_attempt === 1 &&
      run.head_sha === proof.identity.sourceSha &&
      run.head_branch === "main" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.path === WORKFLOW &&
      run.html_url === runRef &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY
  );
}

export async function verifyManualBuild(input) {
  return verifyManualBuildInput(input, true);
}

async function verifyManualBuildInput(
  input,
  requireCurrentValidity,
  verifierRepoRoot = input.repoRoot,
  historicalContract = null,
  captureVerifiedBuildRun = null
) {
  const opened = [];
  try {
    exact(input, ["proofBytes", "materialBytes", "repoRoot"]);
    const profile = await loadManualProfile({ repoRoot: input.repoRoot }, requireCurrentValidity);
    const separateVerifier = verifierRepoRoot !== input.repoRoot;
    if (separateVerifier) {
      requireThat(
        typeof verifierRepoRoot === "string" && absolute(verifierRepoRoot) === verifierRepoRoot
      );
      requireThat(
        equal(
          await loadManualProfile({ repoRoot: verifierRepoRoot }, requireCurrentValidity),
          profile
        )
      );
    }
    const proofBytes = inputBytes(input.proofBytes),
      materialBytes = inputBytes(input.materialBytes);
    const proofRawDigest = sha256Bytes(proofBytes),
      materialRawDigest = sha256Bytes(materialBytes);
    const { principal } = await actualHost();
    const read = async (file, privateRoot, sourceRoot = input.repoRoot) => {
      const snapshot = await openInput(file, {
        principal,
        privateRoot,
        sourceRoot: privateRoot ? undefined : sourceRoot
      });
      opened.push(snapshot);
      return snapshot;
    };
    const archiveRoot = profile.storage.archiveRoot,
      buildRoot = path.join(archiveRoot, "inputs", "build");
    const proofPath = path.join(buildRoot, `${proofRawDigest.slice(7)}.proof.json`);
    const materialPath = path.join(buildRoot, `${materialRawDigest.slice(7)}.material.json`);
    const receiptPath = path.join(
      buildRoot,
      `${proofRawDigest.slice(7)}.custody-receipt.retention90.v1.json`
    );
    const proofInput = await read(proofPath, archiveRoot),
      materialInput = await read(materialPath, archiveRoot);
    requireThat(proofInput.bytes.equals(proofBytes) && materialInput.bytes.equals(materialBytes));
    let receiptInput;
    try {
      receiptInput = await read(receiptPath, archiveRoot);
    } catch (error) {
      if (error?.code === "ENOENT") fail(CUSTODY_REQUIRED);
      throw error;
    }
    const proof = json(proofBytes),
      material = json(materialBytes),
      receipt = json(receiptInput.bytes, true);
    assertBuildIdentity({ proof, buildMaterialObservation: material });
    for (const name of ["api", "web", "runner"])
      requireThat(proof.identity.images[name].sourceRevision === proof.identity.sourceSha);
    validateContract("custody-receipt.retention90.v1", receipt);
    const buildProofDigest = sha256Canonical(proof);
    requireThat(
      receipt.contentSizeBytes === encodeManualJson(proof).length &&
        !/^https:\/\/(?:api\.)?github\.com\/.+\/(?:actions\/artifacts|actions\/runs)\//iu.test(
          receipt.storeRef
        )
    );
    const manifestName = "release/contracts/repository-contract-files.v1.json";
    const manifestInput = await read(path.join(input.repoRoot, manifestName));
    const manifest = json(manifestInput.bytes);
    exact(manifest, ["contractVersion", "files"]);
    requireThat(
      manifest.contractVersion === "repository-contract-files.v1" && Array.isArray(manifest.files)
    );
    for (const required of [
      PROFILE,
      OWNER,
      manifestName,
      "scripts/release/manual-stage1-trust.mjs",
      "scripts/release/verify-build-proof.mjs"
    ])
      requireThat(manifest.files.includes(required));
    const sourceInputs = new Map();
    for (const file of manifest.files) {
      requireThat(
        typeof file === "string" &&
          file.length > 0 &&
          !file.includes("\\") &&
          !path.posix.isAbsolute(file) &&
          file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
      );
      sourceInputs.set(file, await read(path.join(input.repoRoot, ...file.split("/"))));
    }
    // The public build verifier always compares against its proof checkout.
    // Only the fixed historical reader may separately bind the executing
    // verifier to its current checkout while authenticating the old source.
    if (separateVerifier) {
      const verifierProfile = await read(
        path.join(verifierRepoRoot, PROFILE),
        undefined,
        verifierRepoRoot
      );
      const verifierOwner = await read(
        path.join(verifierRepoRoot, OWNER),
        undefined,
        verifierRepoRoot
      );
      requireThat(equal(json(verifierProfile.bytes), profile));
      requireThat(verifierOwner.bytes.equals(sourceInputs.get(OWNER).bytes));
    }
    for (const name of ["manual-stage1-trust.mjs", "verify-build-proof.mjs"]) {
      const executing = await read(
        fileURLToPath(new URL(`./${name}`, import.meta.url)),
        undefined,
        verifierRepoRoot
      );
      const verifier = separateVerifier
        ? await read(
            path.join(verifierRepoRoot, "scripts/release", name),
            undefined,
            verifierRepoRoot
          )
        : sourceInputs.get(`scripts/release/${name}`);
      requireThat(executing.bytes.equals(verifier.bytes));
    }
    const verifierSourceSha = separateVerifier
      ? await checkoutCurrentVerifier(verifierRepoRoot)
      : null;
    const inspectSource = async () => {
      requireThat(
        (
          await repositoryContractForSource(
            input.repoRoot,
            proof.identity.sourceSha,
            historicalContract
          )
        ).digest === proof.identity.repositoryContractDigest
      );
      requireThat(
        (await computeMigrationCatalog(input.repoRoot)).digest ===
          proof.identity.migrationCatalogDigest
      );
      await checkoutSource(input.repoRoot, proof.identity.sourceSha);
      if (separateVerifier) await checkoutSource(verifierRepoRoot, verifierSourceSha);
    };
    await inspectSource();
    for (const item of opened) await item.recheck();
    const proofAttestation = await verifyAttestedInput(
      proofPath,
      proofBytes,
      proof.identity.sourceSha,
      instant(proof.provenance.generatedAt)
    );
    for (const item of opened) await item.recheck();
    const receiptAttestation = await verifyAttestedInput(
      receiptPath,
      receiptInput.bytes,
      proof.identity.sourceSha,
      instant(receipt.readbackAt)
    );
    for (const item of opened) await item.recheck();
    for (const field of [
      "sourceSha",
      "issuer",
      "repository",
      "workflowPath",
      "workflowRef",
      "workflowRunId",
      "runAttempt",
      "runnerClass"
    ])
      requireThat(proofAttestation[field] === receiptAttestation[field]);
    assertProofCustody({
      proofDigest: buildProofDigest,
      custodyReceipt: receipt,
      trustRoot: { custody: CUSTODY_POLICY },
      verifiedAttestation: proofAttestation
    });
    await successfulRun(proof, proofAttestation);
    for (const item of opened) await item.recheck();
    await inspectSource();
    requireThat(
      sha256Canonical(
        await loadManualProfile({ repoRoot: input.repoRoot }, requireCurrentValidity)
      ) === sha256Canonical(profile)
    );
    if (captureVerifiedBuildRun)
      captureVerifiedBuildRun(() => successfulRun(proof, proofAttestation));
    return Object.freeze({
      buildProofDigest,
      proofRawDigest,
      materialRawDigest,
      custodyReceiptRawDigest: sha256Bytes(receiptInput.bytes),
      promotionEligible: false
    });
  } catch (error) {
    failWithCause(error?.code === CUSTODY_REQUIRED ? CUSTODY_REQUIRED : BUILD, error);
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}

// Fixed R3 policy plus the existing H2 verification. This holds trusted inputs;
// it does not create a session, grant a capability or admit a hosted destination.
export async function readFixedR3TargetPolicy(input) {
  return readR3TargetPolicyInput(input, true);
}

async function readR3TargetPolicyInput(
  input,
  requireCurrentValidity,
  verifierRepoRoot = input.repoRoot,
  historicalContract = null
) {
  const code = "R3_TARGET_POLICY_INPUT_UNAVAILABLE";
  const opened = [];
  let recheckVerifiedBuildRun = null;
  let closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const results = await Promise.allSettled(opened.map((item) => item.close()));
      for (const item of opened) item.bytes.fill(0);
      if (results.some((result) => result.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "proofBytes", "materialBytes"]);
    requireThat(typeof input.repoRoot === "string");
    const repoRoot = absolute(input.repoRoot),
      proofBytes = inputBytes(input.proofBytes),
      materialBytes = inputBytes(input.materialBytes);
    requireThat(process.platform === "linux");
    const profile = await loadManualProfile({ repoRoot }, requireCurrentValidity),
      profileDigest = sha256Canonical(profile),
      actual = await actualHost(),
      archiveRoot = profile.storage.archiveRoot;
    const sourceOptions = { principal: actual.principal, sourceRoot: repoRoot },
      privateOptions = { principal: actual.principal, privateRoot: archiveRoot };
    const read = async (file, options = sourceOptions) => {
      requireThat(!closed);
      const item = await openInput(file, options);
      opened.push(item);
      requireThat(item.bytes.length > 0 && !closed);
      return item.bytes;
    };
    requireThat(equal(json(await read(path.join(repoRoot, PROFILE))), profile));
    const ownerBytes = await read(path.join(repoRoot, OWNER));
    let verifierSourceSha;
    if (verifierRepoRoot !== repoRoot) {
      const verifierOptions = { principal: actual.principal, sourceRoot: verifierRepoRoot };
      requireThat(
        equal(json(await read(path.join(verifierRepoRoot, PROFILE), verifierOptions)), profile)
      );
      requireThat(
        (await read(path.join(verifierRepoRoot, OWNER), verifierOptions)).equals(ownerBytes)
      );
      for (const name of ["manual-stage1-trust.mjs", "verify-build-proof.mjs"]) {
        const executing = await read(
          fileURLToPath(new URL(`./${name}`, import.meta.url)),
          verifierOptions
        );
        const current = await read(
          path.join(verifierRepoRoot, "scripts/release", name),
          verifierOptions
        );
        requireThat(executing.equals(current));
      }
      verifierSourceSha = await checkoutCurrentVerifier(verifierRepoRoot);
    }
    const policyName = "release/contracts/manual-stage1-r3-target-policy.v1.json",
      targetsName = "release/contracts/database-target-policies.v1.json",
      suitesName = "release/contracts/database-test-manifest.v1.json",
      manifestName = "release/contracts/repository-contract-files.v1.json";
    const policyBytes = await read(path.join(repoRoot, policyName)),
      targetsBytes = await read(path.join(repoRoot, targetsName)),
      suitesBytes = await read(path.join(repoRoot, suitesName)),
      manifest = json(await read(path.join(repoRoot, manifestName))),
      policy = json(policyBytes),
      targets = json(targetsBytes),
      suites = json(suitesBytes);
    validateContract("manual-stage1-r3-target-policy.v1", policy);
    validateContract("database-target-policies.v1", targets);
    validateContract("database-test-manifest.v1", suites);
    requireThat(policy.profileDigest === profileDigest);
    requireThat(
      Array.isArray(manifest.files) &&
        [policyName, targetsName, suitesName].every((file) => manifest.files.includes(file))
    );
    const matchingTargets = targets.policies.filter(
      (p) => p.policyId === policy.databaseTargetPolicyId
    );
    requireThat(matchingTargets.length === 1);
    const buildRoot = path.join(archiveRoot, "inputs", "build"),
      proofRawDigest = sha256Bytes(proofBytes),
      materialRawDigest = sha256Bytes(materialBytes);
    requireThat(
      (
        await read(path.join(buildRoot, `${proofRawDigest.slice(7)}.proof.json`), privateOptions)
      ).equals(proofBytes)
    );
    requireThat(
      (
        await read(
          path.join(buildRoot, `${materialRawDigest.slice(7)}.material.json`),
          privateOptions
        )
      ).equals(materialBytes)
    );
    const receiptBytes = await read(
      path.join(buildRoot, `${proofRawDigest.slice(7)}.custody-receipt.retention90.v1.json`),
      privateOptions
    );
    const build = await verifyManualBuildInput(
        { repoRoot, proofBytes, materialBytes },
        requireCurrentValidity,
        verifierRepoRoot,
        historicalContract,
        requireCurrentValidity
          ? null
          : (recheck) => {
              recheckVerifiedBuildRun = recheck;
            }
      ),
      proof = json(proofBytes);
    requireThat(build.custodyReceiptRawDigest === sha256Bytes(receiptBytes));
    const checkWindow = () => {
      const now = Date.now();
      if (requireCurrentValidity)
        requireThat(instant(profile.validFrom) <= now && now < instant(profile.expiresAt));
    };
    const checkFixed = async () => {
      requireThat(!closed);
      checkWindow();
      requireThat(equal(await actualHost(), actual));
      requireThat(
        sha256Canonical(await loadManualProfile({ repoRoot }, requireCurrentValidity)) ===
          profileDigest
      );
      requireThat(
        (await repositoryContractForSource(repoRoot, proof.identity.sourceSha, historicalContract))
          .digest === proof.identity.repositoryContractDigest
      );
      requireThat(
        (await computeMigrationCatalog(repoRoot)).digest === proof.identity.migrationCatalogDigest
      );
      await checkoutSource(repoRoot, proof.identity.sourceSha);
      if (verifierSourceSha) await checkoutSource(verifierRepoRoot, verifierSourceSha);
      for (const item of opened) await item.recheck();
      checkWindow();
      requireThat(!closed);
    };
    const recheck = async () => {
      try {
        await checkFixed();
        if (recheckVerifiedBuildRun) {
          await recheckVerifiedBuildRun();
          await checkFixed();
        }
      } catch (cause) {
        await close().catch(() => {});
        failWithCause(code, cause);
      }
    };
    await checkFixed();
    return Object.freeze({
      profileDigest,
      policy: freeze(policy),
      policyRawDigest: sha256Bytes(policyBytes),
      databaseTargetPolicy: freeze(matchingTargets[0]),
      databaseTargetPolicyRawDigest: sha256Bytes(targetsBytes),
      databaseTestManifest: freeze(suites),
      databaseTestManifestRawDigest: sha256Bytes(suitesBytes),
      build,
      sourceSha: proof.identity.sourceSha,
      recheck,
      close
    });
  } catch (cause) {
    await close();
    failWithCause(code, cause);
  }
}

function r3CreationSpec(value, operationRef, profile) {
  exact(value, [
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
  ]);
  requireThat(
    value.schemaVersion === "manual-r3-creation-spec.v1" &&
      value.operationRef === operationRef &&
      value.profileDigest === sha256Canonical(profile) &&
      value.ownerId === profile.ownerId &&
      typeof value.sourceSha === "string" &&
      /^[0-9a-f]{40}$/u.test(value.sourceSha) &&
      ["buildProofDigest", "proofRawDigest", "materialRawDigest", "targetPolicyDigest"].every(
        (field) => typeof value[field] === "string" && DIGEST.test(value[field])
      ) &&
      ["source", "final"].includes(value.phase) &&
      ["fresh", "snapshot"].includes(value.chain) &&
      value.cleanup === "stop-owned-engine-and-remove-workspace"
  );
  const workspace = value.workspace;
  exact(workspace, ["id", "capacityBytes", "backingFile", "mountPath", "keyFile", "mapperName"]);
  requireThat(
    workspace.id === operationRef.replaceAll("-", "") &&
      Number.isSafeInteger(workspace.capacityBytes) &&
      workspace.capacityBytes >= 64 * 1048576 &&
      workspace.capacityBytes % 1048576 === 0
  );
  for (const field of ["backingFile", "mountPath", "keyFile", "mapperName"])
    requireThat(typeof workspace[field] === "string");
}

// Fixed owner-imported plan only. Actual hosted job admission and manual
// consumption must precede creation; no key, payload or remote target is opened.
export async function readFixedR3CreationSpec(input) {
  const code = "R3_CREATION_INPUT_UNAVAILABLE",
    opened = [];
  let policyInput,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...opened.map((item) => item.close()),
        ...(policyInput ? [policyInput.close()] : [])
      ]);
      for (const item of opened) item.bytes.fill(0);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "operationRef"]);
    requireThat(
      typeof input.repoRoot === "string" &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef)
    );
    const repoRoot = absolute(input.repoRoot),
      operationRef = input.operationRef;
    requireThat(process.platform === "linux");
    const profile = await loadFixedManualProfile({ repoRoot }),
      actual = await actualHost(),
      archiveRoot = profile.storage.archiveRoot;
    const read = async (file) => {
      requireThat(!closed);
      const held = await openInput(file, { principal: actual.principal, privateRoot: archiveRoot });
      opened.push(held);
      requireThat(held.bytes.length > 0 && !closed);
      return held.bytes;
    };
    const specBytes = await read(
        path.join(archiveRoot, "inputs", "r3", operationRef, "creation-spec.json")
      ),
      spec = json(specBytes, true);
    r3CreationSpec(spec, operationRef, profile);
    const checkWindow = () => {
      const now = Date.now(),
        created = instant(spec.createdAt),
        expires = instant(spec.expiresAt);
      requireThat(
        instant(profile.validFrom) <= created &&
          created <= now &&
          created < expires &&
          now < expires &&
          expires <= instant(profile.expiresAt)
      );
    };
    checkWindow();
    const buildRoot = path.join(archiveRoot, "inputs", "build"),
      proofBytes = await read(path.join(buildRoot, `${spec.proofRawDigest.slice(7)}.proof.json`)),
      materialBytes = await read(
        path.join(buildRoot, `${spec.materialRawDigest.slice(7)}.material.json`)
      );
    requireThat(
      sha256Bytes(proofBytes) === spec.proofRawDigest &&
        sha256Bytes(materialBytes) === spec.materialRawDigest
    );
    policyInput = await readFixedR3TargetPolicy({ repoRoot, proofBytes, materialBytes });
    requireThat(
      spec.buildProofDigest === policyInput.build.buildProofDigest &&
        spec.sourceSha === policyInput.sourceSha &&
        spec.profileDigest === policyInput.profileDigest &&
        spec.targetPolicyDigest === policyInput.policyRawDigest
    );
    const roots = policyInput.policy.workspace,
      workspace = spec.workspace,
      id = workspace.id;
    requireThat(
      workspace.backingFile === path.posix.join(roots.backingRoot, `${id}.luks`) &&
        workspace.mountPath === path.posix.join(roots.mountRoot, id) &&
        workspace.keyFile === path.posix.join(roots.keyRoot, `${id}.key`) &&
        workspace.mapperName === `${roots.mapperPrefix}${id}`
    );
    const recheck = async () => {
      try {
        requireThat(!closed);
        checkWindow();
        requireThat(equal(await actualHost(), actual));
        await policyInput.recheck();
        for (const item of opened) await item.recheck();
        checkWindow();
        requireThat(!closed);
      } catch (cause) {
        await close().catch(() => {});
        failWithCause(code, cause);
      }
    };
    await recheck();
    return Object.freeze({
      spec: freeze(spec),
      creationSpecDigest: sha256Bytes(specBytes),
      profileDigest: policyInput.profileDigest,
      targetPolicyDigest: policyInput.policyRawDigest,
      policy: policyInput.policy,
      databaseTargetPolicy: policyInput.databaseTargetPolicy,
      databaseTestManifest: policyInput.databaseTestManifest,
      databaseTestManifestRawDigest: policyInput.databaseTestManifestRawDigest,
      build: policyInput.build,
      buildMaterialObservation: freeze(json(materialBytes)),
      sourceSha: policyInput.sourceSha,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
  }
}

function r3JobDescriptor(value, creation) {
  exact(value, [
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
  ]);
  requireThat(
    value.schemaVersion === "manual-r3-job-admission.v1" &&
      value.creationSpecDigest === creation.creationSpecDigest
  );
  for (const field of [
    "operationRef",
    "profileDigest",
    "ownerId",
    "buildProofDigest",
    "sourceSha",
    "phase",
    "chain"
  ])
    requireThat(value[field] === creation.spec[field]);
  const ci = value.ci,
    policy = creation.policy.hosted,
    source = value.phase === "source";
  exact(ci, [
    "repository",
    "repositoryId",
    "runId",
    "runAttempt",
    "workflowPath",
    "callerWorkflowPath",
    "jobKey",
    "jobId",
    "jobName",
    "environment",
    "runnerClass"
  ]);
  for (const field of ["repository", "repositoryId", "runAttempt", "runnerClass"])
    requireThat(ci[field] === policy[field]);
  for (const field of ["runId", "jobId"])
    requireThat(
      typeof ci[field] === "string" &&
        /^[1-9][0-9]*$/u.test(ci[field]) &&
        Number.isSafeInteger(Number(ci[field]))
    );
  requireThat(
    ci.workflowPath === (source ? policy.source.workflowPath : policy.final.workflowPath) &&
      ci.callerWorkflowPath ===
        (source ? policy.source.workflowPath : policy.final.callerWorkflowPath) &&
      ci.jobKey === (source ? policy.source.jobs[value.chain] : policy.final.jobId) &&
      ci.jobName ===
        (source
          ? policy.source.jobs[value.chain]
          : `${policy.final.callerJobs[value.chain]} / ${policy.final.jobId}`) &&
      ci.environment === (source ? policy.source.environment : policy.final.environment)
  );
  const host = value.host;
  exact(host, [
    "machineIdFingerprint",
    "forwardingPublicKeyPem",
    "forwardingKeyFingerprint",
    "runnerId",
    "runnerName"
  ]);
  for (const field of ["machineIdFingerprint", "forwardingKeyFingerprint"])
    requireThat(typeof host[field] === "string" && DIGEST.test(host[field]));
  requireThat(
    Number.isSafeInteger(host.runnerId) &&
      host.runnerId >= 0 &&
      typeof host.runnerName === "string" &&
      host.runnerName.length > 0 &&
      host.runnerName.length <= 256 &&
      typeof host.forwardingPublicKeyPem === "string"
  );
  const key = createPublicKey(host.forwardingPublicKeyPem);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      key.export({ type: "spki", format: "pem" }) === host.forwardingPublicKeyPem &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === host.forwardingKeyFingerprint
  );
}

function r3JobApiIdentity(admission, run, job) {
  const { ci, host } = admission;
  requireThat(
    run.id === Number(ci.runId) &&
      run.run_attempt === 1 &&
      run.head_sha === admission.sourceSha &&
      run.head_branch === "main" &&
      run.path === ci.callerWorkflowPath &&
      run.html_url === `https://github.com/${REPOSITORY}/actions/runs/${ci.runId}`
  );
  for (const repo of [run.repository, run.head_repository])
    requireThat(repo?.full_name === REPOSITORY && repo.id === Number(ci.repositoryId));
  requireThat(
    job.id === Number(ci.jobId) &&
      job.run_id === Number(ci.runId) &&
      job.head_sha === admission.sourceSha &&
      job.name === ci.jobName &&
      job.runner_id === host.runnerId &&
      job.runner_name === host.runnerName &&
      (job.run_attempt === undefined || job.run_attempt === 1) &&
      typeof job.started_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(job.started_at) &&
      Number.isFinite(Date.parse(job.started_at)) &&
      Date.parse(job.started_at) <= instant(admission.generatedAt)
  );
}

// A signed hosted-job declaration plus independent current API readbacks.
// This returns evidence, not a manual consume decision or a connected target.
export async function readFixedR3JobAdmission(input) {
  const code = "R3_JOB_ADMISSION_UNAVAILABLE";
  let creation,
    held,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...(creation ? [creation.close()] : []),
        ...(held ? [held.close()] : [])
      ]);
      held?.bytes.fill(0);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "operationRef"]);
    requireThat(
      typeof input.repoRoot === "string" &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef)
    );
    const repoRoot = absolute(input.repoRoot),
      operationRef = input.operationRef;
    requireThat(process.platform === "linux");
    creation = await readFixedR3CreationSpec({ repoRoot, operationRef });
    const profile = await loadFixedManualProfile({ repoRoot }),
      { principal } = await actualHost(),
      file = path.join(
        profile.storage.archiveRoot,
        "inputs",
        "r3",
        operationRef,
        "job-admission.json"
      );
    requireThat(sha256Canonical(profile) === creation.profileDigest);
    held = await openInput(file, { principal, privateRoot: profile.storage.archiveRoot });
    const admission = json(held.bytes, true);
    r3JobDescriptor(admission, creation);
    const checkWindow = () => {
      const now = Date.now(),
        generated = instant(admission.generatedAt),
        expires = instant(admission.expiresAt);
      requireThat(
        instant(creation.spec.createdAt) <= generated &&
          generated <= now &&
          generated < expires &&
          now < expires &&
          expires <= instant(creation.spec.expiresAt)
      );
    };
    checkWindow();
    const ci = admission.ci,
      environment = fixedProcessEnvironment("gh");
    const command = async (args, boundary) => {
      try {
        return await processOutput("gh", args, { env: environment });
      } catch (cause) {
        const timeout = cause?.killed === true && cause?.signal === "SIGTERM";
        markR3JobAdmissionCause(
          cause,
          `R3_JOB_${boundary}_COMMAND_${timeout ? "TIMEOUT" : "FAILED"}`
        );
        throw cause;
      }
    };
    const parsed = (boundary, action) => {
      try {
        return action();
      } catch (cause) {
        if (cause instanceof SyntaxError || cause instanceof TypeError)
          markR3JobAdmissionCause(cause, `R3_JOB_${boundary}_RESPONSE_INVALID`);
        throw cause;
      }
    };
    const attestationBytes = await command(
      attestationArgs(file, admission.sourceSha, ci.workflowPath),
      "ATTESTATION"
    );
    const verifiedAttestation = parsed("ATTESTATION", () =>
      attestation(
        attestationBytes,
        sha256Bytes(held.bytes),
        admission.sourceSha,
        Math.floor(instant(admission.generatedAt) / 1000) * 1000,
        { signer: ci.workflowPath, caller: ci.callerWorkflowPath, repositoryId: ci.repositoryId }
      )
    );
    requireThat(verifiedAttestation.workflowRunId === ci.runId);
    const api = async (endpoint, boundary) => command(["api", endpoint], boundary);
    const recheck = async () => {
      try {
        requireThat(!closed);
        checkWindow();
        await creation.recheck();
        await held.recheck();
        let firstFailure;
        const observe = (promise) =>
          promise.catch((error) => {
            firstFailure ??= error;
            throw error;
          });
        const responses = await Promise.allSettled([
          observe(api(`repos/${REPOSITORY}/actions/runs/${ci.runId}/attempts/1`, "RUN_API")),
          observe(api(`repos/${REPOSITORY}/actions/jobs/${ci.jobId}`, "JOB_API"))
        ]);
        if (firstFailure) throw firstFailure;
        const runBytes = responses[0].value,
          jobBytes = responses[1].value,
          run = parsed("RUN_API", () => json(runBytes)),
          job = parsed("JOB_API", () => json(jobBytes));
        r3JobApiIdentity(admission, run, job);
        requireThat(
          run.status === "in_progress" &&
            run.conclusion === null &&
            job.status === "in_progress" &&
            job.conclusion === null &&
            job.completed_at === null
        );
        await held.recheck();
        await creation.recheck();
        checkWindow();
        requireThat(!closed);
        const rawInputs = Object.freeze({
          admission: Buffer.from(held.bytes),
          attestation: Buffer.from(attestationBytes),
          run: Buffer.from(runBytes),
          job: Buffer.from(jobBytes)
        });
        const observations = freeze({
          checkedAt: new Date().toISOString(),
          ...Object.fromEntries(
            Object.entries(rawInputs).map(([name, bytes]) => [
              name,
              { digest: sha256Bytes(bytes), bytes: bytes.length }
            ])
          )
        });
        return Object.freeze({ observations, rawInputs });
      } catch (cause) {
        await close().catch(() => {});
        failWithCause(code, cause);
      }
    };
    const readback = await recheck();
    const owner = Object.freeze({
      admission: freeze(admission),
      jobAdmissionDigest: sha256Bytes(held.bytes),
      creationSpecDigest: creation.creationSpecDigest,
      spec: creation.spec,
      policy: creation.policy,
      databaseTargetPolicy: creation.databaseTargetPolicy,
      databaseTestManifest: creation.databaseTestManifest,
      databaseTestManifestRawDigest: creation.databaseTestManifestRawDigest,
      build: creation.build,
      buildMaterialObservation: creation.buildMaterialObservation,
      sourceSha: creation.sourceSha,
      verifiedAttestation,
      ...readback,
      recheck,
      close
    });
    fixedR3JobOwners.set(owner, { repoRoot, operationRef, isClosed: () => closed });
    return owner;
  } catch (cause) {
    await close().catch(() => {});
    failWithCause(code, cause);
  }
}

export async function borrowFixedR3JobAdmission(owner, selector) {
  const code = "R3_JOB_ADMISSION_UNAVAILABLE";
  try {
    exact(selector, ["repoRoot", "operationRef"]);
    const registered = fixedR3JobOwners.get(owner);
    requireThat(
      registered &&
        !registered.isClosed() &&
        absolute(selector.repoRoot) === registered.repoRoot &&
        selector.operationRef === registered.operationRef &&
        UUID.test(selector.operationRef),
      code
    );
    await owner.recheck();
    requireThat(!registered.isClosed(), code);
    let closed = false;
    return Object.freeze({
      ...owner,
      recheck: async () => {
        requireThat(!closed, code);
        const result = await owner.recheck();
        requireThat(!closed && !registered.isClosed(), code);
        return result;
      },
      close: async () => {
        closed = true;
      }
    });
  } catch {
    fail(code);
  }
}

// Internal H1/H2 input reader shared by history replay and live admission.
// The core supplies the binding from its verified graph. Reading these inputs
// alone neither verifies execution history nor grants execution authority.
export async function readTrustedR3HistoricalContext(input) {
  const code = "R3_HISTORY_CONTEXT_UNAVAILABLE",
    opened = [],
    policies = new Map(),
    jobs = [];
  let closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...opened.map((item) => item.close()),
        ...[...policies.values()].map((item) => item.close())
      ]);
      for (const item of opened) item.bytes.fill(0);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    const hasCleanup = input && Object.hasOwn(input, "latestCleanupAt");
    const { repoRoot, operationRef } = r3EvidenceSelector(input, [
      "scope",
      "latestExecutionAt",
      ...(hasCleanup ? ["latestCleanupAt"] : [])
    ]);
    exact(input.scope, [
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest",
      "buildProofDigest",
      "sourceSha",
      "phase",
      "chain"
    ]);
    requireThat(
      ["targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest", "buildProofDigest"].every(
        (field) => typeof input.scope[field] === "string" && DIGEST.test(input.scope[field])
      ) &&
        typeof input.scope.sourceSha === "string" &&
        /^[0-9a-f]{40}$/u.test(input.scope.sourceSha) &&
        ["source", "final"].includes(input.scope.phase) &&
        ["fresh", "snapshot"].includes(input.scope.chain)
    );
    instant(input.latestExecutionAt);
    if (hasCleanup) instant(input.latestCleanupAt);
    const boundContext = freeze({
      operationRef,
      scope: { ...input.scope },
      latestExecutionAt: input.latestExecutionAt,
      ...(hasCleanup ? { latestCleanupAt: input.latestCleanupAt } : {})
    });
    const profile = await loadManualProfile({ repoRoot }, false),
      profileDigest = sha256Canonical(profile),
      actual = await actualHost(),
      archiveRoot = profile.storage.archiveRoot,
      environment = fixedProcessEnvironment("gh");
    const read = async (file) => {
      requireThat(!closed);
      const held = await openInput(file, { principal: actual.principal, privateRoot: archiveRoot });
      opened.push(held);
      requireThat(held.bytes.length > 0 && !closed);
      return held.bytes;
    };
    {
      const context = boundContext;
      const { scope } = context;
      const root = path.join(archiveRoot, "inputs", "r3", context.operationRef),
        specBytes = await read(path.join(root, "creation-spec.json")),
        spec = json(specBytes, true),
        admissionPath = path.join(root, "job-admission.json"),
        admissionBytes = await read(admissionPath),
        admission = json(admissionBytes, true);
      r3CreationSpec(spec, context.operationRef, profile);
      requireThat(
        sha256Bytes(specBytes) === scope.creationSpecDigest &&
          sha256Bytes(admissionBytes) === scope.jobAdmissionDigest &&
          ["sourceSha", "buildProofDigest", "targetPolicyDigest", "phase", "chain"].every(
            (field) => spec[field] === scope[field]
          )
      );
      const historicalBinding = {
        operationRef: context.operationRef,
        profileDigest,
        sourceSha: spec.sourceSha,
        proofRawDigest: spec.proofRawDigest,
        materialRawDigest: spec.materialRawDigest,
        creationSpecDigest: scope.creationSpecDigest,
        jobAdmissionDigest: scope.jobAdmissionDigest
      };
      const historicalSourceRoot = approvedR3HistoricalSourceBinding(historicalBinding),
        historicalContract = approvedR3HistoricalContractCompatibility(historicalBinding);
      if (historicalContract) {
        requireThat(historicalContract.sourceRoot === historicalSourceRoot);
        await checkoutSource(historicalSourceRoot, spec.sourceSha);
      }
      const policyKey = `${spec.proofRawDigest}/${spec.materialRawDigest}`;
      if (!policies.has(policyKey)) {
        const buildRoot = path.join(archiveRoot, "inputs", "build"),
          proofBytes = await read(
            path.join(buildRoot, `${spec.proofRawDigest.slice(7)}.proof.json`)
          ),
          materialBytes = await read(
            path.join(buildRoot, `${spec.materialRawDigest.slice(7)}.material.json`)
          );
        requireThat(
          sha256Bytes(proofBytes) === spec.proofRawDigest &&
            sha256Bytes(materialBytes) === spec.materialRawDigest
        );
        policies.set(
          policyKey,
          await readR3TargetPolicyInput(
            { repoRoot: historicalSourceRoot ?? repoRoot, proofBytes, materialBytes },
            false,
            repoRoot,
            historicalContract
          )
        );
      }
      const policyInput = policies.get(policyKey),
        roots = policyInput.policy.workspace,
        workspace = spec.workspace;
      requireThat(
        spec.buildProofDigest === policyInput.build.buildProofDigest &&
          spec.sourceSha === policyInput.sourceSha &&
          spec.profileDigest === policyInput.profileDigest &&
          spec.targetPolicyDigest === policyInput.policyRawDigest &&
          workspace.backingFile === path.posix.join(roots.backingRoot, `${workspace.id}.luks`) &&
          workspace.mountPath === path.posix.join(roots.mountRoot, workspace.id) &&
          workspace.keyFile === path.posix.join(roots.keyRoot, `${workspace.id}.key`) &&
          workspace.mapperName === `${roots.mapperPrefix}${workspace.id}`
      );
      r3JobDescriptor(admission, {
        spec,
        creationSpecDigest: scope.creationSpecDigest,
        policy: policyInput.policy
      });
      const latestExecutionAt = instant(context.latestExecutionAt);
      const latestHostedAt = hasCleanup
        ? Math.max(latestExecutionAt, instant(context.latestCleanupAt))
        : latestExecutionAt;
      requireThat(
        instant(profile.validFrom) <= instant(spec.createdAt) &&
          instant(spec.createdAt) <= instant(admission.generatedAt) &&
          instant(admission.generatedAt) <= latestExecutionAt &&
          latestExecutionAt < instant(admission.expiresAt) &&
          instant(admission.expiresAt) <= instant(spec.expiresAt) &&
          instant(spec.expiresAt) <= instant(profile.expiresAt) &&
          latestHostedAt < instant(admission.expiresAt) &&
          (!hasCleanup || latestExecutionAt <= instant(context.latestCleanupAt)) &&
          latestHostedAt <= Date.now()
      );
      const ci = admission.ci,
        attestationBytes = await processOutput(
          "gh",
          attestationArgs(admissionPath, admission.sourceSha, ci.workflowPath),
          { env: environment }
        ),
        verified = attestation(
          attestationBytes,
          sha256Bytes(admissionBytes),
          admission.sourceSha,
          Math.floor(instant(admission.generatedAt) / 1000) * 1000,
          { signer: ci.workflowPath, caller: ci.callerWorkflowPath, repositoryId: ci.repositoryId }
        );
      requireThat(verified.workflowRunId === ci.runId);
      jobs.push({ admission, latestHostedAt });
    }
    const api = (endpoint) => processOutput("gh", ["api", endpoint], { env: environment });
    const recheck = async () => {
      try {
        requireThat(!closed);
        requireThat(equal(await actualHost(), actual));
        requireThat(
          sha256Canonical(await loadManualProfile({ repoRoot }, false)) === profileDigest
        );
        for (const policy of policies.values()) await policy.recheck();
        for (const { admission, latestHostedAt } of jobs) {
          const ci = admission.ci,
            run = json(await api(`repos/${REPOSITORY}/actions/runs/${ci.runId}/attempts/1`)),
            job = json(await api(`repos/${REPOSITORY}/actions/jobs/${ci.jobId}`));
          r3JobApiIdentity(admission, run, job);
          for (const value of [run, job])
            requireThat(
              (value.status === "in_progress" && value.conclusion === null) ||
                (value.status === "completed" &&
                  typeof value.conclusion === "string" &&
                  value.conclusion.length > 0)
            );
          requireThat(run.status !== "completed" || job.status === "completed");
          if (job.status === "in_progress") requireThat(job.completed_at === null);
          else {
            requireThat(
              typeof job.completed_at === "string" &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(job.completed_at)
            );
            const completedAt = Date.parse(job.completed_at);
            // GitHub timestamps may have only second precision.
            const precision = job.completed_at.includes(".") ? 0 : 999;
            requireThat(
              Number.isFinite(completedAt) &&
                latestHostedAt <= completedAt + precision &&
                completedAt <= Date.now()
            );
          }
        }
        for (const item of opened) await item.recheck();
        requireThat(!closed);
      } catch (cause) {
        await close();
        failWithCause(code, cause);
      }
    };
    await recheck();
    return Object.freeze({
      profileDigest,
      operationRef,
      scope: boundContext.scope,
      latestExecutionAt: boundContext.latestExecutionAt,
      ...(hasCleanup ? { latestCleanupAt: boundContext.latestCleanupAt } : {}),
      recheck,
      close
    });
  } catch (cause) {
    await close();
    failWithCause(code, cause);
  }
}

// Public selector-only reader: derive the contexts from the complete graph
// before independently authenticating each context's retained H1/H2 inputs.
export async function readTrustedR3SourceCompletion(input) {
  const code = "R3_SOURCE_HISTORY_UNAVAILABLE",
    contexts = [];
  let history,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...contexts.map((context) => context.close()),
        ...(history ? [history.close()] : [])
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    const { repoRoot, operationRef } = r3EvidenceSelector(input, ["executionRecordDigest"]);
    requireThat(
      typeof input.executionRecordDigest === "string" && DIGEST.test(input.executionRecordDigest)
    );
    const profile = await loadManualProfile({ repoRoot }, false),
      profileDigest = sha256Canonical(profile),
      actual = await actualHost();
    const { readManualR3SourceHistory } =
      await import("../../packages/release-foundation/src/manual-stage1-session.mjs");
    history = await readManualR3SourceHistory({
      profile,
      ownerObservation: {
        ownerId: profile.ownerId,
        principal: actual.principal,
        observedAt: new Date().toISOString()
      },
      repoRoot,
      terminalExecutionRecordDigest: input.executionRecordDigest,
      now: () => new Date().toISOString()
    });
    requireThat(
      history.profileDigest === profileDigest &&
        history.operationRef === operationRef &&
        history.executionRecordDigest === input.executionRecordDigest &&
        history.scope.phase === "source" &&
        history.promotionEligible === false &&
        DIGEST.test(history.resultDigest) &&
        DIGEST.test(history.acknowledgementRecordDigest) &&
        Array.isArray(history.verifiedContexts) &&
        history.verifiedContexts.length > 0
    );
    const operations = new Set();
    for (const context of history.verifiedContexts) {
      requireThat(!operations.has(context.operationRef));
      operations.add(context.operationRef);
      const held = await readTrustedR3HistoricalContext({
        repoRoot,
        operationRef: context.operationRef,
        scope: context.scope,
        latestExecutionAt: context.latestExecutionAt,
        ...(Object.hasOwn(context, "latestCleanupAt")
          ? { latestCleanupAt: context.latestCleanupAt }
          : {})
      });
      contexts.push(held);
      requireThat(held.profileDigest === profileDigest && equal(held.scope, context.scope));
    }
    requireThat(operations.has(operationRef));
    const recheck = async () => {
      try {
        requireThat(!closed);
        requireThat(equal(await actualHost(), actual));
        requireThat(
          sha256Canonical(await loadManualProfile({ repoRoot }, false)) === profileDigest
        );
        for (const context of contexts) await context.recheck();
        await history.recheck();
        requireThat(!closed);
      } catch {
        await close();
        fail(code);
      }
    };
    await recheck();
    return Object.freeze({
      profileDigest,
      operationRef,
      sessionId: history.sessionId,
      sessionNonce: history.sessionNonce,
      scope: history.scope,
      executionRecordDigest: history.executionRecordDigest,
      resultDigest: history.resultDigest,
      acknowledgementRecordDigest: history.acknowledgementRecordDigest,
      sourceGateEvidence: freeze(JSON.parse(encodeManualJson(history.sourceGateEvidence))),
      sourceGateEvidenceDigest: history.sourceGateEvidenceDigest,
      closedAt: history.closedAt,
      promotionEligible: false,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
  }
}

// Select a single completed final candidate from the independently replayed
// full manual graph, then pin every historical H1/H2 context. This reader does
// not turn an unresolved or second candidate into an empty retry history.
export async function readTrustedR3FinalCompletion(input) {
  const code = "R3_FINAL_HISTORY_UNAVAILABLE",
    contexts = [];
  let history,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...contexts.map((context) => context.close()),
        ...(history ? [history.close()] : [])
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    const { repoRoot, operationRef } = r3EvidenceSelector(input, ["executionRecordDigest"]);
    requireThat(
      typeof input.executionRecordDigest === "string" && DIGEST.test(input.executionRecordDigest)
    );
    const profile = await loadManualProfile({ repoRoot }, false),
      profileDigest = sha256Canonical(profile),
      actual = await actualHost();
    const { readManualR3FinalHistory } =
      await import("../../packages/release-foundation/src/manual-stage1-session.mjs");
    history = await readManualR3FinalHistory({
      profile,
      ownerObservation: {
        ownerId: profile.ownerId,
        principal: actual.principal,
        observedAt: new Date().toISOString()
      },
      repoRoot,
      terminalExecutionRecordDigest: input.executionRecordDigest,
      now: () => new Date().toISOString()
    });
    requireThat(
      history.schemaVersion === "final-native-attempt-history.v1" &&
        history.profileDigest === profileDigest &&
        history.selected.operationId === operationRef &&
        history.selected.terminalExecutionDigest === input.executionRecordDigest &&
        history.matchingRequestDigests.length === 1 &&
        history.matchingRequestDigests[0] === history.selected.requestDigest &&
        Array.isArray(history.verifiedContexts) &&
        history.verifiedContexts.length > 0
    );
    const operations = new Set();
    for (const context of history.verifiedContexts) {
      requireThat(!operations.has(context.operationRef));
      operations.add(context.operationRef);
      const held = await readTrustedR3HistoricalContext({
        repoRoot,
        operationRef: context.operationRef,
        scope: context.scope,
        latestExecutionAt: context.latestExecutionAt,
        ...(Object.hasOwn(context, "latestCleanupAt")
          ? { latestCleanupAt: context.latestCleanupAt }
          : {})
      });
      contexts.push(held);
      requireThat(held.profileDigest === profileDigest && equal(held.scope, context.scope));
    }
    requireThat(operations.has(operationRef));
    const recheck = async () => {
      try {
        requireThat(!closed);
        requireThat(equal(await actualHost(), actual));
        requireThat(
          sha256Canonical(await loadManualProfile({ repoRoot }, false)) === profileDigest
        );
        for (const context of contexts) await context.recheck();
        await history.recheck();
        requireThat(!closed);
      } catch {
        await close();
        fail(code);
      }
    };
    await recheck();
    const attemptHistory = Object.fromEntries(
      [
        "schemaVersion",
        "profileDigest",
        "ownerId",
        "chain",
        "sourceSha",
        "buildProofDigest",
        "matchingSourceEvidenceDigest",
        "sourceGateEvidenceDigest",
        "ci",
        "matchingRequestDigests",
        "selected",
        "verifiedAt"
      ].map((key) => [key, history[key]])
    );
    return Object.freeze({ attemptHistory: freeze(attemptHistory), recheck, close });
  } catch {
    await close();
    fail(code);
  }
}

// Job-key provenance and independently reconstructed storage facts only. Even
// an absent observation still needs its original live job; it cannot release a
// resource lock or stand in for the complete Engine/PG cleanup result.
export async function readFixedR3WorkspaceObservation(input) {
  const code = "R3_WORKSPACE_INPUT_UNAVAILABLE",
    opened = [];
  let job,
    admissionBytes,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...opened.map((item) => item.close()),
        ...(job ? [job.close()] : [])
      ]);
      for (const item of opened) item.bytes.fill(0);
      admissionBytes?.fill(0);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "operationRef", "state"]);
    requireThat(
      typeof input.repoRoot === "string" &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef) &&
        ["active", "absent"].includes(input.state)
    );
    const repoRoot = absolute(input.repoRoot),
      { operationRef, state } = input;
    requireThat(process.platform === "linux");
    job = await readFixedR3JobAdmission({ repoRoot, operationRef });
    admissionBytes = Buffer.from(job.rawInputs.admission);
    const profile = await loadFixedManualProfile({ repoRoot }),
      { principal } = await actualHost(),
      archiveRoot = profile.storage.archiveRoot,
      root = path.join(archiveRoot, "inputs", "r3", operationRef, "observations", state),
      privateOptions = { principal, privateRoot: archiveRoot };
    requireThat(
      sha256Canonical(profile) === job.spec.profileDigest &&
        sha256Bytes(admissionBytes) === job.jobAdmissionDigest
    );
    const read = async (file, options = privateOptions) => {
      requireThat(!closed);
      const held = await openInput(file, options);
      opened.push(held);
      requireThat(!closed);
      return held.bytes;
    };
    const policyBytes = await read(
        path.join(repoRoot, "release/contracts/manual-stage1-r3-target-policy.v1.json"),
        { principal, sourceRoot: repoRoot }
      ),
      observationBytes = await read(path.join(root, `workspace-${state}.json`)),
      bindingBytes = await read(path.join(root, `workspace-${state}.binding.json`));
    requireThat(sha256Bytes(policyBytes) === job.spec.targetPolicyDigest);
    const declared = json(observationBytes, true);
    requireThat(declared.operationRef === operationRef && declared.state === state);
    verifyR3WorkspaceBinding({ bindingBytes, observationBytes, jobAdmissionBytes: admissionBytes });

    // Read only the fixed collector names, addressed by validated digest. The
    // report assessor then checks every field and reconstructs all facts.
    const processNames = [
        "mounts",
        "loops",
        "blocks",
        ...(state === "active" ? ["mapper", "header", "uuid"] : [])
      ],
      fileNames = ["policy", "machineId", ...(state === "active" ? ["swaps", "limits"] : [])];
    requireThat(
      Array.isArray(declared.processes) &&
        declared.processes.length === processNames.length &&
        Array.isArray(declared.files) &&
        declared.files.length === (state === "active" ? 8 : 6)
    );
    const blobs = new Map(),
      raw = Object.create(null);
    const readRaw = async (name, ref) => {
      exact(ref, ["digest", "bytes"]);
      requireThat(
        typeof ref.digest === "string" &&
          DIGEST.test(ref.digest) &&
          Number.isSafeInteger(ref.bytes) &&
          ref.bytes >= 0 &&
          ref.bytes <= LIMIT
      );
      if (!blobs.has(ref.digest))
        blobs.set(ref.digest, await read(path.join(root, "raw", `${ref.digest.slice(7)}.bin`)));
      const bytes = blobs.get(ref.digest);
      requireThat(bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest);
      raw[name] = bytes;
    };
    for (let index = 0; index < processNames.length; index++) {
      const name = processNames[index],
        row = declared.processes[index];
      requireThat(row?.name === name);
      await readRaw(`${name}.stdout`, row.stdout);
      await readRaw(`${name}.stderr`, row.stderr);
    }
    for (const name of fileNames) {
      const matching = declared.files.filter((row) => row?.name === name);
      requireThat(matching.length === 1);
      await readRaw(name, { digest: matching[0].digest, bytes: matching[0].bytes });
    }
    Object.freeze(raw);
    const assess = () => {
      verifyR3WorkspaceBinding({
        bindingBytes,
        observationBytes,
        jobAdmissionBytes: admissionBytes
      });
      return assessR3WorkspaceReport({
        observationBytes,
        rawInputs: raw,
        jobAdmissionBytes: admissionBytes,
        spec: job.spec,
        policyBytes,
        now: new Date().toISOString()
      });
    };
    const observation = assess();
    const recheck = async () => {
      try {
        requireThat(!closed);
        await job.recheck();
        for (const item of opened) await item.recheck();
        assess();
        const jobReadback = await job.recheck();
        for (const item of opened) await item.recheck();
        assess();
        requireThat(!closed);
        return Object.freeze({
          jobReadback,
          rawInputs: Object.freeze(
            Object.fromEntries(
              Object.entries({ observation: observationBytes, binding: bindingBytes, ...raw }).map(
                ([name, bytes]) => [name, Buffer.from(bytes)]
              )
            )
          )
        });
      } catch {
        await close();
        fail(code);
      }
    };
    const readback = await recheck();
    return Object.freeze({
      observation,
      observationDigest: sha256Bytes(observationBytes),
      bindingDigest: sha256Bytes(bindingBytes),
      jobAdmissionDigest: job.jobAdmissionDigest,
      creationSpecDigest: job.creationSpecDigest,
      spec: job.spec,
      policy: job.policy,
      build: job.build,
      sourceSha: job.sourceSha,
      ...readback,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
  }
}

function r3EvidenceSelector(input, additional = []) {
  exact(input, ["repoRoot", "operationRef", ...additional]);
  requireThat(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      typeof input.repoRoot === "string" &&
      typeof input.operationRef === "string" &&
      UUID.test(input.operationRef)
  );
  return { repoRoot: absolute(input.repoRoot), operationRef: input.operationRef };
}
const r3EvidenceRoot = (storageRoot, operationRef, state = "active") =>
  path.join(storageRoot, "inputs", "r3", operationRef, "observations", state);

// Reserve child directories before any job/source handles pin their parents.
// This does not import observations, acquire a capability or consume an operation.
export async function prepareR3HostedEvidenceImport(input) {
  const code = "R3_HOSTED_EVIDENCE_INPUT_UNAVAILABLE";
  try {
    const { repoRoot, operationRef } = r3EvidenceSelector(input);
    const profile = await loadFixedManualProfile({ repoRoot });
    const { principal } = await actualHost();
    const manifest = json(
      await fs.readFile(path.join(repoRoot, "release/contracts/database-test-manifest.v1.json"))
    );
    validateContract("database-test-manifest.v1", manifest);
    const { planR3DatabaseTargets } = await import("./r3-database-targets.mjs");
    // Names do not depend on fresh/snapshot roles; reserve both execution
    // phases before private parent directories are pinned.
    const finalPlan = planR3DatabaseTargets({
      operationRef,
      phase: "final",
      chain: "fresh",
      manifest
    });
    requireThat(
      manifest.suites.every(({ suiteId }) => /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(suiteId))
    );
    const archiveOperation = path.join(profile.storage.archiveRoot, "inputs", "r3", operationRef);
    requireThat(
      (
        await checkedPath(archiveOperation, {
          principal,
          privateRoot: profile.storage.archiveRoot
        })
      )
        .at(-1)
        .stat.isDirectory()
    );
    // The snapshot input UUID is owner-imported after target creation. Reserve
    // its parent before fixed job handles pin their private ancestors.
    const snapshots = path.join(profile.storage.archiveRoot, "inputs", "snapshots");
    try {
      await fs.mkdir(snapshots, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    requireThat(
      (
        await checkedPath(snapshots, {
          principal,
          privateRoot: profile.storage.archiveRoot
        })
      )
        .at(-1)
        .stat.isDirectory()
    );
    for (const storageRoot of [profile.storage.archiveRoot, profile.storage.backupRoot]) {
      let directory = storageRoot;
      const segments = ["inputs", "r3", operationRef, "observations"];
      for (const segment of segments) {
        directory = path.join(directory, segment);
        try {
          await fs.mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        requireThat(
          (await checkedPath(directory, { principal, privateRoot: storageRoot }))
            .at(-1)
            .stat.isDirectory()
        );
      }
      for (const state of ["active", "absent", "lifecycle", "source", "final", "cleanup"]) {
        const leaf = path.join(directory, state);
        try {
          await fs.mkdir(leaf, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        requireThat(
          (await checkedPath(leaf, { principal, privateRoot: storageRoot }))
            .at(-1)
            .stat.isDirectory()
        );
        if (["source", "final"].includes(state)) {
          for (const name of [
            "attempt",
            "manifest",
            ...manifest.suites.map(({ suiteId }) => suiteId),
            ...(state === "final"
              ? [
                  "runtime",
                  "application",
                  "source",
                  ...[...finalPlan.targets, ...finalPlan.reservations].map(
                    ({ databaseName }) => databaseName
                  )
                ]
              : [])
          ]) {
            const suiteDirectory = path.join(leaf, name);
            try {
              await fs.mkdir(suiteDirectory, { mode: 0o700 });
            } catch (error) {
              if (error.code !== "EEXIST") throw error;
            }
            requireThat(
              (await checkedPath(suiteDirectory, { principal, privateRoot: storageRoot }))
                .at(-1)
                .stat.isDirectory()
            );
          }
        }
        if (storageRoot === profile.storage.archiveRoot && ["active", "absent"].includes(state)) {
          const raw = path.join(leaf, "raw");
          try {
            await fs.mkdir(raw, { mode: 0o700 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          requireThat(
            (await checkedPath(raw, { principal, privateRoot: storageRoot }))
              .at(-1)
              .stat.isDirectory()
          );
        }
      }
    }
    return Object.freeze({ operationRef, promotionEligible: false });
  } catch {
    fail(code);
  }
}

// The only input bytes here are untrusted evidence. A verified live job and its
// attested code/key establish provenance; import does not make creation succeed.
export async function importR3HostedEvidence(input) {
  const code = "R3_HOSTED_EVIDENCE_INPUT_UNAVAILABLE";
  let job, policy;
  try {
    const selector = r3EvidenceSelector(input, ["bundleBytes"]);
    requireThat(
      Buffer.isBuffer(input.bundleBytes) &&
        input.bundleBytes.length > 0 &&
        input.bundleBytes.length <= LIMIT
    );
    const bundleBytes = Buffer.from(input.bundleBytes);
    job = await readFixedR3JobAdmission(selector);
    const profile = await loadFixedManualProfile({ repoRoot: selector.repoRoot });
    const { principal } = await actualHost();
    policy = await openInput(
      path.join(selector.repoRoot, "release/contracts/manual-stage1-r3-target-policy.v1.json"),
      { principal, sourceRoot: selector.repoRoot }
    );
    const verified = verifyR3HostedEvidence({
      bundleBytes,
      jobAdmissionBytes: job.rawInputs.admission,
      spec: job.spec,
      policyBytes: policy.bytes,
      now: new Date().toISOString()
    });
    const root = r3EvidenceRoot(profile.storage.archiveRoot, selector.operationRef);
    const backup = r3EvidenceRoot(profile.storage.backupRoot, selector.operationRef);
    const optionsFor = (file) => ({
      principal,
      privateRoot: within(profile.storage.archiveRoot, file)
        ? profile.storage.archiveRoot
        : profile.storage.backupRoot
    });
    const directories = new Map();
    for (const dir of [root, path.join(root, "raw"), backup]) {
      const checked = await checkedPath(dir, optionsFor(dir));
      requireThat(checked.at(-1).stat.isDirectory());
      directories.set(dir, checked.at(-1).stat);
    }
    const check = async () => {
      await policy.recheck();
      for (const [dir, initial] of directories) {
        const current = (await checkedPath(dir, optionsFor(dir))).at(-1).stat;
        requireThat(current.isDirectory() && sameIdentity(initial, current, false));
      }
    };
    const write = async (file, bytes) => {
      await check();
      requireThat(
        Buffer.isBuffer(bytes) && bytes.length <= LIMIT && directories.has(path.dirname(file))
      );
      const handle = await fs.open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
        0o600
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const observed = await openInput(file, optionsFor(file));
      try {
        requireThat(observed.bytes.equals(bytes));
        await observed.recheck();
      } finally {
        await observed.close();
      }
      await check();
    };
    await job.recheck();
    await write(
      path.join(root, "import-started.json"),
      encodeManualJson({
        operationRef: selector.operationRef,
        bundleDigest: verified.bundleDigest,
        jobAdmissionDigest: job.jobAdmissionDigest,
        startedAt: new Date().toISOString(),
        promotionEligible: false
      })
    );
    await write(path.join(backup, "hosted-evidence.json"), bundleBytes);
    await write(path.join(root, "hosted-evidence.json"), bundleBytes);
    const raw = new Map();
    for (const bytes of [
      ...Object.values(verified.workspace.rawInputs),
      ...Object.values(verified.engineRawInputs)
    ]) {
      const digest = sha256Bytes(bytes);
      if (raw.has(digest)) requireThat(raw.get(digest).equals(bytes));
      else raw.set(digest, bytes);
    }
    for (const [digest, bytes] of [...raw].sort(([a], [b]) => a.localeCompare(b)))
      await write(path.join(root, "raw", `${digest.slice(7)}.bin`), bytes);
    await write(path.join(root, "workspace-active.json"), verified.workspace.observationBytes);
    await write(path.join(root, "workspace-active.binding.json"), verified.workspace.bindingBytes);
    for (const dir of directories.keys()) {
      const handle = await fs.open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await check();
    await job.recheck();
    await policy.close();
    policy = null;
    await job.close();
    job = null;
    return await readFixedR3HostedEvidence(selector);
  } catch {
    fail(code);
  } finally {
    await policy?.close();
    await job?.close();
  }
}

export async function readFixedR3HostedEvidence(input) {
  const code = "R3_HOSTED_EVIDENCE_INPUT_UNAVAILABLE";
  let workspace,
    bundle,
    backup,
    closed = false;
  const close = async () => {
    closed = true;
    const results = await Promise.allSettled([
      workspace?.close(),
      bundle?.close(),
      backup?.close()
    ]);
    if (results.some((result) => result.status === "rejected")) fail(code);
  };
  try {
    const selector = r3EvidenceSelector(input);
    workspace = await readFixedR3WorkspaceObservation({ ...selector, state: "active" });
    const profile = await loadFixedManualProfile({ repoRoot: selector.repoRoot });
    const { principal } = await actualHost();
    bundle = await openInput(
      path.join(
        r3EvidenceRoot(profile.storage.archiveRoot, selector.operationRef),
        "hosted-evidence.json"
      ),
      { principal, privateRoot: profile.storage.archiveRoot }
    );
    backup = await openInput(
      path.join(
        r3EvidenceRoot(profile.storage.backupRoot, selector.operationRef),
        "hosted-evidence.json"
      ),
      { principal, privateRoot: profile.storage.backupRoot }
    );
    const assess = () => {
      requireThat(bundle.bytes.equals(backup.bytes));
      const value = verifyR3HostedEvidence({
        bundleBytes: bundle.bytes,
        jobAdmissionBytes: workspace.jobReadback.rawInputs.admission,
        spec: workspace.spec,
        policyBytes: workspace.rawInputs.policy,
        now: new Date().toISOString()
      });
      requireThat(
        value.workspace.observationBytes.equals(workspace.rawInputs.observation) &&
          value.workspace.bindingBytes.equals(workspace.rawInputs.binding)
      );
      return value;
    };
    const recheck = async () => {
      try {
        requireThat(!closed);
        await workspace.recheck();
        await bundle.recheck();
        await backup.recheck();
        return assess();
      } catch {
        await close();
        fail(code);
      }
    };
    const verified = await recheck();
    return Object.freeze({
      ...verified,
      workspaceObservation: workspace.observation,
      spec: workspace.spec,
      jobAdmissionDigest: workspace.jobAdmissionDigest,
      rawBundle: Buffer.from(bundle.bytes),
      jobAdmissionBytes: Buffer.from(workspace.jobReadback.rawInputs.admission),
      policyBytes: Buffer.from(workspace.rawInputs.policy),
      promotionEligible: false,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
  }
}

// Retained active reports identify the original owned workspace; this readback
// does not require that the cleaned workspace or its Engine still exists.
export async function readFixedR3HostedCleanupEvidence(input) {
  const code = "R3_HOSTED_CLEANUP_INPUT_UNAVAILABLE";
  let creation,
    bundle,
    backup,
    closed = false,
    closing;
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        creation?.close(),
        bundle?.close(),
        backup?.close()
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
    })();
    return closing;
  };
  try {
    const selector = r3EvidenceSelector(input);
    creation = await readFixedR3HostedEvidence(selector);
    const profile = await loadFixedManualProfile({ repoRoot: selector.repoRoot });
    const { principal } = await actualHost();
    const read = (storageRoot) =>
      openInput(
        path.join(
          r3EvidenceRoot(storageRoot, selector.operationRef, "cleanup"),
          "hosted-cleanup.json"
        ),
        { principal, privateRoot: storageRoot }
      );
    bundle = await read(profile.storage.archiveRoot);
    backup = await read(profile.storage.backupRoot);
    const assess = () => {
      requireThat(bundle.bytes.equals(backup.bytes));
      return verifyR3HostedCleanupEvidence({
        bundleBytes: bundle.bytes,
        creationEvidenceBytes: creation.rawBundle,
        jobAdmissionBytes: creation.jobAdmissionBytes,
        spec: creation.spec,
        policyBytes: creation.policyBytes,
        now: new Date().toISOString()
      });
    };
    const recheck = async () => {
      try {
        requireThat(!closed);
        await creation.recheck();
        await bundle.recheck();
        await backup.recheck();
        return assess();
      } catch {
        await close();
        fail(code);
      }
    };
    const verified = await recheck();
    return Object.freeze({
      ...verified,
      spec: creation.spec,
      jobAdmissionDigest: creation.jobAdmissionDigest,
      rawBundle: Buffer.from(bundle.bytes),
      creationRawBundle: Buffer.from(creation.rawBundle),
      jobAdmissionBytes: Buffer.from(creation.jobAdmissionBytes),
      policyBytes: Buffer.from(creation.policyBytes),
      promotionEligible: false,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
  }
}

// One import attempt, backup first, at reserved fixed paths. These untrusted
// bytes never grant cleanup success or release a session's locks by themselves.
export async function importR3HostedCleanupEvidence(input) {
  const code = "R3_HOSTED_CLEANUP_INPUT_UNAVAILABLE";
  let creation;
  try {
    const selector = r3EvidenceSelector(input, ["bundleBytes"]);
    requireThat(
      Buffer.isBuffer(input.bundleBytes) &&
        input.bundleBytes.length > 0 &&
        input.bundleBytes.length <= LIMIT
    );
    const bytes = Buffer.from(input.bundleBytes);
    creation = await readFixedR3HostedEvidence(selector);
    const verified = verifyR3HostedCleanupEvidence({
      bundleBytes: bytes,
      creationEvidenceBytes: creation.rawBundle,
      jobAdmissionBytes: creation.jobAdmissionBytes,
      spec: creation.spec,
      policyBytes: creation.policyBytes,
      now: new Date().toISOString()
    });
    const profile = await loadFixedManualProfile({ repoRoot: selector.repoRoot });
    const { principal } = await actualHost();
    const directories = [];
    for (const storageRoot of [profile.storage.archiveRoot, profile.storage.backupRoot]) {
      const directory = r3EvidenceRoot(storageRoot, selector.operationRef, "cleanup");
      const options = { principal, privateRoot: storageRoot };
      const stat = (await checkedPath(directory, options)).at(-1).stat;
      requireThat(stat.isDirectory());
      directories.push({ directory, options, stat });
    }
    const check = async () => {
      await creation.recheck();
      for (const item of directories) {
        const observed = (await checkedPath(item.directory, item.options)).at(-1).stat;
        requireThat(observed.isDirectory() && sameIdentity(item.stat, observed, false));
      }
    };
    const write = async (item, name, content) => {
      await check();
      const file = path.join(item.directory, name);
      const handle = await fs.open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
        0o600
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const readback = await openInput(file, item.options);
      try {
        requireThat(readback.bytes.equals(content));
        await readback.recheck();
      } finally {
        await readback.close();
      }
      const directory = await fs.open(item.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await check();
    };
    await write(
      directories[0],
      "import-started.json",
      encodeManualJson({
        operationRef: selector.operationRef,
        bundleDigest: verified.bundleDigest,
        creationEvidenceDigest: verified.creationEvidenceDigest,
        jobAdmissionDigest: creation.jobAdmissionDigest,
        startedAt: new Date().toISOString(),
        promotionEligible: false
      })
    );
    await write(directories[1], "hosted-cleanup.json", bytes);
    await write(directories[0], "hosted-cleanup.json", bytes);
    await creation.close();
    creation = null;
    return await readFixedR3HostedCleanupEvidence(selector);
  } catch {
    fail(code);
  } finally {
    await creation?.close();
  }
}

// Creation has no future destination facts. Its fixed live job and creation
// plan establish the scope before the existing H1 signing key is opened. The
// session itself owns the original revocation/consumption journal and locks.
export async function openTrustedR3CreationSession(input, verifiedAdmission) {
  const code = "R3_CREATION_SESSION_UNAVAILABLE";
  let fixed,
    session,
    policyInput,
    closed = false,
    closing,
    queue = Promise.resolve();
  const finish = (preserveLocks = false) => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = [];
      // Failure teardown cannot reuse a previously established cleanup receipt
      // to release locks after the outer current-trust checks have failed.
      if (session) {
        if (!preserveLocks) {
          try {
            await fixed.recheck();
            await policyInput?.recheck();
          } catch (reason) {
            preserveLocks = true;
            outcomes.push({ status: "rejected", reason });
          }
        }
        outcomes.push(
          ...(await Promise.allSettled([
            preserveLocks ? session.closeIncomplete() : session.close()
          ]))
        );
      }
      outcomes.push(...(await Promise.allSettled([policyInput?.close(), fixed?.close()])));
      if (outcomes.some((outcome) => outcome.status === "rejected")) fail(code);
      return outcomes[0]?.value;
    })();
    return closing;
  };
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const recheck = async () => {
    try {
      requireThat(!closed);
      await fixed.recheck();
      await policyInput?.recheck();
    } catch (cause) {
      failWithCause(code, cause);
    }
  };
  try {
    exact(input, ["repoRoot", "operationRef"]);
    requireThat(
      typeof input.repoRoot === "string" &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef) &&
        process.platform === "linux"
    );
    const repoRoot = absolute(input.repoRoot),
      operationRef = input.operationRef;
    fixed = verifiedAdmission
      ? await borrowFixedR3JobAdmission(verifiedAdmission, { repoRoot, operationRef })
      : await readFixedR3JobAdmission({ repoRoot, operationRef });
    const profile = await loadFixedManualProfile({ repoRoot }),
      { principal } = await actualHost(),
      spec = fixed.spec,
      scope = freeze({
        targetPolicyDigest: spec.targetPolicyDigest,
        creationSpecDigest: fixed.creationSpecDigest,
        jobAdmissionDigest: fixed.jobAdmissionDigest,
        buildProofDigest: fixed.build.buildProofDigest,
        sourceSha: fixed.sourceSha,
        phase: spec.phase,
        chain: spec.chain
      });
    requireThat(sha256Canonical(profile) === spec.profileDigest);
    policyInput = await openInput(
      path.join(repoRoot, "release/contracts/manual-stage1-r3-target-policy.v1.json"),
      { principal, sourceRoot: repoRoot }
    );
    requireThat(sha256Bytes(policyInput.bytes) === scope.targetPolicyDigest);
    await recheck();
    const keyRef = profile.storage.keyRef;
    requireThat(
      !path.isAbsolute(keyRef) &&
        path.normalize(keyRef) === keyRef &&
        keyRef.split(path.sep).every((part) => part !== "" && part !== "." && part !== "..")
    );
    const keyPath = path.join(profile.storage.keyRoot, keyRef);
    requireThat(within(profile.storage.keyRoot, keyPath) && keyPath !== profile.storage.keyRoot);
    let keyInput, signingKey;
    try {
      keyInput = await openInput(keyPath, { principal, privateRoot: profile.storage.keyRoot });
      signingKey = createPrivateKey(keyInput.bytes);
      requireThat(
        signingKey.asymmetricKeyType === "ed25519" &&
          sha256Bytes(createPublicKey(signingKey).export({ type: "spki", format: "der" })) ===
            profile.keyFingerprint
      );
      await keyInput.recheck();
      await recheck();
      session = await openManualSession({
        profile,
        ownerObservation: {
          ownerId: profile.ownerId,
          principal,
          scope,
          observedAt: new Date().toISOString()
        },
        r3CreationContext: {
          scope,
          creationSpec: spec,
          jobAdmission: fixed.admission,
          snapshotInputs: { repoRoot },
          destinationInputs: {
            manifest: fixed.databaseTestManifest,
            manifestRawDigest: fixed.databaseTestManifestRawDigest,
            policy: fixed.databaseTargetPolicy,
            policyBytesBase64: policyInput.bytes.toString("base64")
          }
        },
        now: () => new Date().toISOString(),
        signingKey
      });
      await recheck();
    } finally {
      keyInput?.bytes.fill(0);
      await keyInput?.close();
      signingKey = null;
    }
    exact(session, [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "scope",
      "sign",
      "consume",
      "holdTargets",
      "completeCreation",
      "registerLifecycleTarget",
      "completeSnapshot",
      "assertSnapshotConsumption",
      "assertCandidateUse",
      "verifySourceOriginals",
      "custodySourceOriginals",
      "completeSource",
      "verifyFinalOriginals",
      "custodyFinalOriginals",
      "completeFinal",
      "acknowledgeSource",
      "acknowledgeFinal",
      "completeCleanup",
      "closeIncomplete",
      "record",
      "close"
    ]);
    requireThat(equal(session.scope, scope) && session.profileDigest === spec.profileDigest);
    const action = (method, args) =>
      serial(async () => {
        requireThat(!closed, code);
        try {
          if (method === "sign")
            await runR3StartupTiming(operationRef, "SIGN_OUTER_RECHECK", () => recheck());
          else await recheck();
          const result = await session[method](...args);
          if (method === "sign")
            await runR3StartupTiming(operationRef, "SIGN_OUTER_RECHECK", () => recheck());
          else await recheck();
          return result;
        } catch (error) {
          // The local session must retain consumed UNKNOWN locks even when the
          // hosted job has ended. Cleanup never depends on a live-job recheck.
          await finish(true).catch(() => {});
          throw error;
        }
      });
    return Object.freeze({
      profileDigest: session.profileDigest,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      scope,
      sign: (value, assertStillAuthorized = undefined) =>
        action("sign", [value, assertStillAuthorized]),
      consume: (value) => action("consume", [value]),
      holdTargets: (value) => action("holdTargets", [value]),
      completeCreation: (value) => action("completeCreation", [value]),
      registerLifecycleTarget: (value) => action("registerLifecycleTarget", [value]),
      completeSnapshot: (...args) => action("completeSnapshot", args),
      assertSnapshotConsumption: (...args) => action("assertSnapshotConsumption", args),
      assertCandidateUse: (...args) => action("assertCandidateUse", args),
      verifySourceOriginals: (...args) => action("verifySourceOriginals", args),
      custodySourceOriginals: (...args) => action("custodySourceOriginals", args),
      completeSource: (...args) => action("completeSource", args),
      verifyFinalOriginals: (...args) => action("verifyFinalOriginals", args),
      custodyFinalOriginals: (...args) => action("custodyFinalOriginals", args),
      completeFinal: (...args) => action("completeFinal", args),
      acknowledgeSource: (...args) => action("acknowledgeSource", args),
      acknowledgeFinal: (...args) => action("acknowledgeFinal", args),
      completeCleanup: (...args) => action("completeCleanup", args),
      record: (kind, value) => action("record", [kind, value]),
      closeIncomplete: (...args) =>
        serial(() => {
          requireThat(args.length === 0, code);
          return finish(true);
        }),
      close: () => serial(() => finish())
    });
  } catch {
    await finish(true).catch(() => {});
    fail(code);
  }
}

export async function openTrustedManualSession(input) {
  let keyInput, signingKey;
  try {
    exact(input, ["repoRoot", "proofBytes", "materialBytes", "operationRef"]);
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    const fixed = await readFixedManualOperation({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef
    });
    const proofBytes = inputBytes(input.proofBytes),
      materialBytes = inputBytes(input.materialBytes);
    requireThat(fixed.proofBytes.equals(proofBytes) && fixed.materialBytes.equals(materialBytes));
    const build = await verifyManualBuild({ repoRoot: input.repoRoot, proofBytes, materialBytes });
    for (const name of [
      "buildProofDigest",
      "proofRawDigest",
      "materialRawDigest",
      "custodyReceiptRawDigest"
    ])
      requireThat(fixed.operation[name] === build[name]);
    const reread = await readFixedManualOperation({
      repoRoot: input.repoRoot,
      operationRef: input.operationRef
    });
    requireThat(
      reread.indexDigest === fixed.indexDigest &&
        reread.proofBytes.equals(proofBytes) &&
        reread.materialBytes.equals(materialBytes)
    );
    requireThat(
      sha256Canonical(await loadFixedManualProfile({ repoRoot: input.repoRoot })) ===
        sha256Canonical(profile)
    );
    const { principal } = await actualHost();
    const keyRef = profile.storage.keyRef;
    requireThat(
      !path.isAbsolute(keyRef) &&
        path.normalize(keyRef) === keyRef &&
        keyRef.split(path.sep).every((part) => part !== "" && part !== "." && part !== "..")
    );
    const keyPath = path.join(profile.storage.keyRoot, keyRef);
    requireThat(within(profile.storage.keyRoot, keyPath) && keyPath !== profile.storage.keyRoot);
    keyInput = await openInput(keyPath, { principal, privateRoot: profile.storage.keyRoot });
    signingKey = createPrivateKey(keyInput.bytes);
    requireThat(
      signingKey.asymmetricKeyType === "ed25519" &&
        sha256Bytes(createPublicKey(signingKey).export({ type: "spki", format: "der" })) ===
          profile.keyFingerprint
    );
    await keyInput.recheck();
    return await openManualSession({
      profile,
      ownerObservation: {
        ownerId: profile.ownerId,
        principal,
        targetIntent: fixed.operation.targetIntent,
        observedAt: new Date().toISOString()
      },
      now: () => new Date().toISOString(),
      signingKey
    });
  } catch {
    fail("MANUAL_SESSION_UNVERIFIED");
  } finally {
    // The existing session owns its KeyObject until close. Clearing our raw
    // bytes/reference is best effort and does not claim physical erasure.
    keyInput?.bytes.fill(0);
    await keyInput?.close();
    signingKey = null;
  }
}
