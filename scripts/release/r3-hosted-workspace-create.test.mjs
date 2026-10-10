import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  encodeManualJson,
  signManualAuthorization
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";

const op = "10000000-0000-4000-8000-000000000001";
const id = op.replaceAll("-", "");
const capacityBytes = 64 * 1048576;
const workspace = {
  id,
  capacityBytes,
  backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
  mountPath: `/srv/stage1-snapshot/${id}`,
  keyFile: `/dev/shm/stage1-keys/${id}.key`,
  mapperName: `s1snap_${id}`
};
const machineId = "b".repeat(32);
const uuid = "2896e6bd-60c0-44f1-b3a0-14a2e1bc0d39";
const policyPath = new URL(
  "../../release/contracts/manual-stage1-r3-target-policy.v1.json",
  import.meta.url
);
const profilePath = new URL(
  "../../release/contracts/manual-stage1-profile.v2.json",
  import.meta.url
);
const originalRead = fs.readFile.bind(fs);
const originalSpawn = childProcess.spawn.bind(childProcess);

const header = {
  keyslots: {
    0: {
      type: "luks2",
      key_size: 64,
      area: { type: "raw", encryption: "aes-xts-plain64", key_size: 64 }
    }
  },
  tokens: {},
  segments: {
    0: {
      type: "crypt",
      offset: "16777216",
      size: "dynamic",
      iv_tweak: "0",
      encryption: "aes-xts-plain64",
      sector_size: 4096
    }
  },
  digests: { 0: { type: "pbkdf2", segments: ["0"], keyslots: ["0"] } },
  config: {}
};

function fakeStat(kind = "directory", size = 0, mode) {
  const directory = kind === "directory";
  return {
    dev: 1n,
    ino: 42n,
    mode: mode ?? (directory ? 0o40700n : 0o100600n),
    uid: 0n,
    gid: 0n,
    nlink: 1n,
    size: BigInt(size),
    mtimeNs: 1n,
    ctimeNs: 1n,
    rdev: 0n,
    isDirectory: () => directory,
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    isBlockDevice: () => kind === "block"
  };
}

async function fixture(t, fault = null, { phase = "source", chain = "fresh" } = {}) {
  let policyBytes = await originalRead(policyPath);
  const policy = JSON.parse(policyBytes);
  const profile = JSON.parse(await originalRead(profilePath));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  profile.publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  profile.keyFingerprint = sha256Bytes(publicKey.export({ type: "spki", format: "der" }));
  const now = Date.now();
  profile.validFrom = new Date(now - 3600000).toISOString();
  profile.expiresAt = new Date(now + 3600000).toISOString();
  policy.profileDigest =
    fault === "policy-profile" ? `sha256:${"0".repeat(64)}` : sha256Canonical(profile);
  policyBytes = encodeManualJson(policy);
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef: op,
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    sourceSha: "a".repeat(40),
    buildProofDigest: `sha256:${"1".repeat(64)}`,
    proofRawDigest: `sha256:${"2".repeat(64)}`,
    materialRawDigest: `sha256:${"3".repeat(64)}`,
    targetPolicyDigest: sha256Bytes(policyBytes),
    phase,
    chain,
    createdAt: new Date(now - 120000).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
    workspace,
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const specBytes = encodeManualJson(spec);
  const job = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef: op,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    creationSpecDigest: sha256Bytes(specBytes),
    buildProofDigest: spec.buildProofDigest,
    sourceSha: spec.sourceSha,
    phase: spec.phase,
    chain: spec.chain,
    generatedAt: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    ci: {
      repository: policy.hosted.repository,
      repositoryId: policy.hosted.repositoryId,
      runId: "123456",
      runAttempt: 1,
      workflowPath:
        phase === "source" ? policy.hosted.source.workflowPath : policy.hosted.final.workflowPath,
      callerWorkflowPath:
        phase === "source"
          ? policy.hosted.source.workflowPath
          : policy.hosted.final.callerWorkflowPath,
      jobKey: phase === "source" ? policy.hosted.source.jobs[chain] : policy.hosted.final.jobId,
      jobId: "98765",
      jobName:
        phase === "source"
          ? policy.hosted.source.jobs[chain]
          : `${policy.hosted.final.callerJobs[chain]} / ${policy.hosted.final.jobId}`,
      environment:
        phase === "source" ? policy.hosted.source.environment : policy.hosted.final.environment,
      runnerClass: policy.hosted.runnerClass
    },
    host: {
      machineIdFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)
      ),
      forwardingPublicKeyPem: profile.publicKeyPem,
      forwardingKeyFingerprint: profile.keyFingerprint,
      runnerId: 42,
      runnerName: "hosted-runner"
    }
  };
  const jobBytes = encodeManualJson(job);
  const request = {
    schemaVersion: "manual-runner-request.v4",
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    sessionId: "20000000-0000-4000-8000-000000000001",
    sessionNonce: "f".repeat(64),
    operationId: op,
    idempotencyKey: "create-one",
    attemptId: "30000000-0000-4000-8000-000000000001",
    runId: "40000000-0000-4000-8000-000000000001",
    attemptAllocationDigest: `sha256:${"4".repeat(64)}`,
    stage: "target-create",
    capability: "create-isolated-target",
    purpose: "stage1-isolated-database-tests",
    phase: spec.phase,
    chain: spec.chain,
    sourceSha: spec.sourceSha,
    targetPolicyDigest: spec.targetPolicyDigest,
    creationSpecDigest: job.creationSpecDigest,
    jobAdmissionDigest: sha256Bytes(jobBytes),
    candidate: { buildProofDigest: spec.buildProofDigest }
  };
  const payload = {
    schemaVersion: "manual-launch-authorization.v4",
    authorizationId: "50000000-0000-4000-8000-000000000001",
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    requestDigest: sha256Canonical(request),
    ...Object.fromEntries(
      [
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
      ].map((field) => [field, request[field]])
    )
  };
  const authorization = signManualAuthorization({ payload, privateKey });
  const input = {
    requestBytes: encodeManualJson(request),
    authorizationBytes: encodeManualJson(authorization),
    creationSpecBytes: specBytes,
    jobAdmissionBytes: jobBytes
  };
  const envNames = [
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
    "RUNNER_NAME",
    "RUNNER_OS"
  ];
  const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: job.ci.repository,
    GITHUB_REPOSITORY_ID: job.ci.repositoryId,
    GITHUB_SHA: job.sourceSha,
    GITHUB_REF: policy.hosted.workflowRef,
    GITHUB_WORKFLOW_REF: `${job.ci.repository}/${job.ci.callerWorkflowPath}@${policy.hosted.workflowRef}`,
    GITHUB_RUN_ID: job.ci.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: job.ci.jobKey,
    RUNNER_NAME: job.host.runnerName,
    RUNNER_OS: "Linux"
  });
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const oldGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
  t.after(() => {
    Object.defineProperty(process, "platform", oldPlatform);
    if (oldGetuid) Object.defineProperty(process, "getuid", oldGetuid);
    else delete process.getuid;
    for (const name of envNames)
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
  });
  const created = new Set();
  const calls = [];
  const writes = [];
  const kills = [];
  let resolveHung;
  const hung = new Promise((resolve) => {
    resolveHung = resolve;
  });
  let mounted = false,
    securedMount = false,
    keyInode = 42n;
  const privateRoots = [
    "/var/lib/stage1-snapshots",
    "/srv/stage1-snapshot",
    "/dev/shm/stage1-keys"
  ];
  t.mock.method(fs, "readFile", async (file) => {
    const name = String(file);
    if (name.endsWith("manual-stage1-r3-target-policy.v1.json")) return Buffer.from(policyBytes);
    if (name.endsWith("manual-stage1-profile.v2.json")) return encodeManualJson(profile);
    if (name === "/etc/machine-id") return Buffer.from(machineId + "\n");
    if (name === "/proc/swaps") return Buffer.from("Filename\tType\tSize\tUsed\tPriority\n");
    if (name === "/proc/self/limits")
      return Buffer.from(
        "Limit Soft Limit Hard Limit Units\nMax core file size        0                    0                    bytes\n"
      );
    assert.fail(`unexpected read ${name}`);
  });
  t.mock.method(fs, "lstat", async (file) => {
    if (
      [
        workspace.backingFile,
        workspace.keyFile,
        workspace.mountPath,
        `/dev/mapper/${workspace.mapperName}`
      ].includes(file) &&
      !created.has(file)
    )
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (file === workspace.backingFile) return fakeStat("file", capacityBytes);
    if (file === workspace.keyFile) return { ...fakeStat("file", 64), ino: keyInode };
    if (file === `/dev/mapper/${workspace.mapperName}`) return fakeStat("symlink");
    if (file === workspace.mountPath)
      return fakeStat("directory", 0, mounted && !securedMount ? 0o40755n : 0o40700n);
    const privatePath = privateRoots.some((root) => file === root || file.startsWith(root + "/"));
    return fakeStat(
      "directory",
      0,
      file === "/dev/shm" ? 0o41777n : privatePath ? 0o40700n : 0o40755n
    );
  });
  t.mock.method(fs, "stat", async (file) =>
    file === "/dev/dm-2" ? fakeStat("block") : fakeStat("file", 1234, 0o100755n)
  );
  t.mock.method(fs, "realpath", async () => "/dev/dm-2");
  t.mock.method(fs, "statfs", async () => ({ bsize: 4096n, bavail: 1000000n }));
  t.mock.method(fs, "open", async (file, flags, mode) => {
    assert.ok([workspace.backingFile, workspace.keyFile].includes(file));
    assert.equal(mode, 0o600);
    assert.equal(created.has(file), false);
    created.add(file);
    writes.push({ file, flags, mode });
    return {
      writeFile: async (bytes) => {
        assert.equal(file, workspace.keyFile);
        assert.equal(bytes.length, 64);
        writes.push({ keyBytes: bytes.length });
      },
      close: async () => {}
    };
  });
  t.mock.method(fs, "mkdir", async (file, options) => {
    assert.equal(file, workspace.mountPath);
    assert.equal(options.mode, 0o700);
    created.add(file);
    writes.push({ directory: file });
  });
  t.mock.method(fs, "chown", async (file, uid, gid) => {
    assert.equal(file, workspace.mountPath);
    assert.deepEqual([uid, gid], [0, 0]);
    writes.push({ chown: file });
  });
  t.mock.method(fs, "chmod", async (file, mode) => {
    assert.equal(file, workspace.mountPath);
    assert.equal(mode, 0o700);
    securedMount = true;
    writes.push({ chmod: file });
  });
  t.mock.method(fs, "unlink", async (file) => {
    assert.ok([workspace.keyFile, workspace.backingFile].includes(file));
    assert.ok(created.delete(file));
    writes.push({ unlink: file });
  });
  t.mock.method(fs, "rmdir", async (file) => {
    assert.equal(file, workspace.mountPath);
    assert.equal(mounted, false);
    assert.ok(created.delete(file));
    writes.push({ rmdir: file });
  });
  const outputs = (tool, args) => {
    const active =
      created.has(`/dev/mapper/${workspace.mapperName}`) &&
      created.has(workspace.mountPath) &&
      mounted;
    if (tool === "findmnt")
      return (
        JSON.stringify({
          filesystems: [
            {
              target: "/",
              source: "/dev/sda1",
              fstype: "ext4",
              options: "rw,relatime",
              "maj:min": "8:1"
            },
            {
              target: "/dev/shm",
              source: "tmpfs",
              fstype: "tmpfs",
              options: "rw,nosuid,nodev",
              "maj:min": "0:42"
            },
            ...(active
              ? [
                  {
                    target: workspace.mountPath,
                    source: `/dev/mapper/${workspace.mapperName}`,
                    fstype: "ext4",
                    options: "rw,nosuid,nodev",
                    "maj:min": "253:2"
                  }
                ]
              : [])
          ]
        }) + "\n"
      );
    if (tool === "losetup")
      return (
        JSON.stringify({
          loopdevices: active
            ? [{ name: "/dev/loop4", "back-file": workspace.backingFile, offset: 0, sizelimit: 0 }]
            : []
        }) + "\n"
      );
    if (tool === "lsblk")
      return (
        JSON.stringify({
          blockdevices: [
            {
              name: "/dev/sda1",
              kname: "/dev/sda1",
              type: "part",
              "maj:min": "8:1",
              pkname: "/dev/sda"
            },
            ...(active
              ? [
                  {
                    name: "/dev/loop4",
                    kname: "/dev/loop4",
                    type: "loop",
                    "maj:min": "7:4",
                    pkname: null
                  },
                  {
                    name: `/dev/mapper/${workspace.mapperName}`,
                    kname: "/dev/dm-2",
                    type: "crypt",
                    "maj:min": "253:2",
                    pkname: "/dev/loop4"
                  }
                ]
              : [])
          ]
        }) + "\n"
      );
    if (tool === "dmsetup")
      return `${workspace.mapperName}|CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}|253|2\n`;
    if (tool === "cryptsetup" && args[0] === "luksDump") return JSON.stringify(header) + "\n";
    if (tool === "cryptsetup" && args[0] === "luksUUID") return uuid + "\n";
    return "";
  };
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    const tool = command.split("/").at(-1);
    calls.push({ tool, command, args, options });
    assert.equal(options.shell, false);
    assert.deepEqual(options.env, {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LC_ALL: "C",
      LANG: "C"
    });
    if (fault === "hang-unmount" && tool === "umount") {
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        kills.push(signal);
        return true;
      };
      resolveHung();
      return child;
    }
    const failure =
      (fault === "crypt-open" && tool === "cryptsetup" && args[0] === "open") ||
      (fault === "crypt-close" && tool === "cryptsetup" && args[0] === "close");
    const output = outputs(tool, args);
    const child = originalSpawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(output)});process.exitCode=${failure ? 1 : 0}`],
      options
    );
    if (!failure && tool === "cryptsetup" && args[0] === "open")
      created.add(`/dev/mapper/${workspace.mapperName}`);
    if (!failure && tool === "mount") mounted = true;
    if (!failure && tool === "umount") mounted = false;
    if (!failure && tool === "cryptsetup" && args[0] === "close")
      created.delete(`/dev/mapper/${workspace.mapperName}`);
    return child;
  });
  const { createR3HostedWorkspace, cleanupR3HostedWorkspace } =
    await import("./r3-hosted-workspace-create.mjs");
  return {
    run: (override = input) => createR3HostedWorkspace(override),
    cleanup: (ownedWorkspace) => cleanupR3HostedWorkspace({ ownedWorkspace }),
    cleanupInput: cleanupR3HostedWorkspace,
    input,
    calls,
    writes,
    kills,
    hung,
    created,
    workspace,
    replaceKeyInode: () => {
      keyInode = 43n;
    }
  };
}

test("R3 creator rejects malformed and mismatched originals before any effect", async (t) => {
  await t.test("request and job digest", async (sub) => {
    const f = await fixture(sub);
    await assert.rejects(f.run({ ...f.input, extra: true }), {
      code: "R3_HOSTED_WORKSPACE_CREATE_INVALID"
    });
    const request = JSON.parse(f.input.requestBytes);
    request.jobAdmissionDigest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(f.run({ ...f.input, requestBytes: encodeManualJson(request) }), {
      code: "R3_HOSTED_WORKSPACE_CREATE_INVALID"
    });
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  });
  await t.test("policy profile binding", async (sub) => {
    const f = await fixture(sub, "policy-profile");
    await assert.rejects(f.run(), { code: "R3_HOSTED_WORKSPACE_CREATE_INVALID" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  });
});

test("R3 creator follows fixed absent-key-backing-LUKS-mount-active sequence", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.observation.observation.status, "OBSERVED");
  assert.equal(result.observation.observation.facts.state, "active");
  assert.deepEqual(
    f.calls.map((call) => call.tool),
    [
      "findmnt",
      "losetup",
      "lsblk",
      "fallocate",
      "cryptsetup",
      "cryptsetup",
      "mkfs.ext4",
      "mount",
      "findmnt",
      "losetup",
      "lsblk",
      "dmsetup",
      "cryptsetup",
      "cryptsetup"
    ]
  );
  assert.ok(f.calls.every((call) => !call.args.includes("--dump-volume-key")));
  assert.equal(
    f.writes.some((write) => write.keyBytes === 64),
    true
  );
  assert.equal(
    f.writes.some((write) => write.chown === f.workspace.mountPath),
    true
  );
  assert.equal(
    f.writes.some((write) => write.chmod === f.workspace.mountPath),
    true
  );
  assert.equal(result.creation.processes.length, 5);
  assert.equal(Object.isFrozen(result.creation.processes[0].args), true);
  assert.equal(Object.isFrozen(result.creation.processes[0].stdout), true);
  assert.equal(
    result.creation.processes[0].stdout.digest,
    sha256Bytes(result.rawInputs["creation.preallocate.stdout"])
  );
  assert.ok(Buffer.isBuffer(result.rawInputs["absent.mounts.stdout"]));
  assert.ok(Buffer.isBuffer(result.rawInputs["active.header.stdout"]));
  assert.equal(result.creation.promotionEligible, false);
});

test("R3 creator retains partial resources and process failure without cleanup", async (t) => {
  const f = await fixture(t, "crypt-open");
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "R3_HOSTED_WORKSPACE_CREATE_INVALID");
    assert.deepEqual(error.failureDiagnostic, {
      schemaVersion: "r3-failure-diagnostic.v1",
      component: "HOSTED_WORKSPACE",
      stage: "LUKS_OPEN",
      completed: false,
      causeCode: "R3_HOSTED_WORKSPACE_CREATE_INVALID",
      cleanupCode: null,
      sshExitCode: null,
      sshSignal: null
    });
    assert.equal(error.creation.processes.at(-1).exitCode, 1);
    assert.ok(error.creation.ownedPaths.includes(f.workspace.keyFile));
    assert.ok(error.creation.ownedPaths.includes(f.workspace.backingFile));
    assert.equal(error.creation.promotionEligible, false);
    assert.equal(
      error.creation.processes.at(-1).stderr.digest,
      sha256Bytes(error.rawInputs["creation.luksOpen.stderr"])
    );
    assert.ok(Buffer.isBuffer(error.rawInputs["absent.blocks.stdout"]));
    assert.equal(Object.isFrozen(error.creation.processes.at(-1).args), true);
    return true;
  });
  assert.equal(
    f.calls.some((call) => ["umount", "rm", "rmdir"].includes(call.tool)),
    false
  );
  assert.equal(f.created.has(f.workspace.keyFile), true);
});

test("R3 final snapshot binds caller workflow env while signer remains reusable workflow", async (t) => {
  const f = await fixture(t, null, { phase: "final", chain: "snapshot" });
  const admission = JSON.parse(f.input.jobAdmissionBytes);
  assert.notEqual(admission.ci.workflowPath, admission.ci.callerWorkflowPath);
  assert.equal(process.env.GITHUB_JOB, "execute");
  const result = await f.run();
  assert.equal(result.observation.observation.facts.state, "active");
  assert.equal(result.creation.status, "WORKSPACE_OBSERVED");
});

test("R3 cleanup removes only a held successful workspace and confirms absent", async (t) => {
  const f = await fixture(t);
  const owned = await f.run();
  const before = f.calls.length;
  await assert.rejects(f.cleanup({ ...owned }), { code: "R3_HOSTED_WORKSPACE_CLEANUP_INVALID" });
  await assert.rejects(f.cleanupInput({ ownedWorkspace: owned, verified: true }), {
    code: "R3_HOSTED_WORKSPACE_CLEANUP_INVALID"
  });
  assert.equal(f.calls.length, before);
  const result = await f.cleanup(owned);
  assert.equal(result.cleanup.status, "WORKSPACE_REMOVED");
  assert.equal(result.cleanup.promotionEligible, false);
  assert.equal(result.observation.observation.facts.state, "absent");
  assert.deepEqual(
    f.calls
      .filter((call) => ["umount", "cryptsetup"].includes(call.tool))
      .slice(-2)
      .map((call) => [call.tool, call.args]),
    [
      ["umount", [f.workspace.mountPath]],
      ["cryptsetup", ["close", f.workspace.mapperName]]
    ]
  );
  assert.deepEqual(
    f.writes.filter((write) => write.unlink || write.rmdir),
    [
      { unlink: f.workspace.keyFile },
      { unlink: f.workspace.backingFile },
      { rmdir: f.workspace.mountPath }
    ]
  );
  await assert.rejects(f.cleanup(owned), { code: "R3_HOSTED_WORKSPACE_CLEANUP_INVALID" });
});

test("R3 cleanup rejects a replaced owned key before mutation", async (t) => {
  const f = await fixture(t);
  const owned = await f.run();
  f.replaceKeyInode();
  await assert.rejects(f.cleanup(owned), { code: "R3_HOSTED_WORKSPACE_CLEANUP_INVALID" });
  assert.equal(
    f.calls.some((call) => call.tool === "umount"),
    false
  );
  assert.equal(
    f.writes.some((write) => write.unlink || write.rmdir),
    false
  );
});

test("R3 cleanup retains partial process evidence and resources when close fails after unmount", async (t) => {
  const f = await fixture(t, "crypt-close");
  const owned = await f.run();
  await assert.rejects(f.cleanup(owned), (error) => {
    assert.equal(error.code, "R3_HOSTED_WORKSPACE_CLEANUP_INVALID");
    assert.equal(error.cleanup.status, "INCOMPLETE");
    assert.equal(error.cleanup.processes.at(-1).exitCode, 1);
    assert.equal(error.cleanup.promotionEligible, false);
    return true;
  });
  assert.equal(f.created.has(f.workspace.keyFile), true);
  assert.equal(f.created.has(f.workspace.backingFile), true);
  assert.equal(f.created.has(f.workspace.mountPath), true);
  assert.equal(f.created.has(`/dev/mapper/${f.workspace.mapperName}`), true);
  assert.equal(
    f.calls.some((call) => call.tool === "umount"),
    true
  );
  assert.equal(
    f.writes.some((write) => write.unlink || write.rmdir),
    false
  );
  await assert.rejects(f.cleanup(owned), { code: "R3_HOSTED_WORKSPACE_CLEANUP_INVALID" });
});

test("R3 cleanup bounds a child that never reports close after SIGKILL", async (t) => {
  const f = await fixture(t, "hang-unmount");
  const owned = await f.run();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.cleanup(owned);
  await f.hung;
  t.mock.timers.tick(120000);
  t.mock.timers.tick(2000);
  const error = await Promise.race([
    pending.then(
      () => null,
      (failure) => failure
    ),
    new Promise((resolve) => setImmediate(() => resolve(null)))
  ]);
  assert.equal(error?.code, "R3_HOSTED_WORKSPACE_CLEANUP_INVALID");
  assert.equal(error.cleanup.status, "INCOMPLETE");
  assert.equal(error.cleanup.processes.at(-1).pid, 12345);
  assert.equal(error.cleanup.processes.at(-1).closedAt, null);
  assert.equal(error.cleanup.processes.at(-1).exitCode, null);
  assert.deepEqual(f.kills, ["SIGKILL"]);
  assert.equal(
    f.writes.some((write) => write.unlink || write.rmdir),
    false
  );
  assert.equal(f.created.has(f.workspace.keyFile), true);
});
