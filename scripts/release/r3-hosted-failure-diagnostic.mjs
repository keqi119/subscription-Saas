// A fixed, bounded projection of hosted creation failures. Never serialize evidence directly.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const CHECKPOINTS = new Set([
  "PRECONDITION",
  "WORKSPACE",
  "PATHS",
  "CONFIG",
  "EXECUTABLE",
  "SPAWN",
  "PING",
  "INFO",
  "VERSION",
  "INFO_ID",
  "INFO_ROOT",
  "INFO_STORAGE",
  "INFO_EMPTY",
  "INFO_DRIVER_STATUS",
  "VERSION_FIELDS",
  "LIVENESS",
  "SYSTEM_CONTAINERD",
  "SOCKET",
  "CONTAINERD",
  "CONTAINERD_MOUNT",
  "COMPLETE"
]);
const CONTAINERD_CHECKPOINTS = new Set([
  "INPUT",
  "MOUNT",
  "OWNED_PATHS",
  "PID",
  "PROCESS",
  "CONFIG",
  "IDENTITY",
  "SOCKET_ROWS",
  "SOCKET_OWNERS",
  "RAW_ASSESS",
  "STABILITY"
]);
const CONTAINERD_CAUSES = new Set([
  "R3_CONTAINERD_OBSERVATION_INVALID",
  "R3_CONTAINERD_RAW_INVALID",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "EINVAL"
]);
const RAW_NAMES = [
  "ping",
  "info",
  "version",
  "containerd.pidFile",
  "containerd.stat",
  "containerd.cmdline",
  "containerd.config",
  "containerd.socketOwners",
  "containerd.grpcSocketRow",
  "containerd.debugSocketRow"
];
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT"]);
const COMPONENTS = new Set(["HOSTED_CREATE", "HOSTED_WORKSPACE"]);
const STAGES = new Set(["ENGINE", "WORKSPACE"]);
const CODES = new Set([
  "R3_HOSTED_CREATION_CONTROL_INVALID",
  "R3_HOSTED_WORKSPACE_CREATE_INVALID",
  "R3_CONTAINERD_OBSERVATION_INVALID",
  "R3_ENGINE_EXCHANGE_UNAVAILABLE"
]);
const select = (value, allowed) => (allowed.has(value) ? value : null);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

function projectRawRefs(refs) {
  const result = {};
  for (const name of RAW_NAMES) {
    const ref = refs?.[name];
    if (/^sha256:[0-9a-f]{64}$/u.test(ref?.digest) && integer(ref?.bytes, 0, 1_048_576) !== null) {
      result[name] = { digest: ref.digest, bytes: ref.bytes };
    }
  }
  return result;
}

export function projectR3HostedFailure(cause) {
  const diagnostic = cause?.failureDiagnostic;
  const evidence = cause?.evidence;
  const engine = evidence?.engineAttempt;
  const creator = evidence?.creatorFailure;
  if (
    !COMPONENTS.has(diagnostic?.component) ||
    !STAGES.has(diagnostic?.stage) ||
    (!engine && !creator)
  )
    return null;
  return {
    schemaVersion: "r3-hosted-failure-evidence.v1",
    component: diagnostic.component,
    stage: diagnostic.stage,
    causeCode: select(diagnostic.causeCode, CODES),
    engineAttempt: engine
      ? {
          checkpoint: select(engine.checkpoint, CHECKPOINTS),
          pid: integer(engine.pid, 1, 2_147_483_647),
          exitCode: integer(engine.exit?.exitCode, 0, 255),
          exitSignal: select(engine.exit?.signal, SIGNALS),
          httpStatus: integer(engine.httpStatus, 100, 599),
          rawRefs: projectRawRefs(engine.rawRefs),
          containerdFailureCode:
            engine.containerdFailure?.code === "R3_CONTAINERD_OBSERVATION_INVALID"
              ? "R3_CONTAINERD_OBSERVATION_INVALID"
              : null,
          containerdCheckpoint: select(
            engine.containerdFailure?.checkpoint,
            CONTAINERD_CHECKPOINTS
          ),
          containerdCauseCode: select(engine.containerdFailure?.causeCode, CONTAINERD_CAUSES)
        }
      : null,
    creatorFailure: creator
      ? {
          status: select(creator.creation?.status, new Set(["INCOMPLETE", "WORKSPACE_OBSERVED"]))
        }
      : null
  };
}

export async function writeR3HostedFailureDiagnostic(repoRoot, cause) {
  const record = projectR3HostedFailure(cause);
  if (!record) return null;
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot))
    throw new TypeError("R3_HOSTED_FAILURE_ROOT_INVALID");
  const rootStat = await fs.lstat(repoRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new TypeError("R3_HOSTED_FAILURE_ROOT_INVALID");
  const directories = [
    path.join(repoRoot, ".release-output"),
    path.join(repoRoot, ".release-output", "r3-hosted-failure")
  ];
  for (const directory of directories) {
    try {
      await fs.mkdir(directory, { mode: 0o755 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new TypeError("R3_HOSTED_FAILURE_DIRECTORY_INVALID");
    await fs.chmod(directory, 0o755);
  }
  const file = path.join(directories[1], "engine-diagnostic.v1.json");
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW |
    constants.O_CLOEXEC;
  const handle = await fs.open(file, flags, 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
  return file;
}
