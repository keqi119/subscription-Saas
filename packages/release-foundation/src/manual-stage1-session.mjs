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
  validateManualTargetCreationRequest,
  validateManualSnapshotConsumerRequest,
  validateManualCandidateUseRequest,
  verifyManualCandidateUseAuthorizationBinding,
  verifyManualSnapshotConsumerAuthorizationBinding,
  verifyManualTargetCreationAuthorizationBinding
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
import { assertR3MatchingSources } from "./manual-r3-source-matching.mjs";
import { selectSingleR3FinalUse } from "./manual-r3-final-history.mjs";
import { readManualRevocationHistory } from "./manual-revocation-history.mjs";
import { suiteDatabaseName } from "./database-target.mjs";
import { verifyR3HostedEvidence, verifyR3HostedCleanupEvidence } from "./r3-hosted-evidence.mjs";
import { buildR3SnapshotConsumerResult } from "./r3-snapshot-consumer-result.mjs";
import {
  classifyDatabaseTests,
  discoverDatabaseTestCandidates,
  trackedTestUniverse
} from "./database-test-discovery.mjs";
import { scanDatabaseFrameworkBypasses } from "./node-database-test-runner.mjs";
import { computeMigrationCatalog, computeRepositoryContract } from "./catalogs.mjs";

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

async function readManualHistoryGraph(store, profile) {
  const graph = await store.objects();
  const values = [...graph.values()].map((entry) => entry.value);
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
  return { graph, slots };
}
function historyAccumulator() {
  return {
    r3Originals: { artifacts: new Set(), raws: new Set() },
    r3Validated: new Set(),
    r3Acknowledgements: new Set(),
    r3Cleanups: new Set(),
    r3CleanupCustody: new Set(),
    r3FinalResultCustody: new Set(),
    r3SourceProofs: new Map(),
    r3Sources: new Map(),
    r3FinalUses: new Map()
  };
}

function r3CandidateContextFacts(profileDigest, identity, r3Context, destination, snapshotReader) {
  requireThat(
    destination?.postgres &&
      destination.databaseTargetSet?.targetLocks &&
      (identity.scope.chain !== "snapshot" || snapshotReader),
    EVIDENCE
  );
  return {
    profileDigest,
    buildProofDigest: identity.scope.buildProofDigest,
    sourceSha: identity.scope.sourceSha,
    chain: identity.scope.chain,
    manifestDigest: sha256Canonical(r3Context.destinationInputs.manifest),
    manifestRawDigest: destination.manifestRawDigest,
    // Each phase authorizes its actual destination independently, so permission
    // and index digests may differ. The admitted payload and exact stored object
    // version must remain identical across the candidate attempt.
    snapshot:
      identity.scope.chain === "snapshot"
        ? snapshot({
            metadataDigest: snapshotReader.metadataDigest,
            bundleInputs: snapshotReader.bundleInputs,
            ciphertextDigest: snapshotReader.ciphertextDigest,
            objectVersion: snapshotReader.objectVersion,
            storageSubject: snapshotReader.storageSubject,
            envelopeDigest: sha256Canonical(snapshotReader.cryptoInputs.envelope)
          })
        : null,
    ci: snapshot(r3Context.jobAdmission.ci),
    operationRef: r3Context.creationSpec.operationRef,
    sessionId: identity.sessionId,
    sessionNonce: identity.sessionNonce,
    engineId: destination.postgres.engineId,
    containerId: destination.postgres.containerId,
    systemIdentifier: destination.databaseTargetSet.systemIdentifier,
    targetLocks: destination.databaseTargetSet.targetLocks.map((entry) => entry.lockDigest)
  };
}

// Shared proof verification has no signing, consumption, lock acquisition or
// checkpoint-writing methods. Live-session authority remains in its caller.
function createManualHistoryVerifier(runtime) {
  const target = runtime().target;
  function collectFinalUse(graph, accumulator, request) {
    if (
      !["snapshot-consumer", "candidate-use"].includes(request.stage) ||
      request.phase !== "final"
    )
      return;
    const { profileDigest, identity, r3Context, snapshotReader } = runtime();
    const allocation = graph.get(request.attemptAllocationDigest)?.value;
    requireThat(
      allocation?.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest,
      EVIDENCE
    );
    const requestDigest = sha256Canonical(request);
    const priorClaims = accumulator.r3FinalUses.get(requestDigest)?.sourceClaims;
    accumulator.r3FinalUses.set(requestDigest, {
      ...r3CandidateContextFacts(
        profileDigest,
        identity,
        r3Context,
        graph.get(request.destinationAdmissionDigest)?.value,
        snapshotReader
      ),
      stage: request.stage,
      runId: request.runId,
      allocatedAt: allocation.allocatedAt,
      matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
      consumerMatchingSourceEvidenceDigest:
        request.stage === "candidate-use" && identity.scope.chain === "snapshot"
          ? graph.get(graph.get(request.preparationExecutionRecordDigest)?.value?.requestDigest)
              ?.value?.matchingSourceEvidenceDigest
          : null,
      ...(priorClaims ? { sourceClaims: priorClaims } : {})
    });
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
  async function archiveInput(
    request,
    graph = null,
    historicalConsumption = null,
    r3Validated = null,
    r3Originals = null
  ) {
    const { profile, profileBytes, profileDigest, store } = runtime();
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
            (value.kind === "cleanup-observation" &&
              r3Originals?.artifacts.has(sha256Canonical(value))) ||
            (value.kind === "consumption" && r3Validated?.has(sha256Canonical(value))) ||
            (value.kind === "execution" && r3Validated?.has(value.consumptionRecordDigest)),
          SESSION
        );
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-request.v4") {
        validateManualTargetCreationRequest(value);
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-request.v3") {
        validateManualSnapshotConsumerRequest(value);
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-request.v5") {
        validateManualCandidateUseRequest(value);
        r2Artifacts.push(null);
      } else if (value.schemaVersion === "manual-runner-evidence.v2") {
        validateContract("manual-runner-evidence.v2", value);
        r2Artifacts.push(null);
      } else if (value.payload?.schemaVersion === "manual-launch-authorization.v4") {
        validateContract("manual-launch-authorization.v4", value);
        r2Artifacts.push(null);
      } else if (value.payload?.schemaVersion === "manual-launch-authorization.v3") {
        validateContract("manual-launch-authorization.v3", value);
        r2Artifacts.push(null);
      } else if (value.payload?.schemaVersion === "manual-launch-authorization.v5") {
        validateContract("manual-launch-authorization.v5", value);
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
    const { profile, profileDigest, recordSchema, store, r3 } = runtime();
    const graph = await store.objects(),
      values = [...graph.values()].map((item) => item.value);
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
  async function r3CandidatePreparation(request, graph = null) {
    const { store, r3Context, creationCompletionDigest, consumerCompletionDigest } = runtime();
    requireThat(
      ["source", "final"].includes(r3Context.scope.phase) && creationCompletionDigest,
      SESSION
    );
    graph ??= await store.objects();
    const creation = graph.get(creationCompletionDigest)?.value;
    const predecessorDigest =
      r3Context.scope.chain === "snapshot" ? consumerCompletionDigest : creationCompletionDigest;
    const predecessor = graph.get(predecessorDigest)?.value;
    requireThat(
      creation?.stage === "target-create" &&
        creation.status === "SUCCEEDED" &&
        creation.resultDigest === request.destinationAdmissionDigest &&
        request.preparationExecutionRecordDigest === predecessorDigest &&
        predecessor?.kind === "execution" &&
        predecessor.status === "SUCCEEDED" &&
        predecessor.stage ===
          (r3Context.scope.chain === "snapshot" ? "snapshot-consumer" : "target-create") &&
        ["profileDigest", "sessionId", "sessionNonce", "operationId"].every(
          (field) => predecessor[field] === request[field]
        ) &&
        request.databaseTestManifestDigest ===
          sha256Canonical(r3Context.destinationInputs.manifest),
      BINDING
    );
    if (request.phase === "final" && r3Context.scope.chain === "snapshot") {
      const consumerRequest = graph.get(predecessor.requestDigest)?.value;
      requireThat(
        consumerRequest?.schemaVersion === "manual-runner-request.v3" &&
          consumerRequest.phase === "final" &&
          consumerRequest.destinationAdmissionDigest === request.destinationAdmissionDigest &&
          consumerRequest.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest,
        BINDING
      );
    }
    return predecessor;
  }
  function r3LifecycleLock(destination, record) {
    const { r3Context, stamp } = runtime();
    const operationRef = r3Context.creationSpec.operationRef;
    exact(
      record,
      [
        "recordVersion",
        "targetFingerprint",
        "databaseName",
        "databaseOid",
        "marker",
        "runId",
        "suiteId",
        "shard",
        "roles",
        "secretReferences",
        "createdAt"
      ],
      SESSION
    );
    const plan = destination.databaseTargetSet.plan;
    const shard = record.shard;
    requireThat(
      record.recordVersion === "provisioned-database.v1" &&
        record.runId === operationRef &&
        record.suiteId === "database-lifecycle" &&
        (shard === 0 || shard === 1) &&
        plan.operationRef === operationRef &&
        Array.isArray(plan.reservations) &&
        plan.reservations.length === 2,
      SESSION
    );
    const reservation = plan.reservations[shard];
    const postgres = destination.postgres;
    const engineId = postgres.engineId;
    const systemIdentifier = postgres.postgres.systemIdentifier;
    const targetFingerprint = sha256Canonical({
      engineId,
      systemIdentifier,
      containerId: postgres.containerId,
      imageDigest: postgres.imageDigest
    });
    requireThat(
      reservation.shard === shard &&
        reservation.suiteIdentity === "database-lifecycle" &&
        reservation.databaseName === suiteDatabaseName(operationRef, "database-lifecycle", shard) &&
        record.databaseName === reservation.databaseName &&
        equal(record.roles, reservation.roles) &&
        record.targetFingerprint === targetFingerprint &&
        /^[1-9][0-9]*$/u.test(record.databaseOid) &&
        instant(record.createdAt) >= instant(destination.observedAt) &&
        instant(record.createdAt) <= instant(stamp()),
      SESSION
    );
    exact(record.secretReferences, Object.keys(reservation.roles), SESSION);
    requireThat(
      Object.keys(reservation.roles).every(
        (profile) =>
          record.secretReferences[profile] ===
          `r3/${operationRef}/database-credentials/${record.databaseName}-${profile}.json`
      ),
      SESSION
    );
    const marker = {
      markerVersion: "subscription-s1-ephemeral/v1",
      runIdDigest: sha256Canonical(operationRef),
      suiteIdDigest: sha256Canonical("database-lifecycle"),
      shard,
      createdAt: record.createdAt
    };
    requireThat(record.marker === encodeManualJson(marker).toString("utf8"), SESSION);
    const reservedIdentity = {
      kind: "r3-database-reservation",
      engineId,
      systemIdentifier,
      databaseName: reservation.databaseName
    };
    const reservedLockDigest = sha256Canonical(reservedIdentity);
    requireThat(
      destination.databaseTargetSet.targetLocks.some(
        (entry) =>
          entry.lockDigest === reservedLockDigest &&
          entry.databaseName === reservation.databaseName &&
          equal(entry.identity, reservedIdentity)
      ),
      SESSION
    );
    const identity = {
      kind: "r3-database-target",
      engineId,
      systemIdentifier,
      databaseOid: record.databaseOid,
      marker: record.marker
    };
    const entry = {
      lockDigest: sha256Canonical(identity),
      identity,
      databaseName: record.databaseName
    };
    requireThat(
      !destination.databaseTargetSet.targetLocks.some(
        (held) =>
          held.lockDigest === entry.lockDigest ||
          (held.identity.kind === "r3-database-target" &&
            held.identity.databaseOid === record.databaseOid)
      ),
      SESSION
    );
    return { shard, entry, reservedLockDigest, recordDigest: sha256Canonical(record) };
  }
  async function r3StoredDestination(graph, destinationDigest, initialExecution) {
    const {
      profile,
      profileDigest,
      store,
      identity,
      sessionId,
      sessionNonce,
      r3Context,
      targetLocks,
      lifecycleTargetLocks,
      evidenceState,
      evidenceTime
    } = runtime();
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
      now: evidenceTime(destination.observedAt)
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
    const expectedDigests = new Set(expectedLocks.map((entry) => entry.lockDigest));
    const lifecycleOids = new Set();
    for (const held of lifecycleTargetLocks.values()) {
      const checked = r3LifecycleLock(rebuilt.destination, held.record);
      requireThat(
        equal(checked.entry, held.entry) &&
          checked.recordDigest === held.recordDigest &&
          !expectedDigests.has(held.entry.lockDigest) &&
          !lifecycleOids.has(held.entry.identity.databaseOid) &&
          targetLocks.has(held.entry.lockDigest),
        SESSION
      );
      expectedDigests.add(held.entry.lockDigest);
      lifecycleOids.add(held.entry.identity.databaseOid);
    }
    requireThat(
      expectedDigests.size === targetLocks.size &&
        [...expectedDigests].every((digest) => targetLocks.has(digest)),
      SESSION
    );
    await evidenceState();
    return {
      destination,
      destinationDigest,
      observationDigest,
      streamDigest: sha256Bytes(Buffer.from(observations.postgres.streamBase64, "base64"))
    };
  }
  async function r3ConsumerOriginals(graph, initial, request, completed = null) {
    const { profile, store, r3Context, stamp, snapshotReader, creationCompletionDigest } =
      runtime();
    requireThat(snapshotReader && creationCompletionDigest, SESSION);
    const destination = graph.get(request.destinationAdmissionDigest)?.value;
    requireThat(
      destination && sha256Canonical(destination) === request.destinationAdmissionDigest,
      EVIDENCE
    );
    const readArchived = async (digest) => {
      const bytes = await store.read(objectPath(profile.storage.archiveRoot, digest));
      requireThat(
        sha256Bytes(bytes) === digest && graph.get(digest)?.bytes.equals(bytes),
        EVIDENCE
      );
      requireThat(
        (await store.read(objectPath(profile.storage.backupRoot, digest))).equals(bytes),
        STORAGE
      );
      return JSON.parse(bytes);
    };
    let readbacks, completedAt;
    if (completed) {
      const process = await readArchived(completed.processEvidenceDigest);
      exact(
        process.readbacks,
        ["fetchDigest", "decryptionDigest", "copyDigest", "restoreDigests", "cleanupDigest"],
        EVIDENCE
      );
      requireThat(
        Array.isArray(process.readbacks.restoreDigests) &&
          process.readbacks.restoreDigests.length === destination.databaseTargetSet.records.length,
        EVIDENCE
      );
      readbacks = {
        fetch: await readArchived(process.readbacks.fetchDigest),
        decryption: await readArchived(process.readbacks.decryptionDigest),
        copy: await readArchived(process.readbacks.copyDigest),
        restores: [],
        cleanup: await readArchived(process.readbacks.cleanupDigest)
      };
      for (const entry of process.readbacks.restoreDigests) {
        exact(entry, ["databaseName", "digest"], EVIDENCE);
        readbacks.restores.push(await readArchived(entry.digest));
      }
      completedAt = process.completedAt;
    } else {
      const root = path.join(
        profile.storage.credentialRoot,
        "r3",
        r3Context.creationSpec.operationRef,
        "consumer",
        "observations"
      );
      const readPrivate = async (...segments) =>
        JSON.parse(await store.read(path.join(root, ...segments, "readback.json")));
      readbacks = {
        fetch: await readPrivate(),
        decryption: await readPrivate("decryption"),
        copy: await readPrivate("copy"),
        restores: [],
        cleanup: await readPrivate("cleanup")
      };
      for (const target of destination.databaseTargetSet.records) {
        requireThat(/^[a-z][a-z0-9_]{0,62}$/u.test(target.databaseName), EVIDENCE);
        readbacks.restores.push(await readPrivate("restore", target.databaseName));
      }
      completedAt = stamp();
    }
    await snapshotReader.recheck();
    const built = buildR3SnapshotConsumerResult({
      destination,
      initialExecution: initial,
      snapshotInput: {
        inputIndexDigest: snapshotReader.inputIndexDigest,
        ...snapshotReader.restoreInputs,
        storageSubject: snapshotReader.storageSubject,
        cryptoInputs: snapshotReader.cryptoInputs
      },
      readbacks,
      completedAt
    });
    if (completed) {
      requireThat(
        sha256Canonical(built.result) === completed.resultDigest &&
          sha256Canonical(built.processEvidence) === completed.processEvidenceDigest,
        EVIDENCE
      );
      for (const { digest, value } of built.originals)
        requireThat(equal(await readArchived(digest), value), EVIDENCE);
    }
    return built;
  }
  async function r3SourceProof(graph, initial, completed = null) {
    const { profile, store, r3Context, stamp } = runtime();
    const request = graph.get(initial.requestDigest)?.value;
    requireThat(request?.schemaVersion === "manual-runner-request.v5", SESSION);
    const verified = await r3ReadSourceOriginals();
    const subjects = new Set(verified.originals.map(({ digest }) => digest));
    const custodyRecords = [...graph.values()]
      .map(({ value }) => value)
      .filter(
        (value) =>
          value.kind === "custody" &&
          subjects.has(value.subjectDigest) &&
          ["archive-readback", "backup-readback"].includes(value.purpose)
      );
    for (const value of custodyRecords) {
      const bytes = encodeManualJson(value),
        digest = sha256Bytes(bytes);
      for (const role of ["archive", "backup"])
        requireThat(
          (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(bytes),
          STORAGE
        );
    }
    const stored = completed ? graph.get(completed.resultDigest)?.value : null;
    requireThat(!completed || stored?.schemaVersion === "manual-r3-source-result.v1", EVIDENCE);
    const { buildR3SourceCompletion } =
      await import("../../../scripts/release/r3-source-result.mjs");
    const result = buildR3SourceCompletion({
      request,
      initialExecution: initial,
      manifest: r3Context.destinationInputs.manifest,
      verified,
      custodyRecords,
      completedAt: completed ? stored.completedAt : stamp()
    });
    if (completed) {
      requireThat(
        equal(stored, result) &&
          sha256Canonical(result) === completed.resultDigest &&
          completed.processEvidenceDigest === verified.readbackDigest &&
          instant(result.completedAt) <= instant(completed.finishedAt),
        EVIDENCE
      );
      for (const role of ["archive", "backup"])
        requireThat(
          (
            await store.read(objectPath(profile.storage[`${role}Root`], completed.resultDigest))
          ).equals(encodeManualJson(result)),
          STORAGE
        );
    }
    return { request, result, verified };
  }
  async function r3FinalProof(graph, initial, completed = null) {
    const { profile, store, r3Context, stamp } = runtime();
    const request = graph.get(initial.requestDigest)?.value;
    requireThat(
      request?.schemaVersion === "manual-runner-request.v5" && request.phase === "final",
      SESSION
    );
    const verified = await r3ReadFinalOriginals();
    const subjects = new Set(verified.originals.map(({ digest }) => digest));
    const custodyRecords = [...graph.values()]
      .map(({ value }) => value)
      .filter(
        (value) =>
          value.kind === "custody" &&
          subjects.has(value.subjectDigest) &&
          ["archive-readback", "backup-readback"].includes(value.purpose)
      );
    for (const value of custodyRecords) {
      const bytes = encodeManualJson(value);
      const digest = sha256Bytes(bytes);
      for (const role of ["archive", "backup"])
        requireThat(
          (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(bytes),
          STORAGE
        );
    }
    const stored = completed ? graph.get(completed.resultDigest)?.value : null;
    requireThat(!completed || stored?.schemaVersion === "manual-r3-final-result.v1", EVIDENCE);
    const { buildR3FinalCompletion } = await import("../../../scripts/release/r3-final-result.mjs");
    const result = buildR3FinalCompletion({
      request,
      initialExecution: initial,
      manifest: r3Context.destinationInputs.manifest,
      verified,
      custodyRecords,
      completedAt: completed ? stored.completedAt : stamp()
    });
    if (completed) {
      requireThat(
        equal(stored, result) &&
          sha256Canonical(result) === completed.resultDigest &&
          completed.processEvidenceDigest === verified.readbackDigest &&
          instant(result.completedAt) <= instant(completed.finishedAt),
        EVIDENCE
      );
      for (const role of ["archive", "backup"])
        requireThat(
          (
            await store.read(objectPath(profile.storage[`${role}Root`], completed.resultDigest))
          ).equals(encodeManualJson(result)),
          STORAGE
        );
    }
    return { request, result, verified };
  }
  // A cleanup observation consumes no authorization and changes no execution.
  // Both live completion and historical replay rebuild its evidence here.
  async function r3CleanupProof(graph, record, supplied = null) {
    const {
      profile,
      profileDigest,
      identity,
      sessionId,
      sessionNonce,
      current,
      r3Context,
      store,
      stamp,
      creationCompletionDigest,
      candidateUseReceipt
    } = runtime();
    validateContract("manual-operation-record.v3", record);
    requireThat(
      record.kind === "cleanup-observation" &&
        ["source", "final"].includes(identity.scope.phase) &&
        record.profileDigest === profileDigest &&
        record.sessionId === sessionId &&
        record.sessionNonce === sessionNonce &&
        record.ownerId === profile.ownerId &&
        equal(record.scope, identity.scope) &&
        record.operationRef === r3Context.creationSpec.operationRef &&
        record.sessionRecordDigest === sha256Canonical(current) &&
        current.status === "OPEN" &&
        instant(record.recordedAt) <= instant(stamp()),
      EVIDENCE
    );
    const phase = identity.scope.phase;
    const terminalDigest = record[`${phase}ExecutionRecordDigest`];
    const resultDigest = record[`${phase}ResultDigest`];
    const acknowledgementDigest = record[`${phase}AcknowledgementRecordDigest`];
    const terminal = graph.get(terminalDigest)?.value;
    const initial = graph.get(candidateUseReceipt?.executionRecordDigest)?.value;
    const result = graph.get(resultDigest)?.value;
    const acknowledgement = graph.get(acknowledgementDigest)?.value;
    requireThat(
      initial?.stage === "candidate-use" &&
        terminal?.stage === "candidate-use" &&
        terminal.status === "SUCCEEDED" &&
        terminal.resultDigest === resultDigest &&
        terminal.predecessorExecutionRecordDigest === sha256Canonical(initial) &&
        terminal.sessionId === sessionId &&
        terminal.sessionNonce === sessionNonce &&
        terminal.operationId === record.operationRef &&
        [...graph.values()].filter(
          ({ value }) =>
            value.kind === "custody" &&
            value.purpose === "owner-acknowledgement" &&
            value.subjectDigest === terminalDigest
        ).length === 1,
      EVIDENCE
    );
    const assertAcknowledgement =
      phase === "source"
        ? (await import("../../../scripts/release/r3-source-result.mjs"))
            .assertR3SourceAcknowledgement
        : (await import("../../../scripts/release/r3-final-result.mjs"))
            .assertR3FinalAcknowledgement;
    assertAcknowledgement({
      acknowledgement,
      profileDigest,
      ownerId: profile.ownerId,
      execution: terminal,
      result,
      now: record.recordedAt
    });
    const originals = new Map();
    const read = async (digest) => {
      if (originals.has(digest)) return originals.get(digest);
      const bytes = supplied ? supplied.get(digest) : graph.get(digest)?.bytes;
      requireThat(
        Buffer.isBuffer(bytes) &&
          bytes.length <= LIMIT &&
          sha256Bytes(bytes) === digest &&
          encodeManualJson(JSON.parse(bytes)).equals(bytes),
        EVIDENCE
      );
      if (!supplied)
        for (const role of ["archive", "backup"])
          requireThat(
            (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(bytes),
            STORAGE
          );
      originals.set(digest, bytes);
      return bytes;
    };
    const cleanupBundle = await read(record.cleanupBundleDigest);
    const creationBundle = await read(record.creationEvidenceDigest);
    for (const role of ["archive", "backup"])
      for (const [state, name, bytes] of [
        ["cleanup", "hosted-cleanup.json", cleanupBundle],
        ["active", "hosted-evidence.json", creationBundle]
      ])
        requireThat(
          (
            await store.read(
              path.join(
                profile.storage[`${role}Root`],
                "inputs",
                "r3",
                record.operationRef,
                "observations",
                state,
                name
              )
            )
          ).equals(bytes),
          STORAGE
        );
    const policyBytes = Buffer.from(r3Context.destinationInputs.policyBytesBase64, "base64");
    requireThat(sha256Bytes(policyBytes) === identity.scope.targetPolicyDigest, EVIDENCE);
    const verified = verifyR3HostedCleanupEvidence({
      bundleBytes: cleanupBundle,
      creationEvidenceBytes: creationBundle,
      jobAdmissionBytes: encodeManualJson(r3Context.jobAdmission),
      spec: r3Context.creationSpec,
      policyBytes,
      now: record.recordedAt
    });
    const destination = graph.get(graph.get(creationCompletionDigest)?.value?.resultDigest)?.value;
    requireThat(
      destination?.hostedEvidenceDigest === record.creationEvidenceDigest &&
        verified.bundleDigest === record.cleanupBundleDigest &&
        instant(acknowledgement.recordedAt) <= instant(verified.cleanup.startedAt),
      EVIDENCE
    );
    for (const [field, value] of Object.entries(verified.cleanup.postgres))
      requireThat(equal(value, destination.postgres[field]), EVIDENCE);
    requireThat(verified.cleanup.engine.id === destination.postgres.engineId, EVIDENCE);
    const forward = JSON.parse(await read(record.forwardEvidenceDigest));
    exact(forward, ["schemaVersion", "observation", "rawInputs"], EVIDENCE);
    requireThat(
      forward.schemaVersion === "manual-r3-forward-shutdown-evidence.v1" &&
        forward.rawInputs &&
        typeof forward.rawInputs === "object" &&
        !Array.isArray(forward.rawInputs) &&
        sha256Canonical(forward.observation) === record.forwardObservationDigest &&
        instant(verified.cleanup.finishedAt) <= instant(forward.observation.startedAt),
      EVIDENCE
    );
    const rawInputs = Object.fromEntries(
      Object.entries(forward.rawInputs).map(([name, encoded]) => {
        requireThat(typeof encoded === "string", EVIDENCE);
        const bytes = Buffer.from(encoded, "base64");
        requireThat(bytes.toString("base64") === encoded && bytes.length <= LIMIT, EVIDENCE);
        return [name, bytes];
      })
    );
    const { assessR3H1ForwardShutdown } =
      await import("../../../scripts/release/r3-h1-forward-lease.mjs");
    assessR3H1ForwardShutdown({
      observationBytes: encodeManualJson(forward.observation),
      rawInputs,
      now: record.recordedAt
    });
    originals.set(sha256Canonical(record), encodeManualJson(record));
    if (!supplied)
      for (const role of ["archive", "backup"])
        requireThat(
          (
            await store.read(objectPath(profile.storage[`${role}Root`], sha256Canonical(record)))
          ).equals(encodeManualJson(record)),
          STORAGE
        );
    return { originals, verified, forward };
  }
  async function validateR3CleanupContext(graph, accumulator) {
    const { profile, profileDigest, sessionId, sessionNonce, store, stamp } = runtime();
    const values = [...graph.values()].map(({ value }) => value);
    const records = values.filter(
      (value) => value.kind === "cleanup-observation" && value.sessionId === sessionId
    );
    requireThat(records.length <= 1, EVIDENCE);
    for (const record of records) {
      const proof = await r3CleanupProof(graph, record);
      requireThat(
        accumulator.r3Acknowledgements.has(
          record[`${record.scope.phase}AcknowledgementRecordDigest`]
        ),
        EVIDENCE
      );
      for (const [digest] of proof.originals) {
        const custody = values.filter(
          (value) => value.kind === "custody" && value.subjectDigest === digest
        );
        const roles = new Set(["archive", "backup"]);
        requireThat(custody.length === 2, EVIDENCE);
        for (const value of custody) {
          validateContract("manual-operation-record.v3", value);
          requireThat(
            roles.delete(value.storageRole) &&
              value.profileDigest === profileDigest &&
              value.ownerId === profile.ownerId &&
              value.subjectType === "record" &&
              value.purpose === `${value.storageRole}-readback` &&
              value.outcome === "MATCH" &&
              value.observedDigest === digest &&
              value.retentionDays === 90 &&
              value.reasonCode === null &&
              instant(record.recordedAt) <= instant(value.observedAt) &&
              instant(value.observedAt) <= instant(value.recordedAt) &&
              instant(value.recordedAt) <= instant(stamp()),
            EVIDENCE
          );
          const bytes = encodeManualJson(value),
            custodyDigest = sha256Bytes(bytes);
          for (const role of ["archive", "backup"])
            requireThat(
              (await store.read(objectPath(profile.storage[`${role}Root`], custodyDigest))).equals(
                bytes
              ),
              STORAGE
            );
          accumulator.r3CleanupCustody.add(custodyDigest);
        }
        accumulator.r3Originals.artifacts.add(digest);
      }
      accumulator.r3Cleanups.add(sha256Canonical(record));
    }
    for (const value of values.filter(
      (entry) =>
        entry.kind === "session" &&
        entry.sessionId === sessionId &&
        entry.sessionNonce === sessionNonce &&
        entry.status === "CLOSED"
    )) {
      requireThat(
        records.length === 1 && instant(records[0].recordedAt) <= instant(value.recordedAt),
        EVIDENCE
      );
      for (const custodyDigest of accumulator.r3CleanupCustody) {
        const custody = graph.get(custodyDigest)?.value;
        if (
          custody &&
          [
            sha256Canonical(records[0]),
            records[0].cleanupBundleDigest,
            records[0].creationEvidenceDigest,
            records[0].forwardEvidenceDigest
          ].includes(custody.subjectDigest)
        )
          requireThat(instant(custody.recordedAt) <= instant(value.recordedAt), EVIDENCE);
      }
    }
  }
  async function validateR3Context(
    graph,
    slots,
    consumptions,
    accumulator,
    pendingDigest = null,
    pendingDestination = null,
    pendingConsumer = null
  ) {
    const {
      profile,
      profileDigest,
      retentionDays,
      store,
      identity,
      sessionId,
      sessionNonce,
      current,
      r3Context,
      stamp,
      revocations,
      snapshotReader,
      candidateUseReceipt
    } = runtime();
    const values = [...graph.values()].map((entry) => entry.value);
    const { r3Originals, r3Validated, r3Acknowledgements } = accumulator;
    const legacy = [];
    let creationCount = 0,
      consumerCount = 0,
      candidateUseCount = 0,
      historicalCompletion = null,
      historicalConsumerPredecessor = null,
      historicalConsumerDestination = null;
    for (const consumed of consumptions) {
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
      const creation = request.schemaVersion === "manual-runner-request.v4";
      const consumer = request.schemaVersion === "manual-runner-request.v3";
      const candidateUse = request.schemaVersion === "manual-runner-request.v5";
      const r3Request = creation || consumer || candidateUse;
      if (creation) validateManualTargetCreationRequest(request);
      else if (consumer) validateManualSnapshotConsumerRequest(request);
      else if (candidateUse) validateManualCandidateUseRequest(request);
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
        if (creation) creationCount++;
        else if (consumer) consumerCount++;
        else candidateUseCount++;
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
            consumed.stage ===
              (creation ? "target-create" : candidateUse ? "candidate-use" : "snapshot-consumer") &&
            consumed.operationId === r3Context.creationSpec.operationRef &&
            consumed.sessionRecordDigest === sha256Canonical(current) &&
            equal(session.scope, identity.scope) &&
            request.sessionId === sessionId &&
            request.sessionNonce === sessionNonce &&
            request.operationId === consumed.operationId &&
            request.stage === consumed.stage &&
            request.ownerId === profile.ownerId &&
            request.profileDigest === profileDigest &&
            request.sourceSha === identity.scope.sourceSha &&
            request.candidate.buildProofDigest === identity.scope.buildProofDigest &&
            request.phase === identity.scope.phase &&
            request.attemptAllocationDigest === sha256Canonical(allocation) &&
            allocation.sessionRecordDigest === consumed.sessionRecordDigest &&
            allocation.idempotencyKey === request.idempotencyKey &&
            allocation.stage === request.stage &&
            allocation.phase === request.phase &&
            allocation.sourceSha === request.sourceSha &&
            allocation.buildProofDigest === request.candidate.buildProofDigest &&
            execution.status === "INTERRUPTED_UNKNOWN" &&
            execution.predecessorExecutionRecordDigest ===
              (creation ? null : allocation.predecessorExecutionRecordDigest) &&
            execution.startedAt === null &&
            execution.finishedAt === null &&
            execution.resultDigest === null &&
            execution.processEvidenceDigest === null &&
            execution.requestDigest === consumed.requestDigest &&
            execution.idempotencyKey === request.idempotencyKey &&
            execution.stage === consumed.stage &&
            consumed.ownerId === profile.ownerId &&
            consumed.status === "CONSUMED" &&
            instant(session.openedAt) <= instant(allocation.recordedAt) &&
            instant(allocation.recordedAt) <= instant(allocation.allocatedAt) &&
            instant(allocation.allocatedAt) <= instant(authorization.payload.issuedAt) &&
            instant(authorization.payload.issuedAt) <= instant(consumed.recordedAt) &&
            instant(consumed.recordedAt) <= instant(execution.recordedAt),
          SESSION
        );
        const consumptionCustody = values.filter(
          (value) =>
            value.kind === "custody" &&
            value.subjectDigest === digest &&
            value.purpose === "consumption-readback"
        );
        requireThat(
          consumptionCustody.length === 1 &&
            consumptionCustody[0].schemaVersion === "manual-operation-record.v3" &&
            consumptionCustody[0].ownerId === profile.ownerId &&
            consumptionCustody[0].profileDigest === profileDigest &&
            consumptionCustody[0].subjectType === "record" &&
            consumptionCustody[0].outcome === "MATCH" &&
            consumptionCustody[0].observedDigest === digest &&
            consumptionCustody[0].storageRole === "journal" &&
            consumptionCustody[0].retentionDays === retentionDays &&
            instant(consumed.recordedAt) <= instant(consumptionCustody[0].observedAt) &&
            instant(consumptionCustody[0].observedAt) <= instant(execution.recordedAt),
          SESSION
        );
        if (creation || candidateUse)
          requireThat(
            (candidateUse || allocation.predecessorExecutionRecordDigest === null) &&
              allocation.chain === identity.scope.chain &&
              allocation.targetPolicyDigest === identity.scope.targetPolicyDigest &&
              allocation.creationSpecDigest === identity.scope.creationSpecDigest &&
              allocation.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
              request.chain === identity.scope.chain &&
              request.targetPolicyDigest === identity.scope.targetPolicyDigest &&
              request.creationSpecDigest === identity.scope.creationSpecDigest &&
              request.jobAdmissionDigest === identity.scope.jobAdmissionDigest,
            SESSION
          );
        requireThat(
          authorization?.payload?.schemaVersion ===
            (creation
              ? "manual-launch-authorization.v4"
              : candidateUse
                ? "manual-launch-authorization.v5"
                : "manual-launch-authorization.v3") &&
            authorization.payload.authorizationId &&
            authorization.payload.requestDigest === consumed.requestDigest &&
            authorization.payload.sessionId === sessionId &&
            authorization.payload.sessionNonce === sessionNonce &&
            authorization.payload.operationId === request.operationId &&
            authorization.payload.idempotencyKey === request.idempotencyKey &&
            authorization.payload.profileDigest === profileDigest &&
            authorization.payload.ownerId === profile.ownerId &&
            authorization.payload.stage === consumed.stage &&
            (creation || candidateUse
              ? authorization.payload.creationSpecDigest === identity.scope.creationSpecDigest &&
                authorization.payload.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
                authorization.payload.targetPolicyDigest === identity.scope.targetPolicyDigest
              : authorization.payload.scopeAuthorizationDigest ===
                request.scopeAuthorizationDigest) &&
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
        (creation
          ? verifyManualTargetCreationAuthorizationBinding
          : candidateUse
            ? verifyManualCandidateUseAuthorizationBinding
            : verifyManualSnapshotConsumerAuthorizationBinding)({
          authorization,
          profile,
          requestBytes: encodeManualJson(request),
          now: consumed.recordedAt
        });
        const linkedDigest = sha256Canonical(execution);
        if (candidateUse) {
          let finalClaims = null;
          const predecessor = await r3CandidatePreparation(request, graph);
          requireThat(
            candidateUseReceipt?.executionRecordDigest === linkedDigest &&
              linked.length <= 2 &&
              execution.reasonCode === "MANUAL_EVIDENCE_INCOMPLETE" &&
              allocation.predecessorExecutionRecordDigest ===
                request.preparationExecutionRecordDigest &&
              [
                "destinationAdmissionDigest",
                "preparationExecutionRecordDigest",
                "databaseTestManifestDigest",
                ...(request.phase === "final" ? ["matchingSourceEvidenceDigest"] : [])
              ].every((field) => allocation[field] === request[field]) &&
              instant(predecessor.recordedAt) <= instant(allocation.allocatedAt),
            SESSION
          );
          for (const role of ["journal", "archive", "backup"])
            requireThat(
              (await store.read(objectPath(profile.storage[`${role}Root`], linkedDigest))).equals(
                encodeManualJson(execution)
              ),
              STORAGE
            );
          if (linked.length === 2) {
            const completed = linked.find((value) => value !== execution);
            requireThat(
              completed?.status === "SUCCEEDED" &&
                completed.reasonCode === null &&
                completed.stage === "candidate-use" &&
                completed.predecessorExecutionRecordDigest === linkedDigest &&
                completed.startedAt === execution.recordedAt &&
                instant(completed.finishedAt) <= instant(completed.recordedAt) &&
                instant(completed.recordedAt) <= instant(stamp()) &&
                [
                  "profileDigest",
                  "sessionId",
                  "sessionNonce",
                  "operationId",
                  "idempotencyKey",
                  "attemptId",
                  "requestDigest",
                  "authorizationDigest",
                  "consumptionRecordDigest"
                ].every((field) => completed[field] === execution[field]),
              SESSION
            );
            const proof =
              identity.scope.phase === "source"
                ? await r3SourceProof(graph, execution, completed)
                : await r3FinalProof(graph, execution, completed);
            const expected = new Set(["archive", "backup"]);
            const custody = values.filter(
              (value) =>
                value.kind === "custody" &&
                value.subjectDigest === completed.resultDigest &&
                ["archive-readback", "backup-readback"].includes(value.purpose)
            );
            requireThat(custody.length === 2, EVIDENCE);
            for (const value of custody) {
              requireThat(
                value.schemaVersion === "manual-operation-record.v3" &&
                  expected.delete(value.storageRole) &&
                  value.profileDigest === profileDigest &&
                  value.ownerId === profile.ownerId &&
                  value.subjectType === "record" &&
                  value.purpose === `${value.storageRole}-readback` &&
                  value.outcome === "MATCH" &&
                  value.observedDigest === completed.resultDigest &&
                  value.retentionDays === 90 &&
                  value.reasonCode === null &&
                  instant(proof.result.completedAt) <= instant(value.observedAt) &&
                  instant(value.observedAt) <= instant(value.recordedAt) &&
                  instant(value.recordedAt) <= instant(completed.finishedAt),
                EVIDENCE
              );
              for (const role of ["archive", "backup"])
                requireThat(
                  (
                    await store.read(
                      objectPath(profile.storage[`${role}Root`], sha256Canonical(value))
                    )
                  ).equals(encodeManualJson(value)),
                  STORAGE
                );
              if (identity.scope.phase === "final")
                accumulator.r3FinalResultCustody.add(sha256Canonical(value));
            }
            requireThat(expected.size === 0, EVIDENCE);
            for (const role of ["journal", "archive", "backup"])
              requireThat(
                (
                  await store.read(
                    objectPath(profile.storage[`${role}Root`], sha256Canonical(completed))
                  )
                ).equals(encodeManualJson(completed)),
                STORAGE
              );
            r3Originals.artifacts.add(completed.resultDigest);
            const acknowledgements = values.filter(
              (value) =>
                value.schemaVersion === "manual-operation-record.v3" &&
                value.kind === "custody" &&
                value.purpose === "owner-acknowledgement" &&
                value.subjectDigest === sha256Canonical(completed)
            );
            requireThat(acknowledgements.length <= 1, EVIDENCE);
            const assertAcknowledgement =
              identity.scope.phase === "source"
                ? (await import("../../../scripts/release/r3-source-result.mjs"))
                    .assertR3SourceAcknowledgement
                : (await import("../../../scripts/release/r3-final-result.mjs"))
                    .assertR3FinalAcknowledgement;
            for (const acknowledgement of acknowledgements) {
              assertAcknowledgement({
                acknowledgement,
                profileDigest,
                ownerId: profile.ownerId,
                execution: completed,
                result: proof.result,
                now: stamp()
              });
              const bytes = encodeManualJson(acknowledgement);
              const digest = sha256Bytes(bytes);
              for (const role of ["archive", "backup"])
                requireThat(
                  (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(
                    bytes
                  ),
                  STORAGE
                );
              r3Acknowledgements.add(digest);
            }
            if (identity.scope.phase === "source") {
              const destination = graph.get(request.destinationAdmissionDigest)?.value;
              const buildProof = graph.get(request.candidate.buildProofDigest)?.value;
              requireThat(
                destination?.postgres &&
                  buildProof?.identity &&
                  sha256Canonical(destination) === request.destinationAdmissionDigest &&
                  sha256Canonical(buildProof) === request.candidate.buildProofDigest,
                EVIDENCE
              );
              const { buildR3SourceGateEvidence } =
                await import("../../../scripts/release/r3-source-result.mjs");
              const sourceGateEvidence = buildR3SourceGateEvidence({
                spec: r3Context.creationSpec,
                job: r3Context.jobAdmission,
                execution: completed,
                result: proof.result,
                reconstructed: proof.verified.reconstructed,
                postgres: {
                  imageDigest: destination.postgres.imageDigest,
                  serverVersionNum: String(destination.postgres.postgres.serverVersionNum)
                },
                migrationCatalogDigest: buildProof.identity.migrationCatalogDigest,
                repositoryContractDigest: buildProof.identity.repositoryContractDigest,
                ...(identity.scope.chain === "snapshot"
                  ? {
                      snapshot: {
                        metadata: snapshotReader?.restoreInputs?.metadata,
                        bundleInputs: snapshotReader?.bundleInputs,
                        execution: graph.get(request.preparationExecutionRecordDigest)?.value,
                        result: graph.get(
                          graph.get(request.preparationExecutionRecordDigest)?.value?.resultDigest
                        )?.value
                      }
                    }
                  : {})
              });
              accumulator.r3SourceProofs.set(
                sha256Canonical(completed),
                freeze({
                  resultDigest: completed.resultDigest,
                  reconstructedDigest: proof.result.reconstructedDigest,
                  postSchemaDigest: proof.verified.postSchemaDigest,
                  sourceGateEvidence: freeze(snapshot(sourceGateEvidence)),
                  sourceGateEvidenceDigest: sha256Canonical(sourceGateEvidence)
                })
              );
            } else {
              finalClaims = proof.verified.sourceClaims;
            }
          }
          collectFinalUse(graph, accumulator, request);
          if (finalClaims)
            accumulator.r3FinalUses.set(sha256Canonical(request), {
              ...accumulator.r3FinalUses.get(sha256Canonical(request)),
              sourceClaims: freeze(snapshot(finalClaims))
            });
          r3Validated.add(digest);
          continue;
        }
        if (consumer) {
          requireThat(
            ["source", "final"].includes(identity.scope.phase) &&
              identity.scope.chain === "snapshot" &&
              request.phase === identity.scope.phase &&
              request.sourceSha === identity.scope.sourceSha &&
              request.candidate.buildProofDigest === identity.scope.buildProofDigest &&
              allocation.predecessorExecutionRecordDigest !== null &&
              allocation.destinationAdmissionDigest === request.destinationAdmissionDigest &&
              allocation.scopeAuthorizationDigest === request.scopeAuthorizationDigest &&
              allocation.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest &&
              equal(allocation.input, request.input) &&
              allocation.chain === identity.scope.chain &&
              allocation.phase === identity.scope.phase &&
              allocation.sourceSha === identity.scope.sourceSha &&
              allocation.buildProofDigest === identity.scope.buildProofDigest &&
              allocation.creationSpecDigest === identity.scope.creationSpecDigest &&
              allocation.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
              allocation.targetPolicyDigest === identity.scope.targetPolicyDigest &&
              [
                "profileDigest",
                "sessionId",
                "sessionNonce",
                "operationId",
                "idempotencyKey",
                "attemptId",
                "runId",
                "stage"
              ].every((field) => allocation[field] === request[field]) &&
              linked.length <= 2 &&
              execution.stage === "snapshot-consumer" &&
              execution.operationId === request.operationId &&
              execution.idempotencyKey === request.idempotencyKey &&
              execution.requestDigest === consumed.requestDigest &&
              execution.reasonCode === "MANUAL_EVIDENCE_INCOMPLETE" &&
              consumed.ownerId === profile.ownerId &&
              consumed.status === "CONSUMED" &&
              authorization.payload.phase === identity.scope.phase &&
              authorization.payload.capability === "read-decrypt-use" &&
              authorization.payload.purpose === "sanitized-snapshot-test-input",
            SESSION
          );
          requireThat(
            (
              await store.read(
                path.join(
                  profile.storage.journalRoot,
                  "consumptions",
                  `${profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
                )
              )
            ).equals(encodeManualJson(consumed)),
            STORAGE
          );
          requireThat(snapshotReader, SESSION);
          await snapshotReader.assertConsumerBinding({ request, scope: identity.scope });
          if (linked.length === 2) {
            const completed = linked.find((value) => value !== execution);
            requireThat(
              completed?.status === "SUCCEEDED" &&
                completed.reasonCode === null &&
                completed.stage === "snapshot-consumer" &&
                completed.predecessorExecutionRecordDigest === linkedDigest &&
                completed.startedAt === execution.recordedAt &&
                [
                  "profileDigest",
                  "sessionId",
                  "sessionNonce",
                  "operationId",
                  "idempotencyKey",
                  "attemptId",
                  "requestDigest",
                  "authorizationDigest",
                  "consumptionRecordDigest"
                ].every((field) => completed[field] === execution[field]),
              SESSION
            );
            const built = await r3ConsumerOriginals(graph, execution, request, completed);
            requireThat(
              instant(completed.finishedAt) >= instant(built.processEvidence.completedAt) &&
                instant(completed.recordedAt) >= instant(completed.finishedAt),
              SESSION
            );
            for (const role of ["journal", "archive", "backup"])
              requireThat(
                (
                  await store.read(
                    objectPath(profile.storage[`${role}Root`], sha256Canonical(completed))
                  )
                ).equals(encodeManualJson(completed)),
                STORAGE
              );
            const subjects = [completed.resultDigest, completed.processEvidenceDigest];
            const expected = new Set(
              subjects.flatMap((subject) =>
                ["archive", "backup"].map((role) => `${subject}:${role}`)
              )
            );
            const custody = values.filter(
              (value) => value.kind === "custody" && subjects.includes(value.subjectDigest)
            );
            requireThat(custody.length === 4, SESSION);
            for (const value of custody)
              requireThat(
                value.schemaVersion === "manual-operation-record.v3" &&
                  expected.delete(`${value.subjectDigest}:${value.storageRole}`) &&
                  value.profileDigest === profileDigest &&
                  value.ownerId === profile.ownerId &&
                  value.subjectType === "record" &&
                  value.purpose === `${value.storageRole}-readback` &&
                  value.outcome === "MATCH" &&
                  value.observedDigest === value.subjectDigest &&
                  value.retentionDays === retentionDays &&
                  instant(value.observedAt) <= instant(completed.recordedAt),
                SESSION
              );
            requireThat(expected.size === 0, SESSION);
            for (const { digest } of built.originals) r3Originals.artifacts.add(digest);
          }
          historicalConsumerPredecessor = allocation.predecessorExecutionRecordDigest;
          historicalConsumerDestination = request.destinationAdmissionDigest;
          for (const ref of snapshotReader.rawReferences) r3Originals.raws.add(ref.digest);
          collectFinalUse(graph, accumulator, request);
          r3Validated.add(digest);
          continue;
        }
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
          historicalCompletion = sha256Canonical(completed);
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
    requireThat(
      creationCount <= 1 &&
        consumerCount <= 1 &&
        candidateUseCount <= 1 &&
        (consumerCount === 0 ||
          (creationCount === 1 &&
            historicalCompletion === historicalConsumerPredecessor &&
            graph.get(historicalCompletion)?.value?.resultDigest ===
              historicalConsumerDestination)) &&
        (pendingConsumer === null ||
          (consumerCount === 1 && pendingConsumer === historicalConsumerPredecessor)),
      SESSION
    );
    await validateR3CleanupContext(graph, accumulator);
    return { legacy, creationCount, consumerCount, candidateUseCount, historicalCompletion };
  }
  async function finishR3History(graph, slots, accumulator, legacy, request) {
    const { profile, profileDigest } = runtime();
    const values = [...graph.values()].map((entry) => entry.value);
    const {
      r3Originals,
      r3Validated,
      r3Acknowledgements,
      r3Cleanups,
      r3CleanupCustody,
      r3FinalResultCustody
    } = accumulator;
    // Resolve after every context is verified, independently of directory order.
    const matchedSources = assertR3MatchingSources(accumulator);
    for (const value of values) {
      if (value.kind === "cleanup-observation")
        requireThat(r3Cleanups.has(sha256Canonical(value)), EVIDENCE);
      if (
        [
          "manual-r3-hosted-cleanup.v1",
          "manual-r3-hosted-evidence.v1",
          "manual-r3-forward-shutdown-evidence.v1",
          "manual-r3-final-result.v1"
        ].includes(value.schemaVersion)
      )
        requireThat(r3Originals.artifacts.has(sha256Canonical(value)), EVIDENCE);
      const subject = value.kind === "custody" ? graph.get(value.subjectDigest)?.value : null;
      // Existing source custody also covers raw/<digest>.bin; its source proof
      // reads those bytes. Only cleanup's new JSON subjects belong to this gate.
      if (
        subject?.kind === "cleanup-observation" ||
        [
          "manual-r3-hosted-cleanup.v1",
          "manual-r3-hosted-evidence.v1",
          "manual-r3-forward-shutdown-evidence.v1"
        ].includes(subject?.schemaVersion)
      )
        requireThat(r3CleanupCustody.has(sha256Canonical(value)), EVIDENCE);
      if (subject?.schemaVersion === "manual-r3-final-result.v1")
        requireThat(r3FinalResultCustody.has(sha256Canonical(value)), EVIDENCE);
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
    for (const value of values.filter(
      (entry) =>
        entry.schemaVersion === "manual-operation-record.v3" &&
        entry.kind === "custody" &&
        entry.purpose === "owner-acknowledgement"
    ))
      requireThat(r3Acknowledgements.has(sha256Canonical(value)), EVIDENCE);
    for (const execution of values.filter(
      (value) => value.kind === "execution" && value.schemaVersion === "manual-operation-record.v3"
    ))
      requireThat(
        r3Validated.has(execution.consumptionRecordDigest) &&
          execution.requestDigest === slots.get(execution.consumptionRecordDigest)?.requestDigest,
        SESSION
      );
    // Reuse the existing R2 reducer, including its independent reconcile
    // readback. An original apply UNKNOWN stays in the graph after resolution.
    for (const historicalTarget of profile.allowedTargets)
      await history(request, null, historicalTarget, r3Validated, r3Originals);
    return matchedSources;
  }
  async function r3ReadSourceOriginals() {
    const {
      profile,
      profileDigest,
      store,
      sessionId,
      sessionNonce,
      r3Context,
      lifecycleTargetLocks,
      creationCompletionDigest,
      consumerCompletionDigest,
      candidateUseReceipt,
      creationReceipt,
      consumerReceipt,
      evidenceState
    } = runtime();
    await evidenceState();
    requireThat(
      r3Context.scope.phase === "source" &&
        r3Context.snapshotInputs &&
        creationReceipt &&
        creationCompletionDigest &&
        candidateUseReceipt &&
        lifecycleTargetLocks.size === 2 &&
        (r3Context.scope.chain === "snapshot" ? consumerCompletionDigest : !consumerReceipt),
      SESSION
    );
    const graph = await store.objects();
    const initial = graph.get(creationReceipt.executionRecordDigest)?.value;
    const completed = graph.get(creationCompletionDigest)?.value;
    requireThat(
      initial?.stage === "target-create" &&
        completed?.stage === "target-create" &&
        completed.status === "SUCCEEDED" &&
        completed.predecessorExecutionRecordDigest === creationReceipt.executionRecordDigest,
      SESSION
    );
    const request = graph.get(initial.requestDigest)?.value;
    requireThat(request?.schemaVersion === "manual-runner-request.v4", SESSION);
    const original = await r3StoredDestination(graph, completed.resultDigest, initial);
    const destination = original.destination;
    const repoRoot = r3Context.snapshotInputs.repoRoot;
    await store.captureRepository?.(repoRoot, r3Context.destinationInputs.manifest);
    const contractBytes = new Map();
    const load = async (name) => {
      const file = path.join(repoRoot, "release", "contracts", name);
      const bytes = await store.fs.readFile(file);
      requireThat(bytes.length <= LIMIT, EVIDENCE);
      contractBytes.set(file, bytes);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    };
    const discoveryDocument = await load("database-test-discovery.v1.json");
    const exceptions = await load("database-test-exceptions.v1.json");
    const external = await load("external-validation-applicability.v1.json");
    const manifest = r3Context.destinationInputs.manifest;
    const candidates = await discoverDatabaseTestCandidates(repoRoot, discoveryDocument);
    const classification = classifyDatabaseTests(
      candidates,
      manifest.suites,
      exceptions.exceptions,
      external.records
    );
    requireThat(
      classification.unclassified.length === 0 &&
        (await scanDatabaseFrameworkBypasses(repoRoot, manifest)).length === 0,
      EVIDENCE
    );
    const discovery = {
      candidates,
      classification,
      discoveryDigest: sha256Canonical(discoveryDocument)
    };
    const postgres = destination.postgres;
    const plan = freeze(snapshot(destination.databaseTargetSet.plan));
    const names = new Set([
      "attempt",
      "manifest",
      ...manifest.suites.map(({ suiteId }) => suiteId)
    ]);
    requireThat(
      [...names].every((name) => /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(name)),
      EVIDENCE
    );
    const { readR3SourceOriginals } = await import("../../../scripts/release/r3-source-result.mjs");
    const result = await readR3SourceOriginals({
      manifest,
      plan,
      discovery,
      binding: {
        operationRef: r3Context.creationSpec.operationRef,
        chain: r3Context.scope.chain,
        profileDigest,
        sessionId,
        sessionNonce,
        sourceSha: r3Context.creationSpec.sourceSha,
        destinationDigest: original.destinationDigest,
        clusterFingerprint: sha256Canonical({
          engineId: postgres.engineId,
          systemIdentifier: postgres.postgres.systemIdentifier,
          containerId: postgres.containerId,
          imageDigest: postgres.imageDigest
        }),
        containerId: postgres.containerId,
        creationExecutionRecordDigest: creationCompletionDigest,
        candidateUseExecutionRecordDigest: candidateUseReceipt.executionRecordDigest,
        snapshotExecutionRecordDigest: consumerCompletionDigest
      },
      records: destination.databaseTargetSet.records,
      lifecycleRecords: [0, 1].map((shard) => lifecycleTargetLocks.get(shard).record),
      readObservation: async ({ storageRole, name }) => {
        requireThat(["archive", "backup"].includes(storageRole) && names.has(name), EVIDENCE);
        return store.read(
          path.join(
            profile.storage[`${storageRole}Root`],
            "inputs",
            "r3",
            r3Context.creationSpec.operationRef,
            "observations",
            "source",
            name,
            "readback.json"
          ),
          true,
          33554432
        );
      },
      recheck: async () => {
        await evidenceState();
        for (const [file, bytes] of contractBytes)
          requireThat((await store.fs.readFile(file)).equals(bytes), EVIDENCE);
      }
    });
    // A separate read of fixed source files is verification only: it does
    // not write a terminal execution, sign a gate, release locks or claim
    // that the originals have independent cloud retention/readback.
    await evidenceState();
    return freeze(result);
  }
  async function r3ReadFinalOriginals() {
    const {
      profile,
      store,
      r3Context,
      lifecycleTargetLocks,
      creationCompletionDigest,
      consumerCompletionDigest,
      candidateUseReceipt,
      creationReceipt,
      consumerReceipt,
      evidenceState
    } = runtime();
    await evidenceState();
    requireThat(
      r3Context.scope.phase === "final" &&
        r3Context.snapshotInputs &&
        creationReceipt &&
        creationCompletionDigest &&
        candidateUseReceipt &&
        lifecycleTargetLocks.size === 2 &&
        (r3Context.scope.chain === "snapshot" ? consumerCompletionDigest : !consumerReceipt),
      SESSION
    );
    const graph = await store.objects();
    const creationInitial = graph.get(creationReceipt.executionRecordDigest)?.value;
    const creation = graph.get(creationCompletionDigest)?.value;
    const candidateInitial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
    requireThat(
      creationInitial?.stage === "target-create" &&
        creation?.stage === "target-create" &&
        creation.status === "SUCCEEDED" &&
        creation.predecessorExecutionRecordDigest === creationReceipt.executionRecordDigest &&
        candidateInitial?.stage === "candidate-use" &&
        candidateInitial.status === "INTERRUPTED_UNKNOWN",
      SESSION
    );
    const request = graph.get(candidateInitial.requestDigest)?.value;
    requireThat(
      request?.schemaVersion === "manual-runner-request.v5" && request.phase === "final",
      SESSION
    );
    await r3CandidatePreparation(request, graph);
    const original = await r3StoredDestination(graph, creation.resultDigest, creationInitial);
    const repoRoot = r3Context.snapshotInputs.repoRoot;
    const manifest = r3Context.destinationInputs.manifest;
    await store.captureRepository?.(repoRoot, manifest);
    const contractBytes = new Map();
    const load = async (name) => {
      const file = path.join(repoRoot, "release", "contracts", name);
      const bytes = await store.fs.readFile(file);
      requireThat(bytes.length <= LIMIT, EVIDENCE);
      contractBytes.set(file, bytes);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    };
    const discoveryDocument = await load("database-test-discovery.v1.json");
    const exceptions = await load("database-test-exceptions.v1.json");
    const external = await load("external-validation-applicability.v1.json");
    const globalObjectPolicy = await load("migration-global-object-policy.v1.json");
    const candidates = await discoverDatabaseTestCandidates(repoRoot, discoveryDocument);
    const classification = classifyDatabaseTests(
      candidates,
      manifest.suites,
      exceptions.exceptions,
      external.records
    );
    requireThat(
      classification.unclassified.length === 0 &&
        (await scanDatabaseFrameworkBypasses(repoRoot, manifest)).length === 0,
      EVIDENCE
    );
    const discovery = {
      candidates,
      classification,
      discoveryDigest: sha256Canonical(discoveryDocument)
    };
    const buildProof = graph.get(r3Context.scope.buildProofDigest)?.value;
    requireThat(
      buildProof && sha256Canonical(buildProof) === r3Context.scope.buildProofDigest,
      EVIDENCE
    );
    validateContract("build-proof.v1", buildProof);
    const migrationCatalog = await computeMigrationCatalog(repoRoot);
    requireThat(buildProof.identity.migrationCatalogDigest === migrationCatalog.digest, EVIDENCE);
    const repositoryContract = await computeRepositoryContract(repoRoot);
    requireThat(
      buildProof.identity.repositoryContractDigest === repositoryContract.digest,
      EVIDENCE
    );
    const plan = freeze(snapshot(original.destination.databaseTargetSet.plan));
    const { readR3FinalOriginals, r3FinalObservationNames } =
      await import("../../../scripts/release/r3-final-result.mjs");
    const names = r3FinalObservationNames({ manifest, plan });
    requireThat(
      Array.isArray(names) &&
        names.length > 0 &&
        new Set(names).size === names.length &&
        names.every((name) => /^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(name)),
      EVIDENCE
    );
    const allowed = new Set(names);
    const verified = await readR3FinalOriginals({
      manifest,
      plan,
      discovery,
      request,
      initialExecution: candidateInitial,
      destination: original.destination,
      buildProof,
      migrationCatalog,
      globalObjectPolicy,
      lifecycleRecords: [0, 1].map((shard) => lifecycleTargetLocks.get(shard).record),
      repoRoot,
      readObservation: async ({ storageRole, name }) => {
        requireThat(["archive", "backup"].includes(storageRole) && allowed.has(name), EVIDENCE);
        return store.read(
          path.join(
            profile.storage[`${storageRole}Root`],
            "inputs",
            "r3",
            r3Context.creationSpec.operationRef,
            "observations",
            "final",
            name,
            "readback.json"
          ),
          true,
          33554432
        );
      },
      recheck: async () => {
        await evidenceState();
        for (const [file, bytes] of contractBytes)
          requireThat((await store.fs.readFile(file)).equals(bytes), EVIDENCE);
        requireThat(
          (await computeMigrationCatalog(repoRoot)).digest === migrationCatalog.digest,
          EVIDENCE
        );
        requireThat(
          (await computeRepositoryContract(repoRoot)).digest === repositoryContract.digest,
          EVIDENCE
        );
      }
    });
    await evidenceState();
    return freeze(verified);
  }
  return {
    reducedExecution,
    archiveInput,
    history,
    r3CandidatePreparation,
    r3LifecycleLock,
    r3StoredDestination,
    r3ConsumerOriginals,
    r3SourceProof,
    r3FinalProof,
    r3CleanupProof,
    collectFinalUse,
    validateR3Context,
    finishR3History,
    readSourceOriginals: r3ReadSourceOriginals,
    readFinalOriginals: r3ReadFinalOriginals
  };
}

function assertManualR3CreationContext(profile, r3Context) {
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

// Capture existing originals and directory membership, without acquiring any
// execution capability. The final recheck also detects new slots/revocations.
function historicalManualStore(profile, principal, io) {
  const base = fileStore(profile, principal, io);
  const files = new Map(),
    directories = new Map(),
    repositories = new Map();
  let closed = false;
  const available = () => requireThat(!closed, SESSION);
  const remember = (file, bytes, read) => {
    available();
    const old = files.get(file);
    requireThat(!old || old.bytes.equals(bytes), STORAGE);
    if (!old) files.set(file, { bytes: Buffer.from(bytes), read });
    return bytes;
  };
  const read = async (file, raw = false, limit = LIMIT) =>
    remember(file, await base.read(file, raw, limit), () => base.read(file, raw, limit));
  const readPublicBytes = async (file) => {
    const before = await base.checkedPath(file, false);
    requireThat(before.isFile() && before.nlink === 1 && before.size <= MS2_STDOUT_LIMIT, STORAGE);
    const bytes = await io.fs.readFile(file);
    const after = await base.checkedPath(file, false);
    requireThat(
      before.ino === after.ino &&
        before.dev === after.dev &&
        after.size === bytes.length &&
        bytes.length <= MS2_STDOUT_LIMIT,
      STORAGE
    );
    return bytes;
  };
  const readPublic = async (file) =>
    remember(file, await readPublicBytes(file), () => readPublicBytes(file));
  const readdir = async (dir) => {
    available();
    const names = (await io.fs.readdir(dir)).sort();
    const old = directories.get(dir);
    requireThat(!old || equal(old, names), STORAGE);
    if (!old) directories.set(dir, [...names]);
    return names;
  };
  const repositoryIndex = async (repoRoot) => {
    const { stdout } = await nativeIO.execFile("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return stdout;
  };
  const store = {
    checkedPath: base.checkedPath,
    read,
    roots: base.roots,
    fs: { lstat: io.fs.lstat, readdir, readFile: readPublic },
    async captureRepository(repoRoot, manifest) {
      const index = await repositoryIndex(repoRoot);
      const old = repositories.get(repoRoot);
      requireThat(!old || old.equals(index), STORAGE);
      if (!old) repositories.set(repoRoot, Buffer.from(index));
      const files = new Set([
        ...trackedTestUniverse(index.toString("utf8").split("\0").filter(Boolean)),
        ...manifest.suites.flatMap((suite) => suite.files)
      ]);
      for (const relative of files) {
        requireThat(
          typeof relative === "string" &&
            !path.isAbsolute(relative) &&
            relative.split(/[\\/]/u).every((part) => part !== "" && part !== "." && part !== ".."),
          STORAGE
        );
        await readPublic(path.join(repoRoot, ...relative.split("/")));
      }
    },
    async objects() {
      const graph = new Map();
      for (const role of ["journal", "archive"]) {
        const dir = path.join(profile.storage[`${role}Root`], "objects");
        await base.checkedPath(dir);
        for (const name of await readdir(dir)) {
          requireThat(/^[0-9a-f]{64}\.json$/u.test(name), STORAGE);
          const bytes = await read(path.join(dir, name));
          const digest = sha256Bytes(bytes);
          requireThat(digest === `sha256:${name.slice(0, -5)}`, STORAGE);
          requireThat(!graph.has(digest) || graph.get(digest).bytes.equals(bytes), STORAGE);
          graph.set(digest, { value: JSON.parse(bytes), bytes });
        }
      }
      return graph;
    }
  };
  return {
    store,
    readPublic,
    available,
    async recheck() {
      available();
      for (const [dir, names] of directories) {
        await base.checkedPath(dir);
        requireThat(equal((await io.fs.readdir(dir)).sort(), names), STORAGE);
      }
      for (const { bytes, read } of files.values())
        requireThat((await read()).equals(bytes), STORAGE);
      for (const [repoRoot, index] of repositories)
        requireThat((await repositoryIndex(repoRoot)).equals(index), STORAGE);
      available();
    },
    close() {
      closed = true;
      files.clear();
      directories.clear();
      repositories.clear();
    }
  };
}

// Group all stored R3 consumptions before selecting a current or historical
// verifier. A live identity is seeded even before its first consumption exists.
function groupManualR3History(graph, profileDigest, live = null) {
  const groups = new Map(),
    legacy = [];
  for (const { value: consumed } of graph.values()) {
    if (consumed.kind !== "consumption") continue;
    if (consumed.schemaVersion !== "manual-operation-record.v3") {
      legacy.push(consumed);
      continue;
    }
    requireThat(consumed.profileDigest === profileDigest, SESSION);
    if (!groups.has(consumed.sessionRecordDigest)) groups.set(consumed.sessionRecordDigest, []);
    groups.get(consumed.sessionRecordDigest).push(consumed);
  }
  const sessions = new Set(live ? [live.sessionId] : []);
  const operations = new Set(live ? [live.operationRef] : []);
  for (const [digest, consumptions] of groups) {
    const opening = graph.get(digest)?.value;
    requireThat(
      opening?.schemaVersion === "manual-operation-record.v3" &&
        opening.kind === "session" &&
        opening.status === "OPEN" &&
        opening.profileDigest === profileDigest,
      SESSION
    );
    const refs = new Set(consumptions.map((value) => value.operationId));
    requireThat(
      refs.size === 1 &&
        consumptions.every(
          (value) =>
            value.sessionId === opening.sessionId && value.sessionNonce === opening.sessionNonce
        ),
      SESSION
    );
    const operationRef = [...refs][0];
    if (live && digest === live.sessionRecordDigest) {
      requireThat(
        opening.sessionId === live.sessionId &&
          opening.sessionNonce === live.sessionNonce &&
          operationRef === live.operationRef,
        SESSION
      );
      continue;
    }
    requireThat(!sessions.has(opening.sessionId) && !operations.has(operationRef), SESSION);
    sessions.add(opening.sessionId);
    operations.add(operationRef);
  }
  return { groups, legacy };
}

async function readCompletedR3Environment(profile, repoRoot, capture, stamp) {
  const { store } = capture;
  const profileDigest = sha256Canonical(profile),
    profileBytes = encodeManualJson(profile);
  const contracts = async (name) => {
    const bytes = await capture.readPublic(path.join(repoRoot, "release", "contracts", name));
    return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  };
  const policy = await contracts("manual-stage1-r3-target-policy.v1.json");
  const targets = await contracts("database-target-policies.v1.json");
  const manifest = await contracts("database-test-manifest.v1.json");
  validateContract("manual-stage1-r3-target-policy.v1", policy.value);
  validateContract("database-target-policies.v1", targets.value);
  validateContract("database-test-manifest.v1", manifest.value);
  requireThat(policy.value.profileDigest === profileDigest, SESSION);
  const policies = targets.value.policies.filter(
    (value) => value.policyId === policy.value.databaseTargetPolicyId
  );
  requireThat(policies.length === 1, SESSION);
  const destinationInputs = {
    manifest: manifest.value,
    manifestRawDigest: sha256Bytes(manifest.bytes),
    policy: policies[0],
    policyBytesBase64: policy.bytes.toString("base64")
  };
  const revocations = async () =>
    (
      await readManualRevocationHistory({
        store,
        journalRoot: profile.storage.journalRoot,
        profileDigest,
        ownerId: profile.ownerId,
        recordSchema: "manual-operation-record.v2",
        now: stamp()
      })
    ).records;
  await revocations();
  const locksDir = path.join(profile.storage.journalRoot, "locks");
  const retainedLocks = [];
  await store.checkedPath(locksDir);
  for (const name of await store.fs.readdir(locksDir)) {
    requireThat(/^[0-9a-f]{64}\.json$/u.test(name), SESSION);
    const bytes = await store.read(path.join(locksDir, name));
    const value = JSON.parse(bytes);
    requireThat(value && typeof value === "object" && !Array.isArray(value), SESSION);
    retainedLocks.push({ name, bytes, value });
  }
  return {
    profile,
    profileDigest,
    profileBytes,
    repoRoot,
    capture,
    store,
    stamp,
    policy,
    destinationInputs,
    revocations,
    retainedLocks
  };
}

// Only completed old contexts enter here. The live context continues to use its
// original in-memory receipts, held descriptors and bounded pending transition.
async function readCompletedR3Context(
  environment,
  graph,
  slots,
  sessionRecordDigest,
  consumptions,
  accumulator
) {
  const {
    profile,
    profileDigest,
    profileBytes,
    repoRoot,
    capture,
    store,
    stamp,
    policy,
    destinationInputs,
    revocations,
    retainedLocks
  } = environment;
  const values = [...graph.values()].map(({ value }) => value);
  const current = graph.get(sessionRecordDigest)?.value;
  requireThat(
    current?.kind === "session" &&
      current.status === "OPEN" &&
      current.ownerId === profile.ownerId &&
      current.profileDigest === profileDigest &&
      current.previousSessionRecordDigest === null &&
      current.reasonCode === null,
    SESSION
  );
  validateContract("manual-operation-record.v3", current);
  const { sessionId, sessionNonce } = current;
  const identity = { profileDigest, sessionId, sessionNonce, scope: current.scope };
  const operationRefs = new Set(consumptions.map((value) => value.operationId));
  requireThat(operationRefs.size === 1, SESSION);
  const operationRef = [...operationRefs][0];
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationRef),
    SESSION
  );
  const privateContext = async (name) =>
    JSON.parse(
      await store.read(path.join(profile.storage.archiveRoot, "inputs", "r3", operationRef, name))
    );
  const r3Context = {
    scope: current.scope,
    creationSpec: await privateContext("creation-spec.json"),
    jobAdmission: await privateContext("job-admission.json"),
    destinationInputs,
    snapshotInputs: { repoRoot }
  };
  assertManualR3CreationContext(profile, r3Context);
  const spec = r3Context.creationSpec,
    job = r3Context.jobAdmission;
  requireThat(
    spec.operationRef === operationRef &&
      sha256Bytes(policy.bytes) === current.scope.targetPolicyDigest &&
      instant(profile.validFrom) <= instant(spec.createdAt) &&
      instant(spec.createdAt) <= instant(job.generatedAt) &&
      instant(job.generatedAt) <= instant(current.openedAt) &&
      current.openedAt === current.recordedAt &&
      instant(current.recordedAt) < instant(job.expiresAt) &&
      instant(job.expiresAt) <= instant(spec.expiresAt) &&
      instant(spec.expiresAt) <= instant(profile.expiresAt) &&
      instant(current.recordedAt) <= instant(stamp()),
    "MANUAL_TIME_INVALID"
  );
  const sessionRecords = values.filter(
    (value) => value.kind === "session" && value.sessionId === sessionId
  );
  requireThat(sessionRecords.length >= 1 && sessionRecords.length <= 2, SESSION);
  for (const value of sessionRecords) {
    validateContract("manual-operation-record.v3", value);
    requireThat(
      (await store.read(objectPath(profile.storage.journalRoot, sha256Canonical(value)))).equals(
        encodeManualJson(value)
      ),
      STORAGE
    );
    requireThat(
      value.profileDigest === profileDigest &&
        value.sessionNonce === sessionNonce &&
        value.ownerId === profile.ownerId &&
        equal(value.scope, current.scope) &&
        value.openedAt === current.openedAt &&
        instant(value.recordedAt) >= instant(current.recordedAt) &&
        instant(value.recordedAt) <= instant(stamp()) &&
        (sha256Canonical(value) === sessionRecordDigest ||
          (value.previousSessionRecordDigest === sessionRecordDigest &&
            ((value.status === "CLOSED" && value.reasonCode === null) ||
              (value.status === "INTERRUPTED_UNKNOWN" &&
                value.reasonCode === "MANUAL_EVIDENCE_INCOMPLETE")))),
      SESSION
    );
  }
  const executions = values.filter(
    (value) => value.kind === "execution" && value.sessionId === sessionId
  );
  const stagePair = (stage, required) => {
    const initial = executions.filter(
      (value) => value.stage === stage && value.status === "INTERRUPTED_UNKNOWN"
    );
    const completed = executions.filter(
      (value) => value.stage === stage && value.status === "SUCCEEDED"
    );
    requireThat(
      initial.length === completed.length &&
        initial.length <= 1 &&
        (!required || initial.length === 1),
      SESSION
    );
    if (!initial.length) return null;
    requireThat(
      completed[0].predecessorExecutionRecordDigest === sha256Canonical(initial[0]),
      SESSION
    );
    return { initial: initial[0], completed: completed[0] };
  };
  const creation = stagePair("target-create", true);
  const consumer = stagePair("snapshot-consumer", false);
  const candidate = stagePair("candidate-use", current.scope.phase === "source");
  requireThat(
    current.scope.phase !== "source" || current.scope.chain !== "snapshot" || consumer,
    SESSION
  );
  const creationReceipt = { executionRecordDigest: sha256Canonical(creation.initial) };
  const creationCompletionDigest = sha256Canonical(creation.completed);
  const consumerReceipt = consumer
    ? { executionRecordDigest: sha256Canonical(consumer.initial) }
    : null;
  const consumerCompletionDigest = consumer ? sha256Canonical(consumer.completed) : null;
  const candidateUseReceipt = candidate
    ? { executionRecordDigest: sha256Canonical(candidate.initial) }
    : null;
  for (const value of [...executions, ...consumptions]) {
    requireThat(
      value.profileDigest === profileDigest &&
        value.sessionNonce === sessionNonce &&
        value.operationId === operationRef &&
        instant(value.recordedAt) >= instant(current.openedAt) &&
        instant(value.recordedAt) < instant(job.expiresAt) &&
        instant(value.recordedAt) <= instant(stamp()),
      SESSION
    );
  }
  let snapshotReader = null;
  if (consumer) {
    const request = graph.get(consumer.initial.requestDigest)?.value;
    validateManualSnapshotConsumerRequest(request);
    const { inputReference } = request.input;
    const indexBytes = await store.read(
      path.join(profile.storage.archiveRoot, "inputs", "snapshots", inputReference, "index.json")
    );
    const { readR3SnapshotDeclarations } =
      await import("../../../scripts/release/r3-snapshot-input-admission.mjs");
    const declarations = await readR3SnapshotDeclarations({
      profile,
      indexBytes,
      inputReference,
      observedAt: consumer.initial.recordedAt,
      readRaw: (digest) =>
        store.read(path.join(profile.storage.archiveRoot, "raw", `${digest.slice(7)}.bin`), true)
    });
    snapshotReader = { ...declarations, recheck: async () => capture.available() };
  }
  const targetLocks = new Map(),
    lifecycleTargetLocks = new Map();
  const state = {
    profile,
    profileBytes,
    profileDigest,
    recordSchema: "manual-operation-record.v3",
    retentionDays: 90,
    store,
    identity,
    sessionId,
    sessionNonce,
    current,
    r3Context,
    stamp,
    revocations,
    targetLocks,
    lifecycleTargetLocks,
    snapshotReader,
    creationCompletionDigest,
    consumerCompletionDigest,
    candidateUseReceipt,
    creationReceipt,
    consumerReceipt,
    r3: true,
    target: null,
    evidenceState: async () => capture.available(),
    evidenceTime: (eventAt) => eventAt
  };
  const verifier = createManualHistoryVerifier(() => state);
  const destination = graph.get(creation.completed.resultDigest)?.value;
  requireThat(
    destination?.databaseTargetSet?.targetLocks &&
      Array.isArray(destination.databaseTargetSet.targetLocks),
    SESSION
  );
  for (const held of retainedLocks.filter(
    ({ value }) => value.sessionId === sessionId && value.operationRef === operationRef
  )) {
    const value = held.value;
    const lifecycle = Object.hasOwn(value, "provisionedRecord");
    exact(
      value,
      [
        "profileDigest",
        "sessionId",
        "sessionNonce",
        "scope",
        "pid",
        "operationRef",
        "executionRecordDigest",
        "databaseName",
        "target",
        ...(lifecycle
          ? ["reservationLockDigest", "provisionedRecordDigest", "provisionedRecord"]
          : [])
      ],
      SESSION
    );
    const lockDigest = sha256Canonical(value.target);
    requireThat(
      held.name === `${lockDigest.slice(7)}.json` &&
        value.profileDigest === profileDigest &&
        value.sessionNonce === sessionNonce &&
        equal(value.scope, identity.scope) &&
        value.executionRecordDigest === creationReceipt.executionRecordDigest &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        !targetLocks.has(lockDigest),
      SESSION
    );
    targetLocks.set(lockDigest, { bytes: held.bytes });
    if (lifecycle) {
      const checked = verifier.r3LifecycleLock(destination, value.provisionedRecord);
      requireThat(
        !lifecycleTargetLocks.has(checked.shard) &&
          checked.entry.lockDigest === lockDigest &&
          checked.entry.databaseName === value.databaseName &&
          checked.recordDigest === value.provisionedRecordDigest &&
          checked.reservedLockDigest === value.reservationLockDigest,
        SESSION
      );
      lifecycleTargetLocks.set(checked.shard, {
        entry: checked.entry,
        record: value.provisionedRecord,
        recordDigest: checked.recordDigest
      });
    } else
      requireThat(
        destination.databaseTargetSet.targetLocks.some(
          (entry) =>
            entry.lockDigest === lockDigest &&
            entry.databaseName === value.databaseName &&
            equal(entry.identity, value.target)
        ),
        SESSION
      );
  }
  await verifier.validateR3Context(graph, slots, consumptions, accumulator);
  const cleanupRecord = values.find(
    (value) =>
      value.kind === "cleanup-observation" &&
      value.sessionId === sessionId &&
      accumulator.r3Cleanups.has(sha256Canonical(value))
  );
  if (current.scope.phase === "source") {
    const terminalDigest = sha256Canonical(candidate.completed);
    const acknowledgements = values.filter(
      (value) =>
        value.kind === "custody" &&
        value.purpose === "owner-acknowledgement" &&
        value.subjectDigest === terminalDigest
    );
    requireThat(
      acknowledgements.length === 1 &&
        accumulator.r3Acknowledgements.has(sha256Canonical(acknowledgements[0])),
      EVIDENCE
    );
    const closed = sessionRecords.find((value) => value.status === "CLOSED");
    const sourceProof = accumulator.r3SourceProofs.get(terminalDigest);
    requireThat(sourceProof, EVIDENCE);
    // UNKNOWN remains readable as historical source evidence. Only a verified
    // cleanup and CLOSED session make it eligible for a later final operation.
    accumulator.r3Sources.set(terminalDigest, {
      ...r3CandidateContextFacts(profileDigest, identity, r3Context, destination, snapshotReader),
      ...sourceProof,
      terminalDigest,
      closedAt: cleanupRecord && closed ? closed.recordedAt : null,
      runIds: executions.map((value) => graph.get(value.requestDigest).value.runId)
    });
  }
  return {
    verifier,
    candidate,
    summary: {
      operationRef,
      sessionId,
      sessionNonce,
      scope: snapshot(identity.scope),
      ...(cleanupRecord
        ? { latestCleanupAt: graph.get(cleanupRecord.cleanupBundleDigest).value.cleanup.finishedAt }
        : {}),
      latestExecutionAt: executions
        .map((value) => value.recordedAt)
        .sort()
        .at(-1)
    }
  };
}

// Internal reader for the fixed-H1 wrapper. It replays complete stored history;
// the wrapper independently authenticates every returned context's H2 inputs.
export async function readManualR3SourceHistory(input) {
  exact(
    input,
    [
      "profile",
      "ownerObservation",
      "repoRoot",
      "terminalExecutionRecordDigest",
      "now",
      ...(input.io === undefined ? [] : ["io"])
    ],
    SESSION
  );
  const profile = snapshot(input.profile),
    owner = snapshot(input.ownerObservation);
  validateContract("manual-stage1-profile.v2", profile);
  exact(owner, ["ownerId", "principal", "observedAt"], SESSION);
  exact(
    owner.principal,
    owner.principal.platform === "win32" ? ["platform", "sid"] : ["platform", "uid"],
    SESSION
  );
  const { repoRoot, terminalExecutionRecordDigest, now } = input;
  requireThat(
    owner.ownerId === profile.ownerId &&
      typeof now === "function" &&
      typeof repoRoot === "string" &&
      path.isAbsolute(repoRoot) &&
      path.resolve(repoRoot) === repoRoot &&
      /^sha256:[0-9a-f]{64}$/u.test(terminalExecutionRecordDigest),
    SESSION
  );
  requireThat(
    sha256Bytes(createPublicKey(profile.publicKeyPem).export({ type: "spki", format: "der" })) ===
      profile.keyFingerprint,
    "MANUAL_SIGNATURE_INVALID"
  );
  const readAt = now();
  requireThat(instant(owner.observedAt) <= instant(readAt), "MANUAL_TIME_INVALID");
  const capture = historicalManualStore(profile, owner.principal, input.io ?? nativeIO);
  const { store } = capture;
  const profileDigest = sha256Canonical(profile);
  const stamp = () => {
    capture.available();
    const value = now();
    requireThat(instant(value) >= instant(readAt), "MANUAL_TIME_INVALID");
    return value;
  };
  try {
    await store.roots();
    const { graph, slots } = await readManualHistoryGraph(store, profile);
    const values = [...graph.values()].map(({ value }) => value);
    const selected = graph.get(terminalExecutionRecordDigest)?.value;
    requireThat(
      selected?.schemaVersion === "manual-operation-record.v3" &&
        selected.kind === "execution" &&
        selected.stage === "candidate-use" &&
        selected.status === "SUCCEEDED" &&
        selected.profileDigest === profileDigest,
      SESSION
    );
    const { groups, legacy } = groupManualR3History(graph, profileDigest);
    requireThat(groups.size > 0, SESSION);
    const environment = await readCompletedR3Environment(profile, repoRoot, capture, stamp);
    const accumulator = historyAccumulator(),
      verifiedContexts = [];
    let selectedVerifier = null,
      selectedRequest = null;
    for (const [sessionRecordDigest, consumptions] of groups) {
      const completed = await readCompletedR3Context(
        environment,
        graph,
        slots,
        sessionRecordDigest,
        consumptions,
        accumulator
      );
      verifiedContexts.push(completed.summary);
      if (
        completed.candidate &&
        sha256Canonical(completed.candidate.completed) === terminalExecutionRecordDigest
      ) {
        requireThat(completed.summary.scope.phase === "source", SESSION);
        selectedVerifier = completed.verifier;
        selectedRequest = graph.get(completed.candidate.initial.requestDigest)?.value;
      }
    }
    requireThat(selectedVerifier && selectedRequest, SESSION);
    const oldLocal = await selectedVerifier.validateR3Context(graph, slots, legacy, accumulator);
    await selectedVerifier.finishR3History(
      graph,
      slots,
      accumulator,
      oldLocal.legacy,
      selectedRequest
    );
    const acknowledgements = values.filter(
      (value) =>
        value.kind === "custody" &&
        value.purpose === "owner-acknowledgement" &&
        value.subjectDigest === terminalExecutionRecordDigest
    );
    requireThat(
      acknowledgements.length === 1 &&
        accumulator.r3Acknowledgements.has(sha256Canonical(acknowledgements[0])),
      EVIDENCE
    );
    const selectedContext = verifiedContexts.find(
      (value) =>
        value.sessionId === selected.sessionId && value.sessionNonce === selected.sessionNonce
    );
    requireThat(selectedContext, SESSION);
    await capture.recheck();
    return freeze({
      profileDigest,
      ...selectedContext,
      executionRecordDigest: terminalExecutionRecordDigest,
      resultDigest: selected.resultDigest,
      acknowledgementRecordDigest: sha256Canonical(acknowledgements[0]),
      promotionEligible: false,
      verifiedContexts,
      recheck: async () => {
        stamp();
        await capture.recheck();
      },
      close: async () => capture.close()
    });
  } catch (error) {
    capture.close();
    throw error;
  }
}

// A final gate may describe one completed native attempt only after replaying
// the entire retained graph. An unresolved historical candidate makes that
// replay fail; a second completed candidate for the same CI/source identity
// also fails here. Neither case is represented as an empty retry history.
export async function readManualR3FinalHistory(input) {
  exact(
    input,
    [
      "profile",
      "ownerObservation",
      "repoRoot",
      "terminalExecutionRecordDigest",
      "now",
      ...(input.io === undefined ? [] : ["io"])
    ],
    SESSION
  );
  const profile = snapshot(input.profile),
    owner = snapshot(input.ownerObservation);
  validateContract("manual-stage1-profile.v2", profile);
  exact(owner, ["ownerId", "principal", "observedAt"], SESSION);
  exact(
    owner.principal,
    owner.principal.platform === "win32" ? ["platform", "sid"] : ["platform", "uid"],
    SESSION
  );
  const { repoRoot, terminalExecutionRecordDigest, now } = input;
  requireThat(
    owner.ownerId === profile.ownerId &&
      typeof now === "function" &&
      typeof repoRoot === "string" &&
      path.isAbsolute(repoRoot) &&
      path.resolve(repoRoot) === repoRoot &&
      /^sha256:[0-9a-f]{64}$/u.test(terminalExecutionRecordDigest),
    SESSION
  );
  requireThat(
    sha256Bytes(createPublicKey(profile.publicKeyPem).export({ type: "spki", format: "der" })) ===
      profile.keyFingerprint,
    "MANUAL_SIGNATURE_INVALID"
  );
  const readAt = now();
  requireThat(instant(owner.observedAt) <= instant(readAt), "MANUAL_TIME_INVALID");
  const capture = historicalManualStore(profile, owner.principal, input.io ?? nativeIO);
  const { store } = capture;
  const profileDigest = sha256Canonical(profile);
  const stamp = () => {
    capture.available();
    const value = now();
    requireThat(instant(value) >= instant(readAt), "MANUAL_TIME_INVALID");
    return value;
  };
  try {
    await store.roots();
    const { graph, slots } = await readManualHistoryGraph(store, profile);
    const values = [...graph.values()].map(({ value }) => value);
    const selected = graph.get(terminalExecutionRecordDigest)?.value;
    requireThat(
      selected?.schemaVersion === "manual-operation-record.v3" &&
        selected.kind === "execution" &&
        selected.stage === "candidate-use" &&
        selected.status === "SUCCEEDED" &&
        selected.profileDigest === profileDigest,
      SESSION
    );
    const { groups, legacy } = groupManualR3History(graph, profileDigest);
    requireThat(groups.size > 0, SESSION);
    const environment = await readCompletedR3Environment(profile, repoRoot, capture, stamp);
    const accumulator = historyAccumulator(),
      verifiedContexts = [];
    let selectedVerifier = null,
      selectedRequest = null,
      selectedCandidate = null;
    for (const [sessionRecordDigest, consumptions] of groups) {
      const completed = await readCompletedR3Context(
        environment,
        graph,
        slots,
        sessionRecordDigest,
        consumptions,
        accumulator
      );
      verifiedContexts.push(completed.summary);
      if (
        completed.candidate &&
        sha256Canonical(completed.candidate.completed) === terminalExecutionRecordDigest
      ) {
        requireThat(completed.summary.scope.phase === "final", SESSION);
        selectedVerifier = completed.verifier;
        selectedCandidate = completed.candidate;
        selectedRequest = graph.get(completed.candidate.initial.requestDigest)?.value;
      }
    }
    requireThat(selectedVerifier && selectedRequest && selectedCandidate, SESSION);
    const oldLocal = await selectedVerifier.validateR3Context(graph, slots, legacy, accumulator);
    const matchedSources = await selectedVerifier.finishR3History(
      graph,
      slots,
      accumulator,
      oldLocal.legacy,
      selectedRequest
    );
    const requestDigest = sha256Canonical(selectedRequest);
    const matched = matchedSources.get(requestDigest);
    requireThat(matched, EVIDENCE);
    const { chosen, matchingRequestDigests } = selectSingleR3FinalUse(
      accumulator.r3FinalUses,
      requestDigest
    );
    const acknowledgements = values.filter(
      (value) =>
        value.kind === "custody" &&
        value.purpose === "owner-acknowledgement" &&
        value.subjectDigest === terminalExecutionRecordDigest
    );
    const cleanups = values.filter(
      (value) =>
        value.kind === "cleanup-observation" &&
        value.sessionId === selected.sessionId &&
        value.sessionNonce === selected.sessionNonce
    );
    const closed = values.filter(
      (value) =>
        value.kind === "session" &&
        value.status === "CLOSED" &&
        value.sessionId === selected.sessionId &&
        value.sessionNonce === selected.sessionNonce
    );
    requireThat(
      acknowledgements.length === 1 &&
        accumulator.r3Acknowledgements.has(sha256Canonical(acknowledgements[0])) &&
        cleanups.length === 1 &&
        accumulator.r3Cleanups.has(sha256Canonical(cleanups[0])) &&
        closed.length === 1 &&
        cleanups[0].finalExecutionRecordDigest === terminalExecutionRecordDigest &&
        cleanups[0].finalResultDigest === selected.resultDigest &&
        cleanups[0].finalAcknowledgementRecordDigest === sha256Canonical(acknowledgements[0]) &&
        instant(cleanups[0].recordedAt) <= instant(closed[0].recordedAt),
      EVIDENCE
    );
    const selectedContext = verifiedContexts.find(
      (value) =>
        value.sessionId === selected.sessionId && value.sessionNonce === selected.sessionNonce
    );
    requireThat(selectedContext, SESSION);
    await capture.recheck();
    return freeze({
      schemaVersion: "final-native-attempt-history.v1",
      profileDigest,
      ownerId: profile.ownerId,
      chain: chosen.chain,
      sourceSha: chosen.sourceSha,
      buildProofDigest: chosen.buildProofDigest,
      matchingSourceEvidenceDigest: chosen.matchingSourceEvidenceDigest,
      sourceGateEvidenceDigest: matched.sourceGateEvidenceDigest,
      ci: {
        repository: chosen.ci.repository,
        runId: chosen.ci.runId,
        runAttempt: chosen.ci.runAttempt,
        workflowPath: chosen.ci.workflowPath,
        callerWorkflowPath: chosen.ci.callerWorkflowPath,
        jobId: chosen.ci.jobId
      },
      matchingRequestDigests,
      selected: {
        operationId: selectedRequest.operationId,
        runId: selectedRequest.runId,
        attemptId: selectedRequest.attemptId,
        sessionId: selectedRequest.sessionId,
        sessionNonceDigest: sha256Bytes(Buffer.from(selectedRequest.sessionNonce, "utf8")),
        requestDigest,
        initialExecutionDigest: sha256Canonical(selectedCandidate.initial),
        terminalExecutionDigest: terminalExecutionRecordDigest,
        resultDigest: selected.resultDigest,
        acknowledgementRecordDigest: sha256Canonical(acknowledgements[0]),
        cleanupObservationRecordDigest: sha256Canonical(cleanups[0]),
        closedSessionRecordDigest: sha256Canonical(closed[0])
      },
      verifiedAt: stamp(),
      verifiedContexts,
      recheck: async () => {
        stamp();
        await capture.recheck();
      },
      close: async () => capture.close()
    });
  } catch (error) {
    capture.close();
    throw error;
  }
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
      [
        "scope",
        "creationSpec",
        "jobAdmission",
        ...(r3Context.destinationInputs === undefined ? [] : ["destinationInputs"]),
        ...(r3Context.snapshotInputs === undefined ? [] : ["snapshotInputs"])
      ],
      SESSION
    );
    if (r3Context.snapshotInputs !== undefined) {
      exact(r3Context.snapshotInputs, ["repoRoot"], SESSION);
      requireThat(
        typeof r3Context.snapshotInputs.repoRoot === "string" &&
          path.isAbsolute(r3Context.snapshotInputs.repoRoot) &&
          path.resolve(r3Context.snapshotInputs.repoRoot) === r3Context.snapshotInputs.repoRoot,
        SESSION
      );
    }
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
    assertManualR3CreationContext(profile, r3Context);
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
  const lifecycleTargetLocks = new Map();
  let snapshotReader = null,
    creationCompletionDigest = null,
    consumerCompletionDigest = null,
    candidateUseReceipt = null,
    r3ReadSourceOriginals = null,
    creationReceipt = null,
    consumerReceipt = null;
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
      await snapshotReader?.recheck();
    }
    const actual = JSON.parse(
      await store.read(objectPath(profile.storage.journalRoot, sha256Canonical(current)))
    );
    requireThat(equal(actual, current) && current.status === "OPEN", SESSION);
  }
  async function revocations() {
    const replay = await readManualRevocationHistory({
      store,
      journalRoot: profile.storage.journalRoot,
      profileDigest,
      ownerId: profile.ownerId,
      recordSchema: revocationSchema,
      now: stamp(),
      checkpoint,
      writeCheckpoint: true
    });
    checkpoint = replay.checkpoint;
    return replay.records;
  }
  const historyVerifier = createManualHistoryVerifier(() => ({
    profile,
    profileBytes,
    profileDigest,
    recordSchema,
    retentionDays,
    store,
    identity,
    sessionId,
    sessionNonce,
    current,
    r3Context,
    stamp,
    revocations,
    targetLocks,
    lifecycleTargetLocks,
    snapshotReader,
    creationCompletionDigest,
    consumerCompletionDigest,
    candidateUseReceipt,
    creationReceipt,
    consumerReceipt,
    evidenceState: async () => {
      await active();
      if (r3) r3Live();
    },
    evidenceTime: () => stamp(),
    r3,
    target
  }));
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
  async function context(request, allocatedPredecessor = null) {
    await active();
    const records = await revocations(),
      readAt = stamp();
    let predecessor = null;
    const digest =
      allocatedPredecessor ??
      request.dryRunRecordDigest ??
      request.predecessorExecutionRecordDigest;
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
  const reducedExecution = (...args) => historyVerifier.reducedExecution(...args);
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
  const archiveInput = (...args) => historyVerifier.archiveInput(...args);
  async function assertOpenHistory() {
    const values = [...(await store.objects()).values()].map(({ value }) => value);
    requireThat(
      !values.some(
        (value) =>
          value.kind === "session" && value.sessionId === sessionId && value.status !== "OPEN"
      ),
      SESSION
    );
  }
  async function history(...args) {
    await assertOpenHistory();
    return historyVerifier.history(...args);
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
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes));
    const consumer = parsed.schemaVersion === "manual-runner-request.v3";
    const candidateUse = parsed.schemaVersion === "manual-runner-request.v5";
    const request = consumer
      ? validateManualSnapshotConsumerRequest(parsed)
      : candidateUse
        ? validateManualCandidateUseRequest(parsed)
        : validateManualTargetCreationRequest(parsed);
    if (consumer) requireThat(creationCompletionDigest, SESSION);
    if (candidateUse) requireThat(creationCompletionDigest && !candidateUseReceipt, SESSION);
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
      ...(consumer
        ? ["scopeAuthorizationDigest"]
        : ["chain", "targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest"]),
      ...(candidateUse
        ? [
            "destinationAdmissionDigest",
            "preparationExecutionRecordDigest",
            "databaseTestManifestDigest",
            ...(request.phase === "final" ? ["matchingSourceEvidenceDigest"] : [])
          ]
        : [])
    ];
    const binding = Object.fromEntries(fields.map((field) => [field, request[field]]));
    requireThat(equal(binding, input.binding), BINDING);
    for (const field of ["profileDigest", "sessionId", "sessionNonce"])
      requireThat(request[field] === identity[field], BINDING);
    requireThat(
      request.ownerId === profile.ownerId &&
        request.operationId === r3Context.creationSpec.operationRef &&
        request.stage ===
          (consumer ? "snapshot-consumer" : candidateUse ? "candidate-use" : "target-create") &&
        request.sourceSha === identity.scope.sourceSha &&
        request.candidate.buildProofDigest === identity.scope.buildProofDigest &&
        (!consumer ||
          (["source", "final"].includes(identity.scope.phase) &&
            identity.scope.chain === "snapshot")),
      BINDING
    );
    for (const field of [
      "phase",
      ...(consumer
        ? []
        : ["chain", "targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest"])
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
        (candidateUse
          ? allocation.predecessorExecutionRecordDigest === request.preparationExecutionRecordDigest
          : consumer
            ? allocation.predecessorExecutionRecordDigest === creationCompletionDigest
            : allocation.predecessorExecutionRecordDigest === null) &&
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
      ...(consumer ? [] : ["chain"]),
      "sourceSha",
      ...(consumer ? [] : ["targetPolicyDigest", "creationSpecDigest", "jobAdmissionDigest"])
    ])
      requireThat(allocation[field] === request[field], BINDING);
    requireThat(allocation.buildProofDigest === request.candidate.buildProofDigest, BINDING);
    if (candidateUse) {
      for (const field of [
        "destinationAdmissionDigest",
        "preparationExecutionRecordDigest",
        "databaseTestManifestDigest",
        ...(request.phase === "final" ? ["matchingSourceEvidenceDigest"] : [])
      ])
        requireThat(allocation[field] === request[field], BINDING);
      await r3CandidatePreparation(request);
    }
    if (consumer) {
      const predecessor = JSON.parse(
        await store.read(objectPath(profile.storage.archiveRoot, creationCompletionDigest))
      );
      requireThat(
        creationCompletionDigest &&
          predecessor.kind === "execution" &&
          predecessor.status === "SUCCEEDED" &&
          predecessor.stage === "target-create" &&
          predecessor.resultDigest === request.destinationAdmissionDigest &&
          sha256Canonical(predecessor) === creationCompletionDigest &&
          request.scopeAuthorizationDigest === allocation.scopeAuthorizationDigest &&
          request.destinationAdmissionDigest === allocation.destinationAdmissionDigest &&
          request.matchingSourceEvidenceDigest === allocation.matchingSourceEvidenceDigest &&
          equal(request.input, allocation.input) &&
          allocation.chain === identity.scope.chain &&
          allocation.creationSpecDigest === identity.scope.creationSpecDigest &&
          allocation.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
          allocation.targetPolicyDigest === identity.scope.targetPolicyDigest,
        BINDING
      );
    }
    return { request, binding, canonicalBytes, allocation };
  }
  const r3CandidatePreparation = (...args) => historyVerifier.r3CandidatePreparation(...args);
  const r3LifecycleLock = (...args) => historyVerifier.r3LifecycleLock(...args);
  const r3StoredDestination = (...args) => historyVerifier.r3StoredDestination(...args);
  const r3ConsumerOriginals = (...args) => historyVerifier.r3ConsumerOriginals(...args);
  const r3SourceProof = (...args) => historyVerifier.r3SourceProof(...args);
  const r3FinalProof = (...args) => historyVerifier.r3FinalProof(...args);
  async function verifyR3History(
    request,
    pendingDigest = null,
    pendingDestination = null,
    pendingConsumer = null
  ) {
    let { graph, slots } = await readManualHistoryGraph(store, profile);
    const live = {
      sessionRecordDigest: sha256Canonical(current),
      sessionId,
      sessionNonce,
      operationRef: r3Context.creationSpec.operationRef
    };
    let { groups, legacy } = groupManualR3History(graph, profileDigest, live);
    let capture = null;
    const trustInputs = [];
    try {
      const accumulator = historyAccumulator();
      const completedContexts = [];
      if ([...groups.keys()].some((digest) => digest !== live.sessionRecordDigest)) {
        requireThat(r3Context.snapshotInputs, SESSION);
        capture = historicalManualStore(profile, owner.principal, io);
        await capture.store.roots();
        const captured = await readManualHistoryGraph(capture.store, profile);
        requireThat(
          equal([...graph.keys()].sort(), [...captured.graph.keys()].sort()) &&
            equal([...slots.keys()].sort(), [...captured.slots.keys()].sort()),
          SESSION
        );
        ({ graph, slots } = captured);
        ({ groups, legacy } = groupManualR3History(graph, profileDigest, live));
        const environment = await readCompletedR3Environment(
          profile,
          r3Context.snapshotInputs.repoRoot,
          capture,
          stamp
        );
        for (const [digest, consumptions] of groups) {
          if (digest === live.sessionRecordDigest) continue;
          const old = await readCompletedR3Context(
            environment,
            graph,
            slots,
            digest,
            consumptions,
            accumulator
          );
          completedContexts.push(old.summary);
        }
      }
      // The current group alone owns pending transitions and the live receipts.
      // Prior successful groups never count as this session's consumed stage.
      const {
        legacy: checkedLegacy,
        creationCount,
        consumerCount,
        historicalCompletion
      } = await historyVerifier.validateR3Context(
        graph,
        slots,
        [...(groups.get(live.sessionRecordDigest) ?? []), ...legacy],
        accumulator,
        pendingDigest,
        pendingDestination,
        pendingConsumer
      );
      await assertOpenHistory();
      historyVerifier.collectFinalUse(graph, accumulator, request);
      const matchedSources = await historyVerifier.finishR3History(
        graph,
        slots,
        accumulator,
        checkedLegacy,
        request
      );
      if (completedContexts.length) {
        // This is fixed H1/H2 input authentication, separate from the complete
        // execution/original proof above. No caller may supply a trusted flag.
        const { readTrustedR3HistoricalContext } =
          await import("../../../scripts/release/manual-stage1-trust.mjs");
        for (const context of completedContexts) {
          const held = await readTrustedR3HistoricalContext({
            repoRoot: r3Context.snapshotInputs.repoRoot,
            operationRef: context.operationRef,
            scope: context.scope,
            latestExecutionAt: context.latestExecutionAt,
            ...(Object.hasOwn(context, "latestCleanupAt")
              ? { latestCleanupAt: context.latestCleanupAt }
              : {})
          });
          trustInputs.push(held);
          requireThat(
            held.profileDigest === profileDigest &&
              held.operationRef === context.operationRef &&
              equal(held.scope, context.scope) &&
              held.latestExecutionAt === context.latestExecutionAt &&
              Object.hasOwn(held, "latestCleanupAt") ===
                Object.hasOwn(context, "latestCleanupAt") &&
              held.latestCleanupAt === context.latestCleanupAt &&
              typeof held.recheck === "function" &&
              typeof held.close === "function",
            SESSION
          );
        }
        for (const held of trustInputs) await held.recheck();
        await capture.recheck();
        await active();
        r3Live();
      }
      // A consumed target-create slot is never authorization to sign another one.
      requireThat(
        creationCount === 0 ||
          pendingDigest !== null ||
          (["snapshot-consumer", "candidate-use"].includes(request.stage) &&
            historicalCompletion !== null),
        SESSION
      );
      requireThat(
        consumerCount === 0 ||
          pendingConsumer !== null ||
          (request.stage === "candidate-use" && consumerCompletionDigest !== null),
        SESSION
      );
      return { graph, matchedSources };
    } finally {
      const closedInputs = await Promise.allSettled(trustInputs.map((held) => held.close()));
      capture?.close();
      if (closedInputs.some((value) => value.status === "rejected")) fail(SESSION);
    }
  }
  const r3History = async (...args) => (await verifyR3History(...args)).graph;
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
      consumerCompletionAttempted = false,
      targetLocksAttempted = false,
      completionAttempted = false,
      sourceCustodyAttempted = false,
      sourceCustodyResult = null,
      sourceCompletionAttempted = false,
      sourceCompletionDigest = null,
      finalCustodyAttempted = false,
      finalCustodyResult = null,
      finalCompletionAttempted = false,
      finalCompletionDigest = null,
      sourceAcknowledgementAttempted = false,
      finalAcknowledgementAttempted = false,
      cleanupAttempted = false,
      cleanupReleaseCancelled = false,
      cleanupObservationRecordDigest = null,
      consumerAuthorizationIssued = false,
      candidateUseAuthorizationIssued = false,
      candidateUseAttempted = false,
      consumerAttempted = false,
      closeRef = null;
    const lifecycleAttempts = new Set();
    const boundSnapshot = async (request) => {
      requireThat(r3Context.snapshotInputs && creationCompletionDigest, SESSION);
      if (!snapshotReader) {
        const { readR3SnapshotInput } =
          await import("../../../scripts/release/r3-snapshot-input-admission.mjs");
        snapshotReader = await readR3SnapshotInput({
          repoRoot: r3Context.snapshotInputs.repoRoot,
          inputReference: request.input.inputReference,
          now: new Date(stamp())
        });
      }
      requireThat(snapshotReader.inputId === request.input.inputReference, BINDING);
      await snapshotReader.assertConsumerBinding({ request, scope: identity.scope });
      await snapshotReader.recheck();
    };
    r3ReadSourceOriginals = historyVerifier.readSourceOriginals;
    const r3ReadFinalOriginals = historyVerifier.readFinalOriginals;
    const sourceHistory = async () => {
      requireThat(identity.scope.phase === "source" && candidateUseReceipt, SESSION);
      const graph = await store.objects();
      const initial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
      requireThat(initial?.stage === "candidate-use", SESSION);
      const request = graph.get(initial.requestDigest)?.value;
      requireThat(request?.schemaVersion === "manual-runner-request.v5", SESSION);
      return r3History(request);
    };
    const verifySourceOriginalsInternal = async () => {
      await sourceHistory();
      const result = await r3ReadSourceOriginals();
      await sourceHistory();
      return result;
    };
    const finalHistory = async () => {
      requireThat(identity.scope.phase === "final" && candidateUseReceipt, SESSION);
      const graph = await store.objects();
      const initial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
      requireThat(initial?.stage === "candidate-use", SESSION);
      const request = graph.get(initial.requestDigest)?.value;
      requireThat(
        request?.schemaVersion === "manual-runner-request.v5" && request.phase === "final",
        SESSION
      );
      return { request, ...(await verifyR3History(request)) };
    };
    const verifyFinalOriginalsInternal = async () => {
      const { request, matchedSources } = await finalHistory();
      const matched = matchedSources.get(sha256Canonical(request));
      requireThat(matched, EVIDENCE);
      const verified = await r3ReadFinalOriginals();
      const claims = verified.sourceClaims;
      requireThat(
        claims?.matchingSourceEvidenceDigest === matched.terminalDigest &&
          claims.matchingSourceResultDigest === matched.resultDigest &&
          claims.expectedSchemaDigest === matched.postSchemaDigest &&
          claims.sourceGateEvidenceDigest === matched.sourceGateEvidenceDigest,
        EVIDENCE
      );
      await finalHistory();
      return verified;
    };
    const completedHistory = async () =>
      identity.scope.phase === "final" ? (await finalHistory()).graph : sourceHistory();
    const acknowledgeCompletion = (phase, args) => {
      return serial(async () => {
        const completionDigest =
          phase === "source" ? sourceCompletionDigest : finalCompletionDigest;
        requireThat(
          args.length === 1 &&
            identity.scope.phase === phase &&
            completionDigest &&
            !(phase === "source" ? sourceAcknowledgementAttempted : finalAcknowledgementAttempted),
          SESSION
        );
        const input = snapshot(args[0]);
        exact(input, ["executionRecordDigest"], SESSION);
        requireThat(input.executionRecordDigest === completionDigest, SESSION);
        // This separate owner action is never called by either completion path.
        if (phase === "source") sourceAcknowledgementAttempted = true;
        else finalAcknowledgementAttempted = true;
        await active();
        r3Live();
        const graph = await completedHistory();
        const execution = graph.get(completionDigest)?.value;
        const initial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
        const proof = await (phase === "source"
          ? r3SourceProof(graph, initial, execution)
          : r3FinalProof(graph, initial, execution));
        requireThat(
          ![...graph.values()].some(
            ({ value }) =>
              value.kind === "custody" &&
              value.purpose === "owner-acknowledgement" &&
              value.subjectDigest === completionDigest
          ),
          EVIDENCE
        );
        const buildAcknowledgement =
          phase === "source"
            ? (await import("../../../scripts/release/r3-source-result.mjs"))
                .buildR3SourceAcknowledgement
            : (await import("../../../scripts/release/r3-final-result.mjs"))
                .buildR3FinalAcknowledgement;
        const acknowledgement = buildAcknowledgement({
          profileDigest,
          ownerId: profile.ownerId,
          execution,
          result: proof.result,
          observedAt: stamp(),
          recordedAt: stamp()
        });
        const bytes = encodeManualJson(acknowledgement);
        const acknowledgementRecordDigest = sha256Bytes(bytes);
        for (const role of ["archive", "backup"]) {
          await active();
          r3Live();
          await store.put(acknowledgement, role);
        }
        for (const role of ["archive", "backup"])
          requireThat(
            (
              await store.read(
                objectPath(profile.storage[`${role}Root`], acknowledgementRecordDigest)
              )
            ).equals(bytes),
            STORAGE
          );
        await completedHistory();
        await active();
        r3Live();
        return freeze({
          executionRecordDigest: completionDigest,
          resultDigest: execution.resultDigest,
          acknowledgementRecordDigest,
          promotionEligible: false
        });
      });
    };
    const closeWork = async (preserve) => {
      if (preserve) cleanupReleaseCancelled = true;
      if (closed) return closeRef;
      try {
        await active();
        if (cleanupObservationRecordDigest && !cleanupReleaseCancelled) {
          const graph = await completedHistory();
          requireThat(
            graph.get(cleanupObservationRecordDigest)?.value?.kind === "cleanup-observation",
            EVIDENCE
          );
          const { observeR3H1ForwardShutdown, assessR3H1ForwardShutdown } =
            await import("../../../scripts/release/r3-h1-forward-lease.mjs");
          const forward = await observeR3H1ForwardShutdown();
          assessR3H1ForwardShutdown({
            observationBytes: encodeManualJson(forward.observation),
            rawInputs: forward.rawInputs,
            now: stamp()
          });
          await active();
        }
        const uncertain =
          consumedOrUncertain && (cleanupReleaseCancelled || !cleanupObservationRecordDigest);
        const slotIdentities = !uncertain
          ? [await observerLockHandle.stat(), await lockHandle.stat()]
          : null;
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
        await snapshotReader?.close();
        snapshotReader = null;
        await closeTargetHandles();
        await observerLockHandle.close();
        await lockHandle.close();
        observerLockHandle = null;
        lockHandle = null;
        if (!uncertain) {
          for (const [index, file] of [observerLockPath, lockPath].entries()) {
            const visible = await store.fs.lstat(file);
            requireThat(
              visible.ino === slotIdentities[index].ino &&
                visible.dev === slotIdentities[index].dev &&
                (await store.read(file)).equals(lockBytes),
              STORAGE
            );
            await store.fs.unlink(file);
          }
        }
        return closeRef;
      } catch (error) {
        consumedOrUncertain = true;
        closed = true;
        key = null;
        await snapshotReader?.close().catch(() => {});
        snapshotReader = null;
        await closeTargetHandles().catch(() => {});
        await observerLockHandle?.close().catch(() => {});
        await lockHandle?.close().catch(() => {});
        observerLockHandle = null;
        lockHandle = null;
        throw error;
      }
    };
    return freeze({
      ...identity,
      sign(input) {
        return serial(async () => {
          await active();
          r3Live();
          const request = await r3CheckedRequest(input);
          if (request.request.stage === "candidate-use")
            requireThat(!candidateUseAuthorizationIssued && !candidateUseAttempted, SESSION);
          if (request.request.stage === "snapshot-consumer") {
            requireThat(!consumerAuthorizationIssued && !consumerAttempted, SESSION);
            await boundSnapshot(request.request);
          }
          await r3History(request.request);
          const issuedAt = stamp(),
            ctx = await context(
              request.request,
              request.allocation.predecessorExecutionRecordDigest
            ),
            expiresAt = new Date(
              Math.min(
                instant(profile.expiresAt),
                instant(r3Context.jobAdmission.expiresAt),
                ...(request.request.stage === "snapshot-consumer"
                  ? [instant(snapshotReader.expiresAt)]
                  : []),
                instant(issuedAt) + 300000
              )
            ).toISOString();
          requireThat(instant(issuedAt) < instant(expiresAt), "MANUAL_TIME_INVALID");
          const authorization = signManualAuthorization({
            payload: {
              schemaVersion:
                request.request.stage === "snapshot-consumer"
                  ? "manual-launch-authorization.v3"
                  : request.request.stage === "candidate-use"
                    ? "manual-launch-authorization.v5"
                    : "manual-launch-authorization.v4",
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
          if (request.request.stage === "snapshot-consumer") consumerAuthorizationIssued = true;
          if (request.request.stage === "candidate-use") candidateUseAuthorizationIssued = true;
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
          if (request.request.stage === "candidate-use")
            requireThat(candidateUseAuthorizationIssued && !candidateUseAttempted, SESSION);
          if (request.request.stage === "snapshot-consumer") {
            requireThat(consumerAuthorizationIssued && !consumerAttempted, SESSION);
            await boundSnapshot(request.request);
          }
          await r3History(request.request);
          const ctx = await context(
              request.request,
              request.allocation.predecessorExecutionRecordDigest
            ),
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
            stage: request.request.stage,
            sessionRecordDigest: sha256Canonical(current),
            revocationRecordDigest: ctx.revocation.headDigest,
            revocationSequence: ctx.revocation.records.at(-1).sequence,
            status: "CONSUMED"
          };
          validateContract(recordSchema, consumption);
          // Once create-only slot insertion begins, every failure retains both
          // forward slots. A missing execution is reconstructed as uncertainty.
          consumedOrUncertain = true;
          if (request.request.stage === "snapshot-consumer") consumerAttempted = true;
          if (request.request.stage === "candidate-use") candidateUseAttempted = true;
          await store.create(
            consumptionSlot(authorization.payload.authorizationId),
            encodeManualJson(consumption),
            "MANUAL_AUTHORIZATION_CONSUMED"
          );
          await store.put(consumption, "journal");
          const readback = await consumptionReadback(consumption);
          const execution = {
            ...common("execution", stamp()),
            stage: request.request.stage,
            sessionId,
            sessionNonce,
            operationId: request.request.operationId,
            idempotencyKey: request.request.idempotencyKey,
            attemptId: request.request.attemptId,
            requestDigest: consumption.requestDigest,
            authorizationDigest: consumption.authorizationDigest,
            consumptionRecordDigest: sha256Canonical(consumption),
            predecessorExecutionRecordDigest: request.allocation.predecessorExecutionRecordDigest,
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
          const final = await context(
            request.request,
            request.allocation.predecessorExecutionRecordDigest
          );
          verify(authorization, request, final);
          const receipt = freeze({
            stage: request.request.stage,
            parentDecision,
            consumptionReadbackDigest: readback.recordDigest,
            executionRecordDigest: executionRef.recordDigest
          });
          if (request.request.stage === "target-create") creationReceipt = receipt;
          else if (request.request.stage === "candidate-use") {
            await store.put(execution);
            await store.put(execution, "backup");
            candidateUseReceipt = receipt;
            await r3History(request.request);
          } else {
            consumerReceipt = receipt;
            await active();
            r3Live();
            await r3History(request.request, null, null, creationCompletionDigest);
          }
          return receipt;
        });
      },
      assertSnapshotConsumption(...args) {
        return serial(async () => {
          requireThat(
            args.length === 0 && consumerReceipt && creationCompletionDigest && snapshotReader,
            SESSION
          );
          await active();
          r3Live();
          const graph = await store.objects();
          const execution = graph.get(consumerReceipt.executionRecordDigest)?.value;
          requireThat(
            execution?.stage === "snapshot-consumer" && execution.status === "INTERRUPTED_UNKNOWN",
            SESSION
          );
          const request = graph.get(execution.requestDigest)?.value;
          requireThat(request?.schemaVersion === "manual-runner-request.v3", SESSION);
          // The initial consumed receipt is retained after completion. Replaying
          // this session's known transition does not authorize another consume.
          await r3History(request, null, null, creationCompletionDigest);
          await active();
          r3Live();
          return freeze({
            executionRecordDigest: consumerReceipt.executionRecordDigest,
            matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest ?? null
          });
        });
      },
      assertCandidateUse(...args) {
        return serial(async () => {
          requireThat(
            args.length === 0 && candidateUseReceipt && !sourceCompletionAttempted,
            SESSION
          );
          await active();
          r3Live();
          const graph = await store.objects();
          const execution = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
          requireThat(
            execution?.stage === "candidate-use" && execution.status === "INTERRUPTED_UNKNOWN",
            SESSION
          );
          const request = graph.get(execution.requestDigest)?.value;
          requireThat(request?.schemaVersion === "manual-runner-request.v5", SESSION);
          const { matchedSources } = await verifyR3History(request);
          await active();
          r3Live();
          const matchedSource = matchedSources.get(sha256Canonical(request));
          requireThat(request.phase !== "final" || matchedSource, EVIDENCE);
          return freeze({
            executionRecordDigest: candidateUseReceipt.executionRecordDigest,
            ...(request.phase === "final"
              ? {
                  matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
                  matchedSource
                }
              : {})
          });
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
          creationCompletionDigest = executionDigest;
          return freeze({ executionRecordDigest: executionDigest, custodyRecordDigests });
        });
      },
      registerLifecycleTarget(input) {
        return serial(async () => {
          await active();
          r3Live();
          requireThat(
            creationCompletionDigest && candidateUseReceipt && targetLocksAttempted,
            SESSION
          );
          exact(input, ["record"], SESSION);
          const record = snapshot(input.record);
          const graph = await store.objects();
          const initial = graph.get(creationReceipt.executionRecordDigest)?.value;
          const completed = graph.get(creationCompletionDigest)?.value;
          requireThat(
            initial?.stage === "target-create" &&
              initial.status === "INTERRUPTED_UNKNOWN" &&
              completed?.stage === "target-create" &&
              completed.status === "SUCCEEDED" &&
              completed.predecessorExecutionRecordDigest ===
                creationReceipt.executionRecordDigest &&
              /^sha256:[0-9a-f]{64}$/u.test(completed.resultDigest ?? ""),
            SESSION
          );
          const request = graph.get(initial.requestDigest)?.value;
          requireThat(request?.schemaVersion === "manual-runner-request.v4", SESSION);
          // Continue the already consumed creation; the default history path
          // deliberately refuses a second target-create authorization.
          await r3History(
            request,
            creationReceipt.executionRecordDigest,
            null,
            consumerReceipt ? creationCompletionDigest : null
          );
          const original = await r3StoredDestination(graph, completed.resultDigest, initial);
          const checked = r3LifecycleLock(original.destination, record);
          requireThat(
            !lifecycleAttempts.has(checked.shard) &&
              !targetLocks.has(checked.entry.lockDigest) &&
              [...lifecycleTargetLocks.values()].every(
                (held) => held.entry.identity.databaseOid !== checked.entry.identity.databaseOid
              ),
            SESSION
          );
          lifecycleAttempts.add(checked.shard);
          const file = path.join(
            profile.storage.journalRoot,
            "locks",
            `${checked.entry.lockDigest.slice(7)}.json`
          );
          const bytes = encodeManualJson({
            ...identity,
            pid: process.pid,
            operationRef: r3Context.creationSpec.operationRef,
            executionRecordDigest: creationReceipt.executionRecordDigest,
            databaseName: checked.entry.databaseName,
            target: checked.entry.identity,
            reservationLockDigest: checked.reservedLockDigest,
            provisionedRecordDigest: checked.recordDigest,
            provisionedRecord: record
          });
          let handle;
          try {
            await store.checkedPath(path.dirname(file));
            handle = await store.fs.open(file, "wx", 0o600);
          } catch {
            fail(SESSION);
          }
          // The captured descriptor and pathname remain held after any later
          // write/readback failure; a failed attempt cannot switch identities.
          targetLocks.set(checked.entry.lockDigest, { file, bytes, handle });
          lifecycleTargetLocks.set(checked.shard, {
            entry: checked.entry,
            record,
            recordDigest: checked.recordDigest
          });
          await store.setNewOwner(file);
          await handle.writeFile(bytes);
          await handle.sync();
          requireThat((await store.read(file)).equals(bytes), STORAGE);
          await r3StoredDestination(await store.objects(), completed.resultDigest, initial);
          await active();
          r3Live();
          return freeze({
            shard: checked.shard,
            lock: checked.entry,
            reservationLockDigest: checked.reservedLockDigest,
            provisionedRecordDigest: checked.recordDigest
          });
        });
      },
      completeSnapshot(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          await active();
          r3Live();
          requireThat(
            consumerReceipt &&
              creationCompletionDigest &&
              snapshotReader &&
              !consumerCompletionAttempted,
            SESSION
          );
          consumerCompletionAttempted = true;
          const initialGraph = await store.objects();
          const initial = initialGraph.get(consumerReceipt.executionRecordDigest)?.value;
          requireThat(
            initial?.kind === "execution" &&
              initial.stage === "snapshot-consumer" &&
              initial.status === "INTERRUPTED_UNKNOWN",
            SESSION
          );
          const request = initialGraph.get(initial.requestDigest)?.value;
          requireThat(request?.schemaVersion === "manual-runner-request.v3", SESSION);
          await r3History(request, null, null, creationCompletionDigest);
          const proof = await r3ConsumerOriginals(initialGraph, initial, request);
          const resultDigest = sha256Canonical(proof.result);
          const processEvidenceDigest = sha256Canonical(proof.processEvidence);
          // Archive each actual original separately to keep the existing JSON
          // bound. The two custody records per index bind this complete graph;
          // ownership originals themselves must also have exact dual readback.
          for (const { digest, value } of proof.originals) {
            const bytes = encodeManualJson(value);
            requireThat(sha256Bytes(bytes) === digest, EVIDENCE);
            await store.put(value);
            await store.create(objectPath(profile.storage.backupRoot, digest), bytes);
            for (const role of ["archive", "backup"])
              requireThat(
                (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(
                  bytes
                ),
                STORAGE
              );
          }
          const custodyRecordDigests = [];
          for (const subjectDigest of [resultDigest, processEvidenceDigest]) {
            for (const role of ["archive", "backup"]) {
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
          const consumed = initialGraph.get(initial.consumptionRecordDigest)?.value;
          const authorization = initialGraph.get(initial.authorizationDigest)?.value;
          requireThat(
            consumed &&
              authorization?.payload &&
              (await store.read(consumptionSlot(authorization.payload.authorizationId))).equals(
                encodeManualJson(consumed)
              ),
            STORAGE
          );
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
          const execution = {
            ...common("execution", finishedAt),
            stage: "snapshot-consumer",
            sessionId,
            sessionNonce,
            operationId: initial.operationId,
            idempotencyKey: initial.idempotencyKey,
            attemptId: initial.attemptId,
            requestDigest: initial.requestDigest,
            authorizationDigest: initial.authorizationDigest,
            consumptionRecordDigest: initial.consumptionRecordDigest,
            predecessorExecutionRecordDigest: consumerReceipt.executionRecordDigest,
            startedAt: initial.recordedAt,
            finishedAt,
            status: "SUCCEEDED",
            reasonCode: null,
            resultDigest,
            processEvidenceDigest
          };
          validateContract(recordSchema, execution);
          // Rebuild from the stored originals and independently re-read both
          // copies before writing a terminal execution. No caller success flag.
          await r3ConsumerOriginals(await store.objects(), initial, request, execution);
          const current = await r3ConsumerOriginals(initialGraph, initial, request);
          requireThat(
            equal(current.processEvidence.readbacks, proof.processEvidence.readbacks),
            EVIDENCE
          );
          await active();
          r3Live();
          requireThat(
            !(await revocations()).some(
              (record) =>
                record.action === "REVOKE_PROFILE" ||
                (record.action === "REVOKE_AUTHORIZATION" &&
                  record.authorizationId === authorization.payload.authorizationId)
            ),
            REVOCATION
          );
          const executionDigest = sha256Canonical(execution);
          await store.put(execution, "journal");
          await store.put(execution);
          await store.create(
            objectPath(profile.storage.backupRoot, executionDigest),
            encodeManualJson(execution)
          );
          await r3History(request, null, null, creationCompletionDigest);
          consumerCompletionDigest = executionDigest;
          return freeze({
            executionRecordDigest: executionDigest,
            resultDigest,
            processEvidenceDigest,
            custodyRecordDigests,
            originalDigests: proof.originals.map(({ digest }) => digest)
          });
        });
      },
      verifySourceOriginals(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          return verifySourceOriginalsInternal();
        });
      },
      verifyFinalOriginals(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          return verifyFinalOriginalsInternal();
        });
      },
      custodySourceOriginals(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          await active();
          r3Live();
          requireThat(
            !sourceCustodyAttempted &&
              r3Context.scope.phase === "source" &&
              r3Context.snapshotInputs &&
              creationReceipt &&
              creationCompletionDigest &&
              lifecycleTargetLocks.size === 2 &&
              (r3Context.scope.chain === "snapshot" ? consumerCompletionDigest : !consumerReceipt),
            SESSION
          );
          sourceCustodyAttempted = true;
          const verified = await verifySourceOriginalsInternal();
          const names = [
            "attempt",
            ...r3Context.destinationInputs.manifest.suites.map(({ suiteId }) => suiteId),
            "manifest"
          ];
          requireThat(
            Array.isArray(verified.originals) &&
              verified.originals.length === names.length &&
              new Set(verified.originals.map(({ digest }) => digest)).size === names.length,
            EVIDENCE
          );
          const refs = verified.originals.map((ref, index) => {
            exact(ref, ["name", "digest", "bytes"], EVIDENCE);
            requireThat(
              ref.name === names[index] &&
                /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(ref.name) &&
                /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
                Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= 33554432,
              EVIDENCE
            );
            return ref;
          });
          const readSource = async (ref, role) => {
            const bytes = await store.read(
              path.join(
                profile.storage[`${role}Root`],
                "inputs",
                "r3",
                r3Context.creationSpec.operationRef,
                "observations",
                "source",
                ref.name,
                "readback.json"
              ),
              true,
              33554432
            );
            requireThat(bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest, STORAGE);
          };
          const custodyRecordDigests = [];
          const custodyCopies = [];
          for (const ref of refs) {
            for (const role of ["archive", "backup"]) {
              await active();
              r3Live();
              await readSource(ref, role);
              const observedAt = stamp();
              const custody = {
                ...common("custody", observedAt),
                ownerId: profile.ownerId,
                subjectDigest: ref.digest,
                subjectType: "record",
                purpose: `${role}-readback`,
                outcome: "MATCH",
                observedDigest: ref.digest,
                observedAt,
                storageRole: role,
                retentionDays,
                reasonCode: null
              };
              validateContract(recordSchema, custody);
              const recordBytes = encodeManualJson(custody);
              const recordDigest = sha256Bytes(recordBytes);
              await active();
              r3Live();
              requireThat((await store.put(custody)).recordDigest === recordDigest, STORAGE);
              await active();
              r3Live();
              await store.create(objectPath(profile.storage.backupRoot, recordDigest), recordBytes);
              for (const copyRole of ["archive", "backup"])
                requireThat(
                  (
                    await store.read(objectPath(profile.storage[`${copyRole}Root`], recordDigest))
                  ).equals(recordBytes),
                  STORAGE
                );
              custodyRecordDigests.push(recordDigest);
              custodyCopies.push({ recordDigest, recordBytes });
            }
          }
          for (const { recordDigest, recordBytes } of custodyCopies)
            for (const role of ["archive", "backup"])
              requireThat(
                (await store.read(objectPath(profile.storage[`${role}Root`], recordDigest))).equals(
                  recordBytes
                ),
                STORAGE
              );
          await active();
          r3Live();
          requireThat(
            sha256Canonical(await verifySourceOriginalsInternal()) === sha256Canonical(verified),
            EVIDENCE
          );
          await active();
          r3Live();
          sourceCustodyResult = freeze({ verified, custodyRecordDigests });
          return freeze({ ...verified, custodyRecordDigests });
        });
      },
      completeSource(...args) {
        return serial(async () => {
          requireThat(
            args.length === 0 &&
              identity.scope.phase === "source" &&
              candidateUseReceipt &&
              sourceCustodyResult &&
              !sourceCompletionAttempted,
            SESSION
          );
          sourceCompletionAttempted = true;
          await active();
          r3Live();
          const graph = await sourceHistory();
          const initial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
          const proof = await r3SourceProof(graph, initial);
          requireThat(
            equal(proof.verified, sourceCustodyResult.verified) &&
              equal(proof.result.custodyRecordDigests, sourceCustodyResult.custodyRecordDigests),
            EVIDENCE
          );
          const resultDigest = sha256Canonical(proof.result);
          const resultBytes = encodeManualJson(proof.result);
          await store.put(proof.result);
          await store.put(proof.result, "backup");
          const custodyRecordDigests = [];
          for (const role of ["archive", "backup"]) {
            await active();
            r3Live();
            requireThat(
              (await store.read(objectPath(profile.storage[`${role}Root`], resultDigest))).equals(
                resultBytes
              ),
              STORAGE
            );
            const observedAt = stamp();
            const custody = {
              ...common("custody", observedAt),
              ownerId: profile.ownerId,
              subjectDigest: resultDigest,
              subjectType: "record",
              purpose: `${role}-readback`,
              outcome: "MATCH",
              observedDigest: resultDigest,
              observedAt,
              storageRole: role,
              retentionDays,
              reasonCode: null
            };
            validateContract(recordSchema, custody);
            const digest = sha256Canonical(custody);
            await store.put(custody);
            await store.put(custody, "backup");
            for (const copyRole of ["archive", "backup"])
              requireThat(
                (await store.read(objectPath(profile.storage[`${copyRole}Root`], digest))).equals(
                  encodeManualJson(custody)
                ),
                STORAGE
              );
            custodyRecordDigests.push(digest);
          }
          await active();
          r3Live();
          const authorization = graph.get(initial.authorizationDigest)?.value;
          const records = await revocations();
          requireThat(
            authorization?.payload &&
              !records.some(
                (record) =>
                  record.action === "REVOKE_PROFILE" ||
                  (record.action === "REVOKE_AUTHORIZATION" &&
                    record.authorizationId === authorization.payload.authorizationId)
              ),
            REVOCATION
          );
          const finishedAt = stamp();
          const execution = {
            ...initial,
            ...common("execution", stamp()),
            predecessorExecutionRecordDigest: candidateUseReceipt.executionRecordDigest,
            startedAt: initial.recordedAt,
            finishedAt,
            status: "SUCCEEDED",
            reasonCode: null,
            resultDigest,
            processEvidenceDigest: proof.verified.readbackDigest
          };
          validateContract(recordSchema, execution);
          const executionRecordDigest = sha256Canonical(execution);
          for (const role of ["journal", "archive", "backup"]) await store.put(execution, role);
          await sourceHistory();
          await active();
          r3Live();
          sourceCompletionDigest = executionRecordDigest;
          return freeze({
            executionRecordDigest,
            resultDigest,
            processEvidenceDigest: execution.processEvidenceDigest,
            custodyRecordDigests
          });
        });
      },
      custodyFinalOriginals(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          await active();
          r3Live();
          requireThat(
            !finalCustodyAttempted &&
              identity.scope.phase === "final" &&
              r3Context.snapshotInputs &&
              creationReceipt &&
              creationCompletionDigest &&
              candidateUseReceipt &&
              lifecycleTargetLocks.size === 2 &&
              (identity.scope.chain === "snapshot" ? consumerCompletionDigest : !consumerReceipt),
            SESSION
          );
          finalCustodyAttempted = true;
          const verified = await verifyFinalOriginalsInternal();
          const { r3FinalObservationNames } =
            await import("../../../scripts/release/r3-final-result.mjs");
          const graph = await store.objects();
          const destination = graph.get(
            graph.get(creationCompletionDigest)?.value?.resultDigest
          )?.value;
          requireThat(destination?.databaseTargetSet?.plan, EVIDENCE);
          const names = r3FinalObservationNames({
            manifest: r3Context.destinationInputs.manifest,
            plan: destination.databaseTargetSet.plan
          });
          requireThat(
            Array.isArray(verified.originals) &&
              verified.originals.length === names.length &&
              new Set(verified.originals.map(({ digest }) => digest)).size === names.length,
            EVIDENCE
          );
          const refs = verified.originals.map((ref, index) => {
            exact(ref, ["name", "digest", "bytes"], EVIDENCE);
            requireThat(
              ref.name === names[index] &&
                /^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(ref.name) &&
                /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
                Number.isSafeInteger(ref.bytes) &&
                ref.bytes > 0 &&
                ref.bytes <= 33554432,
              EVIDENCE
            );
            return ref;
          });
          const readFinal = async (ref, role) => {
            const bytes = await store.read(
              path.join(
                profile.storage[`${role}Root`],
                "inputs",
                "r3",
                r3Context.creationSpec.operationRef,
                "observations",
                "final",
                ref.name,
                "readback.json"
              ),
              true,
              33554432
            );
            requireThat(bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest, STORAGE);
          };
          const custodyRecordDigests = [];
          const custodyCopies = [];
          for (const ref of refs) {
            for (const role of ["archive", "backup"]) {
              await active();
              r3Live();
              await readFinal(ref, role);
              const observedAt = stamp();
              const custody = {
                ...common("custody", observedAt),
                ownerId: profile.ownerId,
                subjectDigest: ref.digest,
                subjectType: "record",
                purpose: `${role}-readback`,
                outcome: "MATCH",
                observedDigest: ref.digest,
                observedAt,
                storageRole: role,
                retentionDays,
                reasonCode: null
              };
              validateContract(recordSchema, custody);
              const recordBytes = encodeManualJson(custody);
              const recordDigest = sha256Bytes(recordBytes);
              await active();
              r3Live();
              requireThat((await store.put(custody)).recordDigest === recordDigest, STORAGE);
              await active();
              r3Live();
              await store.create(objectPath(profile.storage.backupRoot, recordDigest), recordBytes);
              for (const copyRole of ["archive", "backup"])
                requireThat(
                  (
                    await store.read(objectPath(profile.storage[`${copyRole}Root`], recordDigest))
                  ).equals(recordBytes),
                  STORAGE
                );
              custodyRecordDigests.push(recordDigest);
              custodyCopies.push({ recordDigest, recordBytes });
            }
          }
          for (const { recordDigest, recordBytes } of custodyCopies)
            for (const role of ["archive", "backup"])
              requireThat(
                (await store.read(objectPath(profile.storage[`${role}Root`], recordDigest))).equals(
                  recordBytes
                ),
                STORAGE
              );
          await active();
          r3Live();
          requireThat(
            sha256Canonical(await verifyFinalOriginalsInternal()) === sha256Canonical(verified),
            EVIDENCE
          );
          await active();
          r3Live();
          finalCustodyResult = freeze({ verified, custodyRecordDigests });
          return freeze({ ...verified, custodyRecordDigests });
        });
      },
      completeFinal(...args) {
        return serial(async () => {
          requireThat(
            args.length === 0 &&
              identity.scope.phase === "final" &&
              candidateUseReceipt &&
              finalCustodyResult &&
              !finalCompletionAttempted,
            SESSION
          );
          finalCompletionAttempted = true;
          await active();
          r3Live();
          const { graph, request } = await finalHistory();
          const initial = graph.get(candidateUseReceipt.executionRecordDigest)?.value;
          const proof = await r3FinalProof(graph, initial);
          requireThat(
            equal(proof.verified, finalCustodyResult.verified) &&
              equal(proof.result.custodyRecordDigests, finalCustodyResult.custodyRecordDigests),
            EVIDENCE
          );
          const resultDigest = sha256Canonical(proof.result);
          const resultBytes = encodeManualJson(proof.result);
          await store.put(proof.result);
          await store.put(proof.result, "backup");
          const custodyRecordDigests = [];
          for (const role of ["archive", "backup"]) {
            await active();
            r3Live();
            requireThat(
              (await store.read(objectPath(profile.storage[`${role}Root`], resultDigest))).equals(
                resultBytes
              ),
              STORAGE
            );
            const observedAt = stamp();
            const custody = {
              ...common("custody", observedAt),
              ownerId: profile.ownerId,
              subjectDigest: resultDigest,
              subjectType: "record",
              purpose: `${role}-readback`,
              outcome: "MATCH",
              observedDigest: resultDigest,
              observedAt,
              storageRole: role,
              retentionDays,
              reasonCode: null
            };
            validateContract(recordSchema, custody);
            const digest = sha256Canonical(custody);
            await store.put(custody);
            await store.put(custody, "backup");
            for (const copyRole of ["archive", "backup"])
              requireThat(
                (await store.read(objectPath(profile.storage[`${copyRole}Root`], digest))).equals(
                  encodeManualJson(custody)
                ),
                STORAGE
              );
            custodyRecordDigests.push(digest);
          }
          await active();
          r3Live();
          const authorization = graph.get(initial.authorizationDigest)?.value;
          const records = await revocations();
          requireThat(
            authorization?.payload &&
              !records.some(
                (record) =>
                  record.action === "REVOKE_PROFILE" ||
                  (record.action === "REVOKE_AUTHORIZATION" &&
                    record.authorizationId === authorization.payload.authorizationId)
              ),
            REVOCATION
          );
          const finishedAt = stamp();
          const execution = {
            ...initial,
            ...common("execution", stamp()),
            predecessorExecutionRecordDigest: candidateUseReceipt.executionRecordDigest,
            startedAt: initial.recordedAt,
            finishedAt,
            status: "SUCCEEDED",
            reasonCode: null,
            resultDigest,
            processEvidenceDigest: proof.verified.readbackDigest
          };
          validateContract(recordSchema, execution);
          const executionRecordDigest = sha256Canonical(execution);
          for (const role of ["journal", "archive", "backup"]) await store.put(execution, role);
          await r3History(request);
          await active();
          r3Live();
          finalCompletionDigest = executionRecordDigest;
          return freeze({
            executionRecordDigest,
            resultDigest,
            processEvidenceDigest: execution.processEvidenceDigest,
            custodyRecordDigests,
            promotionEligible: false
          });
        });
      },
      acknowledgeSource: (...args) => acknowledgeCompletion("source", args),
      acknowledgeFinal: (...args) => acknowledgeCompletion("final", args),
      completeCleanup(...args) {
        return serial(async () => {
          const phase = identity.scope.phase;
          const completionDigest =
            phase === "source" ? sourceCompletionDigest : finalCompletionDigest;
          requireThat(
            args.length === 0 &&
              completionDigest &&
              (phase === "source"
                ? sourceAcknowledgementAttempted
                : finalAcknowledgementAttempted) &&
              candidateUseReceipt &&
              !cleanupAttempted &&
              r3Context.snapshotInputs?.repoRoot,
            SESSION
          );
          cleanupAttempted = true;
          await active();
          r3Live();
          const graph = await completedHistory();
          const terminal = graph.get(completionDigest)?.value;
          const acknowledgements = [...graph.values()]
            .map(({ value }) => value)
            .filter(
              (value) =>
                value.kind === "custody" &&
                value.purpose === "owner-acknowledgement" &&
                value.subjectDigest === completionDigest
            );
          requireThat(
            acknowledgements.length === 1 &&
              ![...graph.values()].some(
                ({ value }) => value.kind === "cleanup-observation" && value.sessionId === sessionId
              ),
            EVIDENCE
          );
          const { readFixedR3HostedCleanupEvidence } =
            await import("../../../scripts/release/manual-stage1-trust.mjs");
          const { observeR3H1ForwardShutdown } =
            await import("../../../scripts/release/r3-h1-forward-lease.mjs");
          let held;
          let receipt;
          try {
            held = await readFixedR3HostedCleanupEvidence({
              repoRoot: r3Context.snapshotInputs.repoRoot,
              operationRef: r3Context.creationSpec.operationRef
            });
            requireThat(
              held.operationRef === r3Context.creationSpec.operationRef &&
                equal(held.spec, r3Context.creationSpec) &&
                held.jobAdmissionDigest === identity.scope.jobAdmissionDigest &&
                held.jobAdmissionBytes.equals(encodeManualJson(r3Context.jobAdmission)) &&
                sha256Bytes(held.policyBytes) === identity.scope.targetPolicyDigest &&
                sha256Bytes(held.rawBundle) === held.bundleDigest &&
                sha256Bytes(held.creationRawBundle) === held.creationEvidenceDigest,
              EVIDENCE
            );
            const forward = await observeR3H1ForwardShutdown();
            const forwardEvidence = {
              schemaVersion: "manual-r3-forward-shutdown-evidence.v1",
              observation: forward.observation,
              rawInputs: Object.fromEntries(
                Object.entries(forward.rawInputs).map(([name, bytes]) => {
                  requireThat(Buffer.isBuffer(bytes), EVIDENCE);
                  return [name, bytes.toString("base64")];
                })
              )
            };
            const forwardBytes = encodeManualJson(forwardEvidence);
            const record = {
              ...common("cleanup-observation", stamp()),
              sessionId,
              sessionNonce,
              ownerId: profile.ownerId,
              scope: snapshot(identity.scope),
              operationRef: r3Context.creationSpec.operationRef,
              sessionRecordDigest: sha256Canonical(current),
              [`${phase}ExecutionRecordDigest`]: completionDigest,
              [`${phase}ResultDigest`]: terminal.resultDigest,
              [`${phase}AcknowledgementRecordDigest`]: sha256Canonical(acknowledgements[0]),
              cleanupBundleDigest: held.bundleDigest,
              creationEvidenceDigest: held.creationEvidenceDigest,
              forwardEvidenceDigest: sha256Bytes(forwardBytes),
              forwardObservationDigest: forward.observationDigest
            };
            const supplied = new Map([
              [record.cleanupBundleDigest, Buffer.from(held.rawBundle)],
              [record.creationEvidenceDigest, Buffer.from(held.creationRawBundle)],
              [record.forwardEvidenceDigest, forwardBytes]
            ]);
            const proof = await historyVerifier.r3CleanupProof(graph, record, supplied);
            await held.recheck();
            await active();
            r3Live();
            // No history projection while these exact, already checked originals
            // are being persisted. A partial write remains an orphan and blocks
            // subsequent gates; it never becomes a broad pending exception.
            const custodyRecordDigests = [];
            for (const [digest, bytes] of proof.originals) {
              for (const role of ["archive", "backup"])
                await store.create(objectPath(profile.storage[`${role}Root`], digest), bytes);
              for (const role of ["archive", "backup"]) {
                requireThat(
                  (await store.read(objectPath(profile.storage[`${role}Root`], digest))).equals(
                    bytes
                  ),
                  STORAGE
                );
                const observedAt = stamp();
                const custody = {
                  ...common("custody", observedAt),
                  ownerId: profile.ownerId,
                  subjectDigest: digest,
                  subjectType: "record",
                  purpose: `${role}-readback`,
                  outcome: "MATCH",
                  observedDigest: digest,
                  observedAt,
                  storageRole: role,
                  retentionDays,
                  reasonCode: null
                };
                validateContract(recordSchema, custody);
                const custodyDigest = sha256Canonical(custody);
                for (const copyRole of ["archive", "backup"]) await store.put(custody, copyRole);
                for (const copyRole of ["archive", "backup"])
                  requireThat(
                    (
                      await store.read(
                        objectPath(profile.storage[`${copyRole}Root`], custodyDigest)
                      )
                    ).equals(encodeManualJson(custody)),
                    STORAGE
                  );
                custodyRecordDigests.push(custodyDigest);
              }
            }
            await completedHistory();
            await held.recheck();
            await active();
            r3Live();
            receipt = freeze({
              cleanupObservationRecordDigest: sha256Canonical(record),
              cleanupBundleDigest: record.cleanupBundleDigest,
              creationEvidenceDigest: record.creationEvidenceDigest,
              forwardEvidenceDigest: record.forwardEvidenceDigest,
              forwardObservationDigest: record.forwardObservationDigest,
              [`${phase}ExecutionRecordDigest`]: record[`${phase}ExecutionRecordDigest`],
              [`${phase}AcknowledgementRecordDigest`]:
                record[`${phase}AcknowledgementRecordDigest`],
              custodyRecordDigests,
              promotionEligible: false
            });
          } finally {
            await held?.close();
          }
          cleanupObservationRecordDigest = receipt.cleanupObservationRecordDigest;
          return receipt;
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
      closeIncomplete(...args) {
        return serial(async () => {
          requireThat(args.length === 0, SESSION);
          return closeWork(true);
        });
      },
      close() {
        return serial(() => closeWork(false));
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
