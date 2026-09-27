import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../src/digest.mjs";
import { assessR3WorkspaceObservation } from "../src/r3-workspace-observation.mjs";
import {
  signR3WorkspaceBinding,
  verifyR3WorkspaceBinding,
  assessR3WorkspaceReport
} from "../src/r3-workspace-report.mjs";

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
