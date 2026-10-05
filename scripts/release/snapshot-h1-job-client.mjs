import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const MANAGEMENT_SOCKET = "/run/stage1-snapshot/management/control.sock";
const JOB_SOCKET = "/run/stage1-snapshot/job/request.sock";
const REF = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE = 4096;
const TIMEOUT_MS = 900_000;
const FAILURE = "H1_CONTROL_REJECTED";
const SUCCESS = {
  prepare_job: "PREPARED",
  run_script_step: "SUCCEEDED",
  cleanup_job: "CLEANED",
  produce: "SUCCEEDED"
};

function reject() {
  throw new Error(FAILURE);
}

function exactKeys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

export function canonicalAbsolute(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value === "/" ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  )
    reject();
  return value;
}

export function prepareRequest(command, admissionRef) {
  if (!Object.hasOwn(SUCCESS, command) || !REF.test(admissionRef ?? "")) reject();
  return { command, admissionRef };
}

export function parseControlResponse(bytes, command, admissionRef) {
  prepareRequest(command, admissionRef);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESPONSE) reject();
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    reject();
  }
  if (exactKeys(value, ["status", "code"]) && value.status === "FAILED" && value.code === FAILURE)
    reject();
  const names =
    command === "produce" ? ["status", "admissionRef"] : ["status", "admissionRef", "runnerRoot"];
  if (
    !exactKeys(value, names) ||
    value.status !== SUCCESS[command] ||
    value.admissionRef !== admissionRef
  )
    reject();
  if (command !== "produce") canonicalAbsolute(value.runnerRoot);
  return value;
}

async function checkSocket(socketPath, expectedGid) {
  for (
    let parent = path.posix.dirname(socketPath);
    parent !== "/";
    parent = path.posix.dirname(parent)
  ) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022)
      reject();
  }
  const parent = await lstat(path.posix.dirname(socketPath));
  const socket = await lstat(socketPath);
  if (
    parent.gid !== expectedGid ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== 0 ||
    socket.gid !== expectedGid ||
    (socket.mode & 0o777) !== 0o660
  )
    reject();
}

export async function requestControl(command, admissionRef) {
  const request = prepareRequest(command, admissionRef);
  const job = command === "produce";
  if (
    process.platform !== "linux" ||
    process.getuid() !== (job ? 65533 : 992) ||
    process.getgid() !== (job ? 65533 : 988)
  )
    reject();
  const socketPath = job ? JOB_SOCKET : MANAGEMENT_SOCKET;
  await checkSocket(socketPath, job ? 65533 : 988);
  return new Promise((resolve, rejectPromise) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolve(result);
    };
    const fail = () => finish(new Error(FAILURE));
    const timer = setTimeout(fail, TIMEOUT_MS);
    socket.on("connect", () => socket.end(JSON.stringify(request)));
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE) fail();
      else chunks.push(chunk);
    });
    socket.on("end", () => {
      try {
        finish(null, parseControlResponse(Buffer.concat(chunks), command, admissionRef));
      } catch {
        fail();
      }
    });
    socket.on("error", fail);
    socket.on("close", () => {
      if (!settled) fail();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--admission-ref") {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  } else {
    requestControl("produce", args[1])
      .then(() => process.stdout.write("H1_JOB_SUCCEEDED\n"))
      .catch(() => {
        process.stderr.write(`${FAILURE}\n`);
        process.exitCode = 1;
      });
  }
}
