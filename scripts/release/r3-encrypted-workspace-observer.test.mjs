import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const operationRef = "10000000-0000-4000-8000-000000000001";
const id = operationRef.replaceAll("-", "");
const capacityBytes = 1073741824;
const uuid = "2896e6bd-60c0-44f1-b3a0-14a2e1bc0d39";
const workspace = {
  backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
  keyFile: `/dev/shm/stage1-keys/${id}.key`,
  mountPath: `/srv/stage1-snapshot/${id}`,
  mapperName: `s1snap_${id}`
};
const machineId = "b".repeat(32);
const header = {
  keyslots: {
    0: {
      type: "luks2",
      key_size: 64,
      af: { type: "luks1", stripes: 4000, hash: "sha256" },
      area: {
        type: "raw",
        offset: "32768",
        size: "258048",
        encryption: "aes-xts-plain64",
        key_size: 64
      },
      kdf: { type: "argon2id", time: 4, memory: 1048576, cpus: 4, salt: "test-public-metadata" }
    }
  },
  tokens: {},
  segments: {
    0: {
      type: "crypt",
      offset: "16777216",
      size: "dynamic",
      iv_tweak: "0",
      encryption: "aes-xts-plain64",
      sector_size: 4096
    }
  },
  digests: {
    0: {
      type: "pbkdf2",
      keyslots: ["0"],
      segments: ["0"],
      hash: "sha256",
      iterations: 232954,
      salt: "test-public-metadata",
      digest: "test-public-digest"
    }
  },
  config: { json_size: "12288", keyslots_size: "16744448" }
};
function fakeStat(kind, size = 0, ino = 42n, mode) {
  return {
    dev: 1n,
    ino,
    mode: mode ?? (kind === "directory" ? 0o40700n : 0o100600n),
    uid: 0n,
    gid: 0n,
    nlink: 1n,
    size: BigInt(size),
    mtimeNs: 1n,
    ctimeNs: 1n,
    rdev: 0n,
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
    isFile: () => kind === "file",
    isBlockDevice: () => kind === "block"
  };
}
async function nativeFixture(t, state, fault = null) {
  const actualRead = fs.readFile.bind(fs),
    actualSpawn = childProcess.spawn.bind(childProcess);
  const policyPath = new URL(
    "../../release/contracts/manual-stage1-r3-target-policy.v1.json",
    import.meta.url
  );
  const policy = await actualRead(policyPath);
  const reads = [],
    calls = [],
    closes = [],
    stats = new Map();
  const leaves = new Set([
    workspace.backingFile,
    workspace.keyFile,
    workspace.mountPath,
    `/dev/mapper/${workspace.mapperName}`
  ]);
  t.mock.method(process, "getuid", () => 0);
  t.mock.method(fs, "lstat", async (file) => {
    const count = (stats.get(file) ?? 0) + 1;
    stats.set(file, count);
    if (state === "absent" && leaves.has(file))
      throw Object.assign(new Error("unavailable"), {
        code: fault === "denied" ? "EACCES" : "ENOENT"
      });
    if (file === workspace.backingFile) return fakeStat("file", capacityBytes);
    if (file === workspace.keyFile)
      return fakeStat("file", 64, fault === "key-replaced" && count > 1 ? 43n : 42n);
    if (file === `/dev/mapper/${workspace.mapperName}`) return fakeStat("symlink");
    const privatePath = [
      "/var/lib/stage1-snapshots",
      "/srv/stage1-snapshot",
      "/dev/shm/stage1-keys"
    ].some((root) => file === root || file.startsWith(root + "/"));
    return fakeStat(
      "directory",
      0,
      42n,
      file === "/dev/shm" ? 0o41777n : privatePath ? 0o40700n : 0o40755n
    );
  });
  t.mock.method(fs, "stat", async (file) =>
    file === "/dev/dm-2" ? fakeStat("block") : fakeStat("file", 1234, 42n, 0o100755n)
  );
  t.mock.method(fs, "realpath", async (file) => {
    assert.equal(file, `/dev/mapper/${workspace.mapperName}`);
    return "/dev/dm-2";
  });
  t.mock.method(fs, "readFile", async (file) => {
    const name = String(file);
    reads.push(name);
    if (name.endsWith("/manual-stage1-r3-target-policy.v1.json")) return Buffer.from(policy);
    if (name === "/etc/machine-id") return Buffer.from(machineId + "\n");
    if (name === "/proc/swaps") return Buffer.from("Filename\tType\tSize\tUsed\tPriority\n");
    if (name === "/proc/self/limits")
      return Buffer.from(
        "Limit Soft Limit Hard Limit Units\nMax core file size        0                    0                    bytes\n"
      );
    assert.fail(`Unexpected content read: ${name}`);
  });
  const outputs = {
    findmnt: {
      filesystems: [
        {
          target: "/",
          source: "/dev/sda1",
          fstype: "ext4",
          options: "rw,relatime",
          "maj:min": "8:1"
        },
        {
          target: "/dev/shm",
          source: "tmpfs",
          fstype: "tmpfs",
          options: "rw,nosuid,nodev",
          "maj:min": "0:42"
        },
        ...(state === "active"
          ? [
              {
                target: workspace.mountPath,
                source: `/dev/mapper/${workspace.mapperName}`,
                fstype: "ext4",
                options: "rw,nosuid,nodev,relatime",
                "maj:min": "253:2"
              }
            ]
          : [])
      ]
    },
    losetup: {
      loopdevices:
        state === "active"
          ? [{ name: "/dev/loop4", "back-file": workspace.backingFile, offset: 0, sizelimit: 0 }]
          : []
    },
    lsblk: {
      blockdevices: [
        {
          name: "/dev/sda1",
          kname: "/dev/sda1",
          type: "part",
          "maj:min": "8:1",
          pkname: "/dev/sda"
        },
        ...(state === "active"
          ? [
              {
                name: "/dev/loop4",
                kname: "/dev/loop4",
                type: "loop",
                "maj:min": "7:4",
                pkname: null
              },
              {
                name: `/dev/mapper/${workspace.mapperName}`,
                kname: "/dev/dm-2",
                type: "crypt",
                "maj:min": "253:2",
                pkname: "/dev/loop4"
              }
            ]
          : [])
      ]
    }
  };
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.deepEqual(options.env, {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LC_ALL: "C",
      LANG: "C"
    });
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    const tool = command.split("/").at(-1);
    assert.ok(["findmnt", "losetup", "lsblk", "dmsetup", "cryptsetup"].includes(tool));
    assert.equal(args.includes("--dump-volume-key"), false);
    assert.equal(args.includes("--key-file"), false);
    const output = outputs[tool]
      ? JSON.stringify(outputs[tool]) + "\n"
      : tool === "dmsetup"
        ? `${workspace.mapperName}|CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}|253|2\n`
        : args[0] === "luksDump"
          ? JSON.stringify(header) + "\n"
          : uuid + "\n";
    const exitCode = fault === "command-failed" && tool === "findmnt" ? 1 : 0;
    // Real Node children provide the actual spawn/close stream. Kernel/CLI
    // outputs and filesystem metadata are synthetic, not real LUKS acceptance.
    const child = actualSpawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(output)});process.exitCode=${exitCode}`],
      options
    );
    calls.push({ command, args, pid: child.pid });
    child.once("close", (code, signal) => closes.push({ pid: child.pid, code, signal }));
    return child;
  });
  const { observeR3EncryptedWorkspace } = await import("./r3-encrypted-workspace-observer.mjs");
  return {
    run: () => observeR3EncryptedWorkspace({ operationRef, capacityBytes, state }),
    reads,
    calls,
    closes
  };
}

test("R3 workspace observer rejects caller paths and adapters before native reads", async () => {
  const { observeR3EncryptedWorkspace } = await import("./r3-encrypted-workspace-observer.mjs");
  const input = {
    operationRef: "10000000-0000-4000-8000-000000000001",
    capacityBytes: 1073741824,
    state: "active"
  };
  for (const change of [
    { path: "/other-project" },
    { io: {} },
    { state: "success" },
    { operationRef: "../escape" },
    { capacityBytes: 1000 }
  ])
    await assert.rejects(observeR3EncryptedWorkspace({ ...input, ...change }), {
      code: "R3_WORKSPACE_INPUT_INVALID"
    });
});

test(
  "R3 workspace native collector preserves actual process closes without reading key or backing",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await nativeFixture(t, "active");
    const result = await f.run();
    assert.equal(result.observation.status, "OBSERVED");
    assert.equal(result.observation.facts.state, "active");
    assert.equal(
      result.observation.hostFingerprint,
      sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machineId}`))
    );
    assert.equal(result.observation.processes.length, 6);
    assert.equal(f.closes.length, 6);
    for (const call of result.observation.processes) {
      assert.ok(
        f.closes.some(
          (close) => close.pid === call.pid && close.code === 0 && close.signal === null
        )
      );
      assert.equal(call.stdout.digest, sha256Bytes(result.rawInputs[`${call.name}.stdout`]));
      assert.equal(call.stderr.bytes, 0);
    }
    assert.equal(f.reads.includes(workspace.keyFile), false);
    assert.equal(f.reads.includes(workspace.backingFile), false);
    assert.equal(result.observation.promotionEligible, false);
    assert.ok(Object.isFrozen(result.observation));
  }
);

test(
  "R3 workspace absence requires successful full topology and ENOENT rather than a failed lookup",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await nativeFixture(t, "absent");
    const result = await f.run();
    assert.equal(result.observation.facts.state, "absent");
    assert.equal(result.observation.processes.length, 3);
    assert.equal(result.observation.files.filter((file) => file.exists === false).length, 4);
    t.mock.restoreAll();
    const denied = await nativeFixture(t, "absent", "denied");
    await assert.rejects(
      denied.run(),
      (error) =>
        error.code === "R3_WORKSPACE_OBSERVATION_INVALID" &&
        error.evidence.observation.status === "INCOMPLETE" &&
        error.evidence.observation.facts === null
    );
    assert.equal(denied.calls.length, 0);
  }
);

test(
  "R3 workspace collector retains failed process evidence and refuses changed leaf identity",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const fault of ["command-failed", "key-replaced"]) {
      const f = await nativeFixture(t, "active", fault);
      await assert.rejects(f.run(), (error) => {
        assert.equal(error.code, "R3_WORKSPACE_OBSERVATION_INVALID");
        assert.equal(error.evidence.observation.status, "INCOMPLETE");
        assert.equal(error.evidence.observation.facts, null);
        if (fault === "command-failed") {
          const [call] = error.evidence.observation.processes;
          assert.equal(call.exitCode, 1);
          assert.equal(call.pid, f.closes[0].pid);
          assert.equal(call.stdout.digest, sha256Bytes(error.evidence.rawInputs["mounts.stdout"]));
        }
        return true;
      });
      t.mock.restoreAll();
    }
  }
);
