// Fixed checks for the existing H1 main signing-key volume. This module never
// opens the key and accepts no paths or environment overrides.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CODE = "H1_GITHUB_JWT_UNAVAILABLE";
const MOUNT = "/var/lib/stage1-volumes/main";
const BACKING = "/var/lib/stage1-ciphertext/main.luks";
const MAPPER = "/dev/mapper/stage1-h1-main";
const UUID = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const identity = (left, right) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => left[key] === right[key]
  );

async function directories(file) {
  let current = path.posix.dirname(file);
  while (true) {
    const stat = await lstat(current);
    requireThat(
      stat.isDirectory() && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o022) === 0
    );
    if (current === MOUNT || current.startsWith(`${MOUNT}/`))
      requireThat((stat.mode & 0o777) === 0o700);
    if (current === "/") break;
    current = path.posix.dirname(current);
  }
}

function hostIdentity() {
  requireThat(process.platform === "linux" && process.getuid() === 0 && process.getgid() === 0);
}

function validateMemory(swaps, pattern, limits) {
  requireThat(swaps.trim().split(/\r?\n/).length === 1);
  requireThat(pattern.trim() === "|/bin/false");
  requireThat(/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(limits));
}

async function command(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: "/",
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
        encoding: "utf8",
        maxBuffer: 8192,
        timeout: 10000
      },
      (error, stdout) => (error ? reject(new Error(CODE)) : resolve(stdout.trim()))
    );
  });
}

export function assertH1KeyMemory() {
  try {
    hostIdentity();
    validateMemory(
      readFileSync("/proc/swaps", "utf8"),
      readFileSync("/proc/sys/kernel/core_pattern", "utf8"),
      readFileSync("/proc/self/limits", "utf8")
    );
  } catch {
    fail();
  }
}

async function protection() {
  hostIdentity();
  validateMemory(
    await readFile("/proc/swaps", "utf8"),
    await readFile("/proc/sys/kernel/core_pattern", "utf8"),
    await readFile("/proc/self/limits", "utf8")
  );
}

async function volume() {
  await directories(BACKING);
  const backing = await lstat(BACKING);
  requireThat(
    backing.isFile() &&
      backing.uid === 0 &&
      backing.gid === 0 &&
      backing.nlink === 1 &&
      (backing.mode & 0o777) === 0o600 &&
      backing.size === 1073741824
  );
  requireThat((await command("/usr/sbin/cryptsetup", ["luksUUID", BACKING])) === UUID);
  const status = await command("/usr/sbin/cryptsetup", ["status", "stage1-h1-main"]);
  requireThat(/^\s*type:\s+LUKS2\s*$/m.test(status));
  const loop = status.match(/^\s*device:\s*(\/dev\/loop[0-9]+)\s*$/m)?.[1];
  requireThat(
    loop &&
      (await command("/usr/sbin/losetup", ["-j", BACKING]))
        .split("\n")
        .some((line) => line.startsWith(`${loop}:`))
  );
  const found = JSON.parse(
    await command("/usr/bin/findmnt", [
      "--json",
      "--mountpoint",
      MOUNT,
      "--output",
      "TARGET,SOURCE,FSTYPE,OPTIONS"
    ])
  );
  requireThat(Array.isArray(found.filesystems) && found.filesystems.length === 1);
  const mount = found.filesystems[0];
  requireThat(
    mount.target === MOUNT &&
      mount.fstype === "ext4" &&
      !mount.children &&
      typeof mount.source === "string" &&
      typeof mount.options === "string" &&
      ["nosuid", "nodev", "noexec"].every((flag) => mount.options.split(",").includes(flag)) &&
      (await realpath(mount.source)) === (await realpath(MAPPER))
  );
  requireThat(identity(backing, await lstat(BACKING)));
}

export async function assertH1KeyVolume() {
  try {
    await protection();
    await volume();
    assertH1KeyMemory();
  } catch {
    fail();
  }
}
