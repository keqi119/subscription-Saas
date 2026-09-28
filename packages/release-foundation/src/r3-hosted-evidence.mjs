// Job-key provenance for the hosted workspace and its still-empty Engine.
// This bundle conveys observations only; it grants no manual operation authority.
import { KeyObject, createPublicKey, sign, verify } from "node:crypto";

import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { sha256Bytes } from "./digest.mjs";
import { assessR3ContainerdRaw } from "./r3-containerd-raw.mjs";
import {
  assessR3WorkspaceReport,
  signR3WorkspaceBinding,
  verifyR3WorkspaceBinding
} from "./r3-workspace-report.mjs";

const CODE = "R3_HOSTED_EVIDENCE_INVALID";
const DOMAIN = Buffer.from("subscription-saas/r3-hosted-evidence/v1\n");
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
