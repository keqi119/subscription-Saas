// Internal tool adapter. The producer must already hold plaintext-host authority
// and an admitted private workspace. This helper does not grant either authority.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

export const SNAPSHOT_POSTGRES_TOOL_IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const MAX_BYTES = 1073741824;
const CID = /^[0-9a-f]{64}$/u;
const VERSION = /^pg_restore \(PostgreSQL\) 17\.11(?: [^\r\n]+)?$/u;
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
    const stdout = [],
      stderr = [];
    let outLength = 0,
      errLength = 0;
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
  ) {
    throw error();
  }
  return result.stdout;
}

// runDocker is an internal test seam, never a CLI/record/environment selection.
export async function expandPostgresSnapshotArchive(
  { archive, expectedArchiveDigest, maxExpandedBytes },
  { workspaceDirectory, signal, runDocker = nativeDocker }
) {
  if (
    process.platform !== "linux" ||
    !Buffer.isBuffer(archive) ||
    archive.length < 5 ||
    archive.length > MAX_BYTES ||
    !archive.subarray(0, 5).equals(Buffer.from("PGDMP")) ||
    expectedArchiveDigest !== sha256Bytes(archive) ||
    maxExpandedBytes !== MAX_BYTES ||
    typeof workspaceDirectory !== "string" ||
    !path.isAbsolute(workspaceDirectory) ||
    path.resolve(workspaceDirectory) !== workspaceDirectory ||
    signal?.aborted
  )
    throw error("SNAPSHOT_ARCHIVE_TOOL_INPUT_INVALID");
  const stat = await lstat(workspaceDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(workspaceDirectory)) !== workspaceDirectory
  ) {
    throw error("SNAPSHOT_ARCHIVE_TOOL_WORKSPACE_INVALID");
  }
  const config = await mkdtemp(path.join(workspaceDirectory, "snapshot-docker-"));
  const prefix = ["--config", config, "--host", "unix:///var/run/docker.sock"];
  const operation = randomUUID();
  const run = async (args, options) => runDocker([...prefix, ...args], options);
  const runTool = async (toolArgs, input, maxBytes) => {
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
            `stage1.snapshot-operation=${operation}`,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--tmpfs=/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=1048576,mode=0700",
            "--security-opt=no-new-privileges",
            "--pids-limit=32",
            "--memory=512m",
            "--memory-swap=512m",
            "--log-driver=none",
            "--entrypoint=/usr/bin/pg_restore",
            SNAPSHOT_POSTGRES_TOOL_IMAGE,
            ...toolArgs
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
              `label=stage1.snapshot-operation=${operation}`,
              "--format",
              "{{.ID}}"
            ])
          )
        ).trim();
        // An empty readback cannot rule out a create request still in flight.
        // Preserve uncertainty so the producer cannot certify workspace cleanup.
        if (!CID.test(found)) throw error();
        id = found;
      } catch {
        throw error("SNAPSHOT_ARCHIVE_TOOL_CLEANUP_FAILED", {
          containerName: name,
          operation,
          primaryCode: failure?.code
        });
      }
    }
    if (id) {
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
    }
    if (failure) throw failure;
    return output;
  };
  try {
    const pgRestoreVersion = decode(await runTool(["--version"], undefined, 1024)).trim();
    if (pgRestoreVersion.length > 256 || !VERSION.test(pgRestoreVersion)) throw error();
    const expandedBytes = await runTool(["--file=-"], archive, maxExpandedBytes);
    if (
      !expandedBytes.length ||
      expandedBytes.length > maxExpandedBytes ||
      sha256Bytes(archive) !== expectedArchiveDigest
    )
      throw error();
    return { archiveDigest: expectedArchiveDigest, expandedBytes, exitCode: 0, pgRestoreVersion };
  } finally {
    // Only our empty, nonsecret Docker config directory; never caller files.
    await rmdir(config);
  }
}
