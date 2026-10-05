/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */
const { Buffer } = require("node:buffer");
const { lstat, open, realpath } = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { clearTimeout, setTimeout } = require("node:timers");
const { TextDecoder } = require("node:util");

const IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const REF = /^sha256:[0-9a-f]{64}$/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/iu;
const FAILURE = "H1_CONTROL_REJECTED";

function reject() {
  throw new Error(FAILURE);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyString(value) {
  return value === undefined || value === null || value === "";
}

function emptyArray(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function emptyPorts(value) {
  return emptyArray(value) || (object(value) && Object.keys(value).length === 0);
}

function prepareHookRequest(input, environmentRef) {
  if (!object(input) || typeof input.responseFile !== "string") reject();
  const command = input.command;
  if (!["prepare_job", "run_script_step", "cleanup_job"].includes(command)) reject();
  const admissionRef = command === "prepare_job" ? environmentRef : input.state?.admissionRef;
  if (!REF.test(admissionRef ?? "")) reject();
  if (command === "prepare_job") {
    const args = input.args;
    const container = args?.container;
    if (
      !object(args) ||
      !object(container) ||
      container.image !== IMAGE ||
      !Array.isArray(args.services) ||
      args.services.length !== 0 ||
      !emptyString(container.createOptions) ||
      !emptyArray(container.userMountVolumes) ||
      !emptyPorts(container.portMappings) ||
      !emptyPorts(container.ports)
    )
      reject();
  }
  return { command, admissionRef };
}

function responseFileForRunner(responseFile, runnerRoot) {
  if (
    typeof runnerRoot !== "string" ||
    !runnerRoot.startsWith("/") ||
    runnerRoot === "/" ||
    path.posix.normalize(runnerRoot) !== runnerRoot ||
    runnerRoot
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..") ||
    typeof responseFile !== "string" ||
    !responseFile.startsWith("/") ||
    path.posix.normalize(responseFile) !== responseFile ||
    responseFile
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..") ||
    !GUID.test(path.posix.basename(responseFile)) ||
    path.posix.dirname(responseFile) !==
      path.posix.join(runnerRoot, "_work", "_temp", "_runner_hook_responses")
  )
    reject();
  return responseFile;
}

async function writeHookResponse(responseFile, runnerRoot, value) {
  responseFileForRunner(responseFile, runnerRoot);
  const directories = [
    runnerRoot,
    ...["_work", "_temp", "_runner_hook_responses"].map((_, index) =>
      path.posix.join(
        runnerRoot,
        ...["_work", "_temp", "_runner_hook_responses"].slice(0, index + 1)
      )
    )
  ];
  for (const directory of directories) {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(directory)) !== directory ||
      (directory === directories.at(-1) && stat.uid !== 992)
    )
      reject();
  }
  const file = await open(
    responseFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(JSON.stringify(value));
  } finally {
    await file.close();
  }
}

async function main() {
  if (
    process.platform !== "linux" ||
    process.getuid() !== 992 ||
    process.getgid() !== 988 ||
    process.argv.length !== 2
  )
    reject();
  const chunks = [];
  let size = 0;
  const stdinDeadline = setTimeout(() => process.stdin.destroy(new Error(FAILURE)), 5000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) reject();
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(stdinDeadline);
  }
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    reject();
  }
  const request = prepareHookRequest(input, process.env.STAGE1_SNAPSHOT_ADMISSION_REF);
  const { requestControl } = await import("./snapshot-h1-job-client.mjs");
  const result = await requestControl(request.command, request.admissionRef);
  const response =
    request.command === "prepare_job"
      ? { isAlpine: false, state: { admissionRef: request.admissionRef } }
      : {};
  await writeHookResponse(input.responseFile, result.runnerRoot, response);
}

module.exports = { prepareHookRequest, responseFileForRunner };

if (require.main === module) {
  main().catch(() => {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  });
}
