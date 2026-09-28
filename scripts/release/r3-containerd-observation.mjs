// Observe the containerd child that Moby 26.1.3 starts for this encrypted Engine.
// This is a read-only consistency check, not destination or cleanup authority.
import fs from "node:fs/promises";

import {
  assessR3ContainerdRaw,
  extractR3ContainerdSocketRows,
  readR3ContainerdPidFile
} from "../../packages/release-foundation/src/r3-containerd-raw.mjs";

const CODE = "R3_CONTAINERD_OBSERVATION_INVALID";
const LIMIT = 1048576;
const MOUNT = /^\/srv\/stage1-snapshot\/[0-9a-f]{32}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
const keys = (value, expected) =>
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key))
  );
async function read(path, evidence, name) {
  const value = await fs.readFile(path);
  need(Buffer.isBuffer(value) && value.length > 0 && value.length <= LIMIT);
  const copy = Buffer.from(value);
  if (name) evidence[name] = Buffer.from(copy);
  return copy;
}
function metadata(path, stat) {
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
async function owned(path, mountDev, type) {
  need((await fs.realpath(path)) === path);
  const stat = await fs.lstat(path, { bigint: true });
  need(
    stat.uid === 0n &&
      stat.gid === 0n &&
      stat.dev === mountDev &&
      !stat.isSymbolicLink() &&
      (type === "directory"
        ? stat.isDirectory()
        : type === "socket"
          ? stat.isSocket()
          : stat.isFile())
  );
  if (type !== "socket") need((stat.mode & 0o022n) === 0n);
  return metadata(path, stat);
}
async function sample(mountPath, dockerdPid, evidence) {
  const base = `${mountPath}/exec/containerd`;
  const expected = {
    base,
    root: `${mountPath}/docker/containerd/daemon`,
    state: `${base}/daemon`,
    grpc: `${base}/containerd.sock`,
    debug: `${base}/containerd-debug.sock`
  };
  const mount = await fs.lstat(mountPath, { bigint: true });
  need(
    mount.isDirectory() &&
      mount.uid === 0n &&
      mount.gid === 0n &&
      (mount.mode & 0o022n) === 0n &&
      !mount.isSymbolicLink() &&
      (await fs.realpath(mountPath)) === mountPath
  );
  for (const directory of [
    `${mountPath}/docker`,
    `${mountPath}/docker/containerd`,
    `${mountPath}/exec`,
    base
  ])
    await owned(directory, mount.dev, "directory");
  const root = await owned(expected.root, mount.dev, "directory");
  const state = await owned(expected.state, mount.dev, "directory");
  const grpc = await owned(expected.grpc, mount.dev, "socket");
  const debug = await owned(expected.debug, mount.dev, "socket");
  const pidPath = `${base}/containerd.pid`,
    configPath = `${base}/containerd.toml`;
  const pidFileIdentity = await owned(pidPath, mount.dev, "file");
  const configIdentity = await owned(configPath, mount.dev, "file");
  const pidFile = await read(pidPath, evidence, "pidFile");
  const pid = readR3ContainerdPidFile(pidFile);
  const stat = await read(`/proc/${pid}/stat`, evidence, "stat");
  const cmdline = await read(`/proc/${pid}/cmdline`, evidence, "cmdline");
  const executablePath = await fs.readlink(`/proc/${pid}/exe`);
  need(["/usr/bin/containerd", "/usr/sbin/containerd"].includes(executablePath));
  const executable = await fs.stat(`/proc/${pid}/exe`, { bigint: true });
  need(
    executable.isFile() &&
      executable.uid === 0n &&
      (executable.mode & 0o111n) !== 0n &&
      (executable.mode & 0o022n) === 0n
  );
  const config = await read(configPath, evidence, "config");
  need(
    JSON.stringify(await owned(pidPath, mount.dev, "file")) === JSON.stringify(pidFileIdentity) &&
      JSON.stringify(await owned(configPath, mount.dev, "file")) === JSON.stringify(configIdentity)
  );
  const unix = await read("/proc/net/unix", evidence);
  const { grpc: grpcRow, debug: debugRow } = extractR3ContainerdSocketRows({
    mountPath,
    unixBytes: unix
  });
  evidence.grpcSocketRow = Buffer.from(grpcRow.line);
  evidence.debugSocketRow = Buffer.from(debugRow.line);
  const descriptors = await fs.readdir(`/proc/${pid}/fd`);
  need(Array.isArray(descriptors) && descriptors.length <= 65536);
  const held = new Set();
  const socketOwners = [];
  for (const fd of descriptors) {
    need(/^(?:0|[1-9][0-9]*)$/u.test(fd));
    let link;
    try {
      link = await fs.readlink(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (link === `socket:[${grpcRow.inode}]` || link === `socket:[${debugRow.inode}]`) {
      held.add(link);
      socketOwners.push({ path: `/proc/${pid}/fd/${fd}`, target: link });
    }
  }
  evidence.socketOwners = Buffer.from(JSON.stringify(socketOwners));
  need(held.size === 2);
  const process = assessR3ContainerdRaw({
    mountPath,
    dockerdPid,
    rawInputs: {
      pidFile,
      stat,
      cmdline,
      config,
      grpcSocketRow: evidence.grpcSocketRow,
      debugSocketRow: evidence.debugSocketRow,
      socketOwners: evidence.socketOwners
    }
  });
  const facts = {
    pid: process.pid,
    parentPid: process.parentPid,
    starttime: process.starttime,
    mount: metadata(mountPath, mount),
    executable: {
      ...metadata(executablePath, executable),
      mode: String(executable.mode),
      uid: String(executable.uid),
      gid: String(executable.gid)
    },
    configDigest: process.configDigest,
    configIdentity,
    pidFileIdentity,
    root,
    state,
    grpc: { ...grpc, listenerInode: grpcRow.inode },
    debug: { ...debug, listenerInode: debugRow.inode }
  };
  return {
    facts,
    rawInputs: {
      pidFile,
      stat,
      cmdline,
      config,
      socketOwners: Buffer.from(evidence.socketOwners),
      grpcSocketRow: Buffer.from(grpcRow.line),
      debugSocketRow: Buffer.from(debugRow.line)
    }
  };
}

export async function observeR3ManagedContainerd(input) {
  const evidence = {};
  try {
    keys(input, ["mountPath", "dockerdPid"]);
    const { mountPath, dockerdPid } = input;
    need(
      process.platform === "linux" &&
        typeof mountPath === "string" &&
        MOUNT.test(mountPath) &&
        Number.isSafeInteger(dockerdPid) &&
        dockerdPid > 0
    );
    const first = await sample(mountPath, dockerdPid, evidence);
    const second = await sample(mountPath, dockerdPid, evidence);
    need(JSON.stringify(first.facts) === JSON.stringify(second.facts));
    return Object.freeze({
      facts: Object.freeze({ ...second.facts }),
      rawInputs: Object.freeze(
        Object.fromEntries(
          Object.entries(second.rawInputs).map(([name, bytes]) => [name, Buffer.from(bytes)])
        )
      )
    });
  } catch (cause) {
    throw Object.assign(new Error(CODE, { cause }), {
      code: CODE,
      rawInputs: Object.freeze(
        Object.fromEntries(
          Object.entries(evidence).map(([name, bytes]) => [name, Buffer.from(bytes)])
        )
      )
    });
  }
}
