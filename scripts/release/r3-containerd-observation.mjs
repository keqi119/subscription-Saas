// Observe the containerd child that Moby 26.1.3 starts for this encrypted Engine.
// This is a read-only consistency check, not destination or cleanup authority.
import fs from "node:fs/promises";

import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const CODE = "R3_CONTAINERD_OBSERVATION_INVALID";
const LIMIT = 1048576;
const MOUNT = /^\/srv\/stage1-snapshot\/[0-9a-f]{32}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
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
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
async function read(path, evidence, name) {
  const value = await fs.readFile(path);
  need(Buffer.isBuffer(value) && value.length > 0 && value.length <= LIMIT);
  const copy = Buffer.from(value);
  if (name) evidence[name] = Buffer.from(copy);
  return copy;
}
const number = (value) => {
  need(POSITIVE.test(value));
  const parsed = Number(value);
  need(Number.isSafeInteger(parsed));
  return parsed;
};
function procIdentity(bytes, pid, dockerdPid) {
  const line = text(bytes).trim();
  const end = line.lastIndexOf(")");
  need(line.startsWith(`${pid} (`) && end > 0);
  const fields = line.slice(end + 2).split(/\s+/u);
  need(
    fields.length >= 20 && !["Z", "X", "x"].includes(fields[0]) && number(fields[1]) === dockerdPid
  );
  number(fields[19]);
  return { pid, parentPid: dockerdPid, starttime: fields[19] };
}
function parseToml(bytes, expected) {
  const sections = new Map([["", new Map()]]);
  let section = "";
  for (const original of text(bytes).split(/\r?\n/u)) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = /^\[([a-z_]+)\]$/u.exec(line);
    if (heading) {
      section = heading[1];
      need(
        [
          "grpc",
          "debug",
          "ttrpc",
          "metrics",
          "cgroup",
          "plugins",
          "proxy_plugins",
          "stream_processors",
          "timeouts"
        ].includes(section) && !sections.has(section)
      );
      sections.set(section, new Map());
      continue;
    }
    const match =
      /^([a-z_]+)\s*=\s*("(?:[^"\\]|\\["\\/bfnrtu])*"|\[(?:\s*"(?:[^"\\]|\\["\\/bfnrtu])*"\s*(?:,\s*"(?:[^"\\]|\\["\\/bfnrtu])*"\s*)*)?\]|-?[0-9]+|true|false)$/u.exec(
        line
      );
    need(match);
    const table = sections.get(section);
    need(!table.has(match[1]));
    let value;
    try {
      value = JSON.parse(match[2]);
    } catch {
      fail();
    }
    table.set(match[1], value);
  }
  const top = sections.get("");
  need(
    top.get("version") === 2 &&
      top.get("root") === expected.root &&
      top.get("state") === expected.state &&
      Array.isArray(top.get("disabled_plugins")) &&
      top.get("disabled_plugins").length === 1 &&
      top.get("disabled_plugins")[0] === "io.containerd.grpc.v1.cri"
  );
  need(
    sections.get("grpc")?.get("address") === expected.grpc &&
      sections.get("debug")?.get("address") === expected.debug
  );
  for (const [name, value] of top) {
    need(
      [
        "version",
        "root",
        "state",
        "temp",
        "plugin_dir",
        "disabled_plugins",
        "required_plugins",
        "imports",
        "oom_score"
      ].includes(name)
    );
    if (["temp", "plugin_dir"].includes(name)) need(value === "");
    if (["imports", "required_plugins"].includes(name))
      need(Array.isArray(value) && value.length === 0);
    if (name === "oom_score") need(Number.isSafeInteger(value) && value >= -1000 && value <= 1000);
  }
  const allowed = {
    grpc: [
      "address",
      "uid",
      "gid",
      "max_recv_message_size",
      "max_send_message_size",
      "tcp_address",
      "tcp_tls_ca",
      "tcp_tls_cert",
      "tcp_tls_key"
    ],
    debug: ["address", "uid", "gid", "level", "format"],
    ttrpc: ["address", "uid", "gid"],
    metrics: ["address", "grpc_histogram"],
    cgroup: ["path"],
    timeouts: []
  };
  for (const [name, table] of sections) {
    if (!name) continue;
    if (["plugins", "proxy_plugins", "stream_processors", "timeouts"].includes(name))
      need(table.size === 0);
    else {
      for (const [key, value] of table) {
        need(allowed[name].includes(key));
        if (key === "address" && name !== "grpc" && name !== "debug") need(value === "");
        if (["tcp_address", "tcp_tls_ca", "tcp_tls_cert", "tcp_tls_key"].includes(key))
          need(value === "");
        if (key === "path") need(value === "");
        if (["uid", "gid"].includes(key)) need(value === 0);
        if (["max_recv_message_size", "max_send_message_size"].includes(key))
          need(Number.isSafeInteger(value) && value >= 0);
        if (key === "format") need(["", "text", "json"].includes(value));
        if (key === "level")
          need(["", "trace", "debug", "info", "warn", "error", "fatal"].includes(value));
        if (key === "grpc_histogram") need(typeof value === "boolean");
      }
    }
  }
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
function socketRow(bytes, path) {
  const rows = text(bytes)
    .split(/\r?\n/u)
    .slice(1)
    .filter((line) => line.trim());
  const matches = rows
    .map((line) => ({ line, columns: line.trim().split(/\s+/u) }))
    .filter(({ columns }) => columns[7] === path);
  need(
    matches.length === 1 &&
      matches[0].columns.length === 8 &&
      POSITIVE.test(matches[0].columns[6]) &&
      Number.parseInt(matches[0].columns[3], 16) & 0x10000 &&
      Number.parseInt(matches[0].columns[4], 16) === 1
  );
  return { inode: matches[0].columns[6], line: matches[0].line };
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
  const pid = number(text(pidFile).trim());
  const stat = await read(`/proc/${pid}/stat`, evidence, "stat");
  const process = procIdentity(stat, pid, dockerdPid);
  const cmdline = await read(`/proc/${pid}/cmdline`, evidence, "cmdline");
  const argumentsList = text(cmdline).split("\0");
  need(argumentsList.at(-1) === "");
  argumentsList.pop();
  need(
    [3, 5].includes(argumentsList.length) &&
      argumentsList[0] === "containerd" &&
      argumentsList[1] === "--config" &&
      argumentsList[2] === configPath &&
      (argumentsList.length === 3 ||
        (argumentsList[3] === "--log-level" &&
          ["trace", "debug", "info", "warn", "error", "fatal"].includes(argumentsList[4])))
  );
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
  parseToml(config, expected);
  need(
    JSON.stringify(await owned(pidPath, mount.dev, "file")) === JSON.stringify(pidFileIdentity) &&
      JSON.stringify(await owned(configPath, mount.dev, "file")) === JSON.stringify(configIdentity)
  );
  const unix = await read("/proc/net/unix", evidence);
  const grpcRow = socketRow(unix, expected.grpc),
    debugRow = socketRow(unix, expected.debug);
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
  const facts = {
    ...process,
    mount: metadata(mountPath, mount),
    executable: {
      ...metadata(executablePath, executable),
      mode: String(executable.mode),
      uid: String(executable.uid),
      gid: String(executable.gid)
    },
    configDigest: sha256Bytes(config),
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
