import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { parseControlResponse, prepareRequest } from "./snapshot-h1-job-client.mjs";

const require = createRequire(import.meta.url);
const { prepareHookRequest, responseFileForRunner } = require("./snapshot-h1-container-hook.js");
const ref = `sha256:${"a".repeat(64)}`;
const image =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const responseFile =
  "/home/runner/_work/_temp/_runner_hook_responses/01234567-89ab-cdef-0123-456789abcdef.json";

test("prepare forwards only the action and opaque ref", () => {
  const input = {
    command: "prepare_job",
    responseFile,
    state: null,
    args: {
      container: {
        image,
        systemMountVolumes: ["/host/secret:/container/secret"]
      },
      services: []
    },
    environment: { PASSWORD: "top-secret" },
    script: "echo top-secret"
  };
  assert.deepEqual(prepareHookRequest(input, ref), {
    command: "prepare_job",
    admissionRef: ref
  });
  assert.equal(JSON.stringify(prepareHookRequest(input, ref)).includes("top-secret"), false);
});

test("hook rejects unknown commands and unsupported container settings", () => {
  const input = {
    command: "prepare_job",
    responseFile,
    state: null,
    args: { container: { image }, services: [] }
  };
  for (const change of [
    { command: "run_container_step" },
    { command: "unknown" },
    { args: { ...input.args, services: [{ name: "db" }] } },
    { args: { ...input.args, container: { image, createOptions: "--privileged" } } },
    { args: { ...input.args, container: { image, createOptions: {} } } },
    { args: { ...input.args, container: { image, userMountVolumes: ["/tmp:/x"] } } },
    { args: { ...input.args, container: { image, userMountVolumes: {} } } },
    { args: { ...input.args, container: { image, portMappings: { 5432: "5432" } } } }
  ])
    assert.throws(() => prepareHookRequest({ ...input, ...change }, ref));
});

test("run and cleanup use only state admission ref", () => {
  const input = {
    command: "run_script_step",
    responseFile,
    state: { admissionRef: ref },
    args: { script: "echo secret", entryPoint: "sh" }
  };
  assert.deepEqual(prepareHookRequest(input), { command: "run_script_step", admissionRef: ref });
  assert.deepEqual(prepareHookRequest({ ...input, command: "cleanup_job" }), {
    command: "cleanup_job",
    admissionRef: ref
  });
  assert.throws(() => prepareHookRequest({ ...input, state: {} }));
});

test("response rejects changed ref, extra fields, and multiple frames", () => {
  const expected = { status: "PREPARED", admissionRef: ref, runnerRoot: "/home/runner" };
  assert.deepEqual(
    parseControlResponse(Buffer.from(JSON.stringify(expected)), "prepare_job", ref),
    expected
  );
  for (const value of [
    { ...expected, admissionRef: `sha256:${"b".repeat(64)}` },
    { ...expected, secret: "leak" },
    { ...expected, runnerRoot: "/home/runner/../elsewhere" }
  ])
    assert.throws(() =>
      parseControlResponse(Buffer.from(JSON.stringify(value)), "prepare_job", ref)
    );
  assert.throws(() =>
    parseControlResponse(
      Buffer.from(`${JSON.stringify(expected)}\n${JSON.stringify(expected)}`),
      "prepare_job",
      ref
    )
  );
  assert.throws(() => parseControlResponse(Buffer.from(JSON.stringify(expected)), "produce", ref));
});

test("response path is fixed below the trusted runner root", () => {
  assert.equal(responseFileForRunner(responseFile, "/home/runner"), responseFile);
  assert.throws(() =>
    responseFileForRunner("/tmp/01234567-89ab-cdef-0123-456789abcdef.json", "/home/runner")
  );
  assert.throws(() =>
    responseFileForRunner("/home/runner/_work/_temp/_runner_hook_responses/x.json", "/home/runner")
  );
});

test("job request accepts only the opaque ref", () => {
  assert.deepEqual(prepareRequest("produce", ref), { command: "produce", admissionRef: ref });
  assert.throws(() => prepareRequest("produce", "secret"));
  assert.throws(() => prepareRequest("shell", ref));
});

test("hook CLI exits with a fixed error while stdin remains open", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./snapshot-h1-container-hook.js", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("hook did not exit"));
    }, 7000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve(code);
    });
  });
  assert.equal(result, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "H1_CONTROL_REJECTED\n");
});
