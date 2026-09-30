import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { createR3ApplicationTls } from "./r3-application-tls.mjs";

const operationRef = "97c61d0d-fa2c-42bb-9ba7-66f8724bc29b";
const errorCode = "R3_APPLICATION_TLS_FAILED";
const execFileAsync = promisify(execFile);

async function privateRoot(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "r3-application-tls-"));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("rejects a noncanonical API URL before making any TLS material", async (t) => {
  const directory = await privateRoot(t);
  let commands = 0;
  for (const apiBaseUrl of [
    "http://api.example.test/api",
    "https://api.example.test:443/api",
    "https://user:secret@api.example.test/api",
    "https://api.example.test/api?x=1",
    "https://api.example.test/api/",
    "https://bad_name.example.test/api"
  ]) {
    await assert.rejects(
      createR3ApplicationTls({
        directory,
        operationRef,
        apiBaseUrl,
        recheck: async () => {},
        runTool: async () => {
          commands++;
        }
      }),
      { code: errorCode }
    );
  }
  assert.equal(commands, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("rejects a symlinked parent before invoking any tool", async (t) => {
  const directory = await privateRoot(t);
  const link = `${directory}-link`;
  try {
    await fs.symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("symlinks unavailable");
    throw error;
  }
  t.after(() => fs.rm(link, { force: true }));
  let commands = 0;
  await assert.rejects(
    createR3ApplicationTls({
      directory: link,
      operationRef,
      apiBaseUrl: "https://api.example.test/api",
      recheck: async () => {},
      runTool: async () => {
        commands++;
      }
    }),
    { code: errorCode }
  );
  assert.equal(commands, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("an aborted request never invokes a tool or leaves an owned child", async (t) => {
  const directory = await privateRoot(t);
  const controller = new globalThis.AbortController();
  controller.abort();
  let commands = 0;
  await assert.rejects(
    createR3ApplicationTls({
      directory,
      operationRef,
      apiBaseUrl: "https://api.example.test/api",
      signal: controller.signal,
      recheck: async () => {},
      runTool: async () => {
        commands++;
      }
    }),
    { code: errorCode }
  );
  assert.equal(commands, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("creates and verifies a 24-hour private chain, then zeroes the returned key on close", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    return t.skip("requires a root Linux caller; NSS is simulated by the test runner");
  const directory = await privateRoot(t);
  let rechecks = 0;
  const runTool = async (executable, args, options) => {
    if (executable === "/usr/bin/certutil") {
      const nss = args[args.indexOf("-d") + 1].slice(4);
      if (args[0] === "-N") {
        await fs.writeFile(path.join(nss, "cert9.db"), "test NSS certificate database", {
          mode: 0o600
        });
        await fs.writeFile(path.join(nss, "key4.db"), "test NSS key database", { mode: 0o600 });
      }
      return {
        code: 0,
        stdout:
          args[0] === "-L" ? await fs.readFile(path.join(options.cwd, "ca.pem")) : Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      };
    }
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "buffer"
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  };
  const material = await createR3ApplicationTls({
    directory,
    operationRef,
    apiBaseUrl: "https://api.example.test/api",
    recheck: async () => {
      rechecks++;
    },
    runTool
  });
  assert.deepEqual(Object.keys(material.files).sort(), [
    "ca.pem",
    "nss/cert9.db",
    "nss/key4.db",
    "server.key",
    "server.pem"
  ]);
  const server = new X509Certificate(material.files["server.pem"]);
  assert.equal(server.checkHost("api.example.test"), "api.example.test");
  assert.equal(material.metadata.nssCertificateDigest, material.metadata.caCertificateDigest);
  assert.ok(rechecks >= 20);
  const key = material.files["server.key"];
  assert.ok(key.some((byte) => byte !== 0));
  await material.close();
  assert.ok(key.every((byte) => byte === 0));
  assert.deepEqual(await fs.readdir(directory), []);
});
