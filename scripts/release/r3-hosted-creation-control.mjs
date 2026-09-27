// Hosted job only. The one-shot HTTP 202 acknowledges receipt after H1 has
// durably consumed the manual operation; it is not an authorization, creation
// success, destination decision or cleanup receipt.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  encodeManualJson,
  validateManualTargetCreationRequest
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { createR3HostedWorkspace } from "./r3-hosted-workspace-create.mjs";

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
            reject(closedError());
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
  const observation = workspaceResult?.observation?.observation;
  requireThat(
    observation?.status === "OBSERVED" &&
      observation?.facts?.state === "active" &&
      workspaceResult.creation?.status === "WORKSPACE_OBSERVED" &&
      encodeManualJson(observation.workspace).equals(encodeManualJson(expectedWorkspace))
  );
  const mount = observation.workspace.mountPath;
  requireThat(typeof mount === "string" && /^\/srv\/stage1-snapshot\/[0-9a-f]{32}$/u.test(mount));
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
    const socket = await fs.lstat(socketPath, { bigint: true });
    requireThat(socket.isSocket() && socket.uid === 0n);
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
      rawRefs: { ping: ref(ping), info: ref(infoBytes), version: ref(versionBytes) },
      promotionEligible: false
    });
    return {
      result,
      rawInputs: { ping, info: infoBytes, version: versionBytes },
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
      engineAttempt: freeze({ ...attempt, rawRefs: { ...attempt.rawRefs } })
    });
  } finally {
    await logFile.close();
  }
}

export async function openR3HostedCreationControl(input) {
  let server,
    ownSocket,
    engine = null,
    accepted = false,
    closing = false,
    createdSettled = false,
    handler = null,
    listenerClosing,
    expiryTimer;
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
  const close = async () => {
    closing = true;
    clearTimeout(expiryTimer);
    if (!accepted) settle(closedError(), null);
    for (const socket of sockets) socket.destroy();
    if (handler) await handler.catch(() => {});
    await closeListener();
    let exit = null;
    if (engine) {
      if (engine.exitState.value === null) engine.child.kill("SIGTERM");
      let timer;
      exit = await Promise.race([
        engine.exited,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 10000);
        })
      ]);
      clearTimeout(timer);
      if (!exit) {
        engine.child.kill("SIGKILL");
        exit = await engine.exited;
      }
      if (exit.exitCode !== 0 || exit.signal !== null)
        throw closedError(null, { engineExit: exit, workspaceRemoved: false, keyRemoved: false });
    }
    return freeze({ engine: exit, workspaceRemoved: false, keyRemoved: false });
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
          requireThat(!closing);
          await currentJob(spec, job);
          engine = await startEngine(workspaceResult, spec.workspace, socketPath, () => closing);
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
    return Object.freeze({ socketPath, created, close });
  } catch (cause) {
    closing = true;
    clearTimeout(expiryTimer);
    await closeListener().catch(() => {});
    settle(closedError(cause, { accepted, workspaceRemoved: false, keyRemoved: false }), null);
    throw closedError(cause);
  }
}
