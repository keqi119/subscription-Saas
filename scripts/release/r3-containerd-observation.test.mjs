import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

import { observeR3ManagedContainerd } from "./r3-containerd-observation.mjs";

const mountPath = "/srv/stage1-snapshot/123e4567e89b42d3a456426614174000";
const base = `${mountPath}/exec/containerd`;
const config = `${base}/containerd.toml`;
const grpc = `${base}/containerd.sock`;
const debug = `${base}/containerd-debug.sock`;
const pid = 456;
const dockerdPid = 123;
const statLine = (parent = dockerdPid, start = "999") =>
  `${pid} (containerd) S ${parent} ${Array(17).fill("0").join(" ")} ${start} 0 0\n`;
const toml = () =>
  `version = 2\nroot = "${mountPath}/docker/containerd/daemon"\nstate = "${base}/daemon"\ntemp = ""\nplugin_dir = ""\nimports = []\nrequired_plugins = []\ndisabled_plugins = ["io.containerd.grpc.v1.cri"]\n[grpc]\naddress = "${grpc}"\nuid = 0\ngid = 0\ntcp_address = ""\ntcp_tls_ca = ""\ntcp_tls_cert = ""\ntcp_tls_key = ""\n[debug]\naddress = "${debug}"\nuid = 0\ngid = 0\n[ttrpc]\naddress = ""\n[metrics]\naddress = ""\n`;
const invalid = (fn) => assert.rejects(fn, { code: "R3_CONTAINERD_OBSERVATION_INVALID" });

function fixture(t, changes = {}) {
  const original = Object.fromEntries(
    ["readFile", "lstat", "stat", "realpath", "readlink", "readdir"].map((name) => [name, fs[name]])
  );
  const files = new Map([
    [`${base}/containerd.pid`, `${pid}\n`],
    [config, changes.config ?? toml()],
    [`/proc/${pid}/stat`, changes.stat ?? statLine()],
    [`/proc/${pid}/cmdline`, `containerd\0--config\0${config}\0`],
    [
      "/proc/net/unix",
      `Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 10000 1 01 8001 ${grpc}\n001: 2 0 10000 1 01 8002 ${debug}\n`
    ]
  ]);
  let statReads = 0;
  fs.readFile = async (path) => {
    if (path === `/proc/${pid}/stat` && changes.drift && ++statReads > 1)
      return Buffer.from(statLine(dockerdPid, "1000"));
    if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return Buffer.from(files.get(path));
  };
  const root = {
    dev: 8n,
    ino: 1n,
    uid: 0n,
    gid: 0n,
    mode: 0o40700n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
    isSocket: () => false
  };
  fs.lstat = async (path) => {
    if (
      path === mountPath ||
      path === `${mountPath}/docker` ||
      path === `${mountPath}/docker/containerd` ||
      path === `${mountPath}/docker/containerd/daemon` ||
      path === `${mountPath}/exec` ||
      path === base ||
      path === `${base}/daemon`
    )
      return root;
    if (path === grpc || path === debug)
      return {
        ...root,
        ino: path === grpc ? 81n : 82n,
        mode: 0o140600n,
        isDirectory: () => false,
        isSocket: () => true
      };
    if (files.has(path))
      return { ...root, ino: 3n, mode: 0o100600n, isDirectory: () => false, isFile: () => true };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  fs.stat = async () => ({
    ...root,
    ino: 90n,
    mode: 0o100755n,
    isDirectory: () => false,
    isFile: () => true
  });
  fs.realpath = async (path) => (changes.badRealpath && path === grpc ? "/tmp/escape" : path);
  fs.readlink = async (path) =>
    path === `/proc/${pid}/exe`
      ? "/usr/bin/containerd"
      : path === `/proc/${pid}/fd/3`
        ? "socket:[8001]"
        : path === `/proc/${pid}/fd/4`
          ? changes.wrongOwner
            ? "socket:[9002]"
            : "socket:[8002]"
          : "pipe:[7]";
  fs.readdir = async () => ["3", "4"];
  t.after(() => {
    for (const [name, method] of Object.entries(original)) fs[name] = method;
  });
}

test("R3 containerd observes fixed encrypted paths and owned listeners", async (t) => {
  fixture(t);
  const result = await observeR3ManagedContainerd({ mountPath, dockerdPid });
  assert.equal(result.facts.pid, pid);
  assert.equal(result.facts.starttime, "999");
  assert.equal(result.facts.root.path, `${mountPath}/docker/containerd/daemon`);
  assert.equal(result.facts.grpc.path, grpc);
  assert.ok(result.rawInputs.config.length > 0);
  assert.deepEqual(JSON.parse(result.rawInputs.socketOwners), [
    { path: `/proc/${pid}/fd/3`, target: "socket:[8001]" },
    { path: `/proc/${pid}/fd/4`, target: "socket:[8002]" }
  ]);
});

test("R3 containerd rejects config escape and wrong parent", async (t) => {
  fixture(t, { config: toml().replace(`root = "${mountPath}`, `root = "/tmp`) });
  await invalid(() => observeR3ManagedContainerd({ mountPath, dockerdPid }));
  fs.readFile = async (path) =>
    Buffer.from(
      path === `/proc/${pid}/stat`
        ? statLine(999)
        : path === `${base}/containerd.pid`
          ? `${pid}\n`
          : path === config
            ? toml()
            : path === `/proc/${pid}/cmdline`
              ? `containerd\0--config\0${config}\0`
              : ""
    );
  await invalid(() => observeR3ManagedContainerd({ mountPath, dockerdPid }));
});

test("R3 containerd rejects socket escape, wrong fd ownership and starttime drift", async (t) => {
  fixture(t, { badRealpath: true });
  await invalid(() => observeR3ManagedContainerd({ mountPath, dockerdPid }));
  fs.realpath = async (path) => path;
  fs.readlink = async (path) =>
    path === `/proc/${pid}/exe` ? "/usr/bin/containerd" : "socket:[9002]";
  await invalid(() => observeR3ManagedContainerd({ mountPath, dockerdPid }));
  fs.readlink = async (path) =>
    path === `/proc/${pid}/exe`
      ? "/usr/bin/containerd"
      : path === `/proc/${pid}/fd/3`
        ? "socket:[8001]"
        : "socket:[8002]";
  const previous = fs.readFile;
  let reads = 0;
  fs.readFile = async (path) =>
    path === `/proc/${pid}/stat` && ++reads > 1
      ? Buffer.from(statLine(dockerdPid, "1000"))
      : previous(path);
  await invalid(() => observeR3ManagedContainerd({ mountPath, dockerdPid }));
});
