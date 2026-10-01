// Hosted-side read-only evidence collection. This neither grants a manual
// capability nor proves Engine/PG disposal. The parent must verify the signed
// job, original bytes and the remaining destination/resource graph separately.
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { assessR3WorkspaceObservation } from "../../packages/release-foundation/src/r3-workspace-observation.mjs";

const INPUT = "R3_WORKSPACE_INPUT_INVALID";
const INVALID = "R3_WORKSPACE_OBSERVATION_INVALID";
const LIMIT = 1048576;
const policyPath = fileURLToPath(
  new URL("../../release/contracts/manual-stage1-r3-target-policy.v1.json", import.meta.url)
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const stamp = () => new Date().toISOString();
const fail = (code = INVALID) => {
  throw Object.assign(new Error(code), { code });
};
const requireThat = (condition, code = INVALID) => {
  if (!condition) fail(code);
};
const ref = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const item = Object.getOwnPropertyDescriptor(value, key);
      return item?.enumerable && Object.hasOwn(item, "value");
    })
  );
}
function freeze(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const identityKeys = [
  "dev",
  "ino",
  "mode",
  "uid",
  "gid",
  "nlink",
  "size",
  "mtimeNs",
  "ctimeNs",
  "rdev"
];
const identity = (value) =>
  Object.fromEntries(identityKeys.map((key) => [key, String(value[key])]));
const sameIdentity = (left, right) => identityKeys.every((key) => left[key] === right[key]);
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export async function observeR3EncryptedWorkspace(input) {
  requireThat(exact(input, ["operationRef", "capacityBytes", "state"]), INPUT);
  const { operationRef, capacityBytes, state } = input;
  requireThat(
    typeof operationRef === "string" &&
      UUID.test(operationRef) &&
      Number.isSafeInteger(capacityBytes) &&
      capacityBytes >= 64 * 1048576 &&
      capacityBytes % 1048576 === 0 &&
      ["active", "absent"].includes(state),
    INPUT
  );
  requireThat(process.platform === "linux" && process.getuid?.() === 0);
  const rawInputs = {},
    processes = [],
    files = [],
    heldPaths = [];
  const startedAt = stamp();
  let workspace, policyDigest, hostFingerprint;
  const evidence = (facts = null) => {
    const observation = freeze({
      schemaVersion: "manual-r3-workspace-observation.v1",
      operationRef,
      policyDigest: policyDigest ?? null,
      state,
      startedAt,
      finishedAt: stamp(),
      hostFingerprint: hostFingerprint ?? null,
      workspace: workspace ?? null,
      promotionEligible: false,
      status: facts === null ? "INCOMPLETE" : "OBSERVED",
      facts,
      processes,
      files
    });
    return Object.freeze({
      observation,
      observationDigest: sha256Canonical(observation),
      rawInputs: Object.freeze(
        Object.fromEntries(
          Object.entries(rawInputs).map(([key, bytes]) => [key, Buffer.from(bytes)])
        )
      )
    });
  };
  const captured = {};
  const read = async (name, file) => {
    const bytes = await fs.readFile(file);
    requireThat(Buffer.isBuffer(bytes) && bytes.length <= LIMIT);
    rawInputs[name] = bytes;
    files.push({ name, path: file, observedAt: stamp(), ...ref(bytes) });
    return bytes;
  };
  const execute = async (name, command, args) => {
    // Fixed executables and an isolated environment: no ambient Docker, loader,
    // libmount, key, profile or PostgreSQL variables can select another source.
    const before = await fs.stat(command, { bigint: true });
    requireThat(before.isFile() && before.uid === 0n && (before.mode & 0o022n) === 0n);
    const call = {
      name,
      command,
      args,
      executable: identity(before),
      startedAt: stamp(),
      pid: null,
      closedAt: null,
      exitCode: null,
      signal: null,
      stdout: null,
      stderr: null
    };
    processes.push(call);
    const result = await new Promise((resolve) => {
      let child,
        timer,
        size = 0,
        overflow = false,
        spawnError = false;
      const stdout = [],
        stderr = [];
      try {
        child = childProcess.spawn(command, args, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C" }
        });
        call.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
        const collect = (target) => (chunk) => {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > LIMIT) {
            overflow = true;
            child.kill("SIGKILL");
          } else target.push(bytes);
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        child.once("error", () => {
          spawnError = true;
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          Object.assign(call, { closedAt: stamp(), exitCode, signal });
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            overflow,
            spawnError
          });
        });
        timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      } catch {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          overflow,
          spawnError: true
        });
      }
    });
    rawInputs[`${name}.stdout`] = result.stdout;
    rawInputs[`${name}.stderr`] = result.stderr;
    Object.assign(call, { stdout: ref(result.stdout), stderr: ref(result.stderr) });
    requireThat(
      !result.overflow &&
        !result.spawnError &&
        call.pid !== null &&
        call.closedAt !== null &&
        call.exitCode === 0 &&
        call.signal === null &&
        result.stderr.length === 0
    );
    requireThat(sameIdentity(before, await fs.stat(command, { bigint: true })));
    captured[name] = result.stdout;
  };
  try {
    const policyBytes = await read("policy", policyPath);
    const policy = JSON.parse(text(policyBytes));
    validateContract("manual-stage1-r3-target-policy.v1", policy);
    policyDigest = sha256Bytes(policyBytes);
    const id = operationRef.replaceAll("-", ""),
      roots = policy.workspace;
    workspace = {
      id,
      capacityBytes,
      backingFile: `${roots.backingRoot}/${id}.luks`,
      mountPath: `${roots.mountRoot}/${id}`,
      keyFile: `${roots.keyRoot}/${id}.key`,
      mapperName: `${roots.mapperPrefix}${id}`
    };
    const machine = text(await read("machineId", "/etc/machine-id")).trim();
    requireThat(/^[0-9a-f]{32}$/u.test(machine));
    hostFingerprint = sha256Bytes(Buffer.from(`subscription-saas/linux-machine-id/v1\n${machine}`));
    const privateRoots = [roots.backingRoot, roots.mountRoot, roots.keyRoot];
    const inspect = async (file, kind, allowMissing = false) => {
      let current = "/",
        leaf;
      const parts = file.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index++) {
        current = path.posix.join(current, parts[index]);
        const last = index === parts.length - 1;
        let stat;
        try {
          stat = await fs.lstat(current, { bigint: true });
        } catch (error) {
          if (last && allowMissing && error.code === "ENOENT") {
            heldPaths.push({ path: current, absent: true });
            files.push({ name: kind, path: current, exists: false, observedAt: stamp() });
            return null;
          }
          throw error;
        }
        requireThat(stat.uid === 0n);
        const privatePath = privateRoots.some(
          (root) => current === root || current.startsWith(root + "/")
        );
        if (!last || kind === "directory") {
          requireThat(stat.isDirectory() && !stat.isSymbolicLink());
          if (privatePath) requireThat((stat.mode & 0o077n) === 0n);
          else
            requireThat(
              (stat.mode & 0o022n) === 0n ||
                (current === "/dev/shm" && (stat.mode & 0o1000n) !== 0n)
            );
        } else if (kind === "mapper") {
          requireThat(stat.isSymbolicLink() || stat.isBlockDevice());
          const resolved = await fs.realpath(current);
          requireThat(/^\/dev\/dm-[0-9]+$/u.test(resolved));
          const block = await fs.stat(resolved, { bigint: true });
          requireThat(block.isBlockDevice() && block.uid === 0n);
        } else
          requireThat(
            stat.isFile() &&
              !stat.isSymbolicLink() &&
              stat.nlink === 1n &&
              (stat.mode & 0o077n) === 0n
          );
        heldPaths.push({ path: current, stat, directory: stat.isDirectory() });
        leaf = stat;
      }
      files.push({
        name: kind,
        path: file,
        exists: true,
        observedAt: stamp(),
        identity: identity(leaf)
      });
      return leaf;
    };
    const absent = state === "absent";
    const backing = await inspect(workspace.backingFile, "backing", absent);
    const key = await inspect(workspace.keyFile, "key", absent);
    const mount = await inspect(workspace.mountPath, "directory", absent);
    const mapper = await inspect(`/dev/mapper/${workspace.mapperName}`, "mapper", absent);
    requireThat(
      absent
        ? !backing && !key && !mount && !mapper
        : backing.size === BigInt(capacityBytes) && key.size === 64n && mount.isDirectory()
    );
    await execute("mounts", "/usr/bin/findmnt", [
      "--json",
      "--list",
      "--kernel",
      "--output",
      "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN"
    ]);
    await execute("loops", "/usr/sbin/losetup", [
      "--json",
      "--list",
      "--output",
      "NAME,BACK-FILE,OFFSET,SIZELIMIT"
    ]);
    await execute("blocks", "/usr/bin/lsblk", [
      "--json",
      "--list",
      "--paths",
      "--output",
      "NAME,KNAME,TYPE,MAJ:MIN,PKNAME"
    ]);
    if (!absent) {
      await execute("mapper", "/usr/sbin/dmsetup", [
        "info",
        "--columns",
        "--noheadings",
        "--separator",
        "|",
        "--options",
        "name,uuid,major,minor",
        workspace.mapperName
      ]);
      await execute("header", "/usr/sbin/cryptsetup", [
        "luksDump",
        "--dump-json-metadata",
        workspace.backingFile
      ]);
      await execute("uuid", "/usr/sbin/cryptsetup", ["luksUUID", workspace.backingFile]);
      captured.swaps = await read("swaps", "/proc/swaps");
      captured.limits = await read("limits", "/proc/self/limits");
    }
    const facts = assessR3WorkspaceObservation({ workspace, state, captured });
    // Keep path/owner/inode identities stable during this observation. Directory
    // timestamps/nlink may change with other entries; leaf metadata may not.
    for (const held of heldPaths) {
      let current;
      try {
        current = await fs.lstat(held.path, { bigint: true });
      } catch (error) {
        if (held.absent && error.code === "ENOENT") continue;
        throw error;
      }
      requireThat(!held.absent);
      requireThat(
        held.directory
          ? ["dev", "ino", "mode", "uid", "gid"].every((key) => current[key] === held.stat[key]) &&
              current.isDirectory() &&
              !current.isSymbolicLink()
          : sameIdentity(current, held.stat)
      );
    }
    requireThat((await fs.readFile(policyPath)).equals(policyBytes));
    requireThat(text(await fs.readFile("/etc/machine-id")).trim() === machine);
    return evidence(facts);
  } catch (cause) {
    // Preserve actual partial observations for the caller's private archive.
    // No stderr, key material or arbitrary host error is put in the message.
    throw Object.assign(new Error(INVALID), { code: INVALID, evidence: evidence() });
  }
}
