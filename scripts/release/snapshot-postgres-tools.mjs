// Internal tool adapter. The producer must already hold plaintext-host authority
// and an admitted private workspace. This helper does not grant either authority.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

export const SNAPSHOT_POSTGRES_TOOL_IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const MAX_BYTES = 1073741824;
const CID = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z_][a-z0-9_]*$/u;
const SNAPSHOT = /^[0-9a-fA-F]+(?:-[0-9a-fA-F]+)+$/u;
const VERSIONS = Object.freeze({
  "/usr/bin/pg_restore": /^pg_restore \(PostgreSQL\) 17\.11(?: [^\r\n]+)?$/u,
  "/usr/bin/pg_dump": /^pg_dump \(PostgreSQL\) 17\.11(?: [^\r\n]+)?$/u
});
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const error = (code = "SNAPSHOT_ARCHIVE_TOOL_FAILED", details) =>
  Object.assign(new Error(code), { code, details });

async function nativeDocker(args, { input, maxBytes = 65536, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/docker", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
    });
    let failed = false;
    const stdout = [];
    const stderr = [];
    let outLength = 0;
    let errLength = 0;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 120000);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (bytes) => {
      outLength += bytes.length;
      if (outLength > maxBytes) stop();
      else if (!failed) stdout.push(bytes);
    });
    child.stderr.on("data", (bytes) => {
      errLength += bytes.length;
      if (errLength > 65536) stop();
      else if (!failed) stderr.push(bytes);
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.once("error", () => {
      finish();
      reject(error());
    });
    child.once("close", (exitCode, exitSignal) => {
      finish();
      if (failed) reject(error());
      else
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr)
        });
    });
    child.stdin.end(input);
  });
}

function succeeded(result) {
  if (
    result?.exitCode !== 0 ||
    result.signal ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  )
    throw error();
  return result.stdout;
}

async function assertPrivateWorkspace(workspaceDirectory) {
  if (
    process.platform !== "linux" ||
    typeof workspaceDirectory !== "string" ||
    !path.isAbsolute(workspaceDirectory) ||
    path.resolve(workspaceDirectory) !== workspaceDirectory
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  let stat;
  try {
    stat = await lstat(workspaceDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o700 ||
      (await realpath(workspaceDirectory)) !== workspaceDirectory
    )
      throw error("SNAPSHOT_ARCHIVE_TOOL_WORKSPACE_INVALID");
  } catch (cause) {
    if (cause?.code === "SNAPSHOT_ARCHIVE_TOOL_WORKSPACE_INVALID") throw cause;
    throw error("SNAPSHOT_ARCHIVE_TOOL_WORKSPACE_INVALID");
  }
}

// Both archive expansion and connected tools use this exact create/start/inspect/remove lifecycle.
async function withToolSession(
  { workspaceDirectory, signal, runDocker = nativeDocker },
  operation
) {
  await assertPrivateWorkspace(workspaceDirectory);
  if (signal?.aborted || typeof runDocker !== "function")
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  const config = await mkdtemp(path.join(workspaceDirectory, "snapshot-docker-"));
  const prefix = ["--config", config, "--host", "unix:///var/run/docker.sock"];
  const operationId = randomUUID();
  const run = async (args, options) => runDocker([...prefix, ...args], options);
  const runTool = async ({
    entrypoint,
    args,
    input,
    maxBytes = 65536,
    network = "none",
    passfile
  }) => {
    if (
      !Object.hasOwn(VERSIONS, entrypoint) ||
      !Array.isArray(args) ||
      (network !== "none" && !/^container:[0-9a-f]{64}$/u.test(network))
    ) {
      throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
    }
    const name = `stage1-snapshot-tool-${randomUUID()}`;
    let id;
    let failure;
    let output;
    try {
      const created = succeeded(
        await run(
          [
            "create",
            "--pull=never",
            "--platform=linux/amd64",
            "--interactive",
            "--name",
            name,
            "--label",
            `stage1.snapshot-operation=${operationId}`,
            `--network=${network}`,
            "--read-only",
            "--cap-drop=ALL",
            "--tmpfs=/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=1048576,mode=0700",
            "--security-opt=no-new-privileges",
            "--pids-limit=32",
            "--memory=512m",
            "--memory-swap=512m",
            "--log-driver=none",
            ...(passfile ? [`--user=${process.getuid()}:${process.getgid()}`] : []),
            ...(passfile
              ? [
                  `--mount=type=bind,src=${passfile},dst=/run/secrets/pgpass,readonly`,
                  "--env=PGPASSFILE=/run/secrets/pgpass"
                ]
              : []),
            `--entrypoint=${entrypoint}`,
            SNAPSHOT_POSTGRES_TOOL_IMAGE,
            ...args
          ],
          { signal }
        )
      );
      id = decode(created).trim();
      if (!CID.test(id)) {
        id = undefined;
        throw error();
      }
      output = succeeded(
        await run(["start", "--attach", "--interactive", id], { input, maxBytes, signal })
      );
      const state = JSON.parse(
        decode(succeeded(await run(["inspect", "--format", "{{json .State}}", id], { signal })))
      );
      if (
        state.Running !== false ||
        state.Status !== "exited" ||
        state.ExitCode !== 0 ||
        state.OOMKilled !== false ||
        state.Error !== ""
      )
        throw error();
    } catch (cause) {
      failure = cause?.code?.startsWith("SNAPSHOT_") ? cause : error();
    }
    if (!id) {
      try {
        const found = decode(
          succeeded(
            await run([
              "container",
              "ls",
              "--all",
              "--no-trunc",
              "--filter",
              `name=^/${name}$`,
              "--filter",
              `label=stage1.snapshot-operation=${operationId}`,
              "--format",
              "{{.ID}}"
            ])
          )
        ).trim();
        // An empty readback cannot rule out a create request still in flight.
        if (!CID.test(found)) throw error();
        id = found;
      } catch {
        throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED", {
          containerName: name,
          operation: operationId,
          primaryCode: failure?.code
        });
      }
    }
    try {
      const removed = decode(succeeded(await run(["rm", "--force", "--volumes", id]))).trim();
      if (removed !== id) throw error();
      const remaining = decode(
        succeeded(
          await run([
            "container",
            "ls",
            "--all",
            "--no-trunc",
            "--filter",
            `id=${id}`,
            "--format",
            "{{.ID}}"
          ])
        )
      ).trim();
      if (remaining) throw error();
    } catch {
      throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED", {
        containerId: id,
        primaryCode: failure?.code
      });
    }
    if (failure) throw failure;
    return output;
  };
  try {
    return await operation({ config, runTool });
  } finally {
    // The caller removes only credentials it created; this directory is otherwise empty.
    await rmdir(config);
  }
}

async function checkedVersion(runTool, entrypoint) {
  const line = decode(await runTool({ entrypoint, args: ["--version"], maxBytes: 1024 })).trim();
  if (line.length > 256 || !VERSIONS[entrypoint].test(line)) throw error();
  return line;
}

// runDocker is an internal test seam, never a CLI/record/environment selection.
export async function expandPostgresSnapshotArchive(
  { archive, expectedArchiveDigest, maxExpandedBytes },
  { workspaceDirectory, signal, runDocker = nativeDocker }
) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length < 5 ||
    archive.length > MAX_BYTES ||
    !archive.subarray(0, 5).equals(Buffer.from("PGDMP")) ||
    expectedArchiveDigest !== sha256Bytes(archive) ||
    maxExpandedBytes !== MAX_BYTES
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  return withToolSession({ workspaceDirectory, signal, runDocker }, async ({ runTool }) => {
    const pgRestoreVersion = await checkedVersion(runTool, "/usr/bin/pg_restore");
    const expandedBytes = await runTool({
      entrypoint: "/usr/bin/pg_restore",
      args: ["--file=-"],
      input: archive,
      maxBytes: maxExpandedBytes
    });
    if (
      !expandedBytes.length ||
      expandedBytes.length > maxExpandedBytes ||
      sha256Bytes(archive) !== expectedArchiveDigest
    )
      throw error();
    return { archiveDigest: expectedArchiveDigest, expandedBytes, exitCode: 0, pgRestoreVersion };
  });
}

// The caller supplies verified container/database/role identities and host authority.
// The factory never resolves a URL or grants access to either PostgreSQL container.
export function createPostgresSnapshotToolCallbacks(
  { workspaceDirectory, containerId, databaseName, roleName, password, purpose },
  { runDocker = nativeDocker } = {}
) {
  if (
    !CID.test(containerId ?? "") ||
    !NAME.test(databaseName ?? "") ||
    !NAME.test(roleName ?? "") ||
    typeof workspaceDirectory !== "string" ||
    /[,\r\n\0]/u.test(workspaceDirectory) ||
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\r\n\0]/u.test(password) ||
    !["source", "workspace"].includes(purpose) ||
    typeof runDocker !== "function"
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  const connection = [
    "--host=127.0.0.1",
    "--port=5432",
    `--username=${roleName}`,
    `--dbname=${databaseName}`,
    "--no-password"
  ];
  const invoke = async (entrypoint, args, input, maxBytes) =>
    withToolSession({ workspaceDirectory, runDocker }, async ({ config, runTool }) => {
      await checkedVersion(runTool, entrypoint);
      const passfile = path.join(config, "pgpass");
      const escaped = password.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
      try {
        await writeFile(passfile, `127.0.0.1:5432:${databaseName}:${roleName}:${escaped}\n`, {
          flag: "wx",
          mode: 0o600
        });
        return await runTool({
          entrypoint,
          args: [...connection, ...args],
          input,
          maxBytes,
          network: `container:${containerId}`,
          passfile
        });
      } finally {
        try {
          await unlink(passfile);
        } catch (cause) {
          if (cause?.code !== "ENOENT") throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED");
        }
      }
    });
  if (purpose === "source") {
    return Object.freeze({
      exportDump: async ({ snapshotId } = {}) => {
        if (typeof snapshotId !== "string" || !SNAPSHOT.test(snapshotId))
          throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
        const bytes = await invoke(
          "/usr/bin/pg_dump",
          ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshotId}`],
          undefined,
          MAX_BYTES
        );
        if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("PGDMP"))) throw error();
        return bytes;
      }
    });
  }
  return Object.freeze({
    restoreDump: async (raw) => {
      if (
        !Buffer.isBuffer(raw) ||
        raw.length < 5 ||
        raw.length > MAX_BYTES ||
        !raw.subarray(0, 5).equals(Buffer.from("PGDMP"))
      )
        throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
      await invoke(
        "/usr/bin/pg_restore",
        ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl"],
        raw,
        65536
      );
    },
    exportDump: async () => {
      const bytes = await invoke(
        "/usr/bin/pg_dump",
        ["--format=custom", "--no-owner", "--no-acl"],
        undefined,
        MAX_BYTES
      );
      if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("PGDMP"))) throw error();
      return bytes;
    }
  });
}

const NATIVE_ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" });

// Private process seam for tests. Runtime callers cannot select an executable or environment.
async function nativePostgresProcess(binary, args, { input, maxBytes = 65536, signal, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env
      });
    } catch {
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        cleanupUnknown: false
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    let outLength = 0;
    let errLength = 0;
    let stopped = false;
    let settled = false;
    let watchdog;
    const groupGone = () => {
      try {
        process.kill(-child.pid, 0);
        return false;
      } catch (cause) {
        return cause?.code === "ESRCH";
      }
    };
    const finish = (exitCode, exitSignal, cleanupUnknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", stop);
      resolve({
        exitCode: stopped ? null : exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        cleanupUnknown
      });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* close/readback decides whether cleanup is known. */
      }
      watchdog = setTimeout(() => finish(null, "SIGKILL", true), 5000);
    };
    const timer = setTimeout(stop, 120000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (bytes) => {
      outLength += bytes.length;
      if (outLength > maxBytes) stop();
      else if (!stopped) stdout.push(bytes);
    });
    child.stderr.on("data", (bytes) => {
      errLength += bytes.length;
      if (errLength > 65536) stop();
      else if (!stopped) stderr.push(bytes);
    });
    child.stdin.on("error", stop);
    child.once("error", () => finish(null, null, !groupGone()));
    child.once("close", async (exitCode, exitSignal) => {
      if (!groupGone()) {
        stop();
        for (let attempt = 0; attempt < 10 && !groupGone(); attempt++)
          await new Promise((done) => setTimeout(done, 50));
      }
      finish(exitCode, exitSignal, !groupGone());
    });
    child.stdin.end(input);
  });
}

async function nativeTool(runNative, binary, args, options = {}) {
  let result;
  try {
    result = await runNative(binary, args, {
      ...options,
      env: { ...NATIVE_ENV, ...(options.passfile ? { PGPASSFILE: options.passfile } : {}) }
    });
  } catch {
    throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED", { cleanupUnknown: true });
  }
  if (result?.cleanupUnknown)
    throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED", { cleanupUnknown: true });
  if (
    result?.exitCode !== 0 ||
    result.signal ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length > (options.maxBytes ?? 65536) ||
    result.stderr.length > 65536
  )
    throw error();
  return result.stdout;
}

async function nativeVersion(runNative, binary, signal) {
  const line = decode(
    await nativeTool(runNative, binary, ["--version"], { maxBytes: 1024, signal })
  ).trim();
  if (line.length > 256 || !VERSIONS[binary].test(line)) throw error();
  return line;
}

async function nativeConnected(
  {
    workspaceDirectory,
    port,
    databaseName,
    roleName,
    password,
    runNative,
    assertWorkspace,
    signal
  },
  binary,
  args,
  input,
  maxBytes
) {
  await assertWorkspace(workspaceDirectory);
  if (signal?.aborted) throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  await nativeVersion(runNative, binary, signal);
  const directory = await mkdtemp(path.join(workspaceDirectory, "snapshot-native-"));
  const passfile = path.join(directory, "pgpass");
  const escaped = password.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  let output;
  let primaryFailure;
  try {
    await writeFile(passfile, `127.0.0.1:${port}:${databaseName}:${roleName}:${escaped}\n`, {
      flag: "wx",
      mode: 0o600
    });
    output = await nativeTool(
      runNative,
      binary,
      [
        "--host=127.0.0.1",
        `--port=${port}`,
        `--username=${roleName}`,
        `--dbname=${databaseName}`,
        "--no-password",
        ...args
      ],
      { input, maxBytes, signal, passfile }
    );
  } catch (cause) {
    primaryFailure = cause;
  }
  if (primaryFailure?.details?.cleanupUnknown === true) throw primaryFailure;
  try {
    await unlink(passfile);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED");
  }
  try {
    await rmdir(directory);
  } catch {
    throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED");
  }
  if (primaryFailure) throw primaryFailure;
  return output;
}

// runNative/assertWorkspace are private test dependencies, never CLI/env/record inputs.
export function createNativePostgresSnapshotToolCallbacks(
  { workspaceDirectory, port, databaseName, roleName, password, purpose },
  { runNative = nativePostgresProcess, assertWorkspace = assertPrivateWorkspace, signal } = {}
) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !NAME.test(databaseName ?? "") ||
    !NAME.test(roleName ?? "") ||
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\r\n\0]/u.test(password) ||
    !["source", "workspace"].includes(purpose) ||
    typeof workspaceDirectory !== "string" ||
    typeof runNative !== "function" ||
    typeof assertWorkspace !== "function"
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  const invoke = (binary, args, input, maxBytes) =>
    nativeConnected(
      {
        workspaceDirectory,
        port,
        databaseName,
        roleName,
        password,
        runNative,
        assertWorkspace,
        signal
      },
      binary,
      args,
      input,
      maxBytes
    );
  if (purpose === "source")
    return Object.freeze({
      exportDump: async ({ snapshotId } = {}) => {
        if (typeof snapshotId !== "string" || !SNAPSHOT.test(snapshotId))
          throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
        const bytes = await invoke(
          "/usr/bin/pg_dump",
          ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshotId}`],
          undefined,
          MAX_BYTES
        );
        if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("PGDMP"))) throw error();
        return bytes;
      }
    });
  return Object.freeze({
    restoreDump: async (raw) => {
      if (
        !Buffer.isBuffer(raw) ||
        raw.length < 5 ||
        raw.length > MAX_BYTES ||
        !raw.subarray(0, 5).equals(Buffer.from("PGDMP"))
      )
        throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
      await invoke(
        "/usr/bin/pg_restore",
        ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl"],
        raw,
        65536
      );
    },
    exportDump: async () => {
      const bytes = await invoke(
        "/usr/bin/pg_dump",
        ["--format=custom", "--no-owner", "--no-acl"],
        undefined,
        MAX_BYTES
      );
      if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("PGDMP"))) throw error();
      return bytes;
    }
  });
}

export async function expandNativePostgresSnapshotArchive(
  { archive, expectedArchiveDigest, maxExpandedBytes },
  {
    workspaceDirectory,
    signal,
    runNative = nativePostgresProcess,
    assertWorkspace = assertPrivateWorkspace
  } = {}
) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length < 5 ||
    archive.length > MAX_BYTES ||
    !archive.subarray(0, 5).equals(Buffer.from("PGDMP")) ||
    expectedArchiveDigest !== sha256Bytes(archive) ||
    maxExpandedBytes !== MAX_BYTES ||
    typeof runNative !== "function" ||
    typeof assertWorkspace !== "function"
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  await assertWorkspace(workspaceDirectory);
  if (signal?.aborted) throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  const pgRestoreVersion = await nativeVersion(runNative, "/usr/bin/pg_restore", signal);
  const expandedBytes = await nativeTool(runNative, "/usr/bin/pg_restore", ["--file=-"], {
    input: archive,
    maxBytes: maxExpandedBytes,
    signal
  });
  if (!expandedBytes.length || sha256Bytes(archive) !== expectedArchiveDigest) throw error();
  return { archiveDigest: expectedArchiveDigest, expandedBytes, exitCode: 0, pgRestoreVersion };
}
