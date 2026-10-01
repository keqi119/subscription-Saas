// A job-key signature binds the collector's bytes to its admitted job. Neither
// this signature nor the validated storage facts grants manual or cleanup power.
import { KeyObject, createPublicKey, sign, verify } from "node:crypto";
import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { sha256Bytes } from "./digest.mjs";
import { validateContract } from "./schema-registry.mjs";
import { assessR3WorkspaceObservation } from "./r3-workspace-observation.mjs";

const LIMIT = 1048576;
const DOMAIN = Buffer.from("subscription-saas/r3-workspace-observation/v1\n");
const BINDING = "R3_WORKSPACE_BINDING_INVALID";
const REPORT = "R3_WORKSPACE_REPORT_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTITY = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
  "rdev"
];
const OBSERVATION_KEYS = [
  "schemaVersion",
  "operationRef",
  "policyDigest",
  "state",
  "startedAt",
  "finishedAt",
  "hostFingerprint",
  "workspace",
  "promotionEligible",
  "status",
  "facts",
  "processes",
  "files"
];
const BINDING_KEYS = [
  "schemaVersion",
  "operationRef",
  "state",
  "observationDigest",
  "jobAdmissionDigest",
  "creationSpecDigest",
  "signature"
];
const JOB_KEYS = [
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
];
const SPEC_KEYS = [
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
];
const WORKSPACE_KEYS = ["id", "capacityBytes", "backingFile", "mountPath", "keyFile", "mapperName"];
const PROCESS_KEYS = [
  "name",
  "command",
  "args",
  "executable",
  "startedAt",
  "pid",
  "closedAt",
  "exitCode",
  "signal",
  "stdout",
  "stderr"
];
const POLICY_FILE = "/release/contracts/manual-stage1-r3-target-policy.v1.json";
const commands = (workspace, state) => [
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
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const requireThat = (condition, code) => {
  if (!condition) fail(code);
};
function exact(value, keys, code) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return property?.enumerable && Object.hasOwn(property, "value");
      }),
    code
  );
}
function bytes(value, code, nonempty = true) {
  requireThat(
    Buffer.isBuffer(value) && value.length <= LIMIT && (!nonempty || value.length > 0),
    code
  );
  return Buffer.from(value);
}
function canonicalBytes(value, code) {
  const copy = bytes(value, code);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy));
  requireThat(encodeManualJson(parsed).equals(copy), code);
  return { value: parsed, bytes: copy };
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function time(value, code) {
  const epoch = typeof value === "string" ? Date.parse(value) : NaN;
  requireThat(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(epoch) &&
      new Date(epoch).toISOString() === value,
    code
  );
  return epoch;
}
function equal(left, right) {
  return encodeManualJson(left).equals(encodeManualJson(right));
}
function publicKey(job, code) {
  exact(job, JOB_KEYS, code);
  requireThat(
    job.schemaVersion === "manual-r3-job-admission.v1" &&
      UUID.test(job.operationRef) &&
      DIGEST.test(job.creationSpecDigest),
    code
  );
  exact(
    job.host,
    [
      "machineIdFingerprint",
      "forwardingPublicKeyPem",
      "forwardingKeyFingerprint",
      "runnerId",
      "runnerName"
    ],
    code
  );
  requireThat(
    DIGEST.test(job.host.machineIdFingerprint) &&
      DIGEST.test(job.host.forwardingKeyFingerprint) &&
      typeof job.host.forwardingPublicKeyPem === "string",
    code
  );
  const key = createPublicKey(job.host.forwardingPublicKeyPem);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      key.export({ type: "spki", format: "pem" }) === job.host.forwardingPublicKeyPem &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) ===
        job.host.forwardingKeyFingerprint,
    code
  );
  return key;
}
function bindingBody(observationBytes, jobAdmissionBytes, code) {
  const observation = canonicalBytes(observationBytes, code);
  const job = canonicalBytes(jobAdmissionBytes, code);
  exact(observation.value, OBSERVATION_KEYS, code);
  publicKey(job.value, code);
  requireThat(
    observation.value.schemaVersion === "manual-r3-workspace-observation.v1" &&
      observation.value.operationRef === job.value.operationRef &&
      ["active", "absent"].includes(observation.value.state),
    code
  );
  return {
    body: {
      schemaVersion: "manual-r3-workspace-binding.v1",
      operationRef: observation.value.operationRef,
      state: observation.value.state,
      observationDigest: sha256Bytes(observation.bytes),
      jobAdmissionDigest: sha256Bytes(job.bytes),
      creationSpecDigest: job.value.creationSpecDigest
    },
    job: job.value
  };
}

export function signR3WorkspaceBinding({ observationBytes, jobAdmissionBytes, privateKey }) {
  try {
    requireThat(
      privateKey instanceof KeyObject &&
        privateKey.type === "private" &&
        privateKey.asymmetricKeyType === "ed25519",
      BINDING
    );
    const { body, job } = bindingBody(observationBytes, jobAdmissionBytes, BINDING);
    const claimed = publicKey(job, BINDING);
    const actual = createPublicKey(privateKey);
    requireThat(
      actual
        .export({ type: "spki", format: "der" })
        .equals(claimed.export({ type: "spki", format: "der" })),
      BINDING
    );
    const signature = sign(
      null,
      Buffer.concat([DOMAIN, encodeManualJson(body)]),
      privateKey
    ).toString("base64");
    return frozen({ ...body, signature });
  } catch {
    fail(BINDING);
  }
}

export function verifyR3WorkspaceBinding({ bindingBytes, observationBytes, jobAdmissionBytes }) {
  try {
    const binding = canonicalBytes(bindingBytes, BINDING).value;
    exact(binding, BINDING_KEYS, BINDING);
    const { signature, ...body } = binding;
    const expected = bindingBody(observationBytes, jobAdmissionBytes, BINDING);
    requireThat(equal(body, expected.body) && typeof signature === "string", BINDING);
    const signatureBytes = Buffer.from(signature, "base64");
    requireThat(
      signatureBytes.length === 64 && signatureBytes.toString("base64") === signature,
      BINDING
    );
    requireThat(
      verify(
        null,
        Buffer.concat([DOMAIN, encodeManualJson(body)]),
        publicKey(expected.job, BINDING),
        signatureBytes
      ),
      BINDING
    );
    return undefined;
  } catch {
    fail(BINDING);
  }
}

function reference(value, raw, code) {
  exact(value, ["digest", "bytes"], code);
  requireThat(
    DIGEST.test(value.digest) &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes === raw.length &&
      value.digest === sha256Bytes(raw),
    code
  );
}
function identity(value, code) {
  exact(value, IDENTITY, code);
  for (const field of IDENTITY)
    requireThat(
      typeof value[field] === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value[field]),
      code
    );
  const numeric = {
    mode: Number(value.mode),
    uid: Number(value.uid),
    size: Number(value.size),
    nlink: Number(value.nlink)
  };
  requireThat(Object.values(numeric).every(Number.isSafeInteger) && numeric.mode <= 0o177777, code);
  return numeric;
}
function file(observation, index, name, path, raw, started, finished, code) {
  const item = observation.files[index];
  exact(item, ["name", "path", "observedAt", "digest", "bytes"], code);
  requireThat(
    item.name === name &&
      item.path === path &&
      started <= time(item.observedAt, code) &&
      time(item.observedAt, code) <= finished,
    code
  );
  reference({ digest: item.digest, bytes: item.bytes }, raw, code);
}
function leaf(observation, index, name, path, state, capacityBytes, started, finished, code) {
  const item = observation.files[index];
  const active = state === "active";
  exact(
    item,
    active
      ? ["name", "path", "exists", "observedAt", "identity"]
      : ["name", "path", "exists", "observedAt"],
    code
  );
  requireThat(
    item.name === name &&
      item.path === path &&
      item.exists === active &&
      started <= time(item.observedAt, code) &&
      time(item.observedAt, code) <= finished,
    code
  );
  if (!active) return;
  const stat = identity(item.identity, code),
    type = stat.mode & 0o170000;
  requireThat(
    stat.uid === 0 &&
      Number.isSafeInteger(stat.mode) &&
      (name === "directory"
        ? type === 0o040000 && (stat.mode & 0o077) === 0
        : name === "mapper"
          ? [0o120000, 0o060000].includes(type)
          : type === 0o100000 &&
            stat.nlink === 1 &&
            (stat.mode & 0o077) === 0 &&
            stat.size === (name === "key" ? 64 : capacityBytes)),
    code
  );
}

export function assessR3WorkspaceReport({
  observationBytes,
  rawInputs,
  jobAdmissionBytes,
  spec,
  policyBytes,
  now
}) {
  try {
    const code = REPORT;
    const observation = canonicalBytes(observationBytes, code).value;
    const job = canonicalBytes(jobAdmissionBytes, code).value;
    const policy = bytes(policyBytes, code);
    const safeSpec = JSON.parse(encodeManualJson(spec));
    exact(observation, OBSERVATION_KEYS, code);
    exact(safeSpec, SPEC_KEYS, code);
    exact(safeSpec.workspace, WORKSPACE_KEYS, code);
    publicKey(job, code);
    const policyValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policy));
    validateContract("manual-stage1-r3-target-policy.v1", policyValue);
    const state = observation.state;
    requireThat(
      observation.schemaVersion === "manual-r3-workspace-observation.v1" &&
        observation.status === "OBSERVED" &&
        observation.promotionEligible === false &&
        ["active", "absent"].includes(state) &&
        UUID.test(observation.operationRef) &&
        safeSpec.schemaVersion === "manual-r3-creation-spec.v1" &&
        safeSpec.operationRef === job.operationRef &&
        observation.operationRef === job.operationRef &&
        job.creationSpecDigest === sha256Bytes(encodeManualJson(safeSpec)) &&
        observation.policyDigest === sha256Bytes(policy) &&
        safeSpec.targetPolicyDigest === observation.policyDigest &&
        observation.hostFingerprint === job.host.machineIdFingerprint &&
        equal(observation.workspace, safeSpec.workspace) &&
        safeSpec.workspace.id === observation.operationRef.replaceAll("-", "") &&
        safeSpec.cleanup === "stop-owned-engine-and-remove-workspace",
      code
    );
    const roots = policyValue.workspace;
    requireThat(
      safeSpec.workspace.backingFile === `${roots.backingRoot}/${safeSpec.workspace.id}.luks` &&
        safeSpec.workspace.mountPath === `${roots.mountRoot}/${safeSpec.workspace.id}` &&
        safeSpec.workspace.keyFile === `${roots.keyRoot}/${safeSpec.workspace.id}.key` &&
        safeSpec.workspace.mapperName === `${roots.mapperPrefix}${safeSpec.workspace.id}`,
      code
    );
    for (const field of [
      "profileDigest",
      "ownerId",
      "sourceSha",
      "buildProofDigest",
      "phase",
      "chain"
    ])
      requireThat(job[field] === safeSpec[field], code);
    requireThat(
      ["source", "final"].includes(job.phase) &&
        ["fresh", "snapshot"].includes(job.chain) &&
        /^[0-9a-f]{40}$/u.test(job.sourceSha),
      code
    );
    const created = time(safeSpec.createdAt, code),
      generated = time(job.generatedAt, code),
      started = time(observation.startedAt, code),
      finished = time(observation.finishedAt, code),
      current = time(now, code),
      expires = time(job.expiresAt, code),
      specExpires = time(safeSpec.expiresAt, code);
    requireThat(
      created <= generated &&
        generated <= started &&
        started <= finished &&
        finished <= current &&
        current < expires &&
        expires <= specExpires,
      code
    );
    const machine = commands(observation.workspace, state);
    const names = [
      "policy",
      "machineId",
      ...machine.flatMap(([name]) => [`${name}.stdout`, `${name}.stderr`]),
      ...(state === "active" ? ["swaps", "limits"] : [])
    ];
    exact(rawInputs, names, code);
    const raw = Object.fromEntries(
      names.map((name) => [name, bytes(rawInputs[name], code, false)])
    );
    requireThat(raw.policy.equals(policy), code);
    const machineId = new TextDecoder("utf-8", { fatal: true }).decode(raw.machineId).trim();
    requireThat(
      /^[0-9a-f]{32}$/u.test(machineId) &&
        sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`)) ===
          observation.hostFingerprint,
      code
    );
    requireThat(
      Array.isArray(observation.processes) && observation.processes.length === machine.length,
      code
    );
    let previousClose = started;
    for (let index = 0; index < machine.length; index++) {
      const [name, command, args] = machine[index],
        call = observation.processes[index];
      exact(call, PROCESS_KEYS, code);
      const began = time(call.startedAt, code),
        ended = time(call.closedAt, code);
      const executable = identity(call.executable, code);
      requireThat(
        call.name === name &&
          call.command === command &&
          equal(call.args, args) &&
          Number.isSafeInteger(call.pid) &&
          call.pid > 0 &&
          call.exitCode === 0 &&
          call.signal === null &&
          previousClose <= began &&
          began <= ended &&
          ended <= finished &&
          executable.uid === 0 &&
          (executable.mode & 0o170000) === 0o100000 &&
          (executable.mode & 0o111) !== 0 &&
          (executable.mode & 0o022) === 0,
        code
      );
      reference(call.stdout, raw[`${name}.stdout`], code);
      reference(call.stderr, raw[`${name}.stderr`], code);
      requireThat(raw[`${name}.stderr`].length === 0, code);
      previousClose = ended;
    }
    requireThat(
      Array.isArray(observation.files) && observation.files.length === (state === "active" ? 8 : 6),
      code
    );
    const policyFile = observation.files[0];
    requireThat(
      typeof policyFile?.path === "string" &&
        policyFile.path.endsWith(POLICY_FILE) &&
        policyFile.path.startsWith("/") &&
        !policyFile.path
          .split("/")
          .slice(1)
          .some((part) => ["", ".", ".."].includes(part)),
      code
    );
    file(observation, 0, "policy", policyFile.path, raw.policy, started, finished, code);
    file(observation, 1, "machineId", "/etc/machine-id", raw.machineId, started, finished, code);
    const w = observation.workspace;
    for (const [index, name, path] of [
      [2, "backing", w.backingFile],
      [3, "key", w.keyFile],
      [4, "directory", w.mountPath],
      [5, "mapper", `/dev/mapper/${w.mapperName}`]
    ])
      leaf(observation, index, name, path, state, w.capacityBytes, started, finished, code);
    for (const entry of observation.files.slice(0, 6))
      requireThat(
        time(entry.observedAt, code) <= time(observation.processes[0].startedAt, code),
        code
      );
    if (state === "active") {
      file(observation, 6, "swaps", "/proc/swaps", raw.swaps, started, finished, code);
      file(observation, 7, "limits", "/proc/self/limits", raw.limits, started, finished, code);
      requireThat(
        time(observation.files[6].observedAt, code) >= previousClose &&
          time(observation.files[7].observedAt, code) >=
            time(observation.files[6].observedAt, code),
        code
      );
    }
    const captured = Object.fromEntries(machine.map(([name]) => [name, raw[`${name}.stdout`]]));
    if (state === "active") Object.assign(captured, { swaps: raw.swaps, limits: raw.limits });
    const facts = assessR3WorkspaceObservation({ workspace: w, state, captured });
    requireThat(equal(observation.facts, facts), code);
    return frozen(observation);
  } catch {
    fail(REPORT);
  }
}
