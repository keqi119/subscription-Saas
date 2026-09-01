import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDockerCli } from "./bootstrap-controlled-postgres.mjs";

function controlledTargetError(code) {
  return Object.assign(new Error(code), { code });
}

function sameFilesystemPath(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

async function defaultReadSecretFile(secretFile) {
  try {
    return JSON.parse(await readFile(secretFile, "utf8"));
  } catch (error) {
    throw controlledTargetError(
      error?.code === "ENOENT"
        ? "CONTROLLED_TARGET_SECRET_MISSING"
        : "CONTROLLED_TARGET_SECRET_INVALID"
    );
  }
}

function controlledDatabaseUrl(secret) {
  const username = encodeURIComponent(secret.username);
  const password = encodeURIComponent(secret.password);
  const database = encodeURIComponent(secret.database);
  const sslMode = encodeURIComponent(secret.tlsMode);
  return `postgresql://${username}:${password}@${secret.host}:${secret.port}/${database}?sslmode=${sslMode}`;
}

function controlledChildEnvironment(environment, secret) {
  const childEnvironment = { ...environment };
  for (const key of Object.keys(childEnvironment)) {
    if (
      /DATABASE_URL$/i.test(key) ||
      /^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$/i.test(key)
    ) {
      delete childEnvironment[key];
    }
  }
  childEnvironment.DATABASE_URL = controlledDatabaseUrl(secret);
  childEnvironment.STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV = "1";
  return childEnvironment;
}

function resolvedHostCommand(command) {
  if (process.platform === "win32" && /^(?:pnpm|pnpm\.cmd)$/i.test(command[0])) {
    return {
      executable: process.execPath,
      args: [
        path.join(path.dirname(process.execPath), "node_modules/corepack/dist/pnpm.js"),
        ...command.slice(1)
      ]
    };
  }
  return { executable: command[0], args: command.slice(1) };
}

async function defaultSpawnChild({ command, environment }) {
  return new Promise((resolve, reject) => {
    const resolved = resolvedHostCommand(command);
    const child = spawn(resolved.executable, resolved.args, {
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(controlledTargetError("CONTROLLED_TARGET_CHILD_INTERRUPTED"));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runWithControlledTarget({
  record,
  profile,
  command,
  docker,
  environment = process.env,
  readSecretFile = defaultReadSecretFile,
  repoRoot = process.cwd(),
  recordPath,
  spawnChild = defaultSpawnChild
}) {
  if (!record || !profile || !Array.isArray(command) || command.length === 0) {
    throw controlledTargetError("CONTROLLED_TARGET_INPUT_INVALID");
  }
  if (!record.roles?.[profile] || !record.secretFiles?.[profile]) {
    throw controlledTargetError("CONTROLLED_TARGET_PROFILE_INVALID");
  }

  const secretPath = path.resolve(repoRoot, record.secretFiles[profile]);
  const expectedSecretPath = path.join(repoRoot, ".release-local", "secrets", `${profile}.json`);
  if (!sameFilesystemPath(secretPath, expectedSecretPath)) {
    throw controlledTargetError("CONTROLLED_TARGET_SECRET_REFERENCE_INVALID");
  }
  const secret = await readSecretFile(secretPath);
  const actual = await docker.inspectExactTarget({ record, profile, secret });
  const expected = {
    containerId: record.container.id,
    imageDigest: record.image.resolvedDigest,
    markerLabel: record.container.markerLabel,
    databaseMarker: record.database.marker,
    databaseName: record.database.name,
    databaseOid: record.database.oid,
    serverVersionNum: record.cluster.serverVersionNum,
    roleName: record.roles[profile]
  };

  if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw controlledTargetError("CONTROLLED_TARGET_IDENTITY_MISMATCH");
  }
  if (
    actual.host !== secret.host ||
    actual.port !== secret.port ||
    actual.tlsMode !== secret.tlsMode
  ) {
    throw controlledTargetError("CONTROLLED_TARGET_CONNECTION_IDENTITY_MISMATCH");
  }

  const exitCode = await spawnChild({
    command,
    environment: controlledChildEnvironment(environment, secret),
    profile,
    record,
    secret
  });
  if (exitCode === 0 && profile === "migrate" && recordPath) {
    if (!docker.readMigrationHead) {
      throw controlledTargetError("CONTROLLED_TARGET_MIGRATION_HEAD_READER_REQUIRED");
    }
    const migrationHead = await docker.readMigrationHead({ record, secret });
    if (!/^\d{14}_[a-z0-9_]+$/.test(migrationHead)) {
      throw controlledTargetError("CONTROLLED_TARGET_MIGRATION_HEAD_INVALID");
    }
    const updatedRecord = {
      ...record,
      database: { ...record.database, migrationHead }
    };
    await writeFile(recordPath, `${JSON.stringify(updatedRecord, null, 2)}\n`, { mode: 0o600 });
  }
  return exitCode;
}

const WRAPPER_USAGE = `Usage:
  node scripts/release/with-controlled-target.mjs [--record <controlled-target-record>] --profile <migrate|verify|runtime-test> -- <command> [args...]
`;

async function wrapperCli(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(WRAPPER_USAGE);
    return 0;
  }
  const separator = argv.indexOf("--");
  const profileIndex = argv.indexOf("--profile");
  const recordIndex = argv.indexOf("--record");
  if (separator < 0 || profileIndex < 0 || separator === argv.length - 1) {
    throw controlledTargetError("CONTROLLED_TARGET_CLI_USAGE");
  }
  const profile = argv[profileIndex + 1];
  if (!new Set(["migrate", "verify", "runtime-test"]).has(profile)) {
    throw controlledTargetError("CONTROLLED_TARGET_PROFILE_INVALID");
  }
  const repoRoot = process.cwd();
  const recordPath = path.resolve(
    repoRoot,
    recordIndex >= 0 ? (argv[recordIndex + 1] ?? "") : ".release-local/controlled-target.v1.json"
  );
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  return runWithControlledTarget({
    repoRoot,
    recordPath,
    record,
    profile,
    command: argv.slice(separator + 1),
    docker: createDockerCli()
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  wrapperCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.code ?? "CONTROLLED_TARGET_COMMAND_FAILED"}\n`);
      process.exitCode = 1;
    }
  );
}
