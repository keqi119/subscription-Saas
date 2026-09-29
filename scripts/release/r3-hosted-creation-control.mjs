// Hosted job only. The one-shot HTTP 202 acknowledges receipt after H1 has
// durably consumed the manual operation; it is not an authorization, creation
// success, destination decision or cleanup receipt.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import net from "node:net";
import childProcess from "node:child_process";
import {
  encodeManualJson,
  validateManualTargetCreationRequest
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  createR3HostedWorkspace,
  cleanupR3HostedWorkspace
} from "./r3-hosted-workspace-create.mjs";
import { assessR3PostgresResources } from "./r3-postgres-observation.mjs";
import { observeR3ManagedContainerd } from "./r3-containerd-observation.mjs";
import {
  buildR3HostedEvidence,
  buildR3HostedCleanupEvidence
} from "../../packages/release-foundation/src/r3-hosted-evidence.mjs";

const CODE = "R3_HOSTED_CREATION_CONTROL_INVALID";
const LIMIT = 1048576;
const ROOT = "/dev/shm/stage1-keys";
const TMPFS_MAGIC = 0x01021994n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
  return { bytes: copy, value };
}
function epoch(value) {
  requireThat(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value
  );
  return Date.parse(value);
}
function closedError(cause, evidence) {
  return Object.assign(new Error(CODE), { code: CODE, evidence, causeCode: cause?.code ?? null });
}
function ref(bytes) {
  return { digest: sha256Bytes(bytes), bytes: bytes.length };
}
function freeze(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function copyResult(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copyResult);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyResult(item)]));
  return value;
}
function statIdentity(stat) {
  return Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs", "rdev"].map(
      (key) => [key, String(stat[key])]
    )
  );
}
function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function absent(file) {
  try {
    await fs.lstat(file, { bigint: true });
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
async function privateKeyRoot() {
  requireThat(process.platform === "linux" && process.getuid?.() === 0);
  for (const file of ["/", "/dev", "/dev/shm", ROOT]) {
    const stat = await fs.lstat(file, { bigint: true });
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0n);
    if (file === ROOT) requireThat((stat.mode & 0o777n) === 0o700n);
  }
  const stat = await fs.statfs(ROOT, { bigint: true });
  requireThat(stat.type === TMPFS_MAGIC);
}
function boundInputs(spec, job, specBytes) {
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
    spec.schemaVersion === "manual-r3-creation-spec.v1" &&
      job.schemaVersion === "manual-r3-job-admission.v1" &&
      UUID.test(spec.operationRef) &&
      job.operationRef === spec.operationRef &&
      job.creationSpecDigest === sha256Bytes(specBytes) &&
      ["profileDigest", "ownerId", "buildProofDigest", "sourceSha", "phase", "chain"].every(
        (key) => job[key] === spec[key]
      ) &&
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
  requireThat(
    spec.workspace.id === id &&
      spec.workspace.keyFile === `${ROOT}/${id}.key` &&
      spec.workspace.mountPath === `/srv/stage1-snapshot/${id}` &&
      Number.isSafeInteger(spec.workspace.capacityBytes) &&
      spec.workspace.capacityBytes >= 64 * 1048576
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
  exact(job.host, [
    "machineIdFingerprint",
    "forwardingPublicKeyPem",
    "forwardingKeyFingerprint",
    "runnerId",
    "runnerName"
  ]);
  const now = Date.now();
  requireThat(
    epoch(spec.createdAt) <= epoch(job.generatedAt) &&
      epoch(job.generatedAt) <= now &&
      now < epoch(job.expiresAt) &&
      epoch(job.expiresAt) <= epoch(spec.expiresAt)
  );
  return { id, socketPath: `${ROOT}/${id}.sock` };
}
async function currentJob(spec, job) {
  const ci = job.ci;
  requireThat(Date.now() < epoch(job.expiresAt) && Date.now() < epoch(spec.expiresAt));
  const machine = new TextDecoder("utf-8", { fatal: true })
    .decode(await fs.readFile("/etc/machine-id"))
    .trim();
  requireThat(
    /^[0-9a-f]{32}$/u.test(machine) &&
      job.host.machineIdFingerprint ===
        sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`))
  );
  requireThat(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_OS === "Linux" &&
      process.env.GITHUB_REPOSITORY === ci.repository &&
      process.env.GITHUB_REPOSITORY_ID === ci.repositoryId &&
      process.env.GITHUB_SHA === spec.sourceSha &&
      process.env.GITHUB_RUN_ID === ci.runId &&
      process.env.GITHUB_RUN_ATTEMPT === String(ci.runAttempt) &&
      process.env.GITHUB_JOB === ci.jobKey &&
      process.env.RUNNER_NAME === job.host.runnerName &&
      process.env.GITHUB_WORKFLOW_REF ===
        `${ci.repository}/${ci.callerWorkflowPath}@${process.env.GITHUB_REF}`
  );
  return machine;
}
async function readBody(request, length) {
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    requireThat(size <= LIMIT && size <= length);
    parts.push(Buffer.from(chunk));
  }
  requireThat(size === length);
  return Buffer.concat(parts);
}
async function getEngine(socketPath, url) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: url, method: "GET", headers: { Connection: "close" } },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (part) => {
          size += part.length;
          if (size > LIMIT) {
            request.destroy();
            return;
          }
          chunks.push(Buffer.from(part));
        });
        response.once("end", () => {
          if (size > LIMIT || response.statusCode !== 200) {
            reject(Object.assign(closedError(), { status: response.statusCode }));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(2000, () => request.destroy());
    request.once("error", reject);
    request.end();
  });
}
// Private, fixed-use cleanup transport. Callers never supply a path or method.
async function cleanupExchange(socketPath, method, url) {
  return new Promise((resolve, reject) => {
    let timer,
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const request = http.request(
      { socketPath, path: url, method, headers: { Connection: "close", "Content-Length": "0" } },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (part) => {
          size += part.length;
          if (size > LIMIT) {
            const error = closedError();
            request.destroy(error);
            finish(error);
          } else chunks.push(Buffer.from(part));
        });
        response.once("end", () =>
          finish(null, { status: response.statusCode, bytes: Buffer.concat(chunks) })
        );
        response.once("error", (error) => finish(error));
        response.once("aborted", () => finish(closedError()));
      }
    );
    // An idle timeout alone never ends a peer that keeps trickling bytes.
    timer = setTimeout(() => {
      const error = closedError();
      request.destroy(error);
      finish(error);
    }, 15000);
    request.once("error", (error) => finish(error));
    request.end();
  });
}
async function waitReady(socketPath, child, exitState, shouldClose) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    requireThat(!shouldClose() && exitState.value === null);
    try {
      const ping = await getEngine(socketPath, "/_ping");
      requireThat(ping.equals(Buffer.from("OK")));
      return ping;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail();
}
async function startEngine(workspaceResult, expectedWorkspace, socketPath, shouldClose) {
  // Otherwise dockerd silently adopts the system containerd, whose persistent
  // metadata would escape the operation's encrypted data/exec roots. Hosted
  // job preparation must stop its default Docker/containerd services first.
  requireThat(await absent("/run/containerd/containerd.sock"));
  const observation = workspaceResult?.observation?.observation;
  requireThat(
    observation?.status === "OBSERVED" &&
      observation?.facts?.state === "active" &&
      workspaceResult.creation?.status === "WORKSPACE_OBSERVED" &&
      encodeManualJson(observation.workspace).equals(encodeManualJson(expectedWorkspace))
  );
  const mount = observation.workspace.mountPath;
  requireThat(typeof mount === "string" && /^\/srv\/stage1-snapshot\/[0-9a-f]{32}$/u.test(mount));
  const mountEvidence = observation.files?.filter(
    (file) => file.path === mount && file.name === "directory" && file.exists === true
  );
  requireThat(mountEvidence?.length === 1 && mountEvidence[0].identity);
  const dataRoot = `${mount}/docker`,
    execRoot = `${mount}/exec`,
    tmpRoot = `${mount}/tmp`,
    home = `${mount}/home`,
    configPath = `${mount}/daemon.json`,
    logPath = `${mount}/daemon.log`,
    pidfile = `${mount}/dockerd.pid`;
  for (const directory of [dataRoot, execRoot, tmpRoot, home])
    await fs.mkdir(directory, { mode: 0o700 });
  const config = freeze({
    "data-root": dataRoot,
    "exec-root": execRoot,
    pidfile: pidfile,
    hosts: [`unix://${socketPath}`],
    "storage-driver": "overlay2",
    "log-driver": "json-file",
    features: { "containerd-snapshotter": false },
    bridge: "none",
    iptables: false,
    ip6tables: false,
    "ip-forward": false,
    "ip-masq": false,
    "userland-proxy": false,
    "live-restore": false
  });
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW |
    constants.O_CLOEXEC;
  const configFile = await fs.open(configPath, flags, 0o600);
  try {
    await configFile.writeFile(encodeManualJson(config));
  } finally {
    await configFile.close();
  }
  const logFile = await fs.open(logPath, flags, 0o600);
  let child, exited, exitState;
  const attempt = {
    command: "/usr/bin/dockerd",
    configPath,
    logPath,
    startedAt: null,
    pid: null,
    exit: null,
    rawRefs: {}
  };
  try {
    const command = "/usr/bin/dockerd";
    const before = await fs.stat(command, { bigint: true });
    requireThat(
      before.isFile() &&
        before.uid === 0n &&
        (before.mode & 0o022n) === 0n &&
        (before.mode & 0o111n) !== 0n
    );
    const args = ["--config-file", configPath];
    const env = {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LC_ALL: "C",
      LANG: "C",
      HOME: home,
      DOCKER_TMPDIR: tmpRoot,
      TMPDIR: tmpRoot
    };
    attempt.startedAt = new Date().toISOString();
    child = childProcess.spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
      env
    });
    attempt.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    child.once("error", () => {});
    exitState = { value: null };
    exited = new Promise((resolve) => {
      child.once("close", (exitCode, signal) => {
        exitState.value = freeze({
          pid: child.pid,
          exitCode,
          signal,
          closedAt: new Date().toISOString()
        });
        resolve(exitState.value);
      });
    });
    requireThat(Number.isSafeInteger(child.pid) && child.pid > 0);
    requireThat(
      JSON.stringify(statIdentity(before)) ===
        JSON.stringify(statIdentity(await fs.stat(command, { bigint: true })))
    );
    const ping = await waitReady(socketPath, child, exitState, shouldClose);
    attempt.rawRefs.ping = ref(ping);
    const infoBytes = await getEngine(socketPath, "/v1.45/info");
    attempt.rawRefs.info = ref(infoBytes);
    const versionBytes = await getEngine(socketPath, "/v1.45/version");
    attempt.rawRefs.version = ref(versionBytes);
    const info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(infoBytes));
    const version = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(versionBytes));
    requireThat(
      info &&
        typeof info === "object" &&
        UUID.test(info.ID) &&
        info.DockerRootDir === dataRoot &&
        info.Driver === "overlay2" &&
        info.LoggingDriver === "json-file" &&
        info.Containers === 0 &&
        info.Images === 0 &&
        Array.isArray(info.DriverStatus) &&
        info.DriverStatus.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 2 &&
            row.every((cell) => typeof cell === "string") &&
            row[0] !== "driver-type"
        ) &&
        version &&
        typeof version.Version === "string" &&
        typeof version.ApiVersion === "string" &&
        !shouldClose() &&
        exitState.value === null
    );
    requireThat(await absent("/run/containerd/containerd.sock"));
    const socket = await fs.lstat(socketPath, { bigint: true });
    requireThat(socket.isSocket() && socket.uid === 0n);
    const containerd = await observeR3ManagedContainerd({
      mountPath: mount,
      dockerdPid: child.pid
    });
    requireThat(!shouldClose() && exitState.value === null);
    requireThat(
      containerd.facts.mount.path === mount &&
        containerd.facts.mount.dev === mountEvidence[0].identity.dev &&
        containerd.facts.mount.ino === mountEvidence[0].identity.ino
    );
    const containerdDigest = sha256Canonical(containerd.facts);
    const rawInputs = { ping, info: infoBytes, version: versionBytes };
    for (const [name, bytes] of Object.entries(containerd.rawInputs)) {
      rawInputs[`containerd.${name}`] = Buffer.from(bytes);
      attempt.rawRefs[`containerd.${name}`] = ref(bytes);
    }
    const recheck = async () => {
      requireThat(!shouldClose() && exitState.value === null);
      requireThat(await absent("/run/containerd/containerd.sock"));
      const current = await observeR3ManagedContainerd({ mountPath: mount, dockerdPid: child.pid });
      requireThat(sha256Canonical(current.facts) === containerdDigest);
      requireThat(!shouldClose() && exitState.value === null);
    };
    const result = freeze({
      id: info.ID,
      info,
      version,
      process: {
        pid: child.pid,
        command,
        args,
        executable: statIdentity(before),
        startedAt: attempt.startedAt,
        logPath
      },
      containerd: containerd.facts,
      rawRefs: Object.fromEntries(
        Object.entries(rawInputs).map(([name, bytes]) => [name, ref(bytes)])
      ),
      promotionEligible: false
    });
    return {
      result,
      rawInputs,
      recheck,
      child,
      exited,
      exitState,
      socket
    };
  } catch (cause) {
    if (child && exitState?.value === null) {
      child.kill("SIGTERM");
      const exit = await Promise.race([
        exited,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 2000);
          timer.unref();
        })
      ]);
      if (!exit) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    attempt.exit = exitState?.value ?? null;
    throw Object.assign(new Error(CODE), {
      code: CODE,
      engineAttempt: freeze({
        ...attempt,
        rawRefs: { ...attempt.rawRefs },
        containerdFailure:
          cause?.code === "R3_CONTAINERD_OBSERVATION_INVALID"
            ? { code: cause.code, rawInputs: cause.rawInputs ?? {} }
            : null
      })
    });
  } finally {
    await logFile.close();
  }
}

// Docker's internal bridge does not program published ports. Keep that network
// private and forward opaque TLS bytes in this already-owned control process.
// No caller can choose a target, port or command; every connection reobserves
// the same Engine/CID/network/volume before any client bytes are forwarded.
async function startPostgresRelay({ spec, job, engine, socketPath, shouldClose }) {
  const catalog = JSON.parse(
    await fs.readFile(
      new URL("../../release/contracts/database-target-policies.v1.json", import.meta.url),
      "utf8"
    )
  );
  const policy = catalog.policies.filter(
    (item) => item.policyId === "s1-release-compose-ephemeral"
  );
  requireThat(policy.length === 1 && /^sha256:[0-9a-f]{64}$/u.test(policy[0].requiredImageDigest));
  const imageDigest = policy[0].requiredImageDigest;
  const id = spec.operationRef.replaceAll("-", "");
  const names = { container: `s1r3pg_${id}`, network: `s1r3net_${id}`, volume: `s1r3data_${id}` };
  const sockets = new Set();
  let relay,
    timer,
    closed = false;
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (relay?.listening)
      await new Promise((resolve, reject) =>
        relay.close((error) => (error ? reject(error) : resolve()))
      );
  };
  const alive = async () => {
    requireThat(!closed && !shouldClose() && engine.exitState.value === null);
    await currentJob(spec, job);
    await engine.recheck();
  };
  const read = async (url) => {
    const bytes = await getEngine(socketPath, `/v1.45${url}`);
    return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  };
  const observe = async (waitForContainer = false) => {
    await alive();
    let container;
    try {
      container = await read(`/containers/${names.container}/json`);
    } catch (error) {
      if (waitForContainer && error.status === 404) return null;
      throw error;
    }
    if (waitForContainer && container.value.State?.Status === "created") return null;
    const info = await read("/info");
    const image = await read(
      `/images/${encodeURIComponent(`postgres:17-bookworm@${imageDigest}`)}/json`
    );
    const network = await read(`/networks/${names.network}`);
    const volume = await read(`/volumes/${names.volume}`);
    const facts = assessR3PostgresResources({
      operationRef: spec.operationRef,
      workspaceMountPath: spec.workspace.mountPath,
      engineId: engine.result.id,
      imageDigest,
      engine: info.value,
      image: image.value,
      container: container.value,
      network: network.value,
      volume: volume.value
    });
    await alive();
    return {
      facts,
      rawInputs: {
        info: info.bytes,
        image: image.bytes,
        container: container.bytes,
        network: network.bytes,
        volume: volume.bytes
      }
    };
  };
  try {
    const deadline = Math.min(Date.now() + 600000, epoch(job.expiresAt), epoch(spec.expiresAt));
    let observed;
    while (!observed) {
      observed = await observe(true);
      if (!observed) {
        requireThat(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const track = (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      return socket;
    };
    relay = net.createServer({ pauseOnConnect: true }, (incoming) => {
      track(incoming);
      void (async () => {
        const current = await observe();
        requireThat(sha256Canonical(current.facts) === sha256Canonical(observed.facts));
        if (incoming.destroyed) return;
        const upstream = track(
          net.createConnection({ host: observed.facts.containerAddress, port: 5432 })
        );
        incoming.once("close", () => upstream.destroy());
        upstream.once("close", () => incoming.destroy());
        upstream.once("connect", () => {
          incoming.pipe(upstream).pipe(incoming);
          incoming.resume();
        });
      })().catch(() => {
        void close().catch(() => {});
      });
    });
    await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(55441, "127.0.0.1", () => {
        relay.off("error", reject);
        resolve();
      });
    });
    relay.on("error", () => {
      void close().catch(() => {});
    });
    await alive();
    timer = setTimeout(
      () => {
        void close().catch(() => {});
      },
      Math.min(epoch(job.expiresAt), epoch(spec.expiresAt)) - Date.now()
    );
    return {
      result: freeze({
        ...observed.facts,
        listener: { address: "127.0.0.1", port: 55441, pid: process.pid },
        promotionEligible: false
      }),
      rawInputs: observed.rawInputs,
      async recheck() {
        const current = await observe();
        requireThat(sha256Canonical(current.facts) === sha256Canonical(observed.facts));
        return current;
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openR3HostedCreationControl(input) {
  let server,
    ownSocket,
    engine = null,
    evidenceSeed = null,
    accepted = false,
    closing = false,
    createdSettled = false,
    handler = null,
    listenerClosing,
    expiryTimer;
  let postgresRelay, relayWork;
  let ownedWorkspace, cleanupWork, cleanupResult;
  let cleanupAttempted = false;
  let resolveForward, rejectForward;
  const postgresForward = new Promise((resolve, reject) => {
    resolveForward = resolve;
    rejectForward = reject;
  });
  postgresForward.catch(() => {});
  const sockets = new Set();
  let resolveCreated, rejectCreated;
  const created = new Promise((resolve, reject) => {
    resolveCreated = resolve;
    rejectCreated = reject;
  });
  created.catch(() => {});
  const settle = (error, value) => {
    if (createdSettled) return;
    createdSettled = true;
    if (error) rejectCreated(error);
    else resolveCreated(value);
  };
  const closeListener = () => {
    if (listenerClosing) return listenerClosing;
    listenerClosing = (async () => {
      if (server?.listening) {
        if (ownSocket) {
          const current = await fs.lstat(ownSocket.path, { bigint: true });
          requireThat(current.isSocket() && sameInode(current, ownSocket.stat));
        }
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
      if (ownSocket) {
        try {
          const current = await fs.lstat(ownSocket.path, { bigint: true });
          requireThat(current.isSocket() && sameInode(current, ownSocket.stat));
          await fs.unlink(ownSocket.path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    })();
    return listenerClosing;
  };
  const stopControl = async () => {
    closing = true;
    clearTimeout(expiryTimer);
    if (!accepted) settle(closedError(), null);
    for (const socket of sockets) socket.destroy();
    if (handler) await handler.catch(() => {});
    if (relayWork) await relayWork.catch(() => {});
    else rejectForward(closedError());
    await postgresRelay?.close();
    await closeListener();
    let exit = null;
    if (engine) {
      if (engine.exitState.value === null) engine.child.kill("SIGTERM");
      const waitForExit = async (milliseconds) => {
        let timer;
        try {
          return await Promise.race([
            engine.exited,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), milliseconds);
            })
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      exit = await waitForExit(10000);
      if (!exit) {
        engine.child.kill("SIGKILL");
        exit = await waitForExit(2000);
      }
      if (!exit || exit.exitCode !== 0 || exit.signal !== null)
        throw closedError(null, {
          enginePid: engine.child.pid,
          engineExit: exit,
          workspaceRemoved: false,
          keyRemoved: false
        });
    }
    return freeze({
      engine: exit,
      workspaceRemoved: Boolean(cleanupResult),
      keyRemoved: Boolean(cleanupResult)
    });
  };
  const close = async () => {
    if (cleanupWork) await cleanupWork.catch(() => {});
    return stopControl();
  };
  try {
    exact(input, ["creationSpecBytes", "jobAdmissionBytes"]);
    const specInput = parse(input.creationSpecBytes),
      jobInput = parse(input.jobAdmissionBytes);
    const spec = specInput.value,
      job = jobInput.value;
    const { socketPath } = boundInputs(spec, job, specInput.bytes);
    await privateKeyRoot();
    await currentJob(spec, job);
    requireThat(await absent(socketPath));
    server = http.createServer((request, response) => {
      if (accepted || closing) {
        response.writeHead(409, { "Content-Length": "0", Connection: "close" }).end();
        return;
      }
      accepted = true;
      clearTimeout(expiryTimer);
      handler = (async () => {
        let workspaceResult;
        try {
          request.setTimeout(10000, () => request.destroy());
          requireThat(
            request.method === "POST" &&
              request.url === "/stage1-r3/target-create" &&
              request.headers["content-type"] === "application/json" &&
              request.headers["transfer-encoding"] === undefined &&
              typeof request.headers["content-length"] === "string" &&
              /^(?:0|[1-9][0-9]*)$/u.test(request.headers["content-length"])
          );
          const length = Number(request.headers["content-length"]);
          requireThat(Number.isSafeInteger(length) && length > 0 && length <= LIMIT);
          const received = parse(await readBody(request, length));
          exact(received.value, ["request", "authorization"]);
          const requestBytes = encodeManualJson(received.value.request);
          const authorizationBytes = encodeManualJson(received.value.authorization);
          const operation = validateManualTargetCreationRequest(received.value.request);
          requireThat(
            operation.operationId === spec.operationRef &&
              operation.creationSpecDigest === sha256Bytes(specInput.bytes) &&
              operation.jobAdmissionDigest === sha256Bytes(jobInput.bytes) &&
              operation.phase === spec.phase &&
              operation.chain === spec.chain
          );
          await currentJob(spec, job);
          requireThat(!closing);
          await new Promise((resolve) => {
            response.writeHead(202, { "Content-Length": "0", Connection: "close" });
            response.end(resolve);
          });
          if (!request.socket.destroyed)
            await new Promise((resolve) => {
              request.socket.once("close", resolve);
              request.socket.end();
            });
          await closeListener();
          requireThat(!closing && (await absent(socketPath)));
          workspaceResult = await createR3HostedWorkspace({
            requestBytes,
            authorizationBytes,
            creationSpecBytes: specInput.bytes,
            jobAdmissionBytes: jobInput.bytes
          });
          ownedWorkspace = workspaceResult;
          requireThat(!closing);
          await currentJob(spec, job);
          engine = await startEngine(workspaceResult, spec.workspace, socketPath, () => closing);
          evidenceSeed = copyResult({
            workspace: workspaceResult,
            engine: engine.result,
            rawInputs: engine.rawInputs,
            promotionEligible: false
          });
          relayWork = startPostgresRelay({
            spec,
            job,
            engine,
            socketPath,
            shouldClose: () => closing
          }).then(
            (value) => {
              postgresRelay = value;
              resolveForward(freeze({ observation: value.result, rawInputs: value.rawInputs }));
            },
            (error) => {
              rejectForward(closedError(error));
            }
          );
          settle(
            null,
            freeze({
              workspace: workspaceResult,
              engine: engine.result,
              rawInputs: Object.freeze(
                Object.fromEntries(
                  Object.entries(engine.rawInputs).map(([name, bytes]) => [
                    name,
                    Buffer.from(bytes)
                  ])
                )
              ),
              promotionEligible: false
            })
          );
        } catch (cause) {
          if (!response.headersSent && !response.destroyed)
            await new Promise((resolve) =>
              response.writeHead(400, { "Content-Length": "0", Connection: "close" }).end(resolve)
            );
          if (!request.socket.destroyed) request.socket.destroy();
          await closeListener().catch(() => {});
          settle(
            closedError(cause, {
              accepted,
              workspace: workspaceResult ?? null,
              creatorFailure: cause?.creation
                ? {
                    creation: cause.creation,
                    rawInputs: cause.rawInputs ?? null,
                    observationEvidence: cause.observationEvidence ?? null
                  }
                : null,
              engineAttempt: cause?.engineAttempt ?? null,
              workspaceRemoved: false,
              keyRemoved: false
            }),
            null
          );
          rejectForward(closedError(cause));
        }
      })();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(120000, () => socket.destroy());
    });
    server.maxRequestsPerSocket = 1;
    server.requestTimeout = 130000;
    server.headersTimeout = 120000;
    server.keepAliveTimeout = 1;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    ownSocket = { path: socketPath, stat: await fs.lstat(socketPath, { bigint: true }) };
    requireThat(ownSocket.stat.isSocket() && ownSocket.stat.uid === 0n);
    await fs.chmod(socketPath, 0o600);
    requireThat(sameInode(await fs.lstat(socketPath, { bigint: true }), ownSocket.stat));
    expiryTimer = setTimeout(
      () => {
        if (!accepted) void close().catch(() => {});
      },
      Math.max(0, Math.min(epoch(spec.expiresAt), epoch(job.expiresAt)) - Date.now())
    );
    return Object.freeze({
      socketPath,
      created,
      postgresForward,
      // Normal path only: ownership comes from this still-held successful
      // creation, never from a reconstructed or caller-supplied resource graph.
      // H1 must separately validate source custody/ACK and signed cleanup
      // readbacks before it can release any retained forwarding slot.
      async cleanupOwnedTarget(...args) {
        requireThat(
          args.length === 0 &&
            !closing &&
            !cleanupAttempted &&
            createdSettled &&
            engine &&
            evidenceSeed &&
            ownedWorkspace &&
            postgresRelay
        );
        cleanupAttempted = true;
        cleanupWork = (async () => {
          const cleanup = {
            operationRef: spec.operationRef,
            creationSpecDigest: sha256Bytes(specInput.bytes),
            jobAdmissionDigest: sha256Bytes(jobInput.bytes),
            status: "INTERRUPTED_UNKNOWN",
            startedAt: new Date().toISOString(),
            finishedAt: null,
            postgres: null,
            engine: {
              id: engine.result.id,
              process: engine.result.process,
              containerd: engine.result.containerd,
              exit: null
            },
            requests: [],
            processAbsence: [],
            workspace: null,
            rawInputs: {},
            promotionEligible: false
          };
          const ready = async () => {
            requireThat(!closing && engine.exitState.value === null);
            await currentJob(spec, job);
            await engine.recheck();
            const socket = await fs.lstat(socketPath, { bigint: true });
            requireThat(socket.isSocket() && socket.uid === 0n && sameInode(socket, engine.socket));
          };
          const exchange = async (name, method, route, expectedStatus) => {
            await ready();
            const entry = {
              name,
              method,
              path: `/v1.45${route}`,
              startedAt: new Date().toISOString(),
              finishedAt: null,
              status: null,
              response: null
            };
            cleanup.requests.push(entry);
            try {
              const result = await cleanupExchange(socketPath, method, entry.path);
              entry.status = result.status;
              entry.response = ref(result.bytes);
              cleanup.rawInputs[name] = Buffer.from(result.bytes);
              requireThat(
                result.status === expectedStatus &&
                  (expectedStatus !== 204 || result.bytes.length === 0)
              );
              await ready();
              return result.bytes;
            } finally {
              entry.finishedAt = new Date().toISOString();
            }
          };
          try {
            await ready();
            const before = await postgresRelay.recheck();
            cleanup.postgres = before.facts;
            for (const [name, bytes] of Object.entries(before.rawInputs))
              cleanup.rawInputs[`before.${name}`] = Buffer.from(bytes);
            requireThat(before.facts.engineId === engine.result.id);
            await postgresRelay.close();
            const target = before.facts;
            const containerPath = `/containers/${target.containerId}`;
            await exchange("stop-container", "POST", `${containerPath}/stop?t=10`, 204);
            const stopped = JSON.parse(
              await exchange("stopped-container", "GET", `${containerPath}/json`, 200)
            );
            requireThat(
              stopped.Id === target.containerId &&
                stopped.Image === target.imageId &&
                stopped.Name === `/${target.containerName}` &&
                stopped.Config?.Labels?.["com.subscription.release.operation-ref"] ===
                  spec.operationRef &&
                stopped.State?.Status === "exited" &&
                stopped.State.Running === false &&
                stopped.State.Paused === false &&
                stopped.State.Restarting === false &&
                stopped.State.Dead === false &&
                stopped.State.Pid === 0 &&
                stopped.State.ExitCode === 0
            );
            await exchange(
              "remove-container",
              "DELETE",
              `${containerPath}?v=false&force=false`,
              204
            );
            await exchange("absent-container", "GET", `${containerPath}/json`, 404);
            await exchange("remove-network", "DELETE", `/networks/${target.networkId}`, 204);
            await exchange("absent-network", "GET", `/networks/${target.networkId}`, 404);
            await exchange(
              "remove-volume",
              "DELETE",
              `/volumes/${target.volumeName}?force=false`,
              204
            );
            await exchange("absent-volume", "GET", `/volumes/${target.volumeName}`, 404);
            const imagePath = `/images/${encodeURIComponent(target.imageId)}`;
            const removed = JSON.parse(
              await exchange("remove-image", "DELETE", `${imagePath}?force=false&noprune=true`, 200)
            );
            requireThat(
              Array.isArray(removed) && removed.some((entry) => entry.Deleted === target.imageId)
            );
            await exchange("absent-image", "GET", `${imagePath}/json`, 404);
            const empty = JSON.parse(await exchange("empty-engine", "GET", "/info", 200));
            requireThat(
              empty.ID === target.engineId &&
                empty.DockerRootDir === `${spec.workspace.mountPath}/docker` &&
                empty.Driver === "overlay2" &&
                empty.LoggingDriver === "json-file" &&
                empty.Containers === 0 &&
                empty.Images === 0
            );
            const ended = await stopControl();
            cleanup.engine.exit = ended.engine;
            for (const pid of [engine.result.process.pid, engine.result.containerd.pid]) {
              const file = `/proc/${pid}`;
              requireThat(await absent(file));
              cleanup.processAbsence.push({
                path: file,
                code: "ENOENT",
                observedAt: new Date().toISOString()
              });
            }
            if (!(await absent(socketPath))) {
              const socket = await fs.lstat(socketPath, { bigint: true });
              requireThat(
                socket.isSocket() && socket.uid === 0n && sameInode(socket, engine.socket)
              );
              await fs.unlink(socketPath);
            }
            requireThat(await absent(socketPath));
            cleanup.workspace = await cleanupR3HostedWorkspace({ ownedWorkspace });
            requireThat(cleanup.workspace.cleanup.status === "WORKSPACE_REMOVED");
            cleanup.status = "TARGET_REMOVED";
            cleanup.finishedAt = new Date().toISOString();
            cleanupResult = freeze(copyResult(cleanup));
            return freeze(copyResult(cleanupResult));
          } catch (cause) {
            cleanup.engine.exit = engine.exitState.value;
            cleanup.finishedAt = new Date().toISOString();
            if (cause?.cleanup)
              cleanup.workspace = {
                cleanup: cause.cleanup,
                observation: cause.observation ?? null,
                rawInputs: cause.rawInputs ?? {}
              };
            throw closedError(cause, freeze(copyResult(cleanup)));
          }
        })();
        return cleanupWork;
      },
      async exportCleanupEvidence(input) {
        exact(input, ["privateKey"]);
        requireThat(cleanupResult !== undefined && cleanupResult !== null);
        await currentJob(spec, job);
        const policyBytes = await fs.readFile(
          new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
        );
        const signedAt = new Date().toISOString();
        const creationEvidenceBytes = buildR3HostedEvidence({
          created: copyResult(evidenceSeed),
          jobAdmissionBytes: Buffer.from(jobInput.bytes),
          spec,
          policyBytes,
          privateKey: input.privateKey,
          now: signedAt
        });
        const bytes = buildR3HostedCleanupEvidence({
          cleanup: copyResult(cleanupResult),
          creationEvidenceBytes,
          jobAdmissionBytes: Buffer.from(jobInput.bytes),
          spec,
          policyBytes,
          privateKey: input.privateKey,
          now: signedAt
        });
        await currentJob(spec, job);
        return bytes;
      },
      async exportEvidence(input) {
        exact(input, ["privateKey"]);
        requireThat(!closing && !cleanupAttempted);
        await created;
        requireThat(!closing && evidenceSeed !== null);
        await currentJob(spec, job);
        await engine.recheck();
        const policyBytes = await fs.readFile(
          new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
        );
        const bytes = buildR3HostedEvidence({
          created: copyResult(evidenceSeed),
          jobAdmissionBytes: Buffer.from(jobInput.bytes),
          spec,
          policyBytes,
          privateKey: input.privateKey,
          now: new Date().toISOString()
        });
        await engine.recheck();
        await currentJob(spec, job);
        requireThat(!closing);
        return bytes;
      },
      close
    });
  } catch (cause) {
    closing = true;
    clearTimeout(expiryTimer);
    await closeListener().catch(() => {});
    settle(closedError(cause, { accepted, workspaceRemoved: false, keyRemoved: false }), null);
    rejectForward(closedError(cause));
    throw closedError(cause);
  }
}
