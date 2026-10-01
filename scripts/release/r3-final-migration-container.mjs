// Internal owner of one migration container. Its caller must be the live H1
// holder: these callbacks are not an external authorization or plugin surface.
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { finished } from "node:stream/promises";
import { openR3EngineAttach } from "./r3-engine-attach.mjs";
import { runR3MigrationHostChannel } from "./r3-final-migration-channel.mjs";

const CODE = "R3_FINAL_MIGRATION_CONTAINER_FAILED";
const cid = /^[0-9a-f]{64}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const error = () => Object.assign(new Error(CODE), { code: CODE });
const need = (value) => {
  if (!value) throw error();
};
const same = (a, b) => sha256Canonical(a ?? null) === sha256Canonical(b ?? null);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const empty = (value) =>
  value == null || (typeof value === "object" && Object.keys(value).length === 0);
const PATH = "/pnpm:/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin";
const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777",
  // The pinned runner inherits PostgreSQL's VOLUME. This explicit tmpfs stops
  // Docker from creating an anonymous persistent volume for that destination.
  "/var/lib/postgresql/data": "rw,nosuid,nodev,noexec,size=65536,mode=0700,uid=1000,gid=1000"
});

function ownedRunnerContainerSpec(identity, role) {
  need(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      identity?.operationRef
    ) &&
      /^[0-9a-f]{40}$/u.test(identity.sourceSha) &&
      digest.test(identity.imageDigest) &&
      identity.imageReference === `ghcr.io/keqi119/subscription-runner@${identity.imageDigest}` &&
      (role === "runtime" || cid.test(identity.runnerContainerId)) &&
      /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(identity.postgresAddress) &&
      identity.postgresAddress
        .split(".")
        .every((part) => Number(part) <= 255 && String(Number(part)) === part)
  );
  const id = identity.operationRef.replaceAll("-", "");
  return {
    name: `s1r3${role === "runtime" ? "runner" : "migrate"}_${id}`,
    body: {
      Image: identity.imageReference,
      User: "1000:1000",
      WorkingDir: "/app",
      Entrypoint: ["/usr/local/bin/node", "/app/apps/release-runner/src/cli.mjs"],
      Cmd: [],
      Env: [
        `RUNNER_EXECUTION_MODE=r3-final-${role === "runtime" ? "runtime" : "migration"}`,
        "NODE_ENV=production",
        "HOME=/tmp",
        `PATH=${PATH}`
      ],
      Labels: {
        "com.subscription.release.operation-ref": identity.operationRef,
        "com.subscription.release.container-role": role
      },
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: `s1r3net_${id}`,
        PidMode: "",
        IpcMode: "private",
        Privileged: false,
        ReadonlyRootfs: true,
        Init: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        RestartPolicy: { Name: "no" },
        Memory: 1073741824,
        MemorySwap: 1073741824,
        PidsLimit: 256,
        ExtraHosts: [`postgres:${identity.postgresAddress}`],
        Tmpfs: {
          ...TMPFS,
          ...(role === "runtime"
            ? {
                "/app/.release-local":
                  "rw,nosuid,nodev,noexec,size=33554432,mode=0700,uid=1000,gid=1000",
                "/run/launch": "rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000",
                "/run/secrets": "rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000"
              }
            : {})
        },
        PortBindings: {},
        PublishAllPorts: false,
        LogConfig: { Type: "none", Config: {} }
      }
    }
  };
}

export const finalMigrationContainerSpec = (identity) =>
  ownedRunnerContainerSpec(identity, "migration");
export const finalRuntimeContainerSpec = (identity) =>
  ownedRunnerContainerSpec(identity, "runtime");

function inspectOwned(value, spec, id, image) {
  need(value?.Id === id && value.Name === `/${spec.name}` && value.Image === image.Id);
  for (const key of [
    "Image",
    "User",
    "WorkingDir",
    "Entrypoint",
    "OpenStdin",
    "StdinOnce",
    "AttachStdin",
    "AttachStdout",
    "AttachStderr",
    "Tty"
  ])
    need(same(value.Config?.[key], spec.body[key]));
  need(empty(value.Config.Cmd));
  for (const [key, expected] of Object.entries(spec.body.Labels))
    need(value.Config.Labels?.[key] === expected);
  const env = (entries) =>
    new Map(
      entries.map((entry) => {
        const index = entry.indexOf("=");
        need(index > 0);
        return [entry.slice(0, index), entry.slice(index + 1)];
      })
    );
  const expectedEnv = env([...(image.Config?.Env ?? []), ...spec.body.Env]);
  need(
    Array.isArray(value.Config.Env) &&
      value.Config.Env.length === expectedEnv.size &&
      same(Object.fromEntries(env(value.Config.Env)), Object.fromEntries(expectedEnv))
  );
  const host = value.HostConfig;
  for (const key of [
    "NetworkMode",
    "PidMode",
    "IpcMode",
    "Privileged",
    "ReadonlyRootfs",
    "Init",
    "CapDrop",
    "SecurityOpt",
    "Memory",
    "MemorySwap",
    "PidsLimit",
    "ExtraHosts",
    "Tmpfs",
    "PublishAllPorts",
    "LogConfig"
  ])
    need(same(host?.[key], spec.body.HostConfig[key]));
  need(
    host.RestartPolicy?.Name === "no" &&
      !host.AutoRemove &&
      empty(host.Binds) &&
      empty(host.Mounts) &&
      empty(host.VolumesFrom) &&
      empty(host.PortBindings) &&
      empty(host.Devices) &&
      empty(host.DeviceRequests) &&
      empty(host.CapAdd)
  );
  need(
    Array.isArray(value.Mounts) &&
      value.Mounts.length <= Object.keys(spec.body.HostConfig.Tmpfs).length &&
      new Set(value.Mounts.map((m) => m.Destination)).size === value.Mounts.length &&
      value.Mounts.every(
        (m) =>
          m.Type === "tmpfs" &&
          Object.hasOwn(spec.body.HostConfig.Tmpfs, m.Destination) &&
          !m.Source &&
          !m.Name &&
          m.RW === true
      )
  );
  need(
    value.State &&
      value.State.Paused === false &&
      value.State.Restarting === false &&
      value.State.Dead === false
  );
}

function originalJson(bytes) {
  need(typeof bytes === "string" && bytes.length <= 2 * 1024 * 1024);
  const buffer = Buffer.from(bytes, "base64");
  need(buffer.toString("base64") === bytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}

function assessChannelOriginals(role, originals) {
  const { channel, channelBindingDigest: bindingDigest } = originals;
  const runtime = role === "runtime";
  need(
    exact(channel, [runtime ? "result" : "results", "transcript"]) && digest.test(bindingDigest)
  );
  const entries = channel.transcript;
  need(Array.isArray(entries) && entries.length === (runtime ? 49 : 11));
  let sentBytes = 0,
    receivedBytes = 0;
  const frames = entries.map((entry, index) => {
    if (index === 1) {
      need(
        exact(
          entry,
          runtime ? ["sequence", "type", "digest", "bytes"] : ["type", "digest", "bytes"]
        ) &&
          entry.type === "START" &&
          digest.test(entry.digest) &&
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes > 0 &&
          entry.bytes <= (runtime ? 32 * 1024 * 1024 : 1048576)
      );
      if (runtime) need(entry.sequence === index);
      sentBytes += entry.bytes + 1;
      return null;
    }
    if (runtime) need(exact(entry, ["sequence", "type", "raw"]) && entry.sequence === index);
    const raw = runtime ? entry.raw : entry;
    need(typeof raw === "string" && Buffer.byteLength(raw) <= 32 * 1024 * 1024);
    const value = JSON.parse(raw);
    need(
      JSON.stringify(value) === raw &&
        value.sequence === index &&
        value.channel === (runtime ? "r3-final-runtime.v1" : "r3-final-migration.v1") &&
        value.bindingDigest === (index === 0 ? null : bindingDigest)
    );
    if (runtime)
      need(
        exact(value, ["channel", "bindingDigest", "sequence", "type", "payload"]) &&
          value.type === entry.type
      );
    if (index % 2) sentBytes += Buffer.byteLength(raw) + 1;
    else receivedBytes += Buffer.byteLength(raw) + 1;
    return value;
  });
  need(sentBytes + receivedBytes <= (runtime ? 128 : 64) * 1024 * 1024);
  const frame = (index, type, fields) => {
    const value = frames[index];
    need(value.type === type);
    if (runtime) {
      need(exact(value.payload, fields));
      return value.payload;
    }
    need(exact(value, ["channel", "type", "sequence", "bindingDigest", ...fields]));
    return value;
  };
  need(/^[0-9a-f]{64}$/u.test(frame(0, "HELLO", ["challenge"]).challenge));
  if (!runtime) {
    need(
      same(bindingDigest, sha256Canonical(originals.inputIdentity)) &&
        Array.isArray(channel.results) &&
        channel.results.length === 4
    );
    let previous;
    for (const [index, stage] of ["plan", "apply", "verify", "prepare"].entries()) {
      const result = frame(index * 2 + 2, ["PLAN", "APPLIED", "VERIFIED", "PREPARED"][index], [
        "result"
      ]).result;
      const extra = [
        ["baseline", "plan", "originals"],
        ["postStateObservation"],
        ["observation", "originals", "processOriginals"],
        ["preparation"]
      ][index];
      need(
        exact(result, [
          "schemaVersion",
          "stage",
          "bindingDigest",
          "predecessorDigest",
          "baselineManifestIdentityDigest",
          "baselineManifestDigest",
          "planDigest",
          ...extra
        ]) &&
          result.schemaVersion === "r3-final-migration-result.v1" &&
          result.stage === stage &&
          result.bindingDigest === bindingDigest &&
          result.predecessorDigest === (previous ? sha256Canonical(previous) : bindingDigest) &&
          same(result, channel.results[index])
      );
      for (const key of ["baselineManifestIdentityDigest", "baselineManifestDigest", "planDigest"])
        need(digest.test(result[key]) && (!previous || result[key] === previous[key]));
      const next = frame(index * 2 + 3, ["APPLY", "VERIFY", "PREPARE_RUNTIME", "FINISH"][index], [
        "predecessorDigest",
        ...(index === 0 ? ["planDigest"] : [])
      ]);
      need(
        next.predecessorDigest === sha256Canonical(result) &&
          (index !== 0 || next.planDigest === result.planDigest)
      );
      previous = result;
    }
    need(
      frame(10, "FINISHED", ["predecessorDigest"]).predecessorDigest === sha256Canonical(previous)
    );
  } else {
    const { selection } = frame(2, "LIFECYCLE_BEGIN", ["selection"]);
    const envelope = originals.inputIdentity;
    need(
      selection?.suiteId === "node.release-database-lifecycle.postgres" &&
        selection.r3ExecutionMode === "lifecycle-owned" &&
        selection.runId === envelope.runId &&
        selection.chain === envelope.chain &&
        selection.manifestDigest === envelope.databaseTestManifestDigest &&
        selection.discoveryDigest === envelope.databaseTestDiscoveryDigest &&
        same(selection.databaseAssignment, envelope.suiteAssignments[selection.suiteId])
    );
    need(
      frame(3, "LIFECYCLE_READY", ["selectionDigest"]).selectionDigest ===
        sha256Canonical(selection)
    );
    const steps = [
      ["provision", 0],
      ["provision", 1],
      ["migrate", 0],
      ["migrate", 1],
      ["grantRuntimeAccess", 0],
      ["grantRuntimeAccess", 1],
      ["runtimeRole", 0],
      ["migrationOwnership", 0],
      ["attemptRuntimeCreate", 0],
      ["runtimeRole", 1],
      ["migrationOwnership", 1],
      ["attemptRuntimeCreate", 1],
      ["cleanup", 0, "database-name"],
      ["cleanup", 0, "marker"],
      ["cleanup", 0],
      ["countDatabase", 0],
      ["siblingDatabase", 1],
      ["cleanup", 1],
      ["countOwned", null],
      ["complete", null]
    ];
    for (const [index, [action, shard, variant = null]] of steps.entries()) {
      const request = frame(index * 2 + 4, "LIFECYCLE", ["frame"]).frame;
      const reply = frame(index * 2 + 5, "LIFECYCLE", ["frame"]).frame;
      const base = { channel: "r3-lifecycle.v1", bindingDigest, sequence: index + 1 };
      need(
        same(request, { ...base, action, shard, variant }) &&
          Buffer.byteLength(JSON.stringify(request)) + 1 <= 131072 &&
          Buffer.byteLength(JSON.stringify(reply)) + 1 <= 131072
      );
      const denied =
        action === "attemptRuntimeCreate"
          ? "42501"
          : action === "cleanup" && variant
            ? "CLEANUP_IDENTITY_MISMATCH"
            : null;
      if (denied) need(same(reply, { ...base, status: "error", code: denied }));
      else {
        need(
          exact(reply, ["channel", "bindingDigest", "sequence", "status", "value"]) &&
            Object.keys(base).every((key) => reply[key] === base[key]) &&
            reply.status === "ok"
        );
        if (["migrate", "grantRuntimeAccess", "cleanup", "complete"].includes(action))
          need(reply.value === null);
      }
    }
    const observed = frame(44, "LIFECYCLE_ORIGINALS", ["originals"]);
    const assessed = frame(45, "LIFECYCLE_RESULT", ["report", "originals"]);
    need(same(observed.originals, assessed.originals));
    const result = frame(46, "MANIFEST_RESULT", ["result"]).result;
    need(same(result, channel.result));
    const resultDigest = sha256Canonical(result);
    need(
      frame(47, "FINISH", ["resultDigest"]).resultDigest === resultDigest &&
        frame(48, "FINISHED", ["resultDigest"]).resultDigest === resultDigest
    );
  }
  const transport = originals.transport;
  need(
    exact(transport, [
      "status",
      "startedAt",
      "finishedAt",
      "frames",
      "receivedBytes",
      "sentBytes",
      "socketClosed"
    ]) &&
      transport.status === "STREAM_ENDED" &&
      transport.socketClosed === true &&
      transport.receivedBytes === receivedBytes &&
      transport.sentBytes === sentBytes &&
      Number.isSafeInteger(transport.frames) &&
      transport.frames > 0
  );
  for (const key of ["startedAt", "finishedAt"])
    need(
      typeof transport[key] === "string" &&
        new Date(transport[key]).toISOString() === transport[key]
    );
  need(Date.parse(transport.finishedAt) >= Date.parse(transport.startedAt));
}

// Independent reconstruction from retained owner originals. This proves neither
// H1 admission nor the database results: its caller must validate those bindings
// and each result separately. Redacted START hashes are format-checked only.
export function assessR3FinalContainerOriginals({ identity, role, originals }) {
  try {
    need(role === "runtime" || role === "migration");
    const spec = ownedRunnerContainerSpec(identity, role);
    need(
      exact(originals, [
        "exchanges",
        "deleted",
        "containerId",
        "inputIdentity",
        "channelBindingDigest",
        "attachmentReadyExchangeCount",
        "channelStartExchangeCount",
        "channelEndExchangeCount",
        "channel",
        "exit",
        "transport",
        "trailingBytes",
        "stopped",
        "stderrBase64"
      ])
    );
    need(
      Array.isArray(originals.exchanges) &&
        originals.exchanges.length === 9 &&
        originals.attachmentReadyExchangeCount === 3 &&
        originals.channelStartExchangeCount === 5 &&
        originals.channelEndExchangeCount === 5 &&
        originals.deleted === true &&
        originals.trailingBytes === 0 &&
        originals.stderrBase64 === ""
    );
    const id = originals.containerId;
    need(cid.test(id) && id !== identity.runnerContainerId);
    const exchange = (index, method, url, status, requestBody = null) => {
      const value = originals.exchanges[index];
      need(
        exact(value, ["method", "url", "status", "requestBody", "bodyBase64"]) &&
          value.method === method &&
          value.url === url &&
          value.status === status &&
          same(value.requestBody, requestBody)
      );
      if (status === 204) {
        need(value.bodyBase64 === "");
        return null;
      }
      return originalJson(value.bodyBase64);
    };
    const image = exchange(
      0,
      "GET",
      `/images/${encodeURIComponent(identity.imageReference)}/json`,
      200
    );
    need(
      digest.test(image.Id) &&
        image.Os === "linux" &&
        image.Architecture === "amd64" &&
        image.RepoDigests?.includes(identity.imageReference) &&
        image.Config?.Labels?.["org.opencontainers.image.revision"] === identity.sourceSha
    );
    const created = exchange(1, "POST", `/containers/create?name=${spec.name}`, 201, spec.body);
    need(created.Id === id && empty(created.Warnings));
    const before = exchange(2, "GET", `/containers/${id}/json`, 200);
    inspectOwned(before, spec, id, image);
    need(
      before.State.Status === "created" && before.State.Running === false && before.State.Pid === 0
    );
    exchange(3, "POST", `/containers/${id}/start`, 204);
    const running = exchange(4, "GET", `/containers/${id}/json`, 200);
    inspectOwned(running, spec, id, image);
    need(
      running.State.Status === "running" &&
        running.State.Running === true &&
        Number.isSafeInteger(running.State.Pid) &&
        running.State.Pid > 0
    );
    const exit = exchange(5, "POST", `/containers/${id}/wait?condition=not-running`, 200);
    const stopped = exchange(6, "GET", `/containers/${id}/json`, 200);
    inspectOwned(stopped, spec, id, image);
    need(
      same(exit, originals.exit) &&
        same(stopped, originals.stopped) &&
        exit.StatusCode === 0 &&
        !exit.Error?.Message &&
        stopped.State.Status === "exited" &&
        stopped.State.Running === false &&
        stopped.State.Pid === 0 &&
        stopped.State.ExitCode === 0 &&
        stopped.State.OOMKilled === false &&
        stopped.State.Error === ""
    );
    exchange(7, "DELETE", `/containers/${id}?force=1&v=1`, 204);
    const absent = exchange(8, "GET", `/containers/${id}/json`, 404);
    need(
      exact(absent, ["message"]) && typeof absent.message === "string" && absent.message.length > 0
    );
    const input = originals.inputIdentity;
    need(
      input?.schemaVersion ===
        (role === "runtime" ? "database-test-launch-envelope.v2" : "r3-final-migration-input.v1") &&
        input.phase === "final" &&
        input.operationId === identity.operationRef &&
        input.sourceSha === identity.sourceSha &&
        input.actualRunnerDigest === identity.imageDigest &&
        (role === "runtime"
          ? input.runnerContainerId === id
          : input.migrationContainerId === id &&
            input.runnerContainerId === identity.runnerContainerId)
    );
    assessChannelOriginals(role, originals);
    return Object.freeze({
      containerId: id,
      bindingDigest: originals.channelBindingDigest,
      ...(role === "runtime"
        ? { resultDigest: sha256Canonical(originals.channel.result) }
        : { resultDigests: Object.freeze(originals.channel.results.map(sha256Canonical)) })
    });
  } catch {
    throw error();
  }
}

// Every request uses the holder's checked Engine transport. register() keeps
// the returned CID held even on partial failure; unregister() is reached only
// after DELETE and a separate 404 readback. prepare() derives input/credential
// from that same holder, and assess() must independently check each stage.
async function executeOwnedRunnerContainer({
  identity,
  signal,
  engineCall,
  recheck,
  register,
  unregister,
  prepare,
  assess,
  started = async () => {},
  role,
  runChannel,
  openAttach = openR3EngineAttach
}) {
  identity = structuredClone(identity);
  const spec = ownedRunnerContainerSpec(identity, role);
  need(
    signal?.addEventListener &&
      !signal.aborted &&
      [
        engineCall,
        recheck,
        register,
        unregister,
        prepare,
        assess,
        started,
        openAttach,
        runChannel
      ].every((fn) => typeof fn === "function")
  );
  const originals = { exchanges: [], deleted: false };
  let id,
    owned = false,
    attachment,
    channel,
    failure,
    prepared,
    stderrBytes = 0;
  const stderr = [];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const live = () => need(!signal.aborted && !controller.signal.aborted);
  const call = async (method, url, body, status, options) => {
    const bytes = await engineCall(method, url, body, status, options);
    need(Buffer.isBuffer(bytes));
    originals.exchanges.push({
      method,
      url,
      status,
      requestBody: structuredClone(body ?? null),
      bodyBase64: bytes.toString("base64")
    });
    return bytes;
  };
  const json = async (...args) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await call(...args)));
  const bounded = async (work, ms) => {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(error());
          }, ms);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await recheck();
    live();
    const image = await json(
      "GET",
      `/images/${encodeURIComponent(identity.imageReference)}/json`,
      undefined,
      200
    );
    need(
      digest.test(image.Id) &&
        image.Os === "linux" &&
        image.Architecture === "amd64" &&
        image.RepoDigests?.includes(identity.imageReference) &&
        image.Config?.Labels?.["org.opencontainers.image.revision"] === identity.sourceSha
    );
    const created = await json("POST", `/containers/create?name=${spec.name}`, spec.body, 201);
    need(
      cid.test(created.Id) && created.Id !== identity.runnerContainerId && empty(created.Warnings)
    );
    id = created.Id;
    originals.containerId = id;
    await register(id);
    const before = await json("GET", `/containers/${id}/json`, undefined, 200);
    inspectOwned(before, spec, id, image);
    owned = true;
    need(
      before.State.Status === "created" && before.State.Running === false && before.State.Pid === 0
    );
    prepared = await prepare(id);
    live();
    const input = role === "runtime" ? prepared?.input?.envelope : prepared?.input;
    need(
      (role === "runtime"
        ? input?.runnerContainerId === id
        : input?.migrationContainerId === id &&
          input.runnerContainerId === identity.runnerContainerId) &&
        input.operationId === identity.operationRef &&
        input.sourceSha === identity.sourceSha &&
        input.actualRunnerDigest === identity.imageDigest
    );
    originals.inputIdentity = structuredClone(input);
    originals.channelBindingDigest = sha256Canonical(prepared.input);
    attachment = openAttach({ containerId: id, signal: controller.signal });
    attachment.stderr.on("data", (bytes) => {
      stderrBytes += bytes.length;
      if (stderrBytes > 2097152) controller.abort();
      else stderr.push(Buffer.from(bytes));
    });
    need(typeof attachment.ready?.then === "function");
    await attachment.ready;
    originals.attachmentReadyExchangeCount = originals.exchanges.length;
    live();
    await call("POST", `/containers/${id}/start`, undefined, 204);
    const running = await json("GET", `/containers/${id}/json`, undefined, 200);
    inspectOwned(running, spec, id, image);
    need(
      running.State.Running === true &&
        Number.isSafeInteger(running.State.Pid) &&
        running.State.Pid > 0
    );
    await started(id);
    await recheck();
    live();
    // HELLO remains buffered in attach.stdout until this independent running
    // inspection completes. No credential is sent before that boundary.
    originals.channelStartExchangeCount = originals.exchanges.length;
    channel = runChannel({
      ...prepared,
      incoming: attachment.stdout,
      outgoing: attachment.stdin,
      signal: controller.signal,
      assess: async (stage) => {
        await recheck();
        live();
        await assess(stage);
        live();
      }
    });
    channel.catch(() => {});
    const result = await channel;
    originals.channelEndExchangeCount = originals.exchanges.length;
    if (role === "migration") prepared.credential = null;
    else prepared.input.credentials = null;
    originals.channel = result;
    let trailingBytes = 0;
    attachment.stdout.on("data", (bytes) => {
      trailingBytes += bytes.length;
    });
    attachment.stdout.resume();
    originals.exit = await json(
      "POST",
      `/containers/${id}/wait?condition=not-running`,
      undefined,
      200,
      { timeout: 15000 }
    );
    [originals.transport] = await bounded(
      Promise.all([
        attachment.completed,
        finished(attachment.stdout, { writable: false }),
        finished(attachment.stderr, { writable: false })
      ]),
      15000
    );
    originals.trailingBytes = trailingBytes;
    const stopped = await json("GET", `/containers/${id}/json`, undefined, 200);
    inspectOwned(stopped, spec, id, image);
    originals.stopped = stopped;
    need(
      originals.exit.StatusCode === 0 &&
        !originals.exit.Error?.Message &&
        stopped.State.Status === "exited" &&
        stopped.State.Running === false &&
        stopped.State.Pid === 0 &&
        stopped.State.ExitCode === 0 &&
        stopped.State.OOMKilled === false &&
        stopped.State.Error === "" &&
        originals.transport.status === "STREAM_ENDED" &&
        originals.transport.socketClosed === true &&
        stderrBytes === 0 &&
        trailingBytes === 0
    );
    live();
  } catch (cause) {
    failure = error();
    Object.defineProperty(failure, "cause", { value: cause });
    if (cause?.originals) originals.failure = cause.originals;
  } finally {
    controller.abort();
    if (prepared) {
      if (role === "migration") prepared.credential = null;
      else if (prepared.input) prepared.input.credentials = null;
    }
    try {
      await attachment?.close();
    } catch (cause) {
      failure ??= error();
      Object.defineProperty(failure, "transportError", { value: cause });
    }
    await channel?.catch(() => {});
    originals.stderrBase64 = Buffer.concat(stderr).toString("base64");
    if (owned) {
      try {
        // force targets only the exact, previously inspected CID. A failing
        // process is still cleaned up, but cannot produce a successful result.
        await call("DELETE", `/containers/${id}?force=1&v=1`, undefined, 204, { timeout: 15000 });
        await call("GET", `/containers/${id}/json`, undefined, 404);
        originals.deleted = true;
        await unregister(id);
      } catch (cause) {
        failure ??= error();
        Object.defineProperty(failure, "cleanupError", { value: cause });
      }
    }
    signal.removeEventListener("abort", onAbort);
  }
  if (failure) {
    Object.defineProperty(failure, "originals", { value: originals });
    throw failure;
  }
  return Object.freeze({
    containerId: id,
    ...(role === "runtime"
      ? { result: originals.channel.result }
      : { results: originals.channel.results }),
    transcript: originals.channel.transcript,
    exit: originals.exit,
    deleted: originals.deleted,
    originals
  });
}

export const executeR3FinalMigrationContainer = (options) =>
  executeOwnedRunnerContainer({
    ...options,
    role: "migration",
    runChannel: runR3MigrationHostChannel
  });

// Same held-CID lifecycle, but prepare(id) finishes ordinary migrations while
// this runtime is still stopped. Its fixed channel receives runtime credentials
// only after attach, start and independent running inspection.
export async function executeR3FinalRuntimeContainer(options) {
  const { runR3FinalHostChannel } = await import("./r3-final-runtime-channel.mjs");
  return executeOwnedRunnerContainer({
    ...options,
    role: "runtime",
    runChannel: (channel) =>
      runR3FinalHostChannel({
        ...channel,
        lifecycleAdapter: options.lifecycleAdapter,
        assessLifecycle: options.assessLifecycle,
        assessResult: channel.assess
      })
  });
}
