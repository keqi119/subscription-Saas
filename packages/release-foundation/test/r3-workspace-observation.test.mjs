import assert from "node:assert/strict";
import test from "node:test";

const parser = await import("../src/r3-workspace-observation.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/r3-workspace-observation.mjs"))
    return null;
  throw error;
});
const id = "a".repeat(32);
const uuid = "2896e6bd-60c0-44f1-b3a0-14a2e1bc0d39";
const workspace = {
  id,
  capacityBytes: 128 * 1024 * 1024,
  backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
  mountPath: `/srv/stage1-snapshot/${id}`,
  keyFile: `/dev/shm/stage1-keys/${id}.key`,
  mapperName: `s1snap_${id}`
};
const jsonBytes = (value) => Buffer.from(JSON.stringify(value) + "\n");

function fixture(state = "active") {
  return {
    state,
    workspace: { ...workspace },
    mounts: {
      filesystems: [
        {
          target: "/",
          source: "/dev/sda1",
          fstype: "ext4",
          options: "rw,relatime",
          "maj:min": "8:1"
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
          : []),
        {
          target: "/dev/shm",
          source: "shm",
          fstype: "tmpfs",
          options: "rw,nosuid,nodev",
          "maj:min": "0:27"
        }
      ]
    },
    loops: {
      loopdevices:
        state === "active"
          ? [{ name: "/dev/loop4", "back-file": workspace.backingFile, offset: 0, sizelimit: 0 }]
          : []
    },
    blocks: {
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
    },
    mapper: ` ${workspace.mapperName}|CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}|253|2\n`,
    header: {
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
    },
    uuid: uuid + "\n",
    swaps: "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n",
    limits:
      "Limit                     Soft Limit           Hard Limit           Units\n" +
      "Max cpu time              unlimited            unlimited            seconds\n" +
      "Max core file size        0                    0                    bytes\n"
  };
}
function input(f) {
  return {
    workspace: f.workspace,
    state: f.state,
    captured: {
      mounts: jsonBytes(f.mounts),
      loops: jsonBytes(f.loops),
      blocks: jsonBytes(f.blocks),
      ...(f.state === "active"
        ? {
            mapper: Buffer.from(f.mapper),
            header: jsonBytes(f.header),
            uuid: Buffer.from(f.uuid),
            swaps: Buffer.from(f.swaps),
            limits: Buffer.from(f.limits)
          }
        : {})
    }
  };
}
function assess(f) {
  assert.equal(typeof parser?.assessR3WorkspaceObservation, "function");
  return parser.assessR3WorkspaceObservation(input(f));
}
const rejected = (f) =>
  assert.throws(() => assess(f), { code: "R3_WORKSPACE_OBSERVATION_INVALID" });

test("active observation joins real explicit-column output by device number and freezes facts", () => {
  for (const source of [`/dev/mapper/${workspace.mapperName}`, "/dev/dm-2"]) {
    const f = fixture();
    f.mounts.filesystems[1].source = source;
    f.blocks.blockdevices[2].name = source;
    const result = assess(f);
    assert.deepEqual(result.workspace, workspace);
    assert.equal(result.state, "active");
    assert.deepEqual(result.mapper, {
      name: workspace.mapperName,
      uuid: `CRYPT-LUKS2-${uuid.replaceAll("-", "")}-${workspace.mapperName}`,
      majorMinor: "253:2"
    });
    assert.deepEqual(result.loop, {
      name: "/dev/loop4",
      backingFile: workspace.backingFile,
      offset: 0,
      sizeLimit: 0
    });
    assert.deepEqual(result.luks, {
      uuid,
      segmentIds: ["0"],
      encryption: "aes-xts-plain64",
      sectorSize: 4096,
      keySizeBytes: 64
    });
    assert.deepEqual(result.swapDevices, []);
    assert.deepEqual(result.coreLimit, { soft: 0, hard: 0 });
    assert.equal(result.mount.majorMinor, "253:2");
    assert.ok(
      Object.isFrozen(result) &&
        Object.isFrozen(result.workspace) &&
        Object.isFrozen(result.mount.options)
    );
    f.workspace.capacityBytes *= 2;
    assert.equal(result.workspace.capacityBytes, 128 * 1024 * 1024);
  }
});

test("active observation refuses incorrect mount mapper UUID parent and backing correspondence", () => {
  for (const mutate of [
    (f) => {
      f.mounts.filesystems[1]["maj:min"] = "253:3";
    },
    (f) => {
      f.mapper = f.mapper.replace("|253|2", "|253|3");
    },
    (f) => {
      f.uuid = "00000000-0000-4000-8000-000000000001\n";
    },
    (f) => {
      f.blocks.blockdevices[2].pkname = "/dev/loop5";
    },
    (f) => {
      f.blocks.blockdevices[1].type = "disk";
    },
    (f) => {
      f.loops.loopdevices[0]["back-file"] = "/outside/other.luks";
    },
    (f) => {
      f.loops.loopdevices[0].offset = 4096;
    },
    (f) => {
      f.loops.loopdevices[0].sizelimit = 67108864;
    },
    (f) => {
      f.mounts.filesystems[1].source = "/dev/dm-9";
    },
    (f) => {
      f.blocks.blockdevices[2].name = "/dev/dm-9";
    },
    (f) => {
      f.blocks.blockdevices[2].kname = "/dev/sda";
    }
  ]) {
    const f = fixture();
    mutate(f);
    rejected(f);
  }
});

test("active observation refuses weak or reencryption metadata and enabled swap or core dumps", () => {
  for (const mutate of [
    (f) => {
      f.header.segments["0"].type = "linear";
    },
    (f) => {
      f.header.segments["0"].encryption = "aes-cbc-essiv:sha256";
    },
    (f) => {
      f.header.keyslots["0"].key_size = 32;
    },
    (f) => {
      f.header.segments["0"].flags = ["in-reencrypt"];
    },
    (f) => {
      f.header.config.requirements = { mandatory: ["online-reencrypt-v2"] };
    },
    (f) => {
      f.header.digests["0"].keyslots = ["9"];
    },
    (f) => {
      f.swaps += "/swapfile file 1048576 0 -2\n";
    },
    (f) => {
      f.limits = f.limits.replace(
        "0                    0                    bytes",
        "0                    unlimited            bytes"
      );
    },
    (f) => {
      f.limits = f.limits.replace(
        "0                    0                    bytes",
        "4096                 0                    bytes"
      );
    },
    (f) => {
      f.mounts.filesystems[1].options = "ro,nosuid,nodev";
    },
    (f) => {
      f.mounts.filesystems[1].options = "rw,suid,nodev";
    },
    (f) => {
      f.mounts.filesystems.push({ ...f.mounts.filesystems[0], target: "/dev/shm/stage1-keys" });
    }
  ]) {
    const f = fixture();
    mutate(f);
    rejected(f);
  }
});

test("active observation rejects duplicate backing and external or nested mounts including deleted loop backing", () => {
  for (const mutate of [
    (f) => {
      f.mounts.filesystems.push({ ...f.mounts.filesystems[1], target: "/external/alias" });
    },
    (f) => {
      f.mounts.filesystems.push({
        ...f.mounts.filesystems[0],
        target: workspace.mountPath + "/data"
      });
    },
    (f) => {
      f.loops.loopdevices.push({ ...f.loops.loopdevices[0], name: "/dev/loop5" });
    },
    (f) => {
      f.loops.loopdevices[0]["back-file"] += " (deleted)";
    },
    (f) => {
      f.mounts.filesystems.push({
        ...f.mounts.filesystems[0],
        target: "/outside/loop",
        "maj:min": "7:4"
      });
    }
  ]) {
    const f = fixture();
    mutate(f);
    rejected(f);
  }
});

test("absent observation proves only topology absence and refuses residual or incomplete inventories", () => {
  const result = assess(fixture("absent"));
  assert.deepEqual(result, {
    state: "absent",
    workspace,
    mount: null,
    mapper: null,
    loop: null,
    luks: null,
    swapDevices: null,
    coreLimit: null
  });
  for (const mutate of [
    (f) => {
      f.loops.loopdevices.push({
        name: "/dev/loop4",
        "back-file": workspace.backingFile,
        offset: 0,
        sizelimit: 0
      });
    },
    (f) => {
      f.loops.loopdevices.push({
        name: "/dev/loop4",
        "back-file": workspace.backingFile + " (deleted)",
        offset: 0,
        sizelimit: 0
      });
    },
    (f) => {
      f.mounts.filesystems.push({
        ...f.mounts.filesystems[0],
        target: workspace.mountPath + "/old"
      });
    },
    (f) => {
      f.mounts.filesystems.push({
        ...f.mounts.filesystems[0],
        target: workspace.mountPath + " (deleted)"
      });
    },
    (f) => {
      f.blocks.blockdevices.push({
        name: `/dev/mapper/${workspace.mapperName}`,
        kname: "/dev/dm-2",
        type: "crypt",
        "maj:min": "253:2",
        pkname: "/dev/loop4"
      });
    },
    (f) => {
      f.mounts = {};
    },
    (f) => {
      f.blocks = { blockdevices: null };
    },
    (f) => {
      f.mounts.filesystems.push({ ...f.mounts.filesystems[0], target: "/dev/shm/stage1-keys" });
    }
  ]) {
    const f = fixture("absent");
    mutate(f);
    rejected(f);
  }
});

test("absent observation allows unrelated stacked system mounts", () => {
  const f = fixture("absent");
  f.mounts.filesystems.push(
    {
      target: "/proc/sys/fs/binfmt_misc",
      source: "systemd-1",
      fstype: "autofs",
      options: "rw,relatime,fd=36,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=8913",
      "maj:min": "0:34"
    },
    {
      target: "/proc/sys/fs/binfmt_misc",
      source: "binfmt_misc",
      fstype: "binfmt_misc",
      options: "rw,relatime",
      "maj:min": "0:37"
    }
  );
  assert.equal(assess(f).state, "absent");
});

test("absent observation rejects stacked mounts on protected paths", () => {
  for (const target of [
    "/dev/shm",
    "/var/lib/stage1-snapshots",
    "/srv/stage1-snapshot",
    `${workspace.mountPath}/nested`
  ]) {
    const f = fixture("absent");
    f.mounts.filesystems.push(
      {
        target,
        source: "tmpfs",
        fstype: "tmpfs",
        options: "rw,nosuid,nodev",
        "maj:min": "0:41"
      },
      {
        target,
        source: "tmpfs",
        fstype: "tmpfs",
        options: "rw,nosuid,nodev",
        "maj:min": "0:42"
      }
    );
    rejected(f);
  }
});

test("observation accepts only fixed inert workspace and complete stdout buffers without secret or success overrides", () => {
  assert.equal(typeof parser?.assessR3WorkspaceObservation, "function");
  const base = input(fixture());
  for (const value of [
    { ...base, workspace: { ...workspace, mountPath: "/outside/operation" } },
    { ...base, workspace: { ...workspace, capacityBytes: 1 } },
    { ...base, workspace: { ...workspace, secret: "never-read" } },
    { ...base, state: "success" },
    { ...base, captured: { ...base.captured, command: Buffer.from("arbitrary") } },
    { ...base, captured: { ...base.captured, swaps: true } },
    { ...base, captured: { ...base.captured, blocks: Buffer.from('{"blockdevices":[]}') } },
    { ...base, captured: { ...base.captured, mounts: Buffer.from([0xff]) } },
    { ...base, captured: { ...base.captured, uuid: Buffer.alloc(0) } },
    { ...base, success: true }
  ])
    assert.throws(() => parser.assessR3WorkspaceObservation(value), {
      code: "R3_WORKSPACE_OBSERVATION_INVALID"
    });
  let getters = 0;
  const accessor = {
    ...base,
    workspace: Object.defineProperty({ ...workspace }, "keyFile", {
      enumerable: true,
      get() {
        getters++;
        return workspace.keyFile;
      }
    })
  };
  assert.throws(() => parser.assessR3WorkspaceObservation(accessor), {
    code: "R3_WORKSPACE_OBSERVATION_INVALID"
  });
  assert.equal(getters, 0);
});
