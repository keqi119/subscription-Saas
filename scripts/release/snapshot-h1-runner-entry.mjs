// Fixed low-privilege entry. The root controller verifies the volume and admission.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";
import { TextDecoder } from "node:util";

const FAILURE = "H1_RUNNER_INPUT_REJECTED";
const MAX = 1048576;
const FILES = [".runner", ".credentials", ".credentials_rsaparams"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw new Error(FAILURE);
};
const requireThat = (value) => {
  if (!value) fail();
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

function base64(value) {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= MAX);
  const decoded = Buffer.from(value, "base64");
  requireThat(decoded.length > 0 && decoded.toString("base64") === value);
  return decoded;
}

function uniqueJson(raw) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const value = JSON.parse(text);
  // JSON.parse establishes valid syntax; the token walk only rejects duplicate keys.
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]/gu)].map((m) => m[0]);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      requireThat(stack.length <= 32);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(token);
      requireThat(stack.at(-1) instanceof Set && !stack.at(-1).has(key));
      stack.at(-1).add(key);
    }
  }
  return value;
}

function githubEndpoint(value) {
  requireThat(typeof value === "string" && value.length <= 2048);
  const url = new URL(value);
  requireThat(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !url.search &&
      url.hostname.endsWith(".actions.githubusercontent.com")
  );
}

function connectionSettings(settings, credentials) {
  // Names are pinned to v2.337.0 RunnerSettings/OAuthCredential. Unknown aliases
  // cannot override a checked field in the case-insensitive .NET deserializer.
  const allowed = [
    "agentId",
    "agentName",
    "skipSessionRecover",
    "poolId",
    "poolName",
    "disableUpdate",
    "ephemeral",
    "serverUrl",
    "gitHubUrl",
    "workFolder",
    "monitorSocketAddress",
    "useV2Flow",
    "useRunnerAdminFlow",
    "serverUrlV2",
    "isHostedServer",
    "IsHostedServer"
  ];
  requireThat(
    Object.keys(settings).every((key) => allowed.includes(key)) &&
      Number.isSafeInteger(settings.poolId) &&
      settings.poolId > 0 &&
      !("isHostedServer" in settings && "IsHostedServer" in settings)
  );
  githubEndpoint(settings.serverUrl);
  if (settings.serverUrlV2) githubEndpoint(settings.serverUrlV2);
  for (const key of ["serverUrlV2", "gitHubUrl", "monitorSocketAddress", "poolName"])
    if (key in settings) requireThat(typeof settings[key] === "string");
  requireThat(
    !settings.gitHubUrl || settings.gitHubUrl === "https://github.com/keqi119/subscription-Saas"
  );
  requireThat(!settings.monitorSocketAddress);
  for (const key of ["skipSessionRecover", "useV2Flow", "useRunnerAdminFlow"])
    if (key in settings) requireThat(typeof settings[key] === "boolean");
  for (const key of ["isHostedServer", "IsHostedServer"])
    if (key in settings) requireThat(settings[key] === true);
  requireThat(
    keys(credentials, ["scheme", "data"]) &&
      credentials.scheme === "OAuth" &&
      object(credentials.data)
  );
  const data = credentials.data;
  requireThat(
    Object.keys(data).every((key) =>
      [
        "clientId",
        "authorizationUrl",
        "authorizationUrlV2",
        "oauthEndpointUrl",
        "requireFipsCryptography",
        "EnableAuthMigrationByDefault"
      ].includes(key)
    ) &&
      typeof data.clientId === "string" &&
      /^[a-f0-9-]{36}$/iu.test(data.clientId)
  );
  githubEndpoint(data.authorizationUrl);
  for (const key of ["authorizationUrlV2", "oauthEndpointUrl"])
    if (key in data) githubEndpoint(data[key]);
  for (const key of ["requireFipsCryptography", "EnableAuthMigrationByDefault"])
    if (key in data)
      requireThat(typeof data[key] === "string" && /^(true|false)$/iu.test(data[key]));
}

export function prepareH1RunnerInput(frame) {
  try {
    requireThat(
      keys(frame, ["attemptId", "admissionRef", "runnerId", "routeNonce", "encodedJitConfig"])
    );
    requireThat(typeof frame.attemptId === "string" && UUID.test(frame.attemptId));
    requireThat(
      typeof frame.admissionRef === "string" && /^sha256:[a-f0-9]{64}$/u.test(frame.admissionRef)
    );
    requireThat(typeof frame.runnerId === "string" && /^[1-9][0-9]{0,15}$/u.test(frame.runnerId));
    requireThat(typeof frame.routeNonce === "string" && /^[a-f0-9]{32}$/u.test(frame.routeNonce));
    const encodedFiles = uniqueJson(base64(frame.encodedJitConfig));
    requireThat(keys(encodedFiles, FILES));
    const files = Object.fromEntries(FILES.map((name) => [name, base64(encodedFiles[name])]));
    const settings = uniqueJson(files[".runner"]);
    requireThat(
      object(settings) &&
        Number.isSafeInteger(settings.agentId) &&
        String(settings.agentId) === frame.runnerId &&
        settings.agentName === `stage1-snapshot-${frame.routeNonce}` &&
        settings.workFolder === "_work" &&
        settings.ephemeral === true &&
        settings.disableUpdate === true
    );
    connectionSettings(settings, uniqueJson(files[".credentials"]));
    return {
      runnerRoot: `/var/lib/subscription-saas/snapshot-volumes/${frame.attemptId}.mnt/runner`,
      admissionRef: frame.admissionRef,
      settings,
      files
    };
  } catch {
    fail();
  }
}

async function readFrame() {
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error(FAILURE)), 5000);
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      requireThat(length <= MAX + 4096);
      chunks.push(chunk);
    }
    return uniqueJson(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function main() {
  requireThat(
    process.platform === "linux" &&
      process.getuid() === 992 &&
      process.getgid() === 988 &&
      process.argv.length === 2
  );
  process.umask(0o077);
  const config = prepareH1RunnerInput(await readFrame());
  const directory = await lstat(config.runnerRoot);
  requireThat(
    directory.isDirectory() &&
      directory.uid === 992 &&
      directory.gid === 988 &&
      (directory.mode & 0o777) === 0o700 &&
      (await realpath(config.runnerRoot)) === config.runnerRoot
  );
  for (const name of FILES) {
    const file = await open(
      `${config.runnerRoot}/${name}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(config.files[name]);
      await file.sync();
    } finally {
      config.files[name].fill(0);
      await file.close();
    }
  }
  // This is the fixed v2.337.0 JIT file layout. No JIT bytes enter argv or env.
  // Listener output stays private; its own diagnostics remain inside the attempt volume.
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(`${config.runnerRoot}/bin/Runner.Listener`, ["run"], {
      cwd: config.runnerRoot,
      shell: false,
      stdio: "ignore",
      env: {
        HOME: config.runnerRoot,
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        TMPDIR: "/tmp",
        DOTNET_EnableDiagnostics: "0",
        ACTIONS_RUNNER_CONTAINER_HOOKS: "/entry/snapshot-h1-container-hook.js",
        ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER: "true",
        STAGE1_SNAPSHOT_ADMISSION_REF: config.admissionRef
      }
    });
    let interrupted = false;
    let force;
    const stop = () => {
      if (interrupted) return;
      interrupted = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 10000);
    };
    const timer = setTimeout(stop, 1100000);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(force);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    };
    child.once("error", () => {
      clear();
      reject(new Error(FAILURE));
    });
    child.once("exit", (code) => {
      clear();
      resolve(interrupted ? 1 : code);
    });
  });
  requireThat(exitCode === 0);
  // Exit 0 only means the Listener exited normally, not that the producer/job passed.
  process.stdout.write('{"status":"LISTENER_EXITED"}\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  });
}
