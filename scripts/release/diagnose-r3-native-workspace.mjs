// Manual, diagnostic-only native tool/observer exercise on a fresh GitHub-hosted VM.
// No production creation request, authorization, H1 grant, or release result is used.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeR3EncryptedWorkspace } from "./r3-encrypted-workspace-observer.mjs";
import { getR3FailureDiagnostic } from "./r3-failure-diagnostic.mjs";
import { startR3HostedEngineForDiagnostic } from "./r3-hosted-creation-control.mjs";
import { projectR3HostedFailure } from "./r3-hosted-failure-diagnostic.mjs";

const exec = promisify(execFile);
const OUTPUT = ".release-output/native-workspace-diagnostic";
const CAPACITY = 64 * 1048576;
const RAW_NAMES = [
  "mounts.stdout",
  "loops.stdout",
  "blocks.stdout",
  "mapper.stdout",
  "header.stdout",
  "uuid.stdout",
  "swaps",
  "limits"
];
let rawCount = 0,
  rawBytes = 0;
const roots = {
  backing: "/var/lib/stage1-snapshots",
  mount: "/srv/stage1-snapshot",
  key: "/dev/shm/stage1-keys"
};
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const PUBLIC_CODES = new Set([
  "R3_WORKSPACE_OBSERVATION_INVALID",
  "R3_WORKSPACE_INPUT_INVALID",
  "ENOENT",
  "EEXIST",
  "EACCES",
  "EPERM",
  "ETIMEDOUT",
  "RAW_LIMIT_EXCEEDED",
  "OBSERVER_STATE_INVALID",
  "ROOT_ALREADY_EXISTS",
  "ROOT_IDENTITY_INVALID",
  "HOST_IDENTITY_INVALID",
  "HOSTED_DISPATCH_INVALID",
  "SWAP_PRESENT",
  "CORE_LIMIT_INVALID",
  "TOOL_PACKAGE_INVALID"
]);
for (const name of [
  "FALLOCATE",
  "LUKSFORMAT",
  "LUKSOPEN",
  "MKFS",
  "MOUNT",
  "UMOUNT",
  "LUKSCLOSE"
]) {
  PUBLIC_CODES.add(`COMMAND_${name}_FAILED`);
  PUBLIC_CODES.add(`COMMAND_${name}_STDERR`);
}
export const publicFailureCode = (error) =>
  PUBLIC_CODES.has(error?.code) ? error.code : "DIAGNOSTIC_PHASE_FAILED";
export function recordPublicFailure(target, stage, error) {
  const field = stage === "ABSENT_AFTER" ? "cleanupObservationFailure" : "failure";
  if (!target[field]) target[field] = { phase: stage, code: publicFailureCode(error) };
}
const status = {
  schemaVersion: "r3-native-workspace-diagnostic.v1",
  diagnosticOnly: true,
  R3Passed: false,
  phase: "PREFLIGHT",
  result: "INCOMPLETE",
  operationRef: null,
  observations: [],
  commands: [],
  cleanup: { complete: false, failures: [] }
};
let owned = null;
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const need = (condition, code) => {
  if (!condition) fail(code);
};

async function command(name, binary, args) {
  const row = {
    name,
    binary: path.basename(binary),
    exitCode: null,
    stdoutBytes: null,
    stderrBytes: null,
    outcome: "UNKNOWN"
  };
  status.commands.push(row);
  try {
    const result = await exec(binary, args, {
      encoding: "buffer",
      shell: false,
      timeout: name === "luksFormat" ? 120000 : 30000,
      maxBuffer: 1048576,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C" }
    });
    row.exitCode = 0;
    row.stdoutBytes = result.stdout.length;
    row.stderrBytes = result.stderr.length;
    row.outcome = "OK";
    if (result.stderr.length !== 0) {
      row.outcome = "FAILED_STDERR";
      fail(`COMMAND_${name.toUpperCase()}_STDERR`);
    }
  } catch (error) {
    row.exitCode = Number.isInteger(error.code) ? error.code : null;
    row.stdoutBytes = Buffer.isBuffer(error.stdout) ? error.stdout.length : null;
    row.stderrBytes = Buffer.isBuffer(error.stderr) ? error.stderr.length : null;
    row.outcome = "FAILED";
    fail(`COMMAND_${name.toUpperCase()}_FAILED`);
  }
}

function safeObservation(stage, value) {
  const o = value.observation;
  return {
    stage,
    rawObservationDigest: value.observationDigest,
    state: o.state,
    status: o.status,
    policyDigest: o.policyDigest,
    facts: o.facts,
    processes: o.processes.map((p) => ({
      name: p.name,
      exitCode: p.exitCode,
      signal: p.signal,
      stdout: p.stdout,
      stderr: p.stderr
    })),
    inputs: Object.fromEntries(
      RAW_NAMES.filter((name) => value.rawInputs[name]).map((name) => [
        name,
        { bytes: value.rawInputs[name].length, digest: digest(value.rawInputs[name]) }
      ])
    )
  };
}
async function saveRaw(stage, value) {
  const directory = path.join(OUTPUT, stage.toLowerCase().replaceAll("_", "-"));
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(".release-output", 0o755);
  await fs.chmod(OUTPUT, 0o755);
  await fs.chmod(directory, 0o755);
  for (const name of RAW_NAMES) {
    const bytes = value.rawInputs[name];
    if (!bytes) continue;
    need(
      Buffer.isBuffer(bytes) &&
        bytes.length <= 1048576 &&
        rawCount < 14 &&
        rawBytes + bytes.length <= 16 * 1048576,
      "RAW_LIMIT_EXCEEDED"
    );
    await fs.writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(path.join(directory, name), 0o644);
    rawCount += 1;
    rawBytes += bytes.length;
  }
}
async function observe(stage, state) {
  status.phase = stage;
  try {
    const value = await observeR3EncryptedWorkspace({
      operationRef: status.operationRef,
      capacityBytes: CAPACITY,
      state
    });
    await saveRaw(stage, value);
    status.observations.push(safeObservation(stage, value));
    need(
      value.observation.status === "OBSERVED" && value.observation.facts?.state === state,
      "OBSERVER_STATE_INVALID"
    );
    return value;
  } catch (error) {
    if (error.evidence) {
      await saveRaw(stage, error.evidence);
      status.observations.push(safeObservation(stage, error.evidence));
    }
    const diagnostic = getR3FailureDiagnostic(error);
    const current = {
      phase: stage,
      code: publicFailureCode(error),
      diagnostic: diagnostic
        ? {
            component: diagnostic.component,
            stage: diagnostic.stage,
            completed: diagnostic.completed,
            causeCode: diagnostic.causeCode,
            cleanupCode: diagnostic.cleanupCode
          }
        : null
    };
    const field = stage === "ABSENT_AFTER" ? "cleanupObservationFailure" : "failure";
    if (!status[field]) status[field] = current;
    throw error;
  }
}
async function privateRoot(root) {
  try {
    await fs.lstat(root);
    fail("ROOT_ALREADY_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(root, { mode: 0o700 });
  owned.roots.push(root);
  const s = await fs.lstat(root, { bigint: true });
  need(
    s.isDirectory() && s.uid === 0n && s.gid === 0n && (s.mode & 0o777n) === 0o700n,
    "ROOT_IDENTITY_INVALID"
  );
}
async function cleanup() {
  if (!owned) {
    status.cleanup.complete = true;
    return;
  }
  const attempt = async (name, action) => {
    try {
      await action();
    } catch {
      status.cleanup.failures.push(name);
    }
  };
  let mountinfo = "";
  try {
    mountinfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  } catch {
    status.cleanup.failures.push("mountinfo_unavailable");
  }
  const mountedHere = mountinfo.split("\n").some((line) => line.split(" ")[4] === owned.mount);
  if (owned.mounted || (owned.mountAttempted && mountedHere))
    await attempt("umount", async () => {
      await command("umount", "/usr/bin/umount", [owned.mount]);
      owned.mounted = false;
    });
  let mapperExists = false;
  try {
    await fs.lstat(`/dev/mapper/${owned.mapper}`);
    mapperExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") status.cleanup.failures.push("mapper_identity");
  }
  if (owned.mapperOpened || (owned.mapperOpenAttempted && mapperExists))
    await attempt("luksClose", async () => {
      await command("luksClose", "/usr/sbin/cryptsetup", ["close", owned.mapper]);
      owned.mapperOpened = false;
    });
  if (!owned.mounted && !owned.mapperOpened) {
    for (const name of ["mount", "backing", "key"]) {
      if (owned[name + "Created"])
        await attempt(`remove_${name}`, async () => {
          if (name === "mount") await fs.rmdir(owned[name]);
          else await fs.unlink(owned[name]);
          owned[name + "Created"] = false;
        });
    }
  }
  status.cleanup.complete =
    status.cleanup.failures.length === 0 && !owned.mounted && !owned.mapperOpened;
}
async function cleanupRoots() {
  if (!owned) return;
  for (const root of [...owned.roots].reverse()) {
    try {
      await fs.rmdir(root);
    } catch {
      status.cleanup.failures.push(`remove_root_${path.basename(root)}`);
    }
  }
  status.cleanup.complete =
    status.cleanup.failures.length === 0 && !owned.mounted && !owned.mapperOpened;
}
async function writeResult() {
  await fs.mkdir(OUTPUT, { recursive: true, mode: 0o755 });
  await fs.chmod(".release-output", 0o755);
  await fs.chmod(OUTPUT, 0o755);
  status.rawCapture = {
    count: rawCount,
    bytes: rawBytes,
    maxCount: 14,
    maxFileBytes: 1048576,
    maxTotalBytes: 16 * 1048576
  };
  const publicResult = JSON.stringify(status, null, 2) + "\n";
  await fs.writeFile(path.join(OUTPUT, "summary.json"), publicResult, { flag: "wx", mode: 0o644 });
  await fs.chmod(path.join(OUTPUT, "summary.json"), 0o644);
}

async function main() {
  try {
    need(process.platform === "linux" && process.getuid?.() === 0, "HOST_IDENTITY_INVALID");
    need(
      process.env.GITHUB_REPOSITORY_ID === "1253231368" &&
        ["refs/heads/main", "refs/heads/codex/stage1-engine-diagnostic"].includes(
          process.env.GITHUB_REF
        ) &&
        process.env.GITHUB_RUN_ATTEMPT === "1" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted",
      "HOSTED_DISPATCH_INVALID"
    );
    need(
      (await fs.readFile("/proc/swaps", "utf8")).trim().split("\n").length === 1,
      "SWAP_PRESENT"
    );
    status.toolPackages = {};
    for (const name of ["cryptsetup-bin", "dmsetup", "e2fsprogs"]) {
      const { stdout } = await exec("/usr/bin/dpkg-query", ["-W", "-f=${Version}", name], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 256
      });
      need(/^[0-9A-Za-z.+:~\-]{1,100}$/u.test(stdout), "TOOL_PACKAGE_INVALID");
      status.toolPackages[name] = stdout;
    }
    const limits = await fs.readFile("/proc/self/limits", "utf8");
    need(/^Max core file size\s+0\s+0\s+bytes\s*$/mu.test(limits), "CORE_LIMIT_INVALID");
    const operationRef = randomUUID();
    const id = operationRef.replaceAll("-", "");
    status.operationRef = operationRef;
    owned = {
      roots: [],
      mapper: `s1snap_${id}`,
      backing: `${roots.backing}/${id}.luks`,
      mount: `${roots.mount}/${id}`,
      key: `${roots.key}/${id}.key`,
      mounted: false,
      mapperOpened: false,
      mountAttempted: false,
      mapperOpenAttempted: false,
      backingCreated: false,
      mountCreated: false,
      keyCreated: false
    };
    for (const root of Object.values(roots)) await privateRoot(root);
    await observe("ABSENT_BEFORE", "absent");
    status.phase = "CREATE_SCRATCH";
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const key = randomBytes(64);
    try {
      const f = await fs.open(owned.key, flags, 0o600);
      owned.keyCreated = true;
      try {
        await f.writeFile(key);
        await f.sync();
      } finally {
        await f.close();
      }
    } finally {
      key.fill(0);
    }
    const backing = await fs.open(owned.backing, flags, 0o600);
    owned.backingCreated = true;
    await backing.close();
    await command("fallocate", "/usr/bin/fallocate", ["--length", String(CAPACITY), owned.backing]);
    await command("luksFormat", "/usr/sbin/cryptsetup", [
      "luksFormat",
      "--type",
      "luks2",
      "--cipher",
      "aes-xts-plain64",
      "--key-size",
      "512",
      "--batch-mode",
      "--key-file",
      owned.key,
      owned.backing
    ]);
    owned.mapperOpenAttempted = true;
    await command("luksOpen", "/usr/sbin/cryptsetup", [
      "open",
      "--type",
      "luks2",
      "--key-file",
      owned.key,
      owned.backing,
      owned.mapper
    ]);
    owned.mapperOpened = true;
    await command("mkfs", "/usr/sbin/mkfs.ext4", ["-F", "-q", `/dev/mapper/${owned.mapper}`]);
    await fs.mkdir(owned.mount, { mode: 0o700 });
    owned.mountCreated = true;
    owned.mountAttempted = true;
    await command("mount", "/usr/bin/mount", [
      "-t",
      "ext4",
      "-o",
      "rw,nodev,nosuid",
      `/dev/mapper/${owned.mapper}`,
      owned.mount
    ]);
    owned.mounted = true;
    await fs.chown(owned.mount, 0, 0);
    await fs.chmod(owned.mount, 0o700);
    const observation = await observe("ACTIVE", "active");
    if (process.env.STAGE1_DIAGNOSTIC_ENGINE === "1") {
      status.phase = "ENGINE";
      let engine;
      try {
        // No H1, credentials, images, containers or target creation are involved.
        // The same engine checks run against this fresh scratch LUKS filesystem.
        const version = await exec("/usr/bin/dockerd", ["--version"], {
          timeout: 5000,
          maxBuffer: 512,
          encoding: "utf8"
        });
        need(
          /^Docker version [0-9A-Za-z., +~_-]+\n?$/u.test(version.stdout),
          "TOOL_PACKAGE_INVALID"
        );
        status.dockerdVersion = version.stdout.trim();
        engine = await startR3HostedEngineForDiagnostic(
          { observation, creation: { status: "WORKSPACE_OBSERVED" } },
          observation.observation.workspace,
          `${owned.mount}/engine.sock`,
          () => false
        );
        status.engine = {
          diagnosticOnly: true,
          R3Passed: false,
          checkpoint: "COMPLETE",
          rawRefs: engine.result.rawRefs
        };
      } catch (error) {
        status.engine = projectR3HostedFailure({
          evidence: { engineAttempt: error.engineAttempt },
          failureDiagnostic: {
            component: "HOSTED_CREATE",
            stage: "ENGINE",
            causeCode: "R3_HOSTED_CREATION_CONTROL_INVALID"
          }
        });
        throw error;
      } finally {
        if (engine) {
          if (engine.exitState.value === null) engine.child.kill("SIGTERM");
          let timer;
          let exit;
          try {
            exit = await Promise.race([
              engine.exited,
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), 10000);
              })
            ]);
          } finally {
            clearTimeout(timer);
          }
          if (!exit) {
            engine.child.kill("SIGKILL");
            try {
              exit = await Promise.race([
                engine.exited,
                new Promise((resolve) => {
                  timer = setTimeout(() => resolve(null), 2000);
                })
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          status.engineStop = {
            completed: Boolean(exit),
            exitCode: exit?.exitCode ?? null,
            signal: exit?.signal ?? null
          };
          if (!exit || exit.exitCode !== 0 || exit.signal !== null) {
            status.cleanup.failures.push("engine_stop");
            fail("DIAGNOSTIC_PHASE_FAILED");
          }
        }
      }
    }
    status.result = "NATIVE_DIAGNOSTIC_OBSERVED";
  } catch (error) {
    status.result = "PARTIAL_FAILURE";
    recordPublicFailure(status, status.phase, error);
  } finally {
    await cleanup();
    if (status.cleanup.complete && status.operationRef) {
      try {
        await observe("ABSENT_AFTER", "absent");
      } catch {
        status.result = "PARTIAL_FAILURE";
      }
    }
    await cleanupRoots();
    if (!status.cleanup.complete) status.result = "CLEANUP_INCOMPLETE";
    await writeResult();
  }
  if (status.result !== "NATIVE_DIAGNOSTIC_OBSERVED" || !status.cleanup.complete)
    process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
