import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
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
  const result = await new Promise((resolve, reject) =>
    childProcess.execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        encoding: "buffer",
        timeout,
        maxBuffer,
        ...(env ? { env } : {})
      },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr }))
    )
  );
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
    exact(input, ["repoRoot", "operationRef"]);
    requireThat(typeof input.operationRef === "string" && UUID.test(input.operationRef));
    const repoRoot = absolute(input.repoRoot);
    const operationRef = input.operationRef;
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
    const indexBytes = await read(path.join(root, operationRef, "index.json"));
    const index = json(indexBytes, true);
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
        indexRawDigest: sha256Bytes(indexBytes),
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
      cert?.subjectAlternativeName?.type === "URI" &&
      cert.subjectAlternativeName.value === signer &&
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
  const opened = [];
  try {
    exact(input, ["proofBytes", "materialBytes", "repoRoot"]);
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    const proofBytes = inputBytes(input.proofBytes),
      materialBytes = inputBytes(input.materialBytes);
    const proofRawDigest = sha256Bytes(proofBytes),
      materialRawDigest = sha256Bytes(materialBytes);
    const { principal } = await actualHost();
    const read = async (file, privateRoot) => {
      const snapshot = await openInput(file, {
        principal,
        privateRoot,
        sourceRoot: privateRoot ? undefined : input.repoRoot
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
    // This closes accidental cross-checkout use; it is not a claim that a
    // compromised verifier can establish its own integrity or replace H2's
    // trusted execution environment.
    for (const name of ["manual-stage1-trust.mjs", "verify-build-proof.mjs"]) {
      const executing = await read(fileURLToPath(new URL(`./${name}`, import.meta.url)));
      requireThat(executing.bytes.equals(sourceInputs.get(`scripts/release/${name}`).bytes));
    }
    const inspectSource = async () => {
      requireThat(
        (await computeRepositoryContract(input.repoRoot)).digest ===
          proof.identity.repositoryContractDigest
      );
      requireThat(
        (await computeMigrationCatalog(input.repoRoot)).digest ===
          proof.identity.migrationCatalogDigest
      );
      await checkoutSource(input.repoRoot, proof.identity.sourceSha);
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
      sha256Canonical(await loadFixedManualProfile({ repoRoot: input.repoRoot })) ===
        sha256Canonical(profile)
    );
    return Object.freeze({
      buildProofDigest,
      proofRawDigest,
      materialRawDigest,
      custodyReceiptRawDigest: sha256Bytes(receiptInput.bytes),
      promotionEligible: false
    });
  } catch (error) {
    fail(error?.code === CUSTODY_REQUIRED ? CUSTODY_REQUIRED : BUILD);
  } finally {
    await Promise.all(opened.map((item) => item.close()));
  }
}

// Fixed R3 policy plus the existing H2 verification. This holds trusted inputs;
// it does not create a session, grant a capability or admit a hosted destination.
export async function readFixedR3TargetPolicy(input) {
  const code = "R3_TARGET_POLICY_INPUT_UNAVAILABLE";
  const opened = [];
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
    const profile = await loadFixedManualProfile({ repoRoot }),
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
    await read(path.join(repoRoot, OWNER));
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
    const build = await verifyManualBuild({ repoRoot, proofBytes, materialBytes }),
      proof = json(proofBytes);
    requireThat(build.custodyReceiptRawDigest === sha256Bytes(receiptBytes));
    const checkWindow = () => {
      const now = Date.now();
      requireThat(instant(profile.validFrom) <= now && now < instant(profile.expiresAt));
    };
    const recheck = async () => {
      try {
        requireThat(!closed);
        checkWindow();
        requireThat(equal(await actualHost(), actual));
        requireThat(sha256Canonical(await loadFixedManualProfile({ repoRoot })) === profileDigest);
        requireThat(
          (await computeRepositoryContract(repoRoot)).digest ===
            proof.identity.repositoryContractDigest
        );
        requireThat(
          (await computeMigrationCatalog(repoRoot)).digest === proof.identity.migrationCatalogDigest
        );
        await checkoutSource(repoRoot, proof.identity.sourceSha);
        for (const item of opened) await item.recheck();
        checkWindow();
        requireThat(!closed);
      } catch {
        await close();
        fail(code);
      }
    };
    await recheck();
    return Object.freeze({
      profileDigest,
      policy: freeze(policy),
      policyRawDigest: sha256Bytes(policyBytes),
      databaseTargetPolicy: freeze(matchingTargets[0]),
      databaseTargetPolicyRawDigest: sha256Bytes(targetsBytes),
      databaseTestManifestRawDigest: sha256Bytes(suitesBytes),
      build,
      sourceSha: proof.identity.sourceSha,
      recheck,
      close
    });
  } catch {
    await close();
    fail(code);
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
      } catch {
        await close();
        fail(code);
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
      build: policyInput.build,
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
      environment = fixedProcessEnvironment("gh"),
      attestationBytes = await processOutput(
        "gh",
        attestationArgs(file, admission.sourceSha, ci.workflowPath),
        { env: environment }
      ),
      verifiedAttestation = attestation(
        attestationBytes,
        sha256Bytes(held.bytes),
        admission.sourceSha,
        Math.floor(instant(admission.generatedAt) / 1000) * 1000,
        { signer: ci.workflowPath, caller: ci.callerWorkflowPath, repositoryId: ci.repositoryId }
      );
    requireThat(verifiedAttestation.workflowRunId === ci.runId);
    const api = async (endpoint) => processOutput("gh", ["api", endpoint], { env: environment });
    const recheck = async () => {
      try {
        requireThat(!closed);
        checkWindow();
        await creation.recheck();
        await held.recheck();
        const runBytes = await api(`repos/${REPOSITORY}/actions/runs/${ci.runId}/attempts/1`),
          jobBytes = await api(`repos/${REPOSITORY}/actions/jobs/${ci.jobId}`),
          run = json(runBytes),
          job = json(jobBytes),
          host = admission.host;
        requireThat(
          run.id === Number(ci.runId) &&
            run.run_attempt === 1 &&
            run.head_sha === admission.sourceSha &&
            run.head_branch === "main" &&
            run.status === "in_progress" &&
            run.conclusion === null &&
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
            job.status === "in_progress" &&
            job.conclusion === null &&
            job.completed_at === null &&
            (job.run_attempt === undefined || job.run_attempt === 1) &&
            typeof job.started_at === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(job.started_at) &&
            Number.isFinite(Date.parse(job.started_at)) &&
            Date.parse(job.started_at) <= instant(admission.generatedAt)
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
      } catch {
        await close();
        fail(code);
      }
    };
    const readback = await recheck();
    return Object.freeze({
      admission: freeze(admission),
      jobAdmissionDigest: sha256Bytes(held.bytes),
      creationSpecDigest: creation.creationSpecDigest,
      spec: creation.spec,
      policy: creation.policy,
      build: creation.build,
      sourceSha: creation.sourceSha,
      verifiedAttestation,
      ...readback,
      recheck,
      close
    });
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
      root = path.join(archiveRoot, "inputs", "r3", operationRef),
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

// Creation has no future destination facts. Its fixed live job and creation
// plan establish the scope before the existing H1 signing key is opened. The
// session itself owns the original revocation/consumption journal and locks.
export async function openTrustedR3CreationSession(input) {
  const code = "R3_CREATION_SESSION_UNAVAILABLE";
  let fixed,
    session,
    closed = false,
    closing,
    queue = Promise.resolve();
  const finish = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const outcomes = await Promise.allSettled([
        ...(session ? [session.close()] : []),
        ...(fixed ? [fixed.close()] : [])
      ]);
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
    } catch {
      fail(code);
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
    fixed = await readFixedR3JobAdmission({ repoRoot, operationRef });
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
        r3CreationContext: { scope, creationSpec: spec, jobAdmission: fixed.admission },
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
      "record",
      "close"
    ]);
    requireThat(equal(session.scope, scope) && session.profileDigest === spec.profileDigest);
    const action = (method, args) =>
      serial(async () => {
        requireThat(!closed, code);
        try {
          await recheck();
          const result = await session[method](...args);
          await recheck();
          return result;
        } catch (error) {
          // The local session must retain consumed UNKNOWN locks even when the
          // hosted job has ended. Cleanup never depends on a live-job recheck.
          await finish().catch(() => {});
          throw error;
        }
      });
    return Object.freeze({
      profileDigest: session.profileDigest,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      scope,
      sign: (value) => action("sign", [value]),
      consume: (value) => action("consume", [value]),
      record: (kind, value) => action("record", [kind, value]),
      close: () => serial(finish)
    });
  } catch {
    await finish().catch(() => {});
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
