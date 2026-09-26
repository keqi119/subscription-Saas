#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  computeRepositoryContract,
  computeMigrationCatalog,
  computeManualClusterFingerprint,
  assertManualDecision,
  verifyManualAuthorization,
  validateContract,
  validateManualRunnerRequest,
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  loadFixedManualProfile,
  readFixedManualOperation,
  verifyManualBuild,
  openTrustedManualSession
} from "./manual-stage1-trust.mjs";
import { createPostgresConnector } from "../../apps/release-runner/src/postgres-connector.mjs";
import { observeManualTarget } from "../../apps/release-runner/src/manual-target-observer.mjs";
import { buildManualBaseline } from "../../apps/release-runner/src/manual-command-adapter.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}

export async function prepareManualOperation(input) {
  if (!exact(input, ["proofBytes", "materialBytes", "targetIntent", "scenario"]))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const proofBytes =
    Buffer.isBuffer(input.proofBytes) && input.proofBytes.length <= 1048576
      ? Buffer.from(input.proofBytes)
      : input.proofBytes;
  const materialBytes =
    Buffer.isBuffer(input.materialBytes) && input.materialBytes.length <= 1048576
      ? Buffer.from(input.materialBytes)
      : input.materialBytes;
  const targetIntent = exact(input.targetIntent, ["endpointPolicyId", "databaseName"])
    ? { ...input.targetIntent }
    : null;
  const scenario = input.scenario;
  // Holding these fixed public inputs establishes no trust. R1 alone validates
  // their shape/H1/build; the handles only prevent changing that validated window.
  const ownerInputs = await pinOwnerInputs();
  try {
    const build = await verifyManualBuild({ repoRoot, proofBytes, materialBytes });
    const profile = await loadFixedManualProfile({ repoRoot });
    await ownerInputs.recheck();
    if (!encodeManualJson(profile).equals(encodeManualJson(JSON.parse(ownerInputs.profileBytes))))
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const principal = Object.freeze({ ...JSON.parse(ownerInputs.bindingBytes).principal });
    if (
      !targetIntent ||
      !["normal", "apply-interrupted"].includes(scenario) ||
      !profile.allowedTargets.some(
        (target) =>
          target.endpointPolicyId === targetIntent.endpointPolicyId &&
          target.databaseName === targetIntent.databaseName &&
          target.purposes.includes("synthetic-fresh")
      )
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const verifiedProof = JSON.parse(proofBytes);
    const recheckSource = async () => {
      await ownerInputs.recheck();
      const sourceSha = (
        await nativeText(
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
          {
            PATH: process.env.PATH,
            ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
          }
        )
      ).trim();
      if (
        sourceSha !== verifiedProof.identity.sourceSha ||
        (await computeRepositoryContract(repoRoot)).digest !==
          verifiedProof.identity.repositoryContractDigest ||
        (await computeMigrationCatalog(repoRoot)).digest !==
          verifiedProof.identity.migrationCatalogDigest
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    };
    const archiveRoot = profile.storage.archiveRoot;
    const operationsRoot = path.join(archiveRoot, "inputs", "operations");
    // Inspect every existing private segment before creating even an intermediate directory.
    for (const file of [archiveRoot, path.join(archiveRoot, "inputs"), operationsRoot]) {
      try {
        await checkedPrivatePath(file, { principal, privateRoot: archiveRoot, directory: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await recheckSource();
    await ensureDirectory(path.join(archiveRoot, "inputs"), {
      principal,
      privateRoot: archiveRoot,
      recheckSource
    });
    await ensureDirectory(operationsRoot, { principal, privateRoot: archiveRoot, recheckSource });
    const operationRef = randomUUID();
    const index = {
      schemaVersion: "manual-operation-input.v1",
      operationRef,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      profileDigest: sha256Canonical(profile),
      buildProofDigest: build.buildProofDigest,
      proofRawDigest: build.proofRawDigest,
      materialRawDigest: build.materialRawDigest,
      custodyReceiptRawDigest: build.custodyReceiptRawDigest,
      targetIntent,
      purpose: "synthetic-fresh",
      scenario,
      operations: Object.fromEntries(
        ["observe", "migrate", "verify"].map((phase) => [
          phase,
          {
            operationId: randomUUID(),
            idempotencyKey: `manual-stage1:${operationRef}:${phase}`
          }
        ])
      ),
      promotionEligible: false
    };
    const bytes = encodeManualJson(index),
      indexDigest = sha256Canonical(index);
    const operationDirectory = path.join(operationsRoot, operationRef);
    const indexPath = path.join(operationDirectory, "index.json");
    try {
      await recheckSource();
      await checkedPrivatePath(operationsRoot, {
        principal,
        privateRoot: archiveRoot,
        directory: true
      });
      // The directory reserves this exact ref. EEXIST is never an invitation to retry.
      await fs.mkdir(operationDirectory, { mode: 0o700 });
      await checkedPrivatePath(operationDirectory, {
        principal,
        privateRoot: archiveRoot,
        directory: true
      });
      await recheckSource();
      const handle = await fs.open(indexPath, "wx", 0o600);
      try {
        await recheckSource();
        await checkedPrivatePath(operationDirectory, {
          principal,
          privateRoot: archiveRoot,
          directory: true
        });
        const chain = await checkedPrivatePath(indexPath, { principal, privateRoot: archiveRoot });
        if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        await handle.writeFile(bytes);
        await handle.sync();
        const after = await checkedPrivatePath(indexPath, { principal, privateRoot: archiveRoot });
        if (!sameIdentity(after.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        await recheckSource();
      } finally {
        await handle.close();
      }
      const fixed = await readFixedManualOperation({ repoRoot, operationRef });
      if (
        fixed.indexDigest !== indexDigest ||
        !encodeManualJson(fixed.operation).equals(bytes) ||
        !fixed.proofBytes.equals(proofBytes) ||
        !fixed.materialBytes.equals(materialBytes)
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      await recheckSource();
      return Object.freeze({ operationRef, indexDigest, promotionEligible: false });
    } catch (cause) {
      // Partial/colliding metadata stays reserved. No execution record or new identity is invented.
      throw Object.assign(new Error("MANUAL_OPERATION_PREPARATION_UNKNOWN", { cause }), {
        code: "MANUAL_OPERATION_PREPARATION_UNKNOWN",
        operationRef
      });
    }
  } finally {
    await ownerInputs.close();
  }
}

function sameIdentity(left, right, contents = true) {
  return [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "nlink",
    ...(contents ? ["size", "mtimeNs", "ctimeNs"] : [])
  ].every((key) => left[key] === right[key]);
}
async function observedPath(file) {
  const chain = [];
  let current = path.parse(file).root;
  for (const segment of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || (await fs.realpath(current)) !== current)
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    chain.push({ path: current, stat });
  }
  return chain;
}
async function readPinned(handle, expected) {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 1048576n ||
    (expected && !sameIdentity(before, expected))
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (BigInt(offset) !== before.size || !sameIdentity(before, await handle.stat({ bigint: true })))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  return { bytes: Buffer.from(bytes.subarray(0, offset)), stat: before };
}
async function pinOwnerInputs() {
  const held = [];
  try {
    for (const relative of [
      "release/contracts/manual-stage1-profile.v2.json",
      "release/contracts/manual-stage1-owner-binding.v1.json"
    ]) {
      const file = path.join(repoRoot, ...relative.split("/"));
      const chain = await observedPath(file),
        handle = await fs.open(file, "r");
      const item = { file, chain, handle };
      held.push(item);
      Object.assign(item, await readPinned(handle, chain.at(-1).stat));
    }
    const recheck = async () => {
      for (const item of held) {
        const after = await observedPath(item.file);
        if (
          after.length !== item.chain.length ||
          !after.every(
            (entry, index) =>
              entry.path === item.chain[index].path &&
              sameIdentity(
                entry.stat,
                item.chain[index].stat,
                index === after.length - 1 ||
                  entry.path === repoRoot ||
                  entry.path.startsWith(repoRoot + path.sep)
              )
          )
        )
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        if (!(await readPinned(item.handle, item.stat)).bytes.equals(item.bytes))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        const independent = await fs.open(item.file, "r");
        try {
          if (!(await readPinned(independent, item.stat)).bytes.equals(item.bytes))
            fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        } finally {
          await independent.close();
        }
      }
    };
    return {
      profileBytes: held[0].bytes,
      bindingBytes: held[1].bytes,
      recheck,
      close: async () => {
        for (const item of held) {
          item.bytes.fill(0);
          await item.handle.close();
        }
      }
    };
  } catch (cause) {
    for (const item of held) {
      item.bytes?.fill(0);
      await item.handle.close();
    }
    throw Object.assign(new Error("TRUSTED_BUILD_UNAVAILABLE", { cause }), {
      code: "TRUSTED_BUILD_UNAVAILABLE"
    });
  }
}
async function nativeText(
  file,
  args,
  environment = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
) {
  return new Promise((resolve, reject) =>
    childProcess.execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        encoding: "buffer",
        timeout: 5000,
        maxBuffer: 8192,
        env: environment
      },
      (error, stdout, stderr) => {
        if (
          error ||
          !Buffer.isBuffer(stdout) ||
          !Buffer.isBuffer(stderr) ||
          stdout.length > 8192 ||
          stderr.length > 8192
        ) {
          reject(
            Object.assign(new Error("MANUAL_OPERATION_INPUT_UNAVAILABLE"), {
              code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
            })
          );
        } else {
          try {
            resolve(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
          } catch {
            reject(
              Object.assign(new Error("MANUAL_OPERATION_INPUT_UNAVAILABLE"), {
                code: "MANUAL_OPERATION_INPUT_UNAVAILABLE"
              })
            );
          }
        }
      }
    )
  );
}
async function ownerOnly(file, principal, stat) {
  if (process.platform === "linux") {
    if (
      principal.platform !== "posix" ||
      stat.uid !== BigInt(principal.uid) ||
      (stat.mode & 0o077n) !== 0n
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    return;
  }
  if (process.platform !== "win32" || principal.platform !== "win32")
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const system = "C:\\Windows\\System32\\";
  await nativeText(system + "icacls.exe", [file]);
  const literal = `'${file.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath ${literal}; [Console]::WriteLine($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value); foreach($e in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [Console]::WriteLine($e.IdentityReference.Value+'|'+$e.AccessControlType+'|'+[int]$e.FileSystemRights) }; [Console]::WriteLine('attributes|'+[int][System.IO.File]::GetAttributes(${literal}))`;
  const lines = (
    await nativeText(system + "WindowsPowerShell\\v1.0\\powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ])
  )
    .trim()
    .split(/\r?\n/u);
  const owner = lines.shift(),
    attributes = lines.pop()?.match(/^attributes\|([0-9]+)$/u);
  const entries = lines.map((line) =>
    line.match(/^(S-1-[0-9]+(?:-[0-9]+)+)\|(Allow|Deny)\|([0-9]+)$/u)
  );
  if (
    owner !== principal.sid ||
    !attributes ||
    !Number.isSafeInteger(Number(attributes[1])) ||
    (Number(attributes[1]) & 1024) !== 0 ||
    entries.length === 0 ||
    !entries.every(
      (entry) =>
        entry &&
        entry[1] === principal.sid &&
        entry[2] === "Allow" &&
        Number.isSafeInteger(Number(entry[3]))
    ) ||
    !entries.some((entry) => (Number(entry[3]) & 2032127) === 2032127)
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
}
async function checkedPrivatePath(file, { principal, privateRoot, directory = false }) {
  const before = await observedPath(file);
  for (const entry of before)
    if (entry.path === privateRoot || entry.path.startsWith(privateRoot + path.sep))
      await ownerOnly(entry.path, principal, entry.stat);
  const after = await observedPath(file);
  if (
    after.length !== before.length ||
    !after.every((entry, index) =>
      sameIdentity(
        entry.stat,
        before[index].stat,
        entry.path === privateRoot || entry.path.startsWith(privateRoot + path.sep)
      )
    ) ||
    (directory
      ? !after.at(-1).stat.isDirectory()
      : !after.at(-1).stat.isFile() || after.at(-1).stat.nlink !== 1n)
  )
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  return after;
}
async function ensureDirectory(file, { principal, privateRoot, recheckSource }) {
  await recheckSource();
  await checkedPrivatePath(path.dirname(file), { principal, privateRoot, directory: true });
  try {
    await fs.mkdir(file, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await checkedPrivatePath(file, { principal, privateRoot, directory: true });
  await recheckSource();
}

export async function launchManualStage1(input) {
  if (
    !exact(input, ["operationRef"]) ||
    typeof input.operationRef !== "string" ||
    !uuid.test(input.operationRef)
  )
    fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
  return withManualTarget(input.operationRef, async (facts) => {
    const session = await openTrustedManualSession({
      repoRoot,
      operationRef: input.operationRef,
      proofBytes: facts.fixed.proofBytes,
      materialBytes: facts.fixed.materialBytes
    });
    try {
      await performTargetObservation(session, facts);
    } finally {
      await session.close();
    }
    fail("MANUAL_RUNNER_INPUT_REQUIRED");
  });
}

export async function connectAndObserveManualTarget(input) {
  if (
    !exact(input, ["session", "operationRef"]) ||
    typeof input.operationRef !== "string" ||
    !uuid.test(input.operationRef) ||
    !input.session ||
    !["sign", "consume", "record", "close"].every((key) => typeof input.session[key] === "function")
  )
    fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
  try {
    return await withManualTarget(input.operationRef, (facts) =>
      performTargetObservation(input.session, facts)
    );
  } finally {
    await input.session.close();
  }
}

async function withManualTarget(operationRef, work) {
  const fixed = await readFixedManualOperation({ repoRoot, operationRef });
  const ownerInputs = await pinOwnerInputs();
  try {
    const build = await verifyManualBuild({
      repoRoot,
      proofBytes: fixed.proofBytes,
      materialBytes: fixed.materialBytes
    });
    const profile = await loadFixedManualProfile({ repoRoot });
    await ownerInputs.recheck();
    if (
      !encodeManualJson(profile).equals(ownerInputs.profileBytes) ||
      ["buildProofDigest", "proofRawDigest", "materialRawDigest", "custodyReceiptRawDigest"].some(
        (key) => build[key] !== fixed.operation[key]
      )
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const principal = Object.freeze({ ...JSON.parse(ownerInputs.bindingBytes).principal });
    return await readH3Inputs(fixed, profile, principal, ownerInputs.recheck, (facts) =>
      work({ ...facts, fixed, profile, principal, build })
    );
  } finally {
    await ownerInputs.close();
  }
}

const observationFields = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
const fieldsFrom = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const objectFile = (root, digest) => {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail("MANUAL_STORAGE_UNVERIFIED");
  return path.join(root, "objects", `${digest.slice(7)}.json`);
};

function targetArchive({ profile, principal, recheck }) {
  const read = async (file, root) => {
    const item = await pinPrivateInput(file, { principal, privateRoot: root });
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(item.bytes));
      if (!encodeManualJson(value).equals(item.bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await item.recheck();
      return { value, bytes: Buffer.from(item.bytes) };
    } finally {
      await item.close();
    }
  };
  const get = async (digest, role = "archive") => {
    const item = await read(
      objectFile(profile.storage[`${role}Root`], digest),
      profile.storage[`${role}Root`]
    );
    if (sha256Bytes(item.bytes) !== digest) fail("MANUAL_STORAGE_UNVERIFIED");
    return item;
  };
  return {
    read,
    get,
    async put(value, schema) {
      validateContract(schema, value);
      const bytes = encodeManualJson(value),
        digest = sha256Bytes(bytes),
        file = objectFile(profile.storage.archiveRoot, digest);
      await recheck();
      await checkedPrivatePath(path.dirname(file), {
        principal,
        privateRoot: profile.storage.archiveRoot,
        directory: true
      });
      const handle = await fs.open(file, "wx", 0o600);
      try {
        const chain = await checkedPrivatePath(file, {
          principal,
          privateRoot: profile.storage.archiveRoot
        });
        if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_STORAGE_UNVERIFIED");
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await get(digest)).bytes.equals(bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await recheck();
      return digest;
    },
    async graph() {
      const graph = new Map();
      for (const role of ["journal", "archive"]) {
        const root = profile.storage[`${role}Root`],
          directory = path.join(root, "objects");
        await checkedPrivatePath(directory, { principal, privateRoot: root, directory: true });
        for (const name of await fs.readdir(directory)) {
          if (!/^[0-9a-f]{64}\.json$/u.test(name)) fail("MANUAL_STORAGE_UNVERIFIED");
          const digest = `sha256:${name.slice(0, -5)}`;
          graph.set(digest, await get(digest, role));
        }
      }
      return graph;
    }
  };
}

async function checkConsumedObservation(session, input, authorization, consumed, facts, archive) {
  assertManualDecision(consumed?.parentDecision);
  const { profile, targetContext } = facts,
    request = JSON.parse(input.canonicalBytes),
    authorizationDigest = sha256Canonical(authorization),
    requestDigest = sha256Bytes(input.canonicalBytes);
  if (
    consumed.stage !== "target-observe" ||
    consumed.parentDecision.authorizationDigest !== authorizationDigest ||
    consumed.parentDecision.requestDigest !== requestDigest
  )
    fail("MANUAL_BINDING_MISMATCH");
  const custody = (await archive.get(consumed.consumptionReadbackDigest)).value;
  validateContract("manual-operation-record.v2", custody);
  const consumption = (await archive.get(custody.subjectDigest, "journal")).value;
  validateContract("manual-operation-record.v2", consumption);
  const slot = await archive.read(
    path.join(
      profile.storage.journalRoot,
      "consumptions",
      `${request.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
    ),
    profile.storage.journalRoot
  );
  if (
    custody.kind !== "custody" ||
    custody.purpose !== "consumption-readback" ||
    custody.outcome !== "MATCH" ||
    custody.observedDigest !== custody.subjectDigest ||
    custody.storageRole !== "journal" ||
    consumption.kind !== "consumption" ||
    consumption.status !== "CONSUMED" ||
    consumption.authorizationDigest !== authorizationDigest ||
    consumption.requestDigest !== requestDigest ||
    !slot.bytes.equals(encodeManualJson(consumption))
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  await facts.recheck();
  const graph = await archive.graph(),
    opened = graph.get(consumption.sessionRecordDigest)?.value;
  if (
    !opened ||
    [...graph.values()].some(
      ({ value }) =>
        value.kind === "session" && value.sessionId === session.sessionId && value.status !== "OPEN"
    )
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const revocationDirectory = path.join(profile.storage.journalRoot, "revocations"),
    records = [];
  for (const name of await fs.readdir(revocationDirectory)) {
    if (!name.startsWith(`${sha256Canonical(profile).slice(7)}-`)) continue;
    records.push(
      (await archive.read(path.join(revocationDirectory, name), profile.storage.journalRoot)).value
    );
  }
  records.sort((left, right) => left.sequence - right.sequence);
  const head = records.at(-1);
  if (!head) fail("MANUAL_REVOCATION_UNVERIFIED");
  const checkpoints = path.join(profile.storage.journalRoot, "checkpoints");
  for (const name of await fs.readdir(checkpoints)) {
    if (!name.startsWith(`${sha256Canonical(profile).slice(7)}-`)) continue;
    const saved = (await archive.read(path.join(checkpoints, name), profile.storage.journalRoot))
      .value;
    if (
      !records[saved.sequence] ||
      sha256Canonical(records[saved.sequence]) !== sha256Canonical(saved)
    )
      fail("MANUAL_REVOCATION_UNVERIFIED");
  }
  const checkpoint = (
    await archive.read(
      path.join(
        profile.storage.journalRoot,
        "checkpoints",
        `${sha256Canonical(profile).slice(7)}-${head.sequence}.json`
      ),
      profile.storage.journalRoot
    )
  ).value;
  const readAt = new Date().toISOString();
  const decision = verifyManualAuthorization({
    authorization,
    profile,
    request: input,
    session: {
      record: opened,
      recordDigest: consumption.sessionRecordDigest,
      readAt,
      predecessor: null
    },
    revocation: {
      records,
      headDigest: sha256Canonical(head),
      checkpoint: { sequence: checkpoint.sequence, digest: sha256Canonical(checkpoint) },
      readAt
    },
    now: readAt
  });
  assertManualDecision(decision);
  if (
    decision.sessionId !== session.sessionId ||
    decision.profileDigest !== targetContext.profileDigest
  )
    fail("MANUAL_BINDING_MISMATCH");
  return consumption;
}

function observerCredential(bytes, expectedRole) {
  try {
    const supplied = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !exact(supplied, ["username", "password"]) ||
      !encodeManualJson(supplied).equals(bytes) ||
      supplied.username !== expectedRole ||
      typeof supplied.password !== "string" ||
      !supplied.password.length ||
      supplied.password.includes("\0")
    )
      fail("MANUAL_CREDENTIAL_INVALID");
    const credential = {
      username: supplied.username,
      password: supplied.password,
      capabilityProfile: "verify"
    };
    supplied.password = "";
    return credential;
  } catch {
    // Native JSON diagnostics can include secret input. Only a fixed code escapes.
    fail("MANUAL_CREDENTIAL_INVALID");
  }
}

async function performTargetObservation(session, facts) {
  const { fixed, profile, principal, targetContext, recheck, recheckResources } = facts,
    archive = targetArchive(facts),
    operation = fixed.operation;
  if (
    session.profileDigest !== operation.profileDigest ||
    sha256Canonical(session.targetIntent) !== sha256Canonical(operation.targetIntent)
  )
    fail("MANUAL_BINDING_MISMATCH");
  // A prior original must never be replaced by a new observation. Resolution
  // of its complete graph is the next continuation boundary for this slice.
  const graph = await archive.graph();
  if (
    [...graph.values()].some(
      ({ value }) =>
        value.schemaVersion === "manual-runner-request.v1" &&
        value.stage === "target-observe" &&
        value.runId === operation.runId &&
        value.operationId === operation.operations.observe.operationId
    )
  )
    fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
  const binding = {
    profileDigest: session.profileDigest,
    ownerId: profile.ownerId,
    ...fieldsFrom(session, ["sessionId", "sessionNonce"]),
    ...operation.operations.observe,
    purpose: operation.purpose,
    targetIntent: operation.targetIntent,
    stage: "target-observe",
    capability: "verify"
  };
  const request = {
    schemaVersion: "manual-runner-request.v1",
    ...binding,
    attemptId: randomUUID(),
    runId: operation.runId
  };
  const allocatedAt = new Date().toISOString();
  const allocation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "attempt-allocation",
    recordedAt: allocatedAt,
    promotionEligible: false,
    ...fieldsFrom(request, observationFields),
    stage: "target-observe",
    phaseKey: "target-observe",
    allocatedAt,
    targetIntent: operation.targetIntent,
    predecessorExecutionRecordDigest: null
  };
  request.attemptAllocationDigest = await archive.put(allocation, "manual-runner-evidence.v1");
  validateManualRunnerRequest(request);
  const requestDigest = await archive.put(request, "manual-runner-request.v1"),
    input = { binding, canonicalBytes: (await archive.get(requestDigest)).bytes };
  const authorization = await session.sign(input),
    consumed = await session.consume({ authorization, request: input });
  let database, credential;
  try {
    let consumption = await checkConsumedObservation(
      session,
      input,
      authorization,
      consumed,
      facts,
      archive
    );
    await recheckResources();
    await checkConsumedObservation(session, input, authorization, consumed, facts, archive);
    const secret = await pinPrivateInput(
      path.join(
        profile.storage.credentialRoot,
        "operations",
        operation.operationRef,
        "observer.json"
      ),
      { principal, privateRoot: profile.storage.credentialRoot }
    );
    try {
      const endpointPolicy = profile.allowedTargets.find(
        (target) =>
          target.endpointPolicyId === operation.targetIntent.endpointPolicyId &&
          target.databaseName === operation.targetIntent.databaseName
      );
      credential = observerCredential(secret.bytes, endpointPolicy.roles.observer);
      await secret.recheck();
      await recheckResources();
      consumption = await checkConsumedObservation(
        session,
        input,
        authorization,
        consumed,
        facts,
        archive
      );
      const endpoint = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(endpointPolicy.endpoint);
      if (!endpoint) fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
      database = await createPostgresConnector()({
        credential,
        target: {
          hostname: endpoint[1] === "[::1]" ? "::1" : endpoint[1],
          port: Number(endpoint[2]),
          databaseName: endpointPolicy.databaseName,
          tlsMode: "require"
        }
      });
      const startedAt = new Date().toISOString();
      const observation = await observeManualTarget({
        request,
        database,
        endpointPolicy,
        approvedClusterObservation: targetContext
      });
      await recheck();
      const observationDigest = await archive.put(observation, "manual-runner-evidence.v1");
      const record = (kind, fields) => ({
        schemaVersion: "manual-operation-record.v2",
        kind,
        profileDigest: request.profileDigest,
        recordedAt: new Date().toISOString(),
        promotionEligible: false,
        ...fields
      });
      const custody = async (subjectDigest, subjectType) => {
        const observedAt = new Date().toISOString();
        return session.record(
          "custody",
          record("custody", {
            ownerId: profile.ownerId,
            subjectDigest,
            subjectType,
            purpose: "archive-readback",
            outcome: "MATCH",
            observedDigest: subjectDigest,
            observedAt,
            storageRole: "archive",
            retentionDays: 90,
            reasonCode: null
          })
        );
      };
      const readback = await custody(observationDigest, "r2-artifact");
      const reopened = (await archive.get(observationDigest)).value;
      const finishedAt = new Date().toISOString();
      const result = {
        schemaVersion: "manual-runner-evidence.v1",
        kind: "manual-command-result",
        recordedAt: finishedAt,
        promotionEligible: false,
        ...fieldsFrom(request, observationFields),
        requestDigest,
        phaseKey: "target-observe",
        attemptAllocationDigest: request.attemptAllocationDigest,
        startedAt,
        finishedAt,
        outcome: "RETURNED",
        reasonCode: null,
        plan: null,
        postState: null,
        observationDigest,
        processEvidenceDigest: null,
        statements: [...database.statementLog],
        originalExecutionRecordDigest: null
      };
      const resultDigest = await archive.put(result, "manual-runner-evidence.v1");
      const scoped = fieldsFrom(request, [
        "sessionId",
        "sessionNonce",
        "operationId",
        "idempotencyKey"
      ]);
      const post = await session.record(
        "post-state",
        record("post-state", {
          ...scoped,
          requestDigest,
          consumptionRecordDigest: sha256Canonical(consumption),
          outcome: "OBSERVED",
          observationDigest,
          observedAt: reopened.observedAt,
          reasonCode: null
        })
      );
      const execution = await session.record(
        "execution",
        record("execution", {
          ...scoped,
          attemptId: request.attemptId,
          requestDigest,
          authorizationDigest: sha256Canonical(authorization),
          consumptionRecordDigest: sha256Canonical(consumption),
          handoffRecordDigest: null,
          handoffReadbackDigest: null,
          postStateRecordDigest: post.recordDigest,
          predecessorExecutionRecordDigest: null,
          startedAt,
          finishedAt,
          status: "SUCCEEDED",
          reasonCode: null,
          resultDigest,
          processEvidenceDigest: null
        })
      );
      await custody(execution.recordDigest, "record");
      await recheckResources();
      // Baseline E references the verified build's canonical archive object,
      // not its differently formatted fixed input bytes.
      const verifiedProof = JSON.parse(fixed.proofBytes);
      if (sha256Canonical(verifiedProof) !== facts.build.buildProofDigest)
        fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
      try {
        if (
          !(await archive.get(facts.build.buildProofDigest)).bytes.equals(
            encodeManualJson(verifiedProof)
          )
        )
          fail("MANUAL_STORAGE_UNVERIFIED");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await archive.put(verifiedProof, "build-proof.v1");
      }
      const baseline = buildManualBaseline({
        request,
        trustedBuildDecision: facts.build,
        targetObservation: reopened,
        roleObservation: reopened.roleObservation,
        preState: reopened.catalog,
        authorizationDigest: sha256Canonical(authorization)
      });
      const baselineDigest = await archive.put(baseline, "manual-baseline-manifest.v1");
      await custody(baselineDigest, "r2-artifact");
      await recheck();
      return Object.freeze({ observation: reopened, readbackDigest: readback.recordDigest });
    } finally {
      secret.bytes.fill(0);
      await secret.close();
    }
  } finally {
    try {
      await database?.close();
    } finally {
      if (credential) {
        credential.password = "";
        credential.username = "";
      }
      credential = null;
    }
  }
}

function canonicalH3(bytes) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!encodeManualJson(value).equals(bytes)) fail("MANUAL_H3_FORMAT_INVALID");
    return value;
  } catch {
    fail("MANUAL_H3_FORMAT_INVALID");
  }
}

async function pinPrivateInput(file, options) {
  const chain = await checkedPrivatePath(file, options);
  const handle = await fs.open(file, "r");
  try {
    const captured = await readPinned(handle, chain.at(-1).stat);
    const sameChain = (observed) =>
      observed.length === chain.length &&
      observed.every(
        (entry, index) =>
          entry.path === chain[index].path &&
          sameIdentity(
            entry.stat,
            chain[index].stat,
            entry.path === options.privateRoot ||
              entry.path.startsWith(options.privateRoot + path.sep)
          )
      );
    const recheck = async () => {
      const after = await checkedPrivatePath(file, options);
      if (
        !sameChain(after) ||
        !(await readPinned(handle, captured.stat)).bytes.equals(captured.bytes)
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      const independent = await fs.open(file, "r");
      try {
        if (!(await readPinned(independent, captured.stat)).bytes.equals(captured.bytes))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      } finally {
        await independent.close();
      }
      const final = await checkedPrivatePath(file, options);
      if (!sameChain(final)) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    };
    await recheck();
    return { bytes: captured.bytes, recheck, close: () => handle.close() };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

function validateH3Inputs(approval, readback, approvalBytes, fixed, profile) {
  const common = [
    "operationRef",
    "indexDigest",
    "runId",
    "profileDigest",
    "targetIntent",
    "ownerId",
    "promotionEligible"
  ];
  if (
    !exact(approval, [
      "recordVersion",
      ...common,
      "approvedAt",
      "creationSpec",
      "operationSheet"
    ]) ||
    !exact(readback, [
      "recordVersion",
      ...common,
      "approval",
      "databaseContainerName",
      "endpoint",
      "databaseOid",
      "cluster",
      "resourceObservedAt",
      "sqlObservedAt",
      "readbackAt",
      "readbackReport"
    ]) ||
    !exact(approval.creationSpec, [
      "databaseContainerName",
      "dataVolumeName",
      "postgresImageDigest",
      "marker",
      "endpoint",
      "serverPort"
    ]) ||
    !exact(readback.approval, ["digest", "bytes"])
  )
    fail("MANUAL_H3_FORMAT_INVALID");
  const text = (value, limit = 256) =>
    typeof value === "string" && value.length > 0 && value.length <= limit;
  const instant = (value) =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
      ? Date.parse(value)
      : NaN;
  const approvedAt = instant(approval.approvedAt),
    resourceAt = instant(readback.resourceObservedAt),
    sqlAt = instant(readback.sqlObservedAt),
    readbackAt = instant(readback.readbackAt);
  const target = profile.allowedTargets.find(
    (entry) =>
      entry.endpointPolicyId === fixed.operation.targetIntent.endpointPolicyId &&
      entry.databaseName === fixed.operation.targetIntent.databaseName
  );
  const spec = approval.creationSpec;
  if (
    approval.recordVersion !== "manual-h3-a-approval.v1" ||
    readback.recordVersion !== "manual-h3-a-readback.v1" ||
    ![approval, readback].every(
      (record) =>
        record.operationRef === fixed.operation.operationRef &&
        record.indexDigest === fixed.indexDigest &&
        record.runId === fixed.operation.runId &&
        record.profileDigest === fixed.operation.profileDigest &&
        sha256Canonical(record.targetIntent) === sha256Canonical(fixed.operation.targetIntent) &&
        record.ownerId === profile.ownerId &&
        record.promotionEligible === false
    ) ||
    !target ||
    spec.endpoint !== target.endpoint ||
    readback.endpoint !== spec.endpoint ||
    readback.databaseContainerName !== spec.databaseContainerName ||
    ![spec.databaseContainerName, spec.dataVolumeName, spec.marker].every((value) => text(value)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(spec.postgresImageDigest) ||
    !Number.isInteger(spec.serverPort) ||
    spec.serverPort < 1 ||
    spec.serverPort > 65535 ||
    !text(approval.operationSheet, 1048576) ||
    !text(readback.readbackReport, 1048576) ||
    typeof readback.databaseOid !== "string" ||
    !/^[1-9][0-9]*$/u.test(readback.databaseOid) ||
    readback.approval.digest !== sha256Bytes(approvalBytes) ||
    readback.approval.bytes !== approvalBytes.length ||
    !(
      approvedAt <= resourceAt &&
      approvedAt <= sqlAt &&
      resourceAt <= readbackAt &&
      sqlAt <= readbackAt &&
      readbackAt <= Date.now()
    ) ||
    !readback.cluster ||
    ["dataVolumeName", "postgresImageDigest", "marker", "serverPort"].some(
      (key) => readback.cluster[key] !== spec[key]
    )
  )
    fail("MANUAL_H3_BINDING_INVALID");
  // Reuse R1's only closed physical cluster validator/hash; H3 supplies no actual SQL facts.
  computeManualClusterFingerprint(readback.cluster);
}

async function readH3Inputs(fixed, profile, principal, recheckOwner, work) {
  const opened = [];
  let verified = false;
  try {
    const root = path.join(
      profile.storage.archiveRoot,
      "inputs",
      "operations",
      fixed.operation.operationRef
    );
    const values = [];
    for (const name of ["h3-a-approval.json", "h3-a-readback.json"]) {
      const item = await pinPrivateInput(path.join(root, name), {
        principal,
        privateRoot: profile.storage.archiveRoot
      });
      opened.push(item);
      values.push(canonicalH3(item.bytes));
    }
    validateH3Inputs(values[0], values[1], opened[0].bytes, fixed, profile);
    const indexInput = await pinPrivateInput(path.join(root, "index.json"), {
      principal,
      privateRoot: profile.storage.archiveRoot
    });
    opened.push(indexInput);
    if (!indexInput.bytes.equals(encodeManualJson(fixed.operation)))
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    for (const item of opened) await item.recheck();
    await recheckOwner();
    const recheckInputs = async () => {
      for (const item of opened) await item.recheck();
      await recheckOwner();
    };
    await observeH3Resources(values[0], values[1], recheckInputs);
    const current = await readFixedManualOperation({
      repoRoot,
      operationRef: fixed.operation.operationRef
    });
    if (
      current.indexDigest !== fixed.indexDigest ||
      !current.proofBytes.equals(fixed.proofBytes) ||
      !current.materialBytes.equals(fixed.materialBytes)
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    await recheckInputs();
    const readback = values[1];
    const targetContext = {
      contextVersion: "manual-h3-target-context.v1",
      operationRef: fixed.operation.operationRef,
      indexDigest: fixed.indexDigest,
      runId: fixed.operation.runId,
      profileDigest: fixed.operation.profileDigest,
      targetIntent: fixed.operation.targetIntent,
      databaseOid: readback.databaseOid,
      cluster: readback.cluster,
      h3Approval: { digest: sha256Bytes(opened[0].bytes), bytes: opened[0].bytes.length },
      h3Readback: { digest: sha256Bytes(opened[1].bytes), bytes: opened[1].bytes.length }
    };
    verified = true;
    return await work({
      targetContext,
      recheck: recheckInputs,
      recheckResources: () => observeH3Resources(values[0], values[1], recheckInputs)
    });
  } catch (cause) {
    if (verified) throw cause;
    throw Object.assign(new Error("H3_INPUT_UNAVAILABLE", { cause }), {
      code: "H3_INPUT_UNAVAILABLE"
    });
  } finally {
    for (const item of opened) await item.close();
  }
}

// Fixed, nonsecret projections. Never collect Docker's whole Config/Env or commands
// (which can contain credentials), nor execute the human operation-sheet text.
const h3MarkerLabel = "subscription-stage1-manual-marker";
const h3DockerFormats = Object.freeze({
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"privileged":{{json .HostConfig.Privileged}},"marker":{{json (index .Config.Labels "' +
    h3MarkerLabel +
    '")}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"networks":{ {{$sep := ""}}{{range $name, $network := .NetworkSettings.Networks}}{{$sep}}{{json $name}}:{"NetworkID":{{json $network.NetworkID}},"IPAddress":{{json $network.IPAddress}},"GlobalIPv6Address":{{json $network.GlobalIPv6Address}}}{{$sep = ","}}{{end}} },"ports":{{json .NetworkSettings.Ports}},"portBindings":{{json .HostConfig.PortBindings}},"pgdata":[{{$sep := ""}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "PGDATA"}}{{$sep}}{{eq . "PGDATA=/var/lib/postgresql/data"}}{{$sep = ","}}{{end}}{{end}}],"defaultEntrypoint":{{eq (json .Config.Entrypoint) "[\\"docker-entrypoint.sh\\"]"}},"defaultCommand":{{eq (json .Config.Cmd) "[\\"postgres\\"]"}}}',
  volume:
    '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"mountpoint":{{json .Mountpoint}},"optionsEmpty":{{not .Options}},"marker":{{json (index .Labels "' +
    h3MarkerLabel +
    '")}}}',
  image: '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}}}'
});

async function dockerObservation(kind, reference, recheck) {
  const daemon =
    process.platform === "win32"
      ? "npipe:////./pipe/docker_engine"
      : process.platform === "linux"
        ? "unix:///var/run/docker.sock"
        : null;
  if (!daemon) fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  const args =
    kind === "users"
      ? [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `volume=${reference}`,
          "--format",
          "{{.ID}}"
        ]
      : [kind, "inspect", "--format", h3DockerFormats[kind], "--", reference];
  // Ignore DOCKER_HOST/CONTEXT/TLS, HOME, PostgreSQL and arbitrary inherited env.
  // Host/principal trust is established by H1, not selected by this invocation.
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR"])
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  const result = await new Promise((resolve) => {
    try {
      childProcess.execFile(
        "docker",
        ["--host", daemon, ...args],
        {
          shell: false,
          windowsHide: true,
          encoding: "buffer",
          timeout: 10000,
          maxBuffer: 1048576,
          env
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })
      );
    } catch {
      resolve({ error: true });
    }
  });
  await recheck();
  if (
    result.error ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length > 1048576 ||
    result.stderr.length > 1048576 ||
    result.stderr.length
  )
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    return kind === "users" ? text : JSON.parse(text);
  } catch {
    // Do not retain raw daemon errors, which may contain private host information.
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  }
}

async function observeH3Resources(approval, readback, recheck) {
  const spec = approval.creationSpec,
    cluster = readback.cluster;
  // DNS/proxy/wildcard paths require a separately proven mapping. This initial
  // implementation admits only an exact loopback publication on the H1 host.
  const endpoint = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(spec.endpoint);
  if (
    !endpoint ||
    Number(endpoint[2]) > 65535 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(spec.dataVolumeName)
  )
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  const host = endpoint[1] === "[::1]" ? "::1" : endpoint[1];
  const mismatch = () => fail("MANUAL_H3_RESOURCE_MISMATCH");
  const snapshot = async () => {
    const container = await dockerObservation("container", cluster.databaseContainerId, recheck);
    if (
      !container ||
      container.id !== cluster.databaseContainerId ||
      container.name !== "/" + spec.databaseContainerName ||
      container.running !== true ||
      container.paused !== false ||
      container.restarting !== false ||
      container.dead !== false ||
      container.privileged !== false ||
      container.marker !== spec.marker ||
      !/^sha256:[0-9a-f]{64}$/u.test(container.imageId) ||
      typeof container.imageReference !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*@sha256:[0-9a-f]{64}$/u.test(container.imageReference) ||
      !container.imageReference.endsWith("@" + spec.postgresImageDigest) ||
      container.defaultEntrypoint !== true ||
      container.defaultCommand !== true ||
      !Array.isArray(container.pgdata) ||
      container.pgdata.length !== 1 ||
      container.pgdata[0] !== true ||
      !Array.isArray(container.mounts) ||
      !container.networks ||
      typeof container.networks !== "object" ||
      Array.isArray(container.networks)
    )
      mismatch();
    const mounts = container.mounts.filter(
      (item) => item?.Destination === "/var/lib/postgresql/data"
    );
    if (
      mounts.length !== 1 ||
      mounts[0].Type !== "volume" ||
      mounts[0].Name !== spec.dataVolumeName ||
      mounts[0].RW !== true ||
      typeof mounts[0].Source !== "string"
    )
      mismatch();
    for (const mount of container.mounts) {
      if (mount === mounts[0]) continue;
      const dest = mount?.Destination;
      if (
        typeof dest !== "string" ||
        !dest.startsWith("/") ||
        dest === "/" ||
        "/var/lib/postgresql/data".startsWith(dest + "/") ||
        dest.startsWith("/var/lib/postgresql/data/") ||
        mount.RW !== false
      )
        mismatch();
    }
    const expectedPorts = { [`${spec.serverPort}/tcp`]: [{ HostIp: host, HostPort: endpoint[2] }] };
    if (
      sha256Canonical(container.ports) !== sha256Canonical(expectedPorts) ||
      sha256Canonical(container.portBindings) !== sha256Canonical(expectedPorts)
    )
      mismatch();
    const networks = Object.entries(container.networks);
    if (networks.length !== 1) mismatch();
    const [networkName, link] = networks[0];
    if (
      !link ||
      !/^[0-9a-f]{64}$/u.test(link.NetworkID) ||
      ![networkName, link.NetworkID].includes(container.networkMode) ||
      ["host", "none", "default", "bridge"].includes(networkName) ||
      ![link.IPAddress, link.GlobalIPv6Address].includes(cluster.serverAddress)
    )
      mismatch();
    const volume = await dockerObservation("volume", spec.dataVolumeName, recheck);
    if (
      !volume ||
      volume.name !== spec.dataVolumeName ||
      volume.driver !== "local" ||
      volume.scope !== "local" ||
      volume.mountpoint !== mounts[0].Source ||
      volume.optionsEmpty !== true ||
      volume.marker !== spec.marker
    )
      mismatch();
    const image = await dockerObservation("image", container.imageId, recheck);
    if (
      !image ||
      image.id !== container.imageId ||
      !Array.isArray(image.repoDigests) ||
      !image.repoDigests.includes(container.imageReference)
    )
      mismatch();
    const network = await dockerObservation("network", link.NetworkID, recheck);
    if (
      !network ||
      network.id !== link.NetworkID ||
      network.name !== networkName ||
      network.driver !== "bridge" ||
      network.scope !== "local"
    )
      mismatch();
    const users = await dockerObservation("users", spec.dataVolumeName, recheck);
    if (
      users !== cluster.databaseContainerId + "\n" &&
      users !== cluster.databaseContainerId + "\r\n"
    )
      mismatch();
    return { container, volume, image, network, users };
  };
  const first = await snapshot(),
    second = await snapshot();
  if (sha256Canonical(first) !== sha256Canonical(second)) mismatch();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  Promise.resolve()
    .then(() => {
      const argv = process.argv.slice(2);
      if (
        argv.length !== 2 ||
        argv[0] !== "--operation-ref" ||
        !uuid.test(argv[1] ?? "") ||
        process.env.RUNNER_LAUNCH_ENVELOPE_FILE !== undefined ||
        process.env.RUNNER_EXECUTION_MODE !== undefined
      )
        fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
      return launchManualStage1({ operationRef: argv[1] });
    })
    .catch((error) => {
      process.stderr.write(`${error?.code ?? "MANUAL_LAUNCH_FAILED"}\n`);
      process.exitCode = 1;
    });
}
