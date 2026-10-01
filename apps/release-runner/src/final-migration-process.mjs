// Fixed subprocess boundary for the final migration adapter. The caller owns
// admission and credential release; this runner records no child environment.
import { spawn } from "node:child_process";
import path from "node:path";

import { prismaMigrateDeployArgs, prismaSchemaDiffArgs } from "./database-runtime-adapter.mjs";

const CODE = "FINAL_MIGRATION_PROCESS_INVALID";
const CALL_OUTPUT_LIMIT = 2 * 1024 * 1024;
const TOTAL_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CALL_LIMIT = 32;
const TIMEOUT_LIMIT = 1_800_000;
const fail = (original, cause) => {
  const error = Object.assign(new Error(CODE), { code: CODE });
  if (original) Object.defineProperty(error, "original", { value: original });
  if (cause) Object.defineProperty(error, "cause", { value: cause });
  return error;
};
const same = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((item, index) => item === right[index]);

export function createFinalMigrationProcessRunner({
  repoRoot = "/app",
  signal,
  originals,
  spawnProcess = spawn
}) {
  if (!path.isAbsolute(repoRoot) || !Array.isArray(originals) || typeof spawnProcess !== "function")
    throw fail();
  const schema = path.resolve(repoRoot, "apps/api/prisma/schema.prisma");
  const config = path.resolve(repoRoot, "apps/api/prisma.config.ts");
  const prisma = path.resolve(repoRoot, "apps/release-runner/node_modules/.bin/prisma");
  const permitted = [
    prismaMigrateDeployArgs({ schema, repoRoot }),
    prismaSchemaDiffArgs({ schema, repoRoot }),
    ["migrate", "diff", "--from-empty", "--to-config-datasource", "--script", "--config", config],
    ["--version"]
  ];
  const active = new Set();
  const pending = new Set();
  let calls = 0;
  let totalBytes = 0;
  let retainedBytes = 0;
  let exhausted = false;
  let unconfirmed = false;

  async function runProcess(command, args, { environment, timeoutMs = 300_000 } = {}) {
    if (
      signal?.aborted ||
      exhausted ||
      ++calls > CALL_LIMIT ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > TIMEOUT_LIMIT ||
      environment === null ||
      typeof environment !== "object" ||
      Array.isArray(environment) ||
      !(
        (command === prisma && permitted.some((expected) => same(args, expected))) ||
        (command === "psql" && same(args, ["--version"]))
      )
    )
      throw fail();

    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd: repoRoot,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (!child?.stdout?.on || !child?.stderr?.on || !child?.once || !child?.kill) throw fail();
    } catch (cause) {
      throw fail(undefined, cause);
    }

    const operation = new Promise((resolve, reject) => {
      const output = { stdout: [], stderr: [] };
      let callBytes = 0;
      let closed = false;
      let timedOut = false;
      let aborted = false;
      let truncated = false;
      let spawnError;
      let stopping = false;
      let settled = false;
      let timeoutTimer;
      let killTimer;
      let drainTimer;

      const send = (name) => {
        try {
          if (
            spawnProcess === spawn &&
            process.platform !== "win32" &&
            Number.isSafeInteger(child.pid) &&
            child.pid > 0
          )
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch {
          try {
            child.kill(name);
          } catch {
            /* The hard drain still completes. */
          }
        }
      };
      const onAbort = () => {
        aborted = true;
        stop();
      };
      const complete = (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        // A detached Linux child can exit before descendants in its process
        // group. Best-effort group cleanup makes no claim of group absence.
        if (
          closed &&
          spawnProcess === spawn &&
          process.platform !== "win32" &&
          Number.isSafeInteger(child.pid) &&
          child.pid > 0
        ) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
        signal?.removeEventListener("abort", onAbort);
        active.delete(stop);
        const original = Object.freeze({
          command,
          args: Object.freeze([...args]),
          pid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
          startedAt,
          finishedAt: new Date().toISOString(),
          closed,
          exitCode: closed && Number.isInteger(exitCode) ? exitCode : null,
          signal: closed && typeof exitSignal === "string" ? exitSignal : null,
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
          timedOut,
          aborted,
          truncated,
          terminationRequested: stopping
        });
        if (!closed) unconfirmed = true;
        originals.push(original);
        if (
          !closed ||
          stopping ||
          timedOut ||
          aborted ||
          truncated ||
          spawnError ||
          original.exitCode === null ||
          original.signal !== null
        )
          reject(fail(original, spawnError));
        else
          resolve({
            exitCode: original.exitCode,
            signal: original.signal,
            stdout: original.stdout,
            stderr: original.stderr
          });
      };
      const stop = () => {
        if (settled || stopping) return;
        stopping = true;
        send("SIGTERM");
        if (settled) return;
        killTimer = setTimeout(() => {
          if (!closed) send("SIGKILL");
        }, 1000);
        drainTimer = setTimeout(() => complete(null, null), 3000);
      };
      const capture = (name, chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const available = Math.max(
          0,
          Math.min(CALL_OUTPUT_LIMIT - callBytes, TOTAL_OUTPUT_LIMIT - retainedBytes)
        );
        const kept = Math.min(available, bytes.length);
        if (kept) output[name].push(bytes.subarray(0, kept));
        retainedBytes += kept;
        callBytes += bytes.length;
        totalBytes += bytes.length;
        if (callBytes > CALL_OUTPUT_LIMIT || totalBytes > TOTAL_OUTPUT_LIMIT) {
          truncated = true;
          exhausted = true;
          for (const activeStop of active) activeStop();
        }
      };
      active.add(stop);
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", (cause) => {
        spawnError = cause;
        stop();
      });
      child.once("close", (exitCode, exitSignal) => {
        closed = true;
        complete(exitCode, exitSignal);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      if (signal?.aborted) onAbort();
    });
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  }
  runProcess.drain = async () => {
    await Promise.allSettled([...pending]);
    if (unconfirmed) throw fail();
  };
  return runProcess;
}
