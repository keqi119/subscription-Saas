// Hosted-only fixed workspace creation. This function is not a manual grant:
// its four originals must come from the already verified, root-only one-shot
// control connection after H1 has durably consumed target-create. A signature
// by itself never proves that consumption. Engine/PG and cleanup are separate.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import { createPublicKey, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  encodeManualJson,
  validateManualTargetCreationRequest,
  verifyManualTargetCreationAuthorizationBinding
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { observeR3EncryptedWorkspace } from "./r3-encrypted-workspace-observer.mjs";
import { r3FailureTracker } from "./r3-failure-diagnostic.mjs";

const CODE = "R3_HOSTED_WORKSPACE_CREATE_INVALID";
const CLEANUP_CODE = "R3_HOSTED_WORKSPACE_CLEANUP_INVALID";
const LIMIT = 1048576;
const ownedWorkspaces = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C" };
const profilePath = fileURLToPath(
  new URL("../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
);
const policyPath = fileURLToPath(
  new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
);
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (condition) => {
  if (!condition) fail();
};
function exact(value, keys) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      })
  );
}
function parse(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
  const copy = Buffer.from(bytes);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy));
  requireThat(encodeManualJson(value).equals(copy));
  return { value, bytes: copy };
}
function instant(value) {
  requireThat(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value
  );
  return Date.parse(value);
}
function ref(bytes) {
  return { digest: sha256Bytes(bytes), bytes: bytes.length };
}
function identity(stat) {
  return Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs", "rdev"].map(
      (key) => [key, String(stat[key])]
    )
  );
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function frozenCreation(creation) {
  return freeze({
    operationRef: creation.operationRef,
    promotionEligible: false,
    startedAt: creation.startedAt,
    finishedAt: new Date().toISOString(),
    status: creation.status,
    ownedPaths: [...creation.ownedPaths],
    processes: creation.processes.map((item) => ({
      ...item,
      args: [...item.args],
      executable: { ...item.executable },
      stdout: item.stdout && { ...item.stdout },
      stderr: item.stderr && { ...item.stderr }
    }))
  });
}
function stableIdentity(stat) {
  return Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid", "rdev"].map((key) => [key, String(stat[key])])
  );
}
function frozenCleanup(cleanup) {
  return freeze({
    operationRef: cleanup.operationRef,
    promotionEligible: false,
    startedAt: cleanup.startedAt,
    finishedAt: new Date().toISOString(),
    status: cleanup.status,
    ownedPaths: [...cleanup.ownedPaths],
    processes: cleanup.processes.map((item) => ({
      ...item,
      args: [...item.args],
      executable: { ...item.executable },
      stdout: item.stdout && { ...item.stdout },
      stderr: item.stderr && { ...item.stderr }
    }))
  });
}
function validSpec(spec, job, profile, policy, specBytes, jobBytes, policyBytes, machine) {
  exact(spec, [
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
    spec.schemaVersion === "manual-r3-creation-spec.v1" &&
      UUID.test(spec.operationRef) &&
      spec.profileDigest === sha256Canonical(profile) &&
      policy.profileDigest === spec.profileDigest &&
      spec.ownerId === profile.ownerId &&
      /^[0-9a-f]{40}$/u.test(spec.sourceSha) &&
      ["buildProofDigest", "proofRawDigest", "materialRawDigest", "targetPolicyDigest"].every(
        (key) => typeof spec[key] === "string" && DIGEST.test(spec[key])
      ) &&
      spec.targetPolicyDigest === sha256Bytes(policyBytes) &&
      ["source", "final"].includes(spec.phase) &&
      ["fresh", "snapshot"].includes(spec.chain) &&
      spec.cleanup === "stop-owned-engine-and-remove-workspace"
  );
  const id = spec.operationRef.replaceAll("-", "");
  exact(spec.workspace, [
    "id",
    "capacityBytes",
    "backingFile",
    "mountPath",
    "keyFile",
    "mapperName"
  ]);
  const workspace = spec.workspace;
  requireThat(
    workspace.id === id &&
      Number.isSafeInteger(workspace.capacityBytes) &&
      workspace.capacityBytes >= 64 * 1048576 &&
      workspace.capacityBytes % 1048576 === 0 &&
      workspace.backingFile === `${policy.workspace.backingRoot}/${id}.luks` &&
      workspace.mountPath === `${policy.workspace.mountRoot}/${id}` &&
      workspace.keyFile === `${policy.workspace.keyRoot}/${id}.key` &&
      workspace.mapperName === `${policy.workspace.mapperPrefix}${id}`
  );
  exact(job, [
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
    job.schemaVersion === "manual-r3-job-admission.v1" &&
      job.creationSpecDigest === sha256Bytes(specBytes) &&
      [
        "operationRef",
        "profileDigest",
        "ownerId",
        "buildProofDigest",
        "sourceSha",
        "phase",
        "chain"
      ].every((key) => job[key] === spec[key])
  );
  exact(job.ci, [
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
  const ci = job.ci;
  const source = spec.phase === "source";
  const hosted = policy.hosted;
  requireThat(
    ci.repository === hosted.repository &&
      ci.repositoryId === hosted.repositoryId &&
      ci.runAttempt === hosted.runAttempt &&
      ci.runnerClass === hosted.runnerClass &&
      ["runId", "jobId"].every(
        (key) =>
          typeof ci[key] === "string" &&
          /^[1-9][0-9]*$/u.test(ci[key]) &&
          Number.isSafeInteger(Number(ci[key]))
      ) &&
      ci.workflowPath === (source ? hosted.source.workflowPath : hosted.final.workflowPath) &&
      ci.callerWorkflowPath ===
        (source ? hosted.source.workflowPath : hosted.final.callerWorkflowPath) &&
      ci.jobKey === (source ? hosted.source.jobs[spec.chain] : hosted.final.jobId) &&
      ci.jobName ===
        (source
          ? hosted.source.jobs[spec.chain]
          : `${hosted.final.callerJobs[spec.chain]} / ${hosted.final.jobId}`) &&
      ci.environment === (source ? hosted.source.environment : hosted.final.environment)
  );
  exact(job.host, [
    "machineIdFingerprint",
    "forwardingPublicKeyPem",
    "forwardingKeyFingerprint",
    "runnerId",
    "runnerName"
  ]);
  const host = job.host;
  requireThat(
    host.machineIdFingerprint ===
      sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`)) &&
      Number.isSafeInteger(host.runnerId) &&
      host.runnerId >= 0 &&
      typeof host.runnerName === "string" &&
      host.runnerName.length > 0 &&
      host.runnerName.length <= 256 &&
      typeof host.forwardingPublicKeyPem === "string" &&
      DIGEST.test(host.forwardingKeyFingerprint)
  );
  const key = createPublicKey(host.forwardingPublicKeyPem);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      key.export({ type: "spki", format: "pem" }) === host.forwardingPublicKeyPem &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === host.forwardingKeyFingerprint
  );
  const now = Date.now();
  requireThat(
    instant(profile.validFrom) <= instant(spec.createdAt) &&
      instant(spec.createdAt) <= instant(job.generatedAt) &&
      instant(job.generatedAt) <= now &&
      now < instant(job.expiresAt) &&
      instant(job.expiresAt) <= instant(spec.expiresAt) &&
      instant(spec.expiresAt) <= instant(profile.expiresAt)
  );
  requireThat(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.GITHUB_REPOSITORY === ci.repository &&
      process.env.GITHUB_REPOSITORY_ID === ci.repositoryId &&
      process.env.GITHUB_SHA === spec.sourceSha &&
      process.env.GITHUB_REF === hosted.workflowRef &&
      process.env.GITHUB_WORKFLOW_REF ===
        `${ci.repository}/${ci.callerWorkflowPath}@${hosted.workflowRef}` &&
      process.env.GITHUB_RUN_ID === ci.runId &&
      process.env.GITHUB_RUN_ATTEMPT === String(ci.runAttempt) &&
      process.env.GITHUB_JOB === ci.jobKey &&
      process.env.RUNNER_NAME === host.runnerName &&
      process.env.RUNNER_OS === "Linux"
  );
  return { workspace, jobDigest: sha256Bytes(jobBytes) };
}
function validRequest(request, spec, jobDigest) {
  requireThat(
    request.operationId === spec.operationRef &&
      request.profileDigest === spec.profileDigest &&
      request.ownerId === spec.ownerId &&
      request.sourceSha === spec.sourceSha &&
      request.candidate.buildProofDigest === spec.buildProofDigest &&
      request.targetPolicyDigest === spec.targetPolicyDigest &&
      request.creationSpecDigest === sha256Bytes(encodeManualJson(spec)) &&
      request.jobAdmissionDigest === jobDigest &&
      request.phase === spec.phase &&
      request.chain === spec.chain
  );
}
function noSwapAndCore(swapsBytes, limitsBytes) {
  requireThat(Buffer.isBuffer(swapsBytes) && swapsBytes.length <= LIMIT);
  requireThat(Buffer.isBuffer(limitsBytes) && limitsBytes.length <= LIMIT);
  const swaps = new TextDecoder("utf-8", { fatal: true }).decode(swapsBytes).trim().split(/\r?\n/u);
  requireThat(swaps.length === 1 && /^Filename\s+Type\s+Size\s+Used\s+Priority$/u.test(swaps[0]));
  const limits = new TextDecoder("utf-8", { fatal: true }).decode(limitsBytes).split(/\r?\n/u);
  const core = limits.filter((line) => /^Max core file size\s+/u.test(line));
  requireThat(core.length === 1 && /^Max core file size\s+0\s+0\s+bytes\s*$/u.test(core[0]));
}
function enough(stat, bytes) {
  const blockSize = BigInt(stat.bsize),
    available = BigInt(stat.bavail);
  requireThat(blockSize > 0n && available >= 0n && blockSize * available >= BigInt(bytes));
}

export async function createR3HostedWorkspace(input) {
  const diagnostic = r3FailureTracker("HOSTED_WORKSPACE");
  const creation = {
    operationRef: null,
    promotionEligible: false,
    startedAt: new Date().toISOString(),
    status: "INCOMPLETE",
    ownedPaths: [],
    processes: []
  };
  const rawInputs = {};
  const capture = (prefix, inputs) => {
    for (const [name, bytes] of Object.entries(inputs)) {
      requireThat(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
      rawInputs[`${prefix}.${name}`] = Buffer.from(bytes);
    }
  };
  const rawCopies = () =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(rawInputs).map(([name, bytes]) => [name, Buffer.from(bytes)])
      )
    );
  let absentObservation;
  try {
    exact(input, ["requestBytes", "authorizationBytes", "creationSpecBytes", "jobAdmissionBytes"]);
    const requestInput = parse(input.requestBytes),
      authorizationInput = parse(input.authorizationBytes),
      specInput = parse(input.creationSpecBytes),
      jobInput = parse(input.jobAdmissionBytes);
    const request = validateManualTargetCreationRequest(requestInput.value),
      authorization = authorizationInput.value,
      spec = specInput.value,
      job = jobInput.value;
    requireThat(process.platform === "linux" && process.getuid?.() === 0);
    const profile = JSON.parse(await fs.readFile(profilePath, { encoding: "utf8" }));
    const policyBytes = await fs.readFile(policyPath);
    requireThat(
      Buffer.isBuffer(policyBytes) && policyBytes.length > 0 && policyBytes.length <= LIMIT
    );
    const policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policyBytes));
    validateContract("manual-stage1-profile.v2", profile);
    validateContract("manual-stage1-r3-target-policy.v1", policy);
    const machine = new TextDecoder("utf-8", { fatal: true })
      .decode(await fs.readFile("/etc/machine-id"))
      .trim();
    requireThat(/^[0-9a-f]{32}$/u.test(machine));
    const { workspace, jobDigest } = validSpec(
      spec,
      job,
      profile,
      policy,
      specInput.bytes,
      jobInput.bytes,
      policyBytes,
      machine
    );
    validRequest(request, spec, jobDigest);
    verifyManualTargetCreationAuthorizationBinding({
      authorization,
      profile,
      requestBytes: requestInput.bytes,
      now: new Date().toISOString()
    });
    creation.operationRef = spec.operationRef;
    const recheck = async () => {
      const currentProfile = JSON.parse(await fs.readFile(profilePath, { encoding: "utf8" }));
      const currentPolicy = await fs.readFile(policyPath);
      const currentMachine = new TextDecoder("utf-8", { fatal: true })
        .decode(await fs.readFile("/etc/machine-id"))
        .trim();
      requireThat(
        sha256Canonical(currentProfile) === spec.profileDigest &&
          Buffer.isBuffer(currentPolicy) &&
          currentPolicy.equals(policyBytes) &&
          currentMachine === machine
      );
      validSpec(
        spec,
        job,
        currentProfile,
        policy,
        specInput.bytes,
        jobInput.bytes,
        currentPolicy,
        currentMachine
      );
      verifyManualTargetCreationAuthorizationBinding({
        authorization,
        profile: currentProfile,
        requestBytes: requestInput.bytes,
        now: new Date().toISOString()
      });
      noSwapAndCore(await fs.readFile("/proc/swaps"), await fs.readFile("/proc/self/limits"));
    };
    diagnostic.enter("PREFLIGHT");
    await recheck();
    diagnostic.enter("ABSENT");
    const absent = await observeR3EncryptedWorkspace({
      operationRef: spec.operationRef,
      capacityBytes: workspace.capacityBytes,
      state: "absent"
    });
    capture("absent", absent.rawInputs);
    absentObservation = absent.observation;
    requireThat(
      absent.observation.status === "OBSERVED" &&
        absent.observation.facts.state === "absent" &&
        absent.observation.hostFingerprint === job.host.machineIdFingerprint &&
        absent.observation.policyDigest === spec.targetPolicyDigest &&
        sha256Canonical(absent.observation.workspace) === sha256Canonical(workspace)
    );
    diagnostic.enter("PREFLIGHT");
    enough(
      await fs.statfs(policy.workspace.backingRoot, { bigint: true }),
      workspace.capacityBytes
    );
    enough(await fs.statfs(policy.workspace.keyRoot, { bigint: true }), 64);
    const run = async (name, command, args) => {
      diagnostic.enter("PREFLIGHT");
      await recheck();
      const before = await fs.stat(command, { bigint: true });
      requireThat(
        before.isFile() &&
          before.uid === 0n &&
          (before.mode & 0o022n) === 0n &&
          (before.mode & 0o111n) !== 0n
      );
      const call = {
        name,
        command,
        args: Object.freeze([...args]),
        executable: identity(before),
        startedAt: new Date().toISOString(),
        pid: null,
        closedAt: null,
        exitCode: null,
        signal: null,
        stdout: null,
        stderr: null
      };
      creation.processes.push(call);
      diagnostic.enter(
        {
          preallocate: "PREALLOCATE",
          luksFormat: "LUKS_FORMAT",
          luksOpen: "LUKS_OPEN",
          mkfs: "MKFS",
          mount: "MOUNT"
        }[name]
      );
      const result = await new Promise((resolve) => {
        let child,
          timer,
          size = 0,
          overflow = false,
          spawnError = false;
        const stdout = [],
          stderr = [];
        try {
          child = childProcess.spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: ENV
          });
          call.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
          const collect = (target) => (chunk) => {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > LIMIT) {
              overflow = true;
              child.kill("SIGKILL");
            } else target.push(bytes);
          };
          child.stdout.on("data", collect(stdout));
          child.stderr.on("data", collect(stderr));
          child.once("error", () => {
            spawnError = true;
          });
          child.once("close", (exitCode, signal) => {
            clearTimeout(timer);
            Object.assign(call, { closedAt: new Date().toISOString(), exitCode, signal });
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              overflow,
              spawnError
            });
          });
          timer = setTimeout(() => child.kill("SIGKILL"), 120000);
        } catch {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            overflow,
            spawnError: true
          });
        }
      });
      call.stdout = ref(result.stdout);
      call.stderr = ref(result.stderr);
      rawInputs[`creation.${name}.stdout`] = Buffer.from(result.stdout);
      rawInputs[`creation.${name}.stderr`] = Buffer.from(result.stderr);
      requireThat(
        !result.overflow &&
          !result.spawnError &&
          call.pid !== null &&
          call.closedAt !== null &&
          call.exitCode === 0 &&
          call.signal === null &&
          result.stderr.length === 0 &&
          JSON.stringify(identity(await fs.stat(command, { bigint: true }))) ===
            JSON.stringify(call.executable)
      );
    };
    // O_EXCL plus O_NOFOLLOW prevents an existing leaf or symlink from being reused.
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC;
    await recheck();
    diagnostic.enter("ALLOCATE");
    const keyBytes = randomBytes(64);
    try {
      const key = await fs.open(workspace.keyFile, flags, 0o600);
      creation.ownedPaths.push(workspace.keyFile);
      try {
        await key.writeFile(keyBytes);
      } finally {
        await key.close();
      }
    } finally {
      keyBytes.fill(0);
    }
    const backing = await fs.open(workspace.backingFile, flags, 0o600);
    creation.ownedPaths.push(workspace.backingFile);
    await backing.close();
    await run("preallocate", "/usr/bin/fallocate", [
      "--length",
      String(workspace.capacityBytes),
      workspace.backingFile
    ]);
    await run("luksFormat", "/usr/sbin/cryptsetup", [
      "luksFormat",
      "--type",
      "luks2",
      "--cipher",
      "aes-xts-plain64",
      "--key-size",
      "512",
      "--batch-mode",
      "--key-file",
      workspace.keyFile,
      workspace.backingFile
    ]);
    await run("luksOpen", "/usr/sbin/cryptsetup", [
      "open",
      "--type",
      "luks2",
      "--key-file",
      workspace.keyFile,
      workspace.backingFile,
      workspace.mapperName
    ]);
    creation.ownedPaths.push(`/dev/mapper/${workspace.mapperName}`);
    await run("mkfs", "/usr/sbin/mkfs.ext4", ["-F", "-q", `/dev/mapper/${workspace.mapperName}`]);
    diagnostic.enter("MOUNT");
    await fs.mkdir(workspace.mountPath, { mode: 0o700 });
    creation.ownedPaths.push(workspace.mountPath);
    const unmountedLeaf = await fs.lstat(workspace.mountPath, { bigint: true });
    requireThat(unmountedLeaf.isDirectory() && !unmountedLeaf.isSymbolicLink());
    await run("mount", "/usr/bin/mount", [
      "-t",
      "ext4",
      "-o",
      "rw,nodev,nosuid",
      `/dev/mapper/${workspace.mapperName}`,
      workspace.mountPath
    ]);
    // mkfs.ext4 normally leaves the filesystem root at 0755; the mounted
    // root itself must be private, not merely the hidden mountpoint beneath.
    await fs.chown(workspace.mountPath, 0, 0);
    await fs.chmod(workspace.mountPath, 0o700);
    const mountedRoot = await fs.lstat(workspace.mountPath, { bigint: true });
    requireThat(
      mountedRoot.isDirectory() &&
        !mountedRoot.isSymbolicLink() &&
        mountedRoot.uid === 0n &&
        mountedRoot.gid === 0n &&
        (mountedRoot.mode & 0o777n) === 0o700n
    );
    diagnostic.enter("ACTIVE");
    const observation = await observeR3EncryptedWorkspace({
      operationRef: spec.operationRef,
      capacityBytes: workspace.capacityBytes,
      state: "active"
    });
    capture("active", observation.rawInputs);
    await recheck();
    requireThat(
      observation.observation.status === "OBSERVED" &&
        observation.observation.facts.state === "active" &&
        observation.observation.hostFingerprint === job.host.machineIdFingerprint &&
        observation.observation.policyDigest === spec.targetPolicyDigest &&
        sha256Canonical(observation.observation.workspace) === sha256Canonical(workspace)
    );
    creation.status = "WORKSPACE_OBSERVED";
    const ownedKey = await fs.lstat(workspace.keyFile, { bigint: true });
    const ownedBacking = await fs.lstat(workspace.backingFile, { bigint: true });
    requireThat(
      ownedKey.isFile() &&
        !ownedKey.isSymbolicLink() &&
        ownedKey.nlink === 1n &&
        ownedKey.size === 64n &&
        ownedBacking.isFile() &&
        !ownedBacking.isSymbolicLink() &&
        ownedBacking.nlink === 1n &&
        ownedBacking.size === BigInt(workspace.capacityBytes)
    );
    const result = Object.freeze({
      observation,
      rawInputs: rawCopies(),
      creation: frozenCreation(creation)
    });
    ownedWorkspaces.set(result, {
      attempted: false,
      spec,
      job,
      workspace,
      profileDigest: spec.profileDigest,
      policyBytes: Buffer.from(policyBytes),
      machine,
      factsDigest: sha256Canonical(observation.observation.facts),
      keyIdentity: stableIdentity(ownedKey),
      backingIdentity: stableIdentity(ownedBacking),
      mountedIdentity: stableIdentity(mountedRoot),
      leafIdentity: stableIdentity(unmountedLeaf),
      ownedPaths: [...creation.ownedPaths]
    });
    diagnostic.complete();
    return result;
  } catch (cause) {
    // Never undo partial resources here. The H1 UNKNOWN slot remains held and
    // a later, separately authorized cleanup must inspect the actual graph.
    const error = Object.assign(new Error(CODE), {
      code: CODE,
      creation: frozenCreation(creation),
      rawInputs: rawCopies()
    });
    if (absentObservation) error.absentObservation = absentObservation;
    if (cause?.evidence) {
      error.observationEvidence = cause.evidence.observation;
      capture("failedObservation", cause.evidence.rawInputs);
      error.rawInputs = rawCopies();
    }
    throw diagnostic.decorate(error, error);
  }
}

// This handle is process-local ownership of a completed create, not a grant.
// The caller must first independently stop the owned Engine and its child.
export async function cleanupR3HostedWorkspace(input) {
  const invalid = () => {
    throw Object.assign(new Error(CLEANUP_CODE), { code: CLEANUP_CODE });
  };
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 1 ||
    !Object.hasOwn(input, "ownedWorkspace") ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(input, "ownedWorkspace"), "value")
  )
    invalid();
  const ownedWorkspace = Object.getOwnPropertyDescriptor(input, "ownedWorkspace").value;
  if (ownedWorkspace === null || typeof ownedWorkspace !== "object") invalid();
  const held = ownedWorkspaces.get(ownedWorkspace);
  if (!held || held.attempted) invalid();
  held.attempted = true;
  const { spec, job, workspace } = held;
  const cleanup = {
    operationRef: spec.operationRef,
    promotionEligible: false,
    startedAt: new Date().toISOString(),
    status: "INCOMPLETE",
    ownedPaths: [...held.ownedPaths],
    processes: []
  };
  const rawInputs = {};
  const capture = (prefix, inputs) => {
    for (const [name, bytes] of Object.entries(inputs)) {
      if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) invalid();
      rawInputs[`${prefix}.${name}`] = Buffer.from(bytes);
    }
  };
  const rawCopies = () =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(rawInputs).map(([name, bytes]) => [name, Buffer.from(bytes)])
      )
    );
  let observation;
  try {
    const recheck = async () => {
      if (process.platform !== "linux" || process.getuid?.() !== 0) invalid();
      const profile = JSON.parse(await fs.readFile(profilePath, { encoding: "utf8" }));
      const policyBytes = await fs.readFile(policyPath);
      const machine = new TextDecoder("utf-8", { fatal: true })
        .decode(await fs.readFile("/etc/machine-id"))
        .trim();
      validateContract("manual-stage1-profile.v2", profile);
      validateContract(
        "manual-stage1-r3-target-policy.v1",
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policyBytes))
      );
      if (
        sha256Canonical(profile) !== held.profileDigest ||
        !Buffer.isBuffer(policyBytes) ||
        !policyBytes.equals(held.policyBytes) ||
        machine !== held.machine ||
        spec.cleanup !== "stop-owned-engine-and-remove-workspace" ||
        Date.now() < instant(spec.createdAt) ||
        Date.now() >= instant(spec.expiresAt) ||
        Date.now() >= instant(profile.expiresAt) ||
        process.env.GITHUB_ACTIONS !== "true" ||
        process.env.GITHUB_REPOSITORY !== job.ci.repository ||
        process.env.GITHUB_REPOSITORY_ID !== job.ci.repositoryId ||
        process.env.GITHUB_SHA !== spec.sourceSha ||
        process.env.GITHUB_REF !== JSON.parse(policyBytes).hosted.workflowRef ||
        process.env.GITHUB_WORKFLOW_REF !==
          `${job.ci.repository}/${job.ci.callerWorkflowPath}@${JSON.parse(policyBytes).hosted.workflowRef}` ||
        process.env.GITHUB_RUN_ID !== job.ci.runId ||
        process.env.GITHUB_RUN_ATTEMPT !== String(job.ci.runAttempt) ||
        process.env.GITHUB_JOB !== job.ci.jobKey ||
        process.env.RUNNER_NAME !== job.host.runnerName ||
        process.env.RUNNER_OS !== "Linux"
      )
        invalid();
      noSwapAndCore(await fs.readFile("/proc/swaps"), await fs.readFile("/proc/self/limits"));
    };
    const same = async (path, expected, kind, expectedSize) => {
      const stat = await fs.lstat(path, { bigint: true });
      if (
        JSON.stringify(stableIdentity(stat)) !== JSON.stringify(expected) ||
        !(kind === "file" ? stat.isFile() : stat.isDirectory()) ||
        stat.isSymbolicLink() ||
        (kind === "file" && stat.nlink !== 1n) ||
        (expectedSize !== undefined && stat.size !== BigInt(expectedSize))
      )
        invalid();
    };
    await recheck();
    await same(workspace.keyFile, held.keyIdentity, "file", 64);
    await same(workspace.backingFile, held.backingIdentity, "file", workspace.capacityBytes);
    await same(workspace.mountPath, held.mountedIdentity, "directory");
    const before = await observeR3EncryptedWorkspace({
      operationRef: spec.operationRef,
      capacityBytes: workspace.capacityBytes,
      state: "active"
    });
    capture("before", before.rawInputs);
    observation = before;
    if (
      before.observation.status !== "OBSERVED" ||
      before.observation.hostFingerprint !== job.host.machineIdFingerprint ||
      before.observation.policyDigest !== spec.targetPolicyDigest ||
      sha256Canonical(before.observation.workspace) !== sha256Canonical(workspace) ||
      sha256Canonical(before.observation.facts) !== held.factsDigest
    )
      invalid();
    await same(workspace.keyFile, held.keyIdentity, "file", 64);
    await same(workspace.backingFile, held.backingIdentity, "file", workspace.capacityBytes);
    await same(workspace.mountPath, held.mountedIdentity, "directory");
    const run = async (name, command, args) => {
      await recheck();
      const beforeStat = await fs.stat(command, { bigint: true });
      if (
        !beforeStat.isFile() ||
        beforeStat.uid !== 0n ||
        (beforeStat.mode & 0o022n) !== 0n ||
        (beforeStat.mode & 0o111n) === 0n
      )
        invalid();
      const call = {
        name,
        command,
        args: Object.freeze([...args]),
        executable: identity(beforeStat),
        startedAt: new Date().toISOString(),
        pid: null,
        closedAt: null,
        exitCode: null,
        signal: null,
        stdout: null,
        stderr: null
      };
      cleanup.processes.push(call);
      const result = await new Promise((resolve) => {
        let child,
          timer,
          drainTimer,
          size = 0,
          overflow = false,
          spawnError = false,
          timedOut = false,
          settled = false;
        const stdout = [],
          stderr = [];
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(drainTimer);
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            overflow,
            spawnError,
            timedOut
          });
        };
        const killAndDrain = () => {
          if (timedOut || settled) return;
          timedOut = true;
          try {
            child?.kill("SIGKILL");
          } catch {
            // The close event, rather than a kill request, proves termination.
          }
          if (!settled) drainTimer = setTimeout(settle, 2000);
        };
        try {
          child = childProcess.spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: ENV
          });
          call.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
          const collect = (target) => (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > LIMIT) {
              overflow = true;
              killAndDrain();
            } else target.push(bytes);
          };
          child.stdout.on("data", collect(stdout));
          child.stderr.on("data", collect(stderr));
          child.once("error", () => {
            spawnError = true;
            killAndDrain();
          });
          child.once("close", (exitCode, signal) => {
            if (settled) return;
            Object.assign(call, { closedAt: new Date().toISOString(), exitCode, signal });
            settle();
          });
          timer = setTimeout(killAndDrain, 120000);
        } catch {
          spawnError = true;
          if (child) killAndDrain();
          else settle();
        }
      });
      call.stdout = ref(result.stdout);
      call.stderr = ref(result.stderr);
      rawInputs[`cleanup.${name}.stdout`] = Buffer.from(result.stdout);
      rawInputs[`cleanup.${name}.stderr`] = Buffer.from(result.stderr);
      if (
        result.overflow ||
        result.spawnError ||
        result.timedOut ||
        call.pid === null ||
        call.closedAt === null ||
        call.exitCode !== 0 ||
        call.signal !== null ||
        result.stderr.length !== 0 ||
        JSON.stringify(identity(await fs.stat(command, { bigint: true }))) !==
          JSON.stringify(call.executable)
      )
        invalid();
    };
    await run("unmount", "/usr/bin/umount", [workspace.mountPath]);
    await run("luksClose", "/usr/sbin/cryptsetup", ["close", workspace.mapperName]);
    await recheck();
    await same(workspace.keyFile, held.keyIdentity, "file", 64);
    await fs.unlink(workspace.keyFile);
    await same(workspace.backingFile, held.backingIdentity, "file", workspace.capacityBytes);
    await fs.unlink(workspace.backingFile);
    await same(workspace.mountPath, held.leafIdentity, "directory");
    await fs.rmdir(workspace.mountPath);
    observation = await observeR3EncryptedWorkspace({
      operationRef: spec.operationRef,
      capacityBytes: workspace.capacityBytes,
      state: "absent"
    });
    capture("after", observation.rawInputs);
    if (
      observation.observation.status !== "OBSERVED" ||
      observation.observation.facts.state !== "absent" ||
      observation.observation.hostFingerprint !== job.host.machineIdFingerprint ||
      observation.observation.policyDigest !== spec.targetPolicyDigest ||
      sha256Canonical(observation.observation.workspace) !== sha256Canonical(workspace)
    )
      invalid();
    cleanup.status = "WORKSPACE_REMOVED";
    return Object.freeze({ cleanup: frozenCleanup(cleanup), observation, rawInputs: rawCopies() });
  } catch (cause) {
    if (cause?.evidence) {
      observation = cause.evidence;
      capture("failedObservation", cause.evidence.rawInputs);
    }
    throw Object.assign(new Error(CLEANUP_CODE), {
      code: CLEANUP_CODE,
      cleanup: frozenCleanup(cleanup),
      observation,
      rawInputs: rawCopies()
    });
  }
}
