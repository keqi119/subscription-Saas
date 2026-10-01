// Parse the bounded original bytes retained by the native containerd observer.
// Filesystem ownership, inode and executable facts are checked by that observer;
// they cannot be reconstructed from these process/config/socket bytes alone.
import { sha256Bytes } from "./digest.mjs";

const CODE = "R3_CONTAINERD_RAW_INVALID";
const LIMIT = 1048576;
const MOUNT = /^\/srv\/stage1-snapshot\/[0-9a-f]{32}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const RAW_KEYS = [
  "pidFile",
  "stat",
  "cmdline",
  "config",
  "grpcSocketRow",
  "debugSocketRow",
  "socketOwners"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
function exact(value, names) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
  );
}
function text(bytes, allowEmpty = false) {
  need(Buffer.isBuffer(bytes) && bytes.length <= LIMIT && (allowEmpty || bytes.length > 0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function positive(value) {
  need(typeof value === "string" && POSITIVE.test(value));
  const number = Number(value);
  need(Number.isSafeInteger(number));
  return number;
}
function paths(mountPath) {
  need(typeof mountPath === "string" && MOUNT.test(mountPath));
  const base = `${mountPath}/exec/containerd`;
  return {
    base,
    config: `${base}/containerd.toml`,
    root: `${mountPath}/docker/containerd/daemon`,
    state: `${base}/daemon`,
    grpc: `${base}/containerd.sock`,
    debug: `${base}/containerd-debug.sock`
  };
}
export function readR3ContainerdPidFile(bytes) {
  try {
    const value = text(bytes);
    need(/^[1-9][0-9]*\n?$/u.test(value));
    return positive(value.trim());
  } catch {
    fail();
  }
}
function processStat(bytes, pid, dockerdPid) {
  const line = text(bytes).trim();
  const end = line.lastIndexOf(")");
  need(line.startsWith(`${pid} (`) && end > 0);
  const fields = line.slice(end + 2).split(/\s+/u);
  need(
    fields.length >= 20 &&
      !["Z", "X", "x"].includes(fields[0]) &&
      positive(fields[1]) === dockerdPid
  );
  positive(fields[19]);
  return { pid, parentPid: dockerdPid, starttime: fields[19] };
}
function commandLine(bytes, configPath) {
  const args = text(bytes).split("\0");
  need(args.at(-1) === "");
  args.pop();
  need(
    [3, 5].includes(args.length) &&
      args[0] === "containerd" &&
      args[1] === "--config" &&
      args[2] === configPath &&
      (args.length === 3 ||
        (args[3] === "--log-level" &&
          ["trace", "debug", "info", "warn", "error", "fatal"].includes(args[4])))
  );
}
function config(bytes, expected) {
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
      top.get("disabled_plugins")[0] === "io.containerd.grpc.v1.cri" &&
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
    else
      for (const [key, value] of table) {
        need(allowed[name].includes(key));
        if (key === "address" && name !== "grpc" && name !== "debug") need(value === "");
        if (["tcp_address", "tcp_tls_ca", "tcp_tls_cert", "tcp_tls_key", "path"].includes(key))
          need(value === "");
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
function socketRow(line, expectedPath) {
  const value = text(line).trim();
  need(!value.includes("\n") && !value.includes("\r"));
  const columns = value.split(/\s+/u);
  need(
    columns.length === 8 &&
      columns[7] === expectedPath &&
      POSITIVE.test(columns[6]) &&
      /^[0-9a-fA-F]+$/u.test(columns[3]) &&
      (Number.parseInt(columns[3], 16) & 0x10000) !== 0 &&
      /^[0-9a-fA-F]+$/u.test(columns[4]) &&
      Number.parseInt(columns[4], 16) === 1
  );
  return { inode: columns[6], line: value };
}
export function extractR3ContainerdSocketRows({ mountPath, unixBytes }) {
  try {
    const expected = paths(mountPath);
    const rows = text(unixBytes)
      .split(/\r?\n/u)
      .slice(1)
      .filter((line) => line.trim());
    const select = (path) => {
      const matches = rows.filter((line) => line.trim().split(/\s+/u).at(-1) === path);
      need(matches.length === 1);
      return socketRow(Buffer.from(matches[0]), path);
    };
    return Object.freeze({ grpc: select(expected.grpc), debug: select(expected.debug) });
  } catch {
    fail();
  }
}
function socketOwnership(bytes, pid, grpcInode, debugInode) {
  let owners;
  try {
    owners = JSON.parse(text(bytes));
  } catch {
    fail();
  }
  need(Array.isArray(owners) && owners.length >= 2 && owners.length <= 65536);
  const paths = new Set(),
    targets = new Set();
  for (const owner of owners) {
    exact(owner, ["path", "target"]);
    need(
      typeof owner.path === "string" &&
        new RegExp(`^/proc/${pid}/fd/(?:0|[1-9][0-9]*)$`, "u").test(owner.path) &&
        !paths.has(owner.path)
    );
    need([`socket:[${grpcInode}]`, `socket:[${debugInode}]`].includes(owner.target));
    paths.add(owner.path);
    targets.add(owner.target);
  }
  need(targets.size === 2);
}
export function assessR3ContainerdRaw({ mountPath, dockerdPid, rawInputs }) {
  try {
    const expected = paths(mountPath);
    need(Number.isSafeInteger(dockerdPid) && dockerdPid > 0);
    exact(rawInputs, RAW_KEYS);
    const pid = readR3ContainerdPidFile(rawInputs.pidFile);
    const process = processStat(rawInputs.stat, pid, dockerdPid);
    commandLine(rawInputs.cmdline, expected.config);
    config(rawInputs.config, expected);
    const grpc = socketRow(rawInputs.grpcSocketRow, expected.grpc);
    const debug = socketRow(rawInputs.debugSocketRow, expected.debug);
    need(grpc.inode !== debug.inode);
    socketOwnership(rawInputs.socketOwners, pid, grpc.inode, debug.inode);
    return Object.freeze({
      ...process,
      configDigest: sha256Bytes(rawInputs.config),
      rootPath: expected.root,
      statePath: expected.state,
      grpcPath: expected.grpc,
      debugPath: expected.debug,
      grpcListenerInode: grpc.inode,
      debugListenerInode: debug.inode
    });
  } catch {
    fail();
  }
}
