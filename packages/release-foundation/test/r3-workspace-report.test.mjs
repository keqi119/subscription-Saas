import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../src/digest.mjs";
import { assessR3WorkspaceObservation } from "../src/r3-workspace-observation.mjs";
import {
  signR3WorkspaceBinding,
  verifyR3WorkspaceBinding,
  assessR3WorkspaceReport
} from "../src/r3-workspace-report.mjs";
import {
  buildR3HostedEvidence,
  verifyR3HostedEvidence,
  buildR3HostedCleanupEvidence,
  verifyR3HostedCleanupEvidence
} from "../src/r3-hosted-evidence.mjs";
import { r3CleanupFixture } from "./r3-cleanup-fixture.mjs";

const operationRef = "10000000-0000-4000-8000-000000000001";
const id = operationRef.replaceAll("-", "");
const capacityBytes = 128 * 1048576;
const workspace = {
  id,
  capacityBytes,
  backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
  mountPath: `/srv/stage1-snapshot/${id}`,
  keyFile: `/dev/shm/stage1-keys/${id}.key`,
  mapperName: `s1snap_${id}`
};
const start = "2026-09-28T00:00:01.000Z";
const finish = "2026-09-28T00:00:02.000Z";
const now = "2026-09-28T00:00:03.000Z";
const digest = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
const json = (value) => Buffer.from(JSON.stringify(value) + "\n");
const canonical = (value) => encodeManualJson(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const identity = (kind, size = 0) => ({
  dev: "1",
  ino: "42",
  mode: String(
    kind === "directory"
      ? 0o40700
      : kind === "mapper"
        ? 0o120777
        : kind === "executable"
          ? 0o100755
          : 0o100600
  ),
  uid: "0",
  gid: "0",
  nlink: "1",
  size: String(size),
  mtimeNs: "1",
  ctimeNs: "1",
  rdev: "0"
});
const commands = (state) => [
  [
    "mounts",
    "/usr/bin/findmnt",
    ["--json", "--list", "--kernel", "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"]
  ],
  [
    "loops",
    "/usr/sbin/losetup",
    ["--json", "--list", "--output", "NAME,BACK-FILE,OFFSET,SIZELIMIT"]
  ],
  [
    "blocks",
    "/usr/bin/lsblk",
    ["--json", "--list", "--paths", "--output", "NAME,KNAME,TYPE,MAJ:MIN,PKNAME"]
  ],
  ...(state === "active"
    ? [
        [
          "mapper",
          "/usr/sbin/dmsetup",
          [
            "info",
            "--columns",
            "--noheadings",
            "--separator",
            "|",
            "--options",
            "name,uuid,major,minor",
            workspace.mapperName
          ]
        ],
        [
          "header",
          "/usr/sbin/cryptsetup",
          ["luksDump", "--dump-json-metadata", workspace.backingFile]
        ],
        ["uuid", "/usr/sbin/cryptsetup", ["luksUUID", workspace.backingFile]]
      ]
    : [])
];

async function fixture(state = "active") {
  const policyBytes = await fs.readFile(
    new URL("../../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
  );
  const machineId = "b".repeat(32);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: "sha256:" + "1".repeat(64),
    ownerId: "owner",
    sourceSha: "a".repeat(40),
    buildProofDigest: "sha256:" + "2".repeat(64),
    proofRawDigest: "sha256:" + "3".repeat(64),
    materialRawDigest: "sha256:" + "4".repeat(64),
    targetPolicyDigest: sha256Bytes(policyBytes),
    phase: "source",
    chain: "fresh",
    createdAt: "2026-09-27T23:59:59.000Z",
    expiresAt: "2026-09-28T00:01:00.000Z",
    workspace,
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const creationSpecDigest = sha256Bytes(canonical(spec));
  const job = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    creationSpecDigest,
    buildProofDigest: spec.buildProofDigest,
    sourceSha: spec.sourceSha,
    phase: spec.phase,
    chain: spec.chain,
    generatedAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "2026-09-28T00:00:30.000Z",
    ci: {
      repository: "keqi119/subscription-Saas",
      repositoryId: "1253231368",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/release-candidate-gate.yml",
      callerWorkflowPath: ".github/workflows/release-candidate-gate.yml",
      jobKey: "source-fresh",
      jobId: "456",
      jobName: "source-fresh",
      environment: "trusted-source-database-gate",
      runnerClass: "github-hosted"
    },
    host: {
      machineIdFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)
      ),
      forwardingPublicKeyPem: pem,
      forwardingKeyFingerprint: sha256Bytes(publicKey.export({ type: "spki", format: "der" })),
      runnerId: 1,
      runnerName: "runner"
    }
  };
  const rawInputs = {
    policy: Buffer.from(policyBytes),
    machineId: Buffer.from(machineId + "\n"),
    "mounts.stdout": json({
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
        ...(state === "active"
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
    }),
    "loops.stdout": json({
      loopdevices:
        state === "active"
          ? [{ name: "/dev/loop4", "back-file": workspace.backingFile, offset: 0, sizelimit: 0 }]
          : []
    }),
    "blocks.stdout": json({
      blockdevices: [
        {
          name: "/dev/sda1",
          kname: "/dev/sda1",
          type: "part",
          "maj:min": "8:1",
          pkname: "/dev/sda"
        },
        ...(state === "active"
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
    })
  };
  if (state === "active") {
    const uuid = "2896e6bd-60c0-44f1-b3a0-14a2e1bc0d39";
    rawInputs["mapper.stdout"] = Buffer.from(
      `${workspace.mapperName}|CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}|253|2\n`
    );
    rawInputs["header.stdout"] = json({
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
      digests: { 0: { type: "pbkdf2", keyslots: ["0"], segments: ["0"] } },
      config: {}
    });
    rawInputs["uuid.stdout"] = Buffer.from(uuid + "\n");
    rawInputs.swaps = Buffer.from("Filename\tType\tSize\tUsed\tPriority\n");
    rawInputs.limits = Buffer.from(
      "Limit Soft Limit Hard Limit Units\nMax core file size        0                    0                    bytes\n"
    );
  }
  for (const [name] of commands(state)) rawInputs[`${name}.stderr`] = Buffer.alloc(0);
  const captured = Object.fromEntries(
    commands(state).map(([name]) => [name, rawInputs[`${name}.stdout`]])
  );
  if (state === "active")
    Object.assign(captured, { swaps: rawInputs.swaps, limits: rawInputs.limits });
  const facts = assessR3WorkspaceObservation({ workspace, state, captured });
  const processes = commands(state).map(([name, command, args], index) => ({
    name,
    command,
    args,
    executable: identity("executable", 1234),
    startedAt: new Date(Date.parse(start) + index * 100).toISOString(),
    pid: 100 + index,
    closedAt: new Date(Date.parse(start) + index * 100 + 50).toISOString(),
    exitCode: 0,
    signal: null,
    stdout: digest(rawInputs[`${name}.stdout`]),
    stderr: digest(rawInputs[`${name}.stderr`])
  }));
  const files = [
    {
      name: "policy",
      path: "/repo/release/contracts/manual-stage1-r3-target-policy.v1.json",
      observedAt: start,
      ...digest(rawInputs.policy)
    },
    {
      name: "machineId",
      path: "/etc/machine-id",
      observedAt: start,
      ...digest(rawInputs.machineId)
    },
    ...["backing", "key", "directory", "mapper"].map((name) => ({
      name,
      path:
        name === "mapper"
          ? `/dev/mapper/${workspace.mapperName}`
          : name === "backing"
            ? workspace.backingFile
            : name === "key"
              ? workspace.keyFile
              : workspace.mountPath,
      exists: state === "active",
      observedAt: start,
      ...(state === "active"
        ? { identity: identity(name, name === "backing" ? capacityBytes : name === "key" ? 64 : 0) }
        : {})
    })),
    ...(state === "active"
      ? [
          { name: "swaps", path: "/proc/swaps", observedAt: finish, ...digest(rawInputs.swaps) },
          {
            name: "limits",
            path: "/proc/self/limits",
            observedAt: finish,
            ...digest(rawInputs.limits)
          }
        ]
      : [])
  ];
  const observation = {
    schemaVersion: "manual-r3-workspace-observation.v1",
    operationRef,
    policyDigest: sha256Bytes(policyBytes),
    state,
    startedAt: start,
    finishedAt: finish,
    hostFingerprint: job.host.machineIdFingerprint,
    workspace,
    promotionEligible: false,
    status: "OBSERVED",
    facts,
    processes,
    files
  };
  return { spec, job, privateKey, policyBytes, rawInputs, observation };
}
const input = (f) => ({
  observationBytes: canonical(f.observation),
  rawInputs: f.rawInputs,
  jobAdmissionBytes: canonical(f.job),
  spec: f.spec,
  policyBytes: f.policyBytes,
  now
});
const invalid = (code) => (error) => error?.code === code;

test("valid active report and job-key binding preserve exact evidence without granting authority", async () => {
  const f = await fixture();
  const binding = signR3WorkspaceBinding({
    observationBytes: canonical(f.observation),
    jobAdmissionBytes: canonical(f.job),
    privateKey: f.privateKey
  });
  assert.equal(binding.operationRef, operationRef);
  assert.equal(
    verifyR3WorkspaceBinding({
      bindingBytes: canonical(binding),
      observationBytes: canonical(f.observation),
      jobAdmissionBytes: canonical(f.job)
    }),
    undefined
  );
  const result = assessR3WorkspaceReport(input(f));
  assert.deepEqual(result, f.observation);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.facts));
  assert.equal(result.promotionEligible, false);
});

function hosted(f) {
  const mount = f.observation.files.find((row) => row.name === "directory").identity;
  const base = `${workspace.mountPath}/exec/containerd`;
  const config = Buffer.from(
    `version = 2\nroot = "${workspace.mountPath}/docker/containerd/daemon"\nstate = "${base}/daemon"\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n[grpc]\naddress = "${base}/containerd.sock"\n[debug]\naddress = "${base}/containerd-debug.sock"\n`
  );
  const containerd = {
    pid: 321,
    parentPid: 320,
    starttime: "12345",
    mount: { path: workspace.mountPath, dev: mount.dev, ino: mount.ino },
    executable: {
      path: "/usr/bin/containerd",
      dev: "1",
      ino: "99",
      mode: String(0o100755),
      uid: "0",
      gid: "0"
    },
    configDigest: sha256Bytes(config),
    configIdentity: { path: `${base}/containerd.toml`, dev: mount.dev, ino: "10" },
    pidFileIdentity: { path: `${base}/containerd.pid`, dev: mount.dev, ino: "11" },
    root: { path: `${workspace.mountPath}/docker/containerd/daemon`, dev: mount.dev, ino: "12" },
    state: { path: `${base}/daemon`, dev: mount.dev, ino: "13" },
    grpc: { path: `${base}/containerd.sock`, dev: mount.dev, ino: "14", listenerInode: "100" },
    debug: {
      path: `${base}/containerd-debug.sock`,
      dev: mount.dev,
      ino: "15",
      listenerInode: "101"
    }
  };
  const info = {
    ID: operationRef,
    DockerRootDir: `${workspace.mountPath}/docker`,
    Driver: "overlay2",
    LoggingDriver: "json-file",
    Containers: 0,
    Images: 0,
    DriverStatus: []
  };
  const version = { Version: "26.1.3", ApiVersion: "1.45" };
  const rawInputs = {
    ping: Buffer.from("OK"),
    info: Buffer.from(JSON.stringify(info)),
    version: Buffer.from(JSON.stringify(version)),
    "containerd.pidFile": Buffer.from("321\n"),
    "containerd.stat": Buffer.from(
      `321 (containerd) S 320 ${Array(17).fill("0").join(" ")} 12345 0 0\n`
    ),
    "containerd.cmdline": Buffer.from(`containerd\0--config\0${base}/containerd.toml\0`),
    "containerd.config": config,
    "containerd.grpcSocketRow": Buffer.from(`000: 2 0 10000 1 01 100 ${base}/containerd.sock`),
    "containerd.debugSocketRow": Buffer.from(
      `001: 2 0 10000 1 01 101 ${base}/containerd-debug.sock`
    ),
    "containerd.socketOwners": Buffer.from(
      JSON.stringify([
        { path: "/proc/321/fd/3", target: "socket:[100]" },
        { path: "/proc/321/fd/4", target: "socket:[101]" }
      ])
    )
  };
  const engine = {
    id: operationRef,
    info,
    version,
    process: {
      pid: 320,
      command: "/usr/bin/dockerd",
      args: ["--config-file", `${workspace.mountPath}/daemon.json`],
      executable: {},
      startedAt: now,
      logPath: `${workspace.mountPath}/daemon.log`
    },
    containerd,
    rawRefs: Object.fromEntries(
      Object.entries(rawInputs).map(([key, bytes]) => [key, digest(bytes)])
    ),
    promotionEligible: false
  };
  return {
    workspace: {
      observation: {
        observation: f.observation,
        observationDigest: sha256Bytes(canonical(f.observation)),
        rawInputs: f.rawInputs
      },
      creation: { status: "WORKSPACE_OBSERVED" },
      rawInputs: {}
    },
    engine,
    rawInputs,
    promotionEligible: false
  };
}

test("R3 hosted evidence binds active workspace and empty encrypted Engine to the job key", async () => {
  const f = await fixture();
  const args = {
    created: hosted(f),
    jobAdmissionBytes: canonical(f.job),
    spec: f.spec,
    policyBytes: f.policyBytes,
    privateKey: f.privateKey,
    now
  };
  const bytes = buildR3HostedEvidence(args);
  const result = verifyR3HostedEvidence({
    bundleBytes: bytes,
    jobAdmissionBytes: args.jobAdmissionBytes,
    spec: f.spec,
    policyBytes: f.policyBytes,
    now
  });
  assert.equal(result.bundleDigest, sha256Bytes(bytes));
  assert.equal(result.engine.containerd.parentPid, result.engine.process.pid);
  assert.deepEqual(result.workspace.observationBytes, canonical(f.observation));
  assert.deepEqual(result.engineRawInputs.ping, Buffer.from("OK"));
});

test("R3 hosted evidence rejects changed raw, job signature, and containerd mount", async () => {
  const f = await fixture();
  const args = {
    created: hosted(f),
    jobAdmissionBytes: canonical(f.job),
    spec: f.spec,
    policyBytes: f.policyBytes,
    privateKey: f.privateKey,
    now
  };
  args.created.engine.containerd.mount.ino = "other";
  assert.throws(() => buildR3HostedEvidence(args), invalid("R3_HOSTED_EVIDENCE_INVALID"));
  args.created = hosted(f);
  args.created.rawInputs.info = Buffer.from("{}");
  assert.throws(() => buildR3HostedEvidence(args), invalid("R3_HOSTED_EVIDENCE_INVALID"));
  args.created = hosted(f);
  const bundle = JSON.parse(buildR3HostedEvidence(args));
  bundle.engine.info.Images = 1;
  assert.throws(
    () =>
      verifyR3HostedEvidence({
        bundleBytes: canonical(bundle),
        jobAdmissionBytes: args.jobAdmissionBytes,
        spec: f.spec,
        policyBytes: f.policyBytes,
        now
      }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
});

test("R3 hosted evidence rejects contradictory raw despite a valid job-key signature", async () => {
  const f = await fixture();
  const jobAdmissionBytes = canonical(f.job);
  const bundle = JSON.parse(
    buildR3HostedEvidence({
      created: hosted(f),
      jobAdmissionBytes,
      spec: f.spec,
      policyBytes: f.policyBytes,
      privateKey: f.privateKey,
      now
    })
  );
  const changed = Buffer.from(
    `321 (containerd) S 999 ${Array(17).fill("0").join(" ")} 12345 0 0\n`
  );
  bundle.engineRawInputs["containerd.stat"] = changed.toString("base64");
  bundle.engine.rawRefs["containerd.stat"] = digest(changed);
  const { signature, ...body } = bundle;
  bundle.signature = sign(
    null,
    Buffer.concat([Buffer.from("subscription-saas/r3-hosted-evidence/v1\n"), canonical(body)]),
    f.privateKey
  ).toString("base64");
  assert.notEqual(bundle.signature, signature);
  assert.throws(
    () =>
      verifyR3HostedEvidence({
        bundleBytes: canonical(bundle),
        jobAdmissionBytes,
        spec: f.spec,
        policyBytes: f.policyBytes,
        now
      }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
});

async function cleanupFixture() {
  const f = await fixture();
  const jobAdmissionBytes = canonical(f.job);
  const creationEvidenceBytes = buildR3HostedEvidence({
    created: hosted(f),
    jobAdmissionBytes,
    spec: f.spec,
    policyBytes: f.policyBytes,
    privateKey: f.privateKey,
    now
  });
  const imageDigest = JSON.parse(
    await fs.readFile(
      new URL("../../../release/contracts/database-target-policies.v1.json", import.meta.url)
    )
  ).policies.find((item) => item.policyId === "s1-release-compose-ephemeral").requiredImageDigest;
  const absent = await fixture("absent");
  const cleanup = r3CleanupFixture({
    spec: f.spec,
    jobAdmissionBytes,
    creationEvidenceBytes,
    activeObservation: f.observation,
    activeRawInputs: f.rawInputs,
    absentObservation: absent.observation,
    absentRawInputs: absent.rawInputs,
    imageDigest,
    startedAt: "2026-09-28T00:00:05.000Z"
  });
  return {
    f,
    jobAdmissionBytes,
    creationEvidenceBytes,
    cleanup,
    checkedAt: new Date(Date.parse(cleanup.finishedAt) + 1000).toISOString()
  };
}
test("R3 hosted cleanup evidence round trips signed raw-backed removal", async () => {
  const x = await cleanupFixture();
  const bundleBytes = buildR3HostedCleanupEvidence({
    cleanup: x.cleanup,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    privateKey: x.f.privateKey,
    now: x.checkedAt
  });
  const result = verifyR3HostedCleanupEvidence({
    bundleBytes,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    now: x.checkedAt
  });
  assert.equal(result.bundleDigest, sha256Bytes(bundleBytes));
  assert.equal(result.creationEvidenceDigest, sha256Bytes(x.creationEvidenceBytes));
  assert.equal(result.operationRef, operationRef);
  assert.equal(result.cleanup.status, "TARGET_REMOVED");
});

test("R3 hosted cleanup evidence rejects UNKNOWN and changed cleanup request order", async () => {
  const x = await cleanupFixture();
  const args = {
    cleanup: x.cleanup,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    privateKey: x.f.privateKey,
    now: x.checkedAt
  };
  args.cleanup.status = "INTERRUPTED_UNKNOWN";
  assert.throws(() => buildR3HostedCleanupEvidence(args), invalid("R3_HOSTED_EVIDENCE_INVALID"));
  args.cleanup.status = "TARGET_REMOVED";
  args.cleanup.requests.reverse();
  assert.throws(() => buildR3HostedCleanupEvidence(args), invalid("R3_HOSTED_EVIDENCE_INVALID"));
});

test("R3 hosted cleanup verifier rejects changed raw, wrong job key, and expired observation", async () => {
  const x = await cleanupFixture();
  const args = {
    cleanup: x.cleanup,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    privateKey: x.f.privateKey,
    now: x.checkedAt
  };
  const bytes = buildR3HostedCleanupEvidence(args);
  const verifyArgs = {
    bundleBytes: bytes,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    now: x.checkedAt
  };
  assert.throws(
    () => verifyR3HostedCleanupEvidence({ ...verifyArgs, now: "2026-09-28T00:00:31.000Z" }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
  const otherKey = generateKeyPairSync("ed25519").privateKey;
  assert.throws(
    () => buildR3HostedCleanupEvidence({ ...args, privateKey: otherKey }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
  const bundle = JSON.parse(bytes);
  bundle.cleanup.rawInputs["before.container"] = Buffer.from("{}").toString("base64");
  const { signature, ...body } = bundle;
  bundle.signature = sign(
    null,
    Buffer.concat([Buffer.from("subscription-saas/r3-hosted-cleanup/v1\n"), canonical(body)]),
    x.f.privateKey
  ).toString("base64");
  assert.notEqual(bundle.signature, signature);
  assert.throws(
    () => verifyR3HostedCleanupEvidence({ ...verifyArgs, bundleBytes: canonical(bundle) }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
});

test("R3 hosted cleanup evidence accepts Docker image and layer deletions", async () => {
  const x = await cleanupFixture();
  const imageId = x.cleanup.postgres.imageId;
  const response = json([
    { Untagged: `postgres@${x.cleanup.postgres.imageDigest}` },
    { Deleted: imageId },
    { Deleted: `sha256:${"f".repeat(64)}` }
  ]);
  x.cleanup.rawInputs["remove-image"] = response;
  x.cleanup.requests[8].response = digest(response);
  const args = {
    cleanup: x.cleanup,
    creationEvidenceBytes: x.creationEvidenceBytes,
    jobAdmissionBytes: x.jobAdmissionBytes,
    spec: x.f.spec,
    policyBytes: x.f.policyBytes,
    privateKey: x.f.privateKey,
    now: x.checkedAt
  };
  const bundleBytes = buildR3HostedCleanupEvidence(args);
  assert.equal(
    verifyR3HostedCleanupEvidence({
      bundleBytes,
      creationEvidenceBytes: x.creationEvidenceBytes,
      jobAdmissionBytes: x.jobAdmissionBytes,
      spec: x.f.spec,
      policyBytes: x.f.policyBytes,
      now: x.checkedAt
    }).cleanup.status,
    "TARGET_REMOVED"
  );
});

test("R3 hosted cleanup evidence rejects executable mode above the kernel mode range", async () => {
  const x = await cleanupFixture();
  x.cleanup.workspace.cleanup.processes[0].executable.mode = String(2 ** 32 + 0o100755);
  assert.throws(
    () =>
      buildR3HostedCleanupEvidence({
        cleanup: x.cleanup,
        creationEvidenceBytes: x.creationEvidenceBytes,
        jobAdmissionBytes: x.jobAdmissionBytes,
        spec: x.f.spec,
        policyBytes: x.f.policyBytes,
        privateKey: x.f.privateKey,
        now: x.checkedAt
      }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
  x.cleanup.workspace.cleanup.processes[0].executable.mode = 0o100755;
  assert.throws(
    () =>
      buildR3HostedCleanupEvidence({
        cleanup: x.cleanup,
        creationEvidenceBytes: x.creationEvidenceBytes,
        jobAdmissionBytes: x.jobAdmissionBytes,
        spec: x.f.spec,
        policyBytes: x.f.policyBytes,
        privateKey: x.f.privateKey,
        now: x.checkedAt
      }),
    invalid("R3_HOSTED_EVIDENCE_INVALID")
  );
});

test("absent report needs three successful inventories and four actual ENOENT leaves", async () => {
  const f = await fixture("absent");
  assert.equal(assessR3WorkspaceReport(input(f)).facts.state, "absent");
  f.observation.files[3].exists = true;
  await assert.rejects(
    async () => assessR3WorkspaceReport(input(f)),
    invalid("R3_WORKSPACE_REPORT_INVALID")
  );
});

test("binding rejects another key, changed data, noncanonical bytes and forged fields", async () => {
  const f = await fixture();
  const args = {
    observationBytes: canonical(f.observation),
    jobAdmissionBytes: canonical(f.job),
    privateKey: f.privateKey
  };
  const binding = signR3WorkspaceBinding(args);
  const other = generateKeyPairSync("ed25519");
  for (const bad of [
    { ...args, privateKey: other.privateKey },
    { ...args, privateKey: "PEM" },
    { ...args, observationBytes: Buffer.from(JSON.stringify(f.observation)) }
  ])
    assert.throws(() => signR3WorkspaceBinding(bad), invalid("R3_WORKSPACE_BINDING_INVALID"));
  for (const bad of [
    { ...binding, state: "absent" },
    { ...binding, extra: true }
  ])
    assert.throws(
      () => verifyR3WorkspaceBinding({ bindingBytes: canonical(bad), ...args }),
      invalid("R3_WORKSPACE_BINDING_INVALID")
    );
});

test("report rejects failed or substituted process raw evidence and fabricated facts", async () => {
  const f = await fixture();
  for (const mutate of [
    (x) => {
      x.observation.processes[0].exitCode = 1;
    },
    (x) => {
      x.observation.processes[0].args = ["--bad"];
    },
    (x) => {
      x.observation.processes[1].startedAt = x.observation.processes[0].startedAt;
    },
    (x) => {
      x.observation.processes[0].executable.mode = String(0o100600);
    },
    (x) => {
      x.rawInputs["mounts.stdout"] = Buffer.from("{}");
    },
    (x) => {
      x.observation.facts.loop.name = "/dev/loop9";
    }
  ]) {
    const x = { ...f, observation: clone(f.observation), rawInputs: { ...f.rawInputs } };
    mutate(x);
    assert.throws(() => assessR3WorkspaceReport(input(x)), invalid("R3_WORKSPACE_REPORT_INVALID"));
  }
});

test("report refuses mismatched spec, host, policy, private file metadata and time window", async () => {
  const f = await fixture();
  for (const mutate of [
    (x) => {
      x.spec.workspace.capacityBytes *= 2;
    },
    (x) => {
      x.observation.hostFingerprint = "sha256:" + "0".repeat(64);
    },
    (x) => {
      x.policyBytes = Buffer.from("{}");
    },
    (x) => {
      x.observation.files.find((file) => file.name === "key").identity.size = "65";
    },
    (x) => {
      x.observation.processes[0].executable.mode = String(2 ** 32 + 0o100755);
    },
    (x) => {
      x.now = "2026-09-28T00:00:31.000Z";
    }
  ]) {
    const x = { ...f, spec: clone(f.spec), observation: clone(f.observation), now };
    mutate(x);
    assert.throws(
      () => assessR3WorkspaceReport({ ...input(x), now: x.now }),
      invalid("R3_WORKSPACE_REPORT_INVALID")
    );
  }
});
