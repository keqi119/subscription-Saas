import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { API_APPLICATION_ENTRYPOINT } from "./r3-application-bootstrap.mjs";

const databaseUrl =
  "postgresql://app:synthetic-private-password@postgres:5432/application?sslmode=require";
const command = ["node", "apps/api/dist/src/main.js"];

async function runBootstrap(input, { delayedInput, apiExit = 0, signalBootstrap = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "r3-api-bootstrap-"));
  const main = path.join(cwd, "apps/api/dist/src/main.js");
  await mkdir(path.dirname(main), { recursive: true });
  await writeFile(
    main,
    `process.stdout.write(JSON.stringify({ privateUrlMatched: process.env.DATABASE_URL === ${JSON.stringify(databaseUrl)}, argv: process.argv.slice(1), cwd: process.cwd() }) + "\\n"); ${signalBootstrap ? 'process.once("SIGTERM", () => { process.stdout.write("child-sigterm\\n"); process.kill(process.pid, "SIGTERM"); });' : ""} setTimeout(() => process.exit(${apiExit}), ${signalBootstrap ? 10000 : 250});\n`
  );
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [...API_APPLICATION_ENTRYPOINT.slice(1), ...command], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let signaled = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (signalBootstrap && !signaled && stdout.includes("\n")) {
      signaled = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    if (input !== null) child.stdin.write(input);
    if (delayedInput !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      child.stdin.write(delayedInput);
    }
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { ...exit, stdout, stderr, cwd };
  } finally {
    clearTimeout(timer);
    await rm(cwd, { recursive: true, force: true });
  }
}

test("the fixed entrypoint launches the image command with a private database URL only in the API child", async () => {
  assert.equal(API_APPLICATION_ENTRYPOINT[0], "/usr/local/bin/node");
  assert.equal(API_APPLICATION_ENTRYPOINT[1], "-e");
  assert.equal(API_APPLICATION_ENTRYPOINT[3], "--");
  const result = await runBootstrap(`${JSON.stringify({ databaseUrl })}\n`);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    privateUrlMatched: true,
    argv: [path.join(result.cwd, "apps/api/dist/src/main.js")],
    cwd: result.cwd
  });
  assert.equal(result.stderr, "");
});

test("malformed, oversized, and nonprivate bootstrap inputs fail without launching or printing a credential", async () => {
  for (const input of [
    "{\n",
    `${JSON.stringify({ databaseUrl, extra: true })}\n`,
    `${JSON.stringify({ databaseUrl: databaseUrl.replace("@postgres:", "@outside:") })}\n`,
    `${JSON.stringify({ databaseUrl: databaseUrl.replace("sslmode=require", "sslmode=disable") })}\n`,
    "x".repeat(16385)
  ]) {
    const result = await runBootstrap(input);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^R3_API_APPLICATION_BOOTSTRAP_FAILED\n$/u);
    assert.equal(result.stderr.includes("synthetic-private-password"), false);
  }
});

test("bytes after the single JSON line are rejected even when they arrive later", async () => {
  for (const delayedInput of [undefined, "second line\n"]) {
    const firstInput = `${JSON.stringify({ databaseUrl })}\n${delayedInput === undefined ? "extra" : ""}`;
    const result = await runBootstrap(firstInput, { delayedInput });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /^R3_API_APPLICATION_BOOTSTRAP_FAILED\n$/u);
    assert.equal(result.stderr.includes("synthetic-private-password"), false);
  }
});

test("the bootstrap propagates the API child exit code", async () => {
  const result = await runBootstrap(`${JSON.stringify({ databaseUrl })}\n`, { apiExit: 7 });
  assert.equal(result.code, 7);
  assert.equal(result.stderr, "");
});

test("SIGTERM terminates the bootstrap and reaches the API child on POSIX", async () => {
  const result = await runBootstrap(`${JSON.stringify({ databaseUrl })}\n`, {
    signalBootstrap: true
  });
  assert.equal(result.signal, "SIGTERM");
  if (process.platform !== "win32") assert.match(result.stdout, /child-sigterm\n$/u);
  assert.equal(result.stderr, "");
});
