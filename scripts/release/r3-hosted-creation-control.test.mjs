import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import childProcess from "node:child_process";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";

const originalOpen = fs.open.bind(fs);
const originalMkdir = fs.mkdir.bind(fs);
const originalStat = fs.stat.bind(fs);
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalRead = fs.readFile.bind(fs);
const originalLstat = fs.lstat.bind(fs);
const root = "/dev/shm/stage1-keys";
const operationRef = "70000000-0000-4000-8000-000000000001";
const id = operationRef.replaceAll("-", "");
const socketPath = `${root}/${id}.sock`;
const mountPath = `/srv/stage1-snapshot/${id}`;
const machine = (await originalRead("/etc/machine-id", "utf8")).trim();
const creationCalls = [];
let creatorFailure = false;
let engineFailure = false;
let systemContainerd = false;
let postgresResources = null;

mock.module("./r3-hosted-workspace-create.mjs", {
  namedExports: {
    createR3HostedWorkspace: async (input) => {
      creationCalls.push(input);
      if (creatorFailure)
        throw Object.assign(new Error("synthetic creator failure"), { code: "SYNTHETIC" });
      return {
        observation: {
          observation: {
            status: "OBSERVED",
            state: "active",
            operationRef,
            workspace: {
              id,
              capacityBytes: 64 * 1048576,
              backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
              mountPath,
              keyFile: `${root}/${id}.key`,
              mapperName: `s1snap_${id}`
            },
            facts: { state: "active" }
          }
        },
        creation: { status: "WORKSPACE_OBSERVED", promotionEligible: false },
        rawInputs: {}
      };
    }
  }
});
const { openR3HostedCreationControl } = await import("./r3-hosted-creation-control.mjs");

function admission(jobLifetimeMs = 60000) {
  const now = Date.now();
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: `sha256:${"1".repeat(64)}`,
    ownerId: "keqi119",
    sourceSha: "a".repeat(40),
    buildProofDigest: `sha256:${"2".repeat(64)}`,
    proofRawDigest: `sha256:${"3".repeat(64)}`,
    materialRawDigest: `sha256:${"4".repeat(64)}`,
    targetPolicyDigest: `sha256:${"5".repeat(64)}`,
    phase: "source",
    chain: "fresh",
    createdAt: new Date(now - 10000).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
    workspace: {
      id,
      capacityBytes: 64 * 1048576,
      backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
      mountPath,
      keyFile: `${root}/${id}.key`,
      mapperName: `s1snap_${id}`
    },
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const creationSpecBytes = encodeManualJson(spec);
  const job = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef,
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    creationSpecDigest: sha256Bytes(creationSpecBytes),
    buildProofDigest: spec.buildProofDigest,
    sourceSha: spec.sourceSha,
    phase: spec.phase,
    chain: spec.chain,
    generatedAt: new Date(now - 5000).toISOString(),
    expiresAt: new Date(now + jobLifetimeMs).toISOString(),
    ci: {
      repository: "keqi119/subscription-Saas",
      repositoryId: "1253231368",
      runId: "1234",
      runAttempt: 1,
      workflowPath: ".github/workflows/release-candidate-gate.yml",
      callerWorkflowPath: ".github/workflows/release-candidate-gate.yml",
      jobKey: "source-fresh",
      jobId: "5678",
      jobName: "source-fresh",
      environment: "trusted-source-database-gate",
      runnerClass: "github-hosted"
    },
    host: {
      machineIdFingerprint: sha256Bytes(
        Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`)
      ),
      forwardingPublicKeyPem: "test-only",
      forwardingKeyFingerprint: `sha256:${"6".repeat(64)}`,
      runnerId: 1,
      runnerName: "synthetic-hosted"
    }
  };
  return { creationSpecBytes, jobAdmissionBytes: encodeManualJson(job) };
}

function body(inputs) {
  const spec = JSON.parse(inputs.creationSpecBytes);
  const request = {
    schemaVersion: "manual-runner-request.v4",
    profileDigest: spec.profileDigest,
    ownerId: spec.ownerId,
    sessionId: "20000000-0000-4000-8000-000000000001",
    sessionNonce: "f".repeat(64),
    operationId: operationRef,
    idempotencyKey: "one",
    attemptId: "30000000-0000-4000-8000-000000000001",
    runId: "40000000-0000-4000-8000-000000000001",
    attemptAllocationDigest: `sha256:${"7".repeat(64)}`,
    stage: "target-create",
    capability: "create-isolated-target",
    purpose: "stage1-isolated-database-tests",
    phase: spec.phase,
    chain: spec.chain,
    sourceSha: spec.sourceSha,
    targetPolicyDigest: spec.targetPolicyDigest,
    creationSpecDigest: sha256Bytes(inputs.creationSpecBytes),
    jobAdmissionDigest: sha256Bytes(inputs.jobAdmissionBytes),
    candidate: { buildProofDigest: spec.buildProofDigest }
  };
  const authorization = {
    payload: { schemaVersion: "manual-launch-authorization.v4" },
    signature: "test-only"
  };
  return encodeManualJson({ request, authorization });
}

function post(socket, bytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: socket,
        path: "/stage1-r3/target-create",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(bytes.length),
          Connection: "close",
          ...headers
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) })
        );
      }
    );
    request.once("error", reject);
    request.end(bytes);
  });
}
function preconnectedPost(socketPath, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const received = [];
    socket.once("error", reject);
    socket.on("data", (part) => received.push(Buffer.from(part)));
    socket.once("connect", () => {
      setTimeout(
        () =>
          socket.write(
            Buffer.concat([
              Buffer.from(
                `POST /stage1-r3/target-create HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`
              ),
              bytes
            ])
          ),
        50
      );
    });
    socket.once("end", () => {
      const raw = Buffer.concat(received).toString("utf8");
      const [head, body] = raw.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), bytes: Buffer.from(body ?? "") });
    });
  });
}

async function setup(t) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    t.skip("native Unix socket test requires Linux root");
    return null;
  }
  let ownsRoot = false;
  try {
    await originalMkdir(root, { mode: 0o700 });
    ownsRoot = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  t.after(async () => {
    if (ownsRoot) await fs.rmdir(root).catch(() => {});
  });
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    GITHUB_REPOSITORY: "keqi119/subscription-Saas",
    GITHUB_REPOSITORY_ID: "1253231368",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "source-fresh",
    RUNNER_NAME: "synthetic-hosted",
    GITHUB_WORKFLOW_REF:
      "keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main"
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const name of Object.keys(env))
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
  });
  const oldCreatorFailure = creatorFailure,
    oldEngineFailure = engineFailure,
    oldSystemContainerd = systemContainerd;
  creatorFailure = false;
  engineFailure = false;
  systemContainerd = false;
  postgresResources = null;
  creationCalls.length = 0;
  t.after(() => {
    creatorFailure = oldCreatorFailure;
    engineFailure = oldEngineFailure;
    systemContainerd = oldSystemContainerd;
  });
  t.mock.method(fs, "lstat", async (file, ...args) => {
    if (file === "/run/containerd/containerd.sock") {
      if (systemContainerd) return { isSocket: () => true };
      throw Object.assign(new Error("synthetic absent system containerd"), { code: "ENOENT" });
    }
    return originalLstat(file, ...args);
  });
  const opens = [],
    commands = [],
    directories = [],
    configurations = [];
  t.mock.method(fs, "mkdir", async (file, options) => {
    if (String(file).startsWith(mountPath + "/")) {
      directories.push({ file: String(file), options });
      return;
    }
    return originalMkdir(file, options);
  });
  t.mock.method(fs, "open", async (file, flags, mode) => {
    if (String(file).startsWith(mountPath + "/")) {
      opens.push({ file: String(file), flags, mode });
      if (String(file).endsWith("/daemon.log")) return originalOpen("/dev/null", "a");
      return {
        writeFile: async (bytes) => configurations.push(Buffer.from(bytes)),
        close: async () => {}
      };
    }
    return originalOpen(file, flags, mode);
  });
  t.mock.method(fs, "stat", async (file, options) => {
    if (file === "/usr/bin/dockerd")
      return {
        isFile: () => true,
        uid: 0n,
        mode: 0o100755n,
        dev: 1n,
        ino: 2n,
        gid: 0n,
        nlink: 1n,
        size: 1n,
        mtimeNs: 1n,
        ctimeNs: 1n,
        rdev: 0n
      };
    return originalStat(file, options);
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(command, "/usr/bin/dockerd");
    commands.push({ command, args, options });
    const helper = `
      const http = require('node:http');
      const socket = process.argv[1], root = process.argv[2];
      const server = http.createServer((req, res) => {
        const resources = ${JSON.stringify(postgresResources)};
        if (resources && req.url in resources) return res.writeHead(200).end(JSON.stringify(resources[req.url]));
        if (req.url === '/_ping') return res.writeHead(200).end('OK');
        if (req.url === '/v1.45/info') return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({
          ID:'69a59aea-54ef-4181-808e-cf8d6cdb05e6', DockerRootDir:root,
          Driver:${JSON.stringify(engineFailure ? "vfs" : "overlay2")},
          DriverStatus:[['Backing Filesystem','extfs']], LoggingDriver:'json-file',
          Containers:0, Images:0
        }));
        if (req.url === '/v1.45/version') return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({Version:'26.1.3',ApiVersion:'1.45'}));
        res.writeHead(404).end();
      });
      server.listen(socket);
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `;
    return originalSpawn(
      process.execPath,
      ["-e", helper, socketPath, `${mountPath}/docker`],
      options
    );
  });
  return { opens, commands, directories, configurations };
}

test("R3 control rejects malformed admission before native socket or creator effect", async (t) => {
  const f = await setup(t);
  if (!f) return;
  await assert.rejects(openR3HostedCreationControl({ ...admission(), extra: true }), {
    code: "R3_HOSTED_CREATION_CONTROL_INVALID"
  });
  assert.equal(creationCalls.length, 0);
  await assert.rejects(fs.lstat(socketPath), { code: "ENOENT" });
  const expiring = await openR3HostedCreationControl(admission(500));
  await assert.rejects(expiring.created, { code: "R3_HOSTED_CREATION_CONTROL_INVALID" });
  assert.equal((await expiring.close()).workspaceRemoved, false);
  await assert.rejects(fs.lstat(socketPath), { code: "ENOENT" });
  assert.equal(creationCalls.length, 0);
});

test("R3 control accepts one native HTTP request then hands same socket to observed Engine", async (t) => {
  const f = await setup(t);
  if (!f) return;
  const inputs = admission();
  const control = await openR3HostedCreationControl(inputs);
  t.after(() => control.close());
  assert.equal(control.socketPath, socketPath);
  const response = await preconnectedPost(socketPath, body(inputs));
  assert.equal(response.status, 202);
  assert.equal(response.bytes.length, 0);
  const result = await control.created;
  assert.equal(creationCalls.length, 1);
  assert.equal(result.workspace.creation.status, "WORKSPACE_OBSERVED");
  assert.equal(result.engine.id, "69a59aea-54ef-4181-808e-cf8d6cdb05e6");
  assert.equal(result.engine.info.DockerRootDir, `${mountPath}/docker`);
  assert.equal(result.engine.info.Driver, "overlay2");
  assert.equal(result.engine.info.Containers, 0);
  assert.equal(result.engine.info.Images, 0);
  assert.equal(f.commands.length, 1);
  assert.ok(f.directories.every((item) => item.file.startsWith(mountPath + "/")));
  assert.equal(f.configurations.length, 1);
  const config = JSON.parse(f.configurations[0]);
  assert.equal(config.iptables, false);
  assert.equal(config.ip6tables, false);
  assert.equal(config["userland-proxy"], false);
  assert.notEqual((await post(socketPath, body(inputs)).catch((error) => error)).status, 202);
  assert.equal(creationCalls.length, 1);
  const closed = await control.close();
  assert.equal(closed.engine.exitCode, 0);
  assert.equal(closed.workspaceRemoved, false);
});

test("R3 control refuses implicit reuse of the system containerd", async (t) => {
  const f = await setup(t);
  if (!f) return;
  systemContainerd = true;
  const inputs = admission();
  const control = await openR3HostedCreationControl(inputs);
  t.after(() => control.close());
  assert.equal((await post(socketPath, body(inputs))).status, 202);
  await assert.rejects(control.created, { code: "R3_HOSTED_CREATION_CONTROL_INVALID" });
  assert.equal(f.commands.length, 0);
  await assert.rejects(control.postgresForward);
});

test("R3 control relays only opaque bytes to its observed PG and closes the loopback listener", async (t) => {
  const f = await setup(t);
  if (!f) return;
  const imageDigest = JSON.parse(
    await originalRead(
      new URL("../../release/contracts/database-target-policies.v1.json", import.meta.url),
      "utf8"
    )
  ).policies.find((value) => value.policyId === "s1-release-compose-ephemeral").requiredImageDigest;
  const names = { container: `s1r3pg_${id}`, network: `s1r3net_${id}`, volume: `s1r3data_${id}` };
  const imageId = `sha256:${"e".repeat(64)}`,
    cid = "b".repeat(64),
    nid = "c".repeat(64);
  const labels = { "com.subscription.release.operation-ref": operationRef };
  const volumePath = `${mountPath}/docker/volumes/${names.volume}/_data`;
  postgresResources = {
    [`/v1.45/containers/${names.container}/json`]: {
      Id: cid,
      Name: `/${names.container}`,
      Image: imageId,
      Config: { Image: `postgres:17-bookworm@${imageDigest}`, Labels: labels },
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 321
      },
      HostConfig: {
        Privileged: false,
        PidMode: "",
        NetworkMode: names.network,
        Binds: null,
        PortBindings: {}
      },
      NetworkSettings: {
        Ports: { "5432/tcp": null },
        Networks: { [names.network]: { NetworkID: nid, IPAddress: "127.0.0.2" } }
      },
      Mounts: [
        {
          Type: "volume",
          Name: names.volume,
          Source: volumePath,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          RW: true
        }
      ]
    },
    [`/v1.45/images/${encodeURIComponent(`postgres:17-bookworm@${imageDigest}`)}/json`]: {
      Id: imageId,
      RepoDigests: [`postgres@${imageDigest}`],
      Os: "linux",
      Architecture: "amd64"
    },
    [`/v1.45/networks/${names.network}`]: {
      Id: nid,
      Name: names.network,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: labels,
      Containers: { [cid]: { Name: names.container, IPv4Address: "127.0.0.2/8" } }
    },
    [`/v1.45/volumes/${names.volume}`]: {
      Name: names.volume,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: labels
    }
  };
  // A synthetic TCP peer stands in for PG; this tests opaque relay lifecycle,
  // not the database, TLS implementation or hosted job provenance.
  const peerSockets = new Set();
  const peer = net.createServer((socket) => {
    peerSockets.add(socket);
    socket.once("close", () => peerSockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    peer.once("error", reject);
    peer.listen(0, "127.0.0.1", resolve);
  });
  const originalConnect = net.createConnection;
  t.mock.method(net, "createConnection", (options, ...args) => {
    if (options?.host === "127.0.0.2") {
      assert.equal(options.port, 5432);
      return originalConnect({ ...options, host: "127.0.0.1", port: peer.address().port }, ...args);
    }
    return originalConnect(options, ...args);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of peerSockets) socket.destroy();
        peer.close(resolve);
      })
  );
  const inputs = admission();
  const control = await openR3HostedCreationControl(inputs);
  t.after(() => control.close());
  assert.equal((await post(socketPath, body(inputs))).status, 202);
  await control.created;
  const forward = await control.postgresForward;
  assert.equal(forward.observation.containerId, cid);
  assert.equal(forward.observation.listener.address, "127.0.0.1");
  assert.equal(forward.observation.listener.port, 55441);
  const payload = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
  const client = net.createConnection({ host: "127.0.0.1", port: 55441 });
  t.after(() => client.destroy());
  const echoed = await new Promise((resolve, reject) => {
    client.once("error", reject);
    client.once("connect", () => client.write(payload));
    client.once("data", resolve);
    client.setTimeout(5000, () => reject(new Error("relay timeout")));
  });
  assert.deepEqual(echoed, payload);
  await control.close();
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: 55441 });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    }),
    { code: "ECONNREFUSED" }
  );
});

test("R3 control keeps UNKNOWN on accepted creator failure and close only removes own socket", async (t) => {
  const f = await setup(t);
  if (!f) return;
  creatorFailure = true;
  const inputs = admission();
  const control = await openR3HostedCreationControl(inputs);
  const response = await post(socketPath, body(inputs));
  assert.equal(response.status, 202);
  await assert.rejects(control.created, { code: "R3_HOSTED_CREATION_CONTROL_INVALID" });
  assert.equal(creationCalls.length, 1);
  assert.equal(f.commands.length, 0);
  const closed = await control.close();
  assert.equal(closed.workspaceRemoved, false);
  await assert.rejects(fs.lstat(socketPath), { code: "ENOENT" });
});

test("R3 control retains workspace and actual daemon exit on rejected Engine facts", async (t) => {
  const f = await setup(t);
  if (!f) return;
  engineFailure = true;
  const inputs = admission();
  const control = await openR3HostedCreationControl(inputs);
  const response = await post(socketPath, body(inputs));
  assert.equal(response.status, 202);
  await assert.rejects(control.created, (error) => {
    assert.equal(error.code, "R3_HOSTED_CREATION_CONTROL_INVALID");
    assert.equal(error.evidence.workspace.creation.status, "WORKSPACE_OBSERVED");
    assert.ok(error.evidence.engineAttempt.pid > 0);
    assert.equal(error.evidence.engineAttempt.exit.exitCode, 0);
    assert.equal(error.evidence.engineAttempt.logPath, `${mountPath}/daemon.log`);
    assert.equal(error.evidence.workspaceRemoved, false);
    return true;
  });
  assert.equal(f.commands.length, 1);
  assert.equal((await control.close()).workspaceRemoved, false);
});
