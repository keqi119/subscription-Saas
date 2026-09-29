// Job-key provenance for the hosted workspace and its still-empty Engine.
// This bundle conveys observations only; it grants no manual operation authority.
import { KeyObject, createPublicKey, sign, verify } from "node:crypto";

import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { assessR3ContainerdRaw } from "./r3-containerd-raw.mjs";
import { assessR3WorkspaceObservation } from "./r3-workspace-observation.mjs";
import { assessR3PostgresResources } from "../../../scripts/release/r3-postgres-observation.mjs";
import {
  assessR3WorkspaceReport,
  signR3WorkspaceBinding,
  verifyR3WorkspaceBinding
} from "./r3-workspace-report.mjs";

const CODE = "R3_HOSTED_EVIDENCE_INVALID";
const DOMAIN = Buffer.from("subscription-saas/r3-hosted-evidence/v1\n");
const CLEANUP_DOMAIN = Buffer.from("subscription-saas/r3-hosted-cleanup/v1\n");
const LIMIT = 1048576;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENGINE_RAW = [
  "ping",
  "info",
  "version",
  "containerd.pidFile",
  "containerd.stat",
  "containerd.cmdline",
  "containerd.config",
  "containerd.grpcSocketRow",
  "containerd.debugSocketRow",
  "containerd.socketOwners"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const exact = (value, names) =>
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
  );
function canonical(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
  const copy = Buffer.from(bytes);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy));
  } catch {
    fail();
  }
  need(encodeManualJson(value).equals(copy));
  return value;
}
function encoded(value) {
  need(Buffer.isBuffer(value) && value.length <= LIMIT);
  return value.toString("base64");
}
function decoded(value) {
  need(
    typeof value === "string" &&
      value.length <= Math.ceil(LIMIT / 3) * 4 &&
      /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  );
  const bytes = Buffer.from(value, "base64");
  need(bytes.length <= LIMIT && bytes.toString("base64") === value);
  return bytes;
}
function decodeMap(map) {
  need(
    map &&
      typeof map === "object" &&
      !Array.isArray(map) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(map)) &&
      Reflect.ownKeys(map).length <= 80
  );
  return Object.fromEntries(
    Object.entries(map).map(([name, value]) => {
      need(/^[A-Za-z][A-Za-z0-9.-]{0,63}$/u.test(name));
      return [name, decoded(value)];
    })
  );
}
function encodeMap(map) {
  need(map && typeof map === "object" && !Array.isArray(map));
  return Object.fromEntries(Object.entries(map).map(([name, bytes]) => [name, encoded(bytes)]));
}
function jobKey(jobAdmissionBytes) {
  const job = canonical(jobAdmissionBytes);
  need(job.schemaVersion === "manual-r3-job-admission.v1" && job.host?.forwardingPublicKeyPem);
  const key = createPublicKey(job.host.forwardingPublicKeyPem);
  need(
    key.asymmetricKeyType === "ed25519" &&
      key.export({ type: "spki", format: "pem" }) === job.host.forwardingPublicKeyPem &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === job.host.forwardingKeyFingerprint
  );
  return { job, key };
}
function verifyEngine(engine, raw, observation, now) {
  exact(engine, ["id", "info", "version", "process", "containerd", "rawRefs", "promotionEligible"]);
  exact(engine.process, ["pid", "command", "args", "executable", "startedAt", "logPath"]);
  need(
    engine.promotionEligible === false &&
      Number.isSafeInteger(engine.process.pid) &&
      engine.process.pid > 0 &&
      engine.process.command === "/usr/bin/dockerd" &&
      engine.process.logPath === `${observation.workspace.mountPath}/daemon.log` &&
      Array.isArray(engine.process.args) &&
      engine.process.args.length === 2 &&
      engine.process.args[0] === "--config-file" &&
      engine.process.args[1] === `${observation.workspace.mountPath}/daemon.json` &&
      typeof engine.process.startedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(engine.process.startedAt) &&
      Number.isFinite(Date.parse(engine.process.startedAt)) &&
      new Date(engine.process.startedAt).toISOString() === engine.process.startedAt &&
      Date.parse(engine.process.startedAt) >= Date.parse(observation.finishedAt) &&
      Date.parse(engine.process.startedAt) <= Date.parse(now)
  );
  exact(raw, ENGINE_RAW);
  exact(engine.rawRefs, ENGINE_RAW);
  for (const [name, bytes] of Object.entries(raw)) {
    exact(engine.rawRefs[name], ["digest", "bytes"]);
    need(
      engine.rawRefs[name].bytes === bytes.length &&
        engine.rawRefs[name].digest === sha256Bytes(bytes)
    );
  }
  need(
    raw.ping.equals(Buffer.from("OK")) &&
      encodeManualJson(JSON.parse(raw.info)).equals(encodeManualJson(engine.info)) &&
      encodeManualJson(JSON.parse(raw.version)).equals(encodeManualJson(engine.version))
  );
  const info = engine.info;
  need(
    UUID.test(engine.id) &&
      info.ID === engine.id &&
      info.DockerRootDir === `${observation.workspace.mountPath}/docker` &&
      info.Driver === "overlay2" &&
      info.LoggingDriver === "json-file" &&
      info.Containers === 0 &&
      info.Images === 0 &&
      Array.isArray(info.DriverStatus) &&
      info.DriverStatus.every(
        (row) => Array.isArray(row) && row.length === 2 && row[0] !== "driver-type"
      ) &&
      typeof engine.version.Version === "string" &&
      typeof engine.version.ApiVersion === "string"
  );
  const c = engine.containerd;
  exact(c, [
    "pid",
    "parentPid",
    "starttime",
    "mount",
    "executable",
    "configDigest",
    "configIdentity",
    "pidFileIdentity",
    "root",
    "state",
    "grpc",
    "debug"
  ]);
  const mount = observation.workspace.mountPath;
  const parsed = assessR3ContainerdRaw({
    mountPath: mount,
    dockerdPid: engine.process.pid,
    rawInputs: Object.fromEntries(
      Object.entries(raw)
        .filter(([name]) => name.startsWith("containerd."))
        .map(([name, bytes]) => [name.slice("containerd.".length), bytes])
    )
  });
  const mountIdentity = observation.files.find((file) => file.name === "directory")?.identity;
  need(
    Number.isSafeInteger(c.pid) &&
      c.pid > 0 &&
      c.parentPid === engine.process.pid &&
      c.pid === parsed.pid &&
      c.parentPid === parsed.parentPid &&
      c.starttime === parsed.starttime &&
      /^[1-9][0-9]*$/u.test(c.starttime) &&
      c.mount.path === mount &&
      c.mount.dev === mountIdentity?.dev &&
      c.mount.ino === mountIdentity?.ino &&
      c.configDigest === parsed.configDigest &&
      c.root.path === parsed.rootPath &&
      c.state.path === parsed.statePath &&
      c.grpc.path === parsed.grpcPath &&
      c.debug.path === parsed.debugPath &&
      c.grpc.listenerInode === parsed.grpcListenerInode &&
      c.debug.listenerInode === parsed.debugListenerInode
  );
  for (const [value, path] of [
    [c.root, `${mount}/docker/containerd/daemon`],
    [c.state, `${mount}/exec/containerd/daemon`],
    [c.grpc, `${mount}/exec/containerd/containerd.sock`],
    [c.debug, `${mount}/exec/containerd/containerd-debug.sock`],
    [c.configIdentity, `${mount}/exec/containerd/containerd.toml`],
    [c.pidFileIdentity, `${mount}/exec/containerd/containerd.pid`]
  ])
    need(value?.path === path && value.dev === c.mount.dev && /^[1-9][0-9]*$/u.test(value.ino));
  need(
    [c.grpc.listenerInode, c.debug.listenerInode].every((value) => /^[1-9][0-9]*$/u.test(value))
  );
}
function verifyBody(body, jobAdmissionBytes, spec, policyBytes, now) {
  exact(body, [
    "schemaVersion",
    "operationRef",
    "jobAdmissionDigest",
    "creationSpecDigest",
    "workspace",
    "engine",
    "engineRawInputs"
  ]);
  const { job } = jobKey(jobAdmissionBytes);
  need(
    body.schemaVersion === "manual-r3-hosted-evidence.v1" &&
      body.operationRef === job.operationRef &&
      body.operationRef === spec.operationRef &&
      body.jobAdmissionDigest === sha256Bytes(jobAdmissionBytes) &&
      body.creationSpecDigest === job.creationSpecDigest &&
      body.creationSpecDigest === sha256Bytes(encodeManualJson(spec))
  );
  exact(body.workspace, ["observation", "binding", "rawInputs"]);
  const observationBytes = decoded(body.workspace.observation);
  const bindingBytes = decoded(body.workspace.binding);
  const workspaceRaw = decodeMap(body.workspace.rawInputs);
  const engineRaw = decodeMap(body.engineRawInputs);
  verifyR3WorkspaceBinding({ bindingBytes, observationBytes, jobAdmissionBytes });
  const observation = assessR3WorkspaceReport({
    observationBytes,
    rawInputs: workspaceRaw,
    jobAdmissionBytes,
    spec,
    policyBytes,
    now
  });
  need(observation.state === "active" && observation.facts.state === "active");
  verifyEngine(body.engine, engineRaw, observation, now);
  return { observationBytes, bindingBytes, workspaceRaw, engineRaw };
}

export function buildR3HostedEvidence({
  created,
  jobAdmissionBytes,
  spec,
  policyBytes,
  privateKey,
  now
}) {
  try {
    exact(created, ["workspace", "engine", "rawInputs", "promotionEligible"]);
    need(
      created.promotionEligible === false &&
        created.workspace?.creation?.status === "WORKSPACE_OBSERVED" &&
        created.workspace.observation?.observation?.state === "active" &&
        privateKey instanceof KeyObject &&
        privateKey.type === "private" &&
        privateKey.asymmetricKeyType === "ed25519"
    );
    const observationBytes = encodeManualJson(created.workspace.observation.observation);
    need(created.workspace.observation.observationDigest === sha256Bytes(observationBytes));
    const binding = signR3WorkspaceBinding({ observationBytes, jobAdmissionBytes, privateKey });
    const body = {
      schemaVersion: "manual-r3-hosted-evidence.v1",
      operationRef: spec.operationRef,
      jobAdmissionDigest: sha256Bytes(jobAdmissionBytes),
      creationSpecDigest: sha256Bytes(encodeManualJson(spec)),
      workspace: {
        observation: encoded(observationBytes),
        binding: encoded(encodeManualJson(binding)),
        rawInputs: encodeMap(created.workspace.observation.rawInputs)
      },
      engine: created.engine,
      engineRawInputs: encodeMap(created.rawInputs)
    };
    verifyBody(body, jobAdmissionBytes, spec, policyBytes, now);
    const { key } = jobKey(jobAdmissionBytes);
    need(
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .equals(key.export({ type: "spki", format: "der" }))
    );
    const signature = sign(
      null,
      Buffer.concat([DOMAIN, encodeManualJson(body)]),
      privateKey
    ).toString("base64");
    const bytes = encodeManualJson({ ...body, signature });
    need(bytes.length <= LIMIT);
    return bytes;
  } catch {
    fail();
  }
}

export function verifyR3HostedEvidence({ bundleBytes, jobAdmissionBytes, spec, policyBytes, now }) {
  try {
    const bundle = canonical(bundleBytes);
    exact(bundle, [
      "schemaVersion",
      "operationRef",
      "jobAdmissionDigest",
      "creationSpecDigest",
      "workspace",
      "engine",
      "engineRawInputs",
      "signature"
    ]);
    const { signature, ...body } = bundle;
    const signatureBytes = decoded(signature);
    need(signatureBytes.length === 64);
    const { key } = jobKey(jobAdmissionBytes);
    need(verify(null, Buffer.concat([DOMAIN, encodeManualJson(body)]), key, signatureBytes));
    const checked = verifyBody(body, jobAdmissionBytes, spec, policyBytes, now);
    return Object.freeze({
      workspace: Object.freeze({
        observationBytes: Buffer.from(checked.observationBytes),
        bindingBytes: Buffer.from(checked.bindingBytes),
        rawInputs: Object.freeze(
          Object.fromEntries(
            Object.entries(checked.workspaceRaw).map(([name, bytes]) => [name, Buffer.from(bytes)])
          )
        )
      }),
      engine: Object.freeze(JSON.parse(JSON.stringify(body.engine))),
      engineRawInputs: Object.freeze(
        Object.fromEntries(
          Object.entries(checked.engineRaw).map(([name, bytes]) => [name, Buffer.from(bytes)])
        )
      ),
      bundleDigest: sha256Bytes(bundleBytes)
    });
  } catch {
    fail();
  }
}

function cleanupTime(value) {
  need(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value
  );
  return Date.parse(value);
}
function sameValue(left, right) {
  return sha256Canonical(left) === sha256Canonical(right);
}
function rawJson(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMIT);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function rawRef(value, bytes) {
  exact(value, ["digest", "bytes"]);
  need(value.digest === sha256Bytes(bytes) && value.bytes === bytes.length);
}
function cleanupProcess(call, name, command, args, raw, previous, finish) {
  exact(call, [
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
  ]);
  need(
    call.name === name &&
      call.command === command &&
      sameValue(call.args, args) &&
      Number.isSafeInteger(call.pid) &&
      call.pid > 0 &&
      call.exitCode === 0 &&
      call.signal === null &&
      previous <= cleanupTime(call.startedAt) &&
      cleanupTime(call.startedAt) <= cleanupTime(call.closedAt) &&
      cleanupTime(call.closedAt) <= finish
  );
  exact(call.executable, [
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
  ]);
  need(
    typeof call.executable.mode === "string" && /^(?:0|[1-9][0-9]*)$/u.test(call.executable.mode)
  );
  const mode = Number(call.executable.mode);
  need(
    Number.isSafeInteger(mode) &&
      mode >= 0 &&
      mode <= 0o177777 &&
      call.executable.uid === "0" &&
      (mode & 0o170000) === 0o100000 &&
      (mode & 0o111) !== 0 &&
      (mode & 0o022) === 0
  );
  rawRef(call.stdout, raw[`cleanup.${name}.stdout`]);
  rawRef(call.stderr, raw[`cleanup.${name}.stderr`]);
  need(raw[`cleanup.${name}.stderr`].length === 0);
  return cleanupTime(call.closedAt);
}
function verifyCleanupBody(body, creationEvidenceBytes, jobAdmissionBytes, spec, policyBytes, now) {
  exact(body, [
    "schemaVersion",
    "operationRef",
    "creationEvidenceDigest",
    "jobAdmissionDigest",
    "creationSpecDigest",
    "cleanup"
  ]);
  const prior = verifyR3HostedEvidence({
    bundleBytes: creationEvidenceBytes,
    jobAdmissionBytes,
    spec,
    policyBytes,
    now
  });
  const creationObservation = canonical(prior.workspace.observationBytes);
  const job = jobKey(jobAdmissionBytes).job;
  need(
    body.schemaVersion === "manual-r3-hosted-cleanup.v1" &&
      body.operationRef === spec.operationRef &&
      body.operationRef === job.operationRef &&
      body.creationEvidenceDigest === sha256Bytes(creationEvidenceBytes) &&
      body.jobAdmissionDigest === sha256Bytes(jobAdmissionBytes) &&
      body.creationSpecDigest === sha256Bytes(encodeManualJson(spec)) &&
      body.creationSpecDigest === job.creationSpecDigest
  );
  const c = body.cleanup;
  exact(c, [
    "operationRef",
    "creationSpecDigest",
    "jobAdmissionDigest",
    "status",
    "startedAt",
    "finishedAt",
    "postgres",
    "engine",
    "requests",
    "processAbsence",
    "workspace",
    "rawInputs",
    "promotionEligible"
  ]);
  const started = cleanupTime(c.startedAt),
    finished = cleanupTime(c.finishedAt),
    current = cleanupTime(now);
  need(
    c.operationRef === body.operationRef &&
      c.creationSpecDigest === body.creationSpecDigest &&
      c.jobAdmissionDigest === body.jobAdmissionDigest &&
      c.status === "TARGET_REMOVED" &&
      c.promotionEligible === false &&
      cleanupTime(prior.engine.process.startedAt) <= started &&
      started <= finished &&
      finished <= current &&
      current < cleanupTime(job.expiresAt) &&
      current < cleanupTime(spec.expiresAt)
  );
  const raw = decodeMap(c.rawInputs);
  const requestNames = [
    "stop-container",
    "stopped-container",
    "remove-container",
    "absent-container",
    "remove-network",
    "absent-network",
    "remove-volume",
    "absent-volume",
    "remove-image",
    "absent-image",
    "empty-engine"
  ];
  exact(raw, [
    "before.info",
    "before.image",
    "before.container",
    "before.network",
    "before.volume",
    ...requestNames
  ]);
  const before = Object.fromEntries(
    ["info", "image", "container", "network", "volume"].map((name) => [
      name,
      rawJson(raw[`before.${name}`])
    ])
  );
  need(DIGEST.test(c.postgres?.imageDigest));
  const postgres = assessR3PostgresResources({
    operationRef: body.operationRef,
    workspaceMountPath: spec.workspace.mountPath,
    engineId: prior.engine.id,
    imageDigest: c.postgres.imageDigest,
    engine: before.info,
    image: before.image,
    container: before.container,
    network: before.network,
    volume: before.volume
  });
  need(sameValue(postgres, c.postgres) && postgres.engineId === prior.engine.id);
  const cid = postgres.containerId,
    nid = postgres.networkId,
    imageId = postgres.imageId;
  const requests = [
    ["stop-container", "POST", `/containers/${cid}/stop?t=10`, 204],
    ["stopped-container", "GET", `/containers/${cid}/json`, 200],
    ["remove-container", "DELETE", `/containers/${cid}?v=false&force=false`, 204],
    ["absent-container", "GET", `/containers/${cid}/json`, 404],
    ["remove-network", "DELETE", `/networks/${nid}`, 204],
    ["absent-network", "GET", `/networks/${nid}`, 404],
    ["remove-volume", "DELETE", `/volumes/${postgres.volumeName}?force=false`, 204],
    ["absent-volume", "GET", `/volumes/${postgres.volumeName}`, 404],
    [
      "remove-image",
      "DELETE",
      `/images/${encodeURIComponent(imageId)}?force=false&noprune=true`,
      200
    ],
    ["absent-image", "GET", `/images/${encodeURIComponent(imageId)}/json`, 404],
    ["empty-engine", "GET", "/info", 200]
  ];
  need(Array.isArray(c.requests) && c.requests.length === requests.length);
  let previous = started;
  for (let i = 0; i < requests.length; i++) {
    const entry = c.requests[i];
    const [name, method, route, status] = requests[i];
    exact(entry, ["name", "method", "path", "startedAt", "finishedAt", "status", "response"]);
    need(
      entry.name === name &&
        entry.method === method &&
        entry.path === `/v1.45${route}` &&
        entry.status === status &&
        previous <= cleanupTime(entry.startedAt) &&
        cleanupTime(entry.startedAt) <= cleanupTime(entry.finishedAt) &&
        cleanupTime(entry.finishedAt) <= finished
    );
    rawRef(entry.response, raw[name]);
    if (status === 204) need(raw[name].length === 0);
    previous = cleanupTime(entry.finishedAt);
  }
  const stopped = rawJson(raw["stopped-container"]);
  need(
    stopped.Id === cid &&
      stopped.Image === imageId &&
      stopped.Name === `/${postgres.containerName}` &&
      stopped.Config?.Labels?.["com.subscription.release.operation-ref"] === body.operationRef &&
      stopped.State?.Status === "exited" &&
      stopped.State.Running === false &&
      stopped.State.Paused === false &&
      stopped.State.Restarting === false &&
      stopped.State.Dead === false &&
      stopped.State.Pid === 0 &&
      stopped.State.ExitCode === 0
  );
  const removed = rawJson(raw["remove-image"]);
  need(Array.isArray(removed) && removed.length > 0 && removed.length <= 128);
  for (const entry of removed) {
    need(entry && typeof entry === "object" && !Array.isArray(entry));
    if (Object.hasOwn(entry, "Deleted")) {
      exact(entry, ["Deleted"]);
      need(DIGEST.test(entry.Deleted));
    } else {
      exact(entry, ["Untagged"]);
      need(typeof entry.Untagged === "string" && /^[\x21-\x7e]{1,1024}$/u.test(entry.Untagged));
    }
  }
  need(removed.some((entry) => entry.Deleted === imageId));
  const empty = rawJson(raw["empty-engine"]);
  need(
    empty.ID === prior.engine.id &&
      empty.DockerRootDir === `${spec.workspace.mountPath}/docker` &&
      empty.Driver === "overlay2" &&
      empty.LoggingDriver === "json-file" &&
      empty.Containers === 0 &&
      empty.Images === 0
  );
  exact(c.engine, ["id", "process", "containerd", "exit"]);
  need(
    c.engine.id === prior.engine.id &&
      sameValue(c.engine.process, prior.engine.process) &&
      sameValue(c.engine.containerd, prior.engine.containerd)
  );
  exact(c.engine.exit, ["pid", "exitCode", "signal", "closedAt"]);
  need(
    c.engine.exit.pid === prior.engine.process.pid &&
      c.engine.exit.exitCode === 0 &&
      c.engine.exit.signal === null &&
      previous <= cleanupTime(c.engine.exit.closedAt) &&
      cleanupTime(c.engine.exit.closedAt) <= finished
  );
  need(Array.isArray(c.processAbsence) && c.processAbsence.length === 2);
  previous = cleanupTime(c.engine.exit.closedAt);
  for (const [index, pid] of [prior.engine.process.pid, prior.engine.containerd.pid].entries()) {
    const row = c.processAbsence[index];
    exact(row, ["path", "code", "observedAt"]);
    need(
      row.path === `/proc/${pid}` &&
        row.code === "ENOENT" &&
        previous <= cleanupTime(row.observedAt) &&
        cleanupTime(row.observedAt) <= finished
    );
    previous = cleanupTime(row.observedAt);
  }
  exact(c.workspace, ["cleanup", "observation", "rawInputs"]);
  const workspaceRaw = decodeMap(c.workspace.rawInputs);
  const beforeNames = Object.keys(prior.workspace.rawInputs);
  const afterNames = [
    "policy",
    "machineId",
    "mounts.stdout",
    "mounts.stderr",
    "loops.stdout",
    "loops.stderr",
    "blocks.stdout",
    "blocks.stderr"
  ];
  exact(workspaceRaw, [
    ...beforeNames.map((name) => `before.${name}`),
    "cleanup.unmount.stdout",
    "cleanup.unmount.stderr",
    "cleanup.luksClose.stdout",
    "cleanup.luksClose.stderr",
    ...afterNames.map((name) => `after.${name}`)
  ]);
  need(workspaceRaw["before.policy"].equals(policyBytes));
  const beforeMachine = new TextDecoder("utf-8", { fatal: true })
    .decode(workspaceRaw["before.machineId"])
    .trim();
  need(
    /^[0-9a-f]{32}$/u.test(beforeMachine) &&
      sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${beforeMachine}`)) ===
        creationObservation.hostFingerprint
  );
  for (const name of beforeNames.filter((name) => name.endsWith(".stderr")))
    need(workspaceRaw[`before.${name}`].length === 0);
  const active = assessR3WorkspaceObservation({
    workspace: spec.workspace,
    state: "active",
    captured: {
      mounts: workspaceRaw["before.mounts.stdout"],
      loops: workspaceRaw["before.loops.stdout"],
      blocks: workspaceRaw["before.blocks.stdout"],
      mapper: workspaceRaw["before.mapper.stdout"],
      header: workspaceRaw["before.header.stdout"],
      uuid: workspaceRaw["before.uuid.stdout"],
      swaps: workspaceRaw["before.swaps"],
      limits: workspaceRaw["before.limits"]
    }
  });
  need(sameValue(active, creationObservation.facts));
  const wc = c.workspace.cleanup;
  exact(wc, [
    "operationRef",
    "promotionEligible",
    "startedAt",
    "finishedAt",
    "status",
    "ownedPaths",
    "processes"
  ]);
  need(
    wc.operationRef === body.operationRef &&
      wc.promotionEligible === false &&
      wc.status === "WORKSPACE_REMOVED" &&
      previous <= cleanupTime(wc.startedAt) &&
      cleanupTime(wc.startedAt) <= cleanupTime(wc.finishedAt) &&
      cleanupTime(wc.finishedAt) <= finished &&
      sameValue(wc.ownedPaths, [
        spec.workspace.keyFile,
        spec.workspace.backingFile,
        `/dev/mapper/${spec.workspace.mapperName}`,
        spec.workspace.mountPath
      ]) &&
      Array.isArray(wc.processes) &&
      wc.processes.length === 2
  );
  previous = cleanupTime(wc.startedAt);
  previous = cleanupProcess(
    wc.processes[0],
    "unmount",
    "/usr/bin/umount",
    [spec.workspace.mountPath],
    workspaceRaw,
    previous,
    cleanupTime(wc.finishedAt)
  );
  previous = cleanupProcess(
    wc.processes[1],
    "luksClose",
    "/usr/sbin/cryptsetup",
    ["close", spec.workspace.mapperName],
    workspaceRaw,
    previous,
    cleanupTime(wc.finishedAt)
  );
  exact(c.workspace.observation, ["observation", "observationDigest"]);
  const afterBytes = decoded(c.workspace.observation.observation);
  need(c.workspace.observation.observationDigest === sha256Bytes(afterBytes));
  const afterRaw = Object.fromEntries(
    afterNames.map((name) => [name, workspaceRaw[`after.${name}`]])
  );
  const after = assessR3WorkspaceReport({
    observationBytes: afterBytes,
    rawInputs: afterRaw,
    jobAdmissionBytes,
    spec,
    policyBytes,
    now
  });
  need(
    after.state === "absent" &&
      after.facts.state === "absent" &&
      previous <= cleanupTime(after.startedAt) &&
      cleanupTime(after.finishedAt) <= cleanupTime(wc.finishedAt)
  );
  return {
    cleanup: {
      ...c,
      rawInputs: raw,
      workspace: {
        cleanup: wc,
        observation: {
          observation: after,
          observationDigest: c.workspace.observation.observationDigest,
          rawInputs: afterRaw
        },
        rawInputs: workspaceRaw
      }
    }
  };
}

// Signed observation of completed cleanup; this neither grants cleanup nor releases a slot.
export function buildR3HostedCleanupEvidence({
  cleanup,
  creationEvidenceBytes,
  jobAdmissionBytes,
  spec,
  policyBytes,
  privateKey,
  now
}) {
  try {
    need(
      privateKey instanceof KeyObject &&
        privateKey.type === "private" &&
        privateKey.asymmetricKeyType === "ed25519"
    );
    exact(cleanup.workspace.observation, ["observation", "observationDigest", "rawInputs"]);
    const afterBytes = encodeManualJson(cleanup.workspace.observation.observation);
    need(cleanup.workspace.observation.observationDigest === sha256Bytes(afterBytes));
    const afterRaw = Object.fromEntries(
      Object.entries(cleanup.workspace.rawInputs)
        .filter(([name]) => name.startsWith("after."))
        .map(([name, bytes]) => [name.slice("after.".length), bytes])
    );
    need(sameValue(encodeMap(afterRaw), encodeMap(cleanup.workspace.observation.rawInputs)));
    const body = {
      schemaVersion: "manual-r3-hosted-cleanup.v1",
      operationRef: spec.operationRef,
      creationEvidenceDigest: sha256Bytes(creationEvidenceBytes),
      jobAdmissionDigest: sha256Bytes(jobAdmissionBytes),
      creationSpecDigest: sha256Bytes(encodeManualJson(spec)),
      cleanup: {
        ...cleanup,
        rawInputs: encodeMap(cleanup.rawInputs),
        workspace: {
          cleanup: cleanup.workspace.cleanup,
          observation: {
            observation: encoded(afterBytes),
            observationDigest: sha256Bytes(afterBytes)
          },
          rawInputs: encodeMap(cleanup.workspace.rawInputs)
        }
      }
    };
    verifyCleanupBody(body, creationEvidenceBytes, jobAdmissionBytes, spec, policyBytes, now);
    const { key } = jobKey(jobAdmissionBytes);
    need(
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .equals(key.export({ type: "spki", format: "der" }))
    );
    const signature = sign(
      null,
      Buffer.concat([CLEANUP_DOMAIN, encodeManualJson(body)]),
      privateKey
    ).toString("base64");
    const bytes = encodeManualJson({ ...body, signature });
    need(bytes.length <= LIMIT);
    return bytes;
  } catch {
    fail();
  }
}

export function verifyR3HostedCleanupEvidence({
  bundleBytes,
  creationEvidenceBytes,
  jobAdmissionBytes,
  spec,
  policyBytes,
  now
}) {
  try {
    const bundle = canonical(bundleBytes);
    exact(bundle, [
      "schemaVersion",
      "operationRef",
      "creationEvidenceDigest",
      "jobAdmissionDigest",
      "creationSpecDigest",
      "cleanup",
      "signature"
    ]);
    const { signature, ...body } = bundle;
    const signatureBytes = decoded(signature);
    need(signatureBytes.length === 64);
    const { key } = jobKey(jobAdmissionBytes);
    need(
      verify(null, Buffer.concat([CLEANUP_DOMAIN, encodeManualJson(body)]), key, signatureBytes)
    );
    const checked = verifyCleanupBody(
      body,
      creationEvidenceBytes,
      jobAdmissionBytes,
      spec,
      policyBytes,
      now
    );
    const copy = (value) => {
      if (Buffer.isBuffer(value)) return Buffer.from(value);
      if (Array.isArray(value)) return Object.freeze(value.map(copy));
      if (value && typeof value === "object")
        return Object.freeze(
          Object.fromEntries(Object.entries(value).map(([name, item]) => [name, copy(item)]))
        );
      return value;
    };
    return Object.freeze({
      bundleDigest: sha256Bytes(bundleBytes),
      creationEvidenceDigest: sha256Bytes(creationEvidenceBytes),
      operationRef: body.operationRef,
      cleanup: copy(checked.cleanup)
    });
  } catch {
    fail();
  }
}
