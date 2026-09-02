import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

function task0Error(code) {
  return Object.assign(new Error(code), { code });
}

function task0Sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function hardenOwnerOnlyFile(filePath) {
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
    return;
  }
  const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  if (!identity.includes("\\")) throw task0Error("CONTROLLED_TARGET_OWNER_IDENTITY_UNAVAILABLE");
  await new Promise((resolve, reject) => {
    const child = spawn("icacls", [filePath, "/inheritance:r", "/grant:r", `${identity}:(F)`], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(task0Error("CONTROLLED_TARGET_SECRET_ACL_FAILED"));
        return;
      }
      resolve();
    });
  });
}

function sameFilesystemPath(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function sqlIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw task0Error("CONTROLLED_TARGET_SQL_NAME_INVALID");
  return `"${value}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function executeDockerCommand({ args, environment = {}, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        const error = task0Error("CONTROLLED_TARGET_DOCKER_COMMAND_FAILED");
        error.exitCode = code;
        error.signal = signal;
        error.diagnostic = stderr.trim().slice(0, 500);
        reject(error);
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input ?? "");
  });
}

async function executeCommandCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(task0Error("CONTROLLED_TARGET_SOURCE_SHA_UNAVAILABLE"));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function defaultWait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function pullExactPostgresImage({
  image,
  executeDocker = executeDockerCommand,
  wait = defaultWait
}) {
  if (!/@sha256:[0-9a-f]{64}$/u.test(image ?? "")) {
    throw task0Error("POSTGRES_IMAGE_DIGEST_REQUIRED");
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await executeDocker({
        purpose: "pull",
        args: ["pull", "--platform", "linux/amd64", image]
      });
    } catch (error) {
      if (error?.code !== "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED" || attempt === 3) {
        throw error;
      }
      await wait(attempt * 1000);
    }
  }
  throw task0Error("CONTROLLED_TARGET_DOCKER_COMMAND_FAILED");
}

function digestFromRepoDigests(stdout, expectedDigest) {
  let repoDigests;
  try {
    repoDigests = JSON.parse(stdout.trim());
  } catch {
    throw task0Error("CONTROLLED_TARGET_IMAGE_INSPECT_INVALID");
  }
  const match = repoDigests.find((value) => value.endsWith(`@${expectedDigest}`));
  if (!match) throw task0Error("CONTROLLED_TARGET_IMAGE_DIGEST_MISMATCH");
  return match.slice(match.lastIndexOf("@") + 1);
}

export function createDockerCli({ executeDocker = executeDockerCommand, wait = defaultWait } = {}) {
  return {
    async createExactTarget({ image, databaseName, runId, outputDirectory, credentials }) {
      const expectedDigest = image.slice(image.lastIndexOf("@") + 1);
      if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
        throw task0Error("POSTGRES_IMAGE_DIGEST_REQUIRED");
      }
      await mkdir(outputDirectory, { recursive: true });
      const bootstrapPasswordPath = path.resolve(outputDirectory, "bootstrap-password");
      await writeFile(bootstrapPasswordPath, `${credentials.bootstrap.password}\n`, {
        mode: 0o600
      });
      await hardenOwnerOnlyFile(bootstrapPasswordPath);
      let containerId = null;
      try {
        await pullExactPostgresImage({ image, executeDocker, wait });

        const repoDigests = await executeDocker({
          purpose: "image-inspect",
          args: ["image", "inspect", image, "--format", "{{json .RepoDigests}}"]
        });
        const actualImageDigest = digestFromRepoDigests(repoDigests, expectedDigest);
        containerId = (
          await executeDocker({
            purpose: "run",
            args: [
              "run",
              "--detach",
              "--platform",
              "linux/amd64",
              "--label",
              "subscription-s1-controlled=v1",
              "--label",
              `subscription-s1-controlled.run-id=${runId}`,
              "--env",
              `POSTGRES_USER=${credentials.bootstrap.username}`,
              "--env",
              "POSTGRES_DB=postgres",
              "--env",
              "POSTGRES_PASSWORD_FILE=/run/secrets/bootstrap-password",
              "--mount",
              `type=bind,source=${bootstrapPasswordPath},target=/run/secrets/bootstrap-password,readonly`,
              "--publish",
              "127.0.0.1::5432",
              image
            ]
          })
        ).trim();
        if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
          throw task0Error("CONTROLLED_TARGET_CONTAINER_ID_INVALID");
        }

        let ready = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            await executeDocker({
              purpose: "readiness",
              args: [
                "exec",
                containerId,
                "pg_isready",
                "--username",
                credentials.bootstrap.username,
                "--dbname",
                "postgres"
              ]
            });
            ready = true;
            break;
          } catch {
            await wait(250);
          }
        }
        if (!ready) throw task0Error("CONTROLLED_TARGET_POSTGRES_NOT_READY");

        const databaseMarker = `subscription-s1-controlled/${runId}`;
        const setupSql = [
          `CREATE ROLE ${sqlIdentifier(credentials.migrate.username)} LOGIN PASSWORD ${sqlLiteral(credentials.migrate.password)};`,
          `CREATE ROLE ${sqlIdentifier(credentials.verify.username)} LOGIN PASSWORD ${sqlLiteral(credentials.verify.password)};`,
          `CREATE ROLE ${sqlIdentifier(credentials["runtime-test"].username)} LOGIN PASSWORD ${sqlLiteral(credentials["runtime-test"].password)};`,
          `CREATE DATABASE ${sqlIdentifier(databaseName)} OWNER ${sqlIdentifier(credentials.migrate.username)};`,
          `COMMENT ON DATABASE ${sqlIdentifier(databaseName)} IS ${sqlLiteral(databaseMarker)};`,
          `REVOKE CONNECT ON DATABASE ${sqlIdentifier(databaseName)} FROM PUBLIC;`,
          `GRANT CONNECT ON DATABASE ${sqlIdentifier(databaseName)} TO ${sqlIdentifier(credentials.bootstrap.username)}, ${sqlIdentifier(credentials.migrate.username)}, ${sqlIdentifier(credentials.verify.username)}, ${sqlIdentifier(credentials["runtime-test"].username)};`
        ].join("\n");
        await executeDocker({
          purpose: "setup",
          args: [
            "exec",
            "--interactive",
            "--env",
            "PGPASSWORD",
            containerId,
            "psql",
            "--host",
            "127.0.0.1",
            "--username",
            credentials.bootstrap.username,
            "--dbname",
            "postgres",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1"
          ],
          environment: { PGPASSWORD: credentials.bootstrap.password },
          input: `${setupSql}\n`
        });

        const portOutput = await executeDocker({
          purpose: "port",
          args: ["port", containerId, "5432/tcp"]
        });
        const portMatch = portOutput.trim().match(/127\.0\.0\.1:(\d+)$/);
        if (!portMatch) throw task0Error("CONTROLLED_TARGET_PORT_INVALID");

        const identitySql = [
          "SELECT d.oid::text,",
          "       COALESCE(shobj_description(d.oid, 'pg_database'), ''),",
          "       current_setting('server_version_num')",
          "FROM pg_database AS d",
          "WHERE d.datname = current_database();"
        ].join(" ");
        const identityOutput = await executeDocker({
          purpose: "identity",
          args: [
            "exec",
            "--env",
            "PGPASSWORD",
            containerId,
            "psql",
            "--host",
            "127.0.0.1",
            "--username",
            credentials.migrate.username,
            "--dbname",
            databaseName,
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--field-separator",
            "\t",
            "--command",
            identitySql
          ],
          environment: { PGPASSWORD: credentials.migrate.password }
        });
        const [databaseOid, observedMarker, serverVersionNum] = identityOutput.trim().split("\t");
        if (!databaseOid || observedMarker !== databaseMarker || !serverVersionNum) {
          throw task0Error("CONTROLLED_TARGET_IDENTITY_MISMATCH");
        }
        await executeDocker({
          purpose: "bootstrap-disable",
          args: [
            "exec",
            "--env",
            "PGPASSWORD",
            containerId,
            "psql",
            "--host",
            "127.0.0.1",
            "--username",
            credentials.bootstrap.username,
            "--dbname",
            "postgres",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            `ALTER ROLE ${sqlIdentifier(credentials.bootstrap.username)} NOLOGIN;`
          ],
          environment: { PGPASSWORD: credentials.bootstrap.password }
        });

        return {
          actualImageDigest,
          containerId,
          databaseMarker,
          databaseName,
          databaseOid,
          host: "127.0.0.1",
          port: Number(portMatch[1]),
          serverVersionNum,
          tlsMode: "disable"
        };
      } catch (error) {
        if (containerId) {
          try {
            await executeDocker({
              purpose: "bootstrap-rollback-remove",
              args: ["rm", "--force", containerId]
            });
          } catch {
            // The original failure remains authoritative; the exact container ID is retained in Docker.
          }
        }
        throw error;
      } finally {
        await rm(bootstrapPasswordPath, { force: true });
      }
    },

    async inspectExactTarget({ record, profile, secret }) {
      const inspectOutput = await executeDocker({
        purpose: "container-inspect",
        args: ["inspect", record.container.id]
      });
      let inspected;
      try {
        [inspected] = JSON.parse(inspectOutput);
      } catch {
        throw task0Error("CONTROLLED_TARGET_CONTAINER_INSPECT_INVALID");
      }
      const labels = inspected?.Config?.Labels ?? {};
      if (
        inspected?.Id !== record.container.id ||
        labels["subscription-s1-controlled"] !== "v1" ||
        labels["subscription-s1-controlled.run-id"] !== record.container.runId ||
        inspected?.Config?.Image !== `${record.image.repository}@${record.image.resolvedDigest}`
      ) {
        throw task0Error("CONTROLLED_TARGET_IDENTITY_MISMATCH");
      }

      const repoDigests = await executeDocker({
        purpose: "image-inspect",
        args: [
          "image",
          "inspect",
          `${record.image.repository}@${record.image.resolvedDigest}`,
          "--format",
          "{{json .RepoDigests}}"
        ]
      });
      const imageDigest = digestFromRepoDigests(repoDigests, record.image.resolvedDigest);
      const portOutput = await executeDocker({
        purpose: "port",
        args: ["port", record.container.id, "5432/tcp"]
      });
      const portMatch = portOutput.trim().match(/^(127\.0\.0\.1):(\d+)$/);
      if (!portMatch) throw task0Error("CONTROLLED_TARGET_PORT_INVALID");
      const identitySql = [
        "SELECT d.oid::text,",
        "       COALESCE(shobj_description(d.oid, 'pg_database'), ''),",
        "       current_setting('server_version_num'),",
        "       current_user,",
        "       current_database()",
        "FROM pg_database AS d",
        "WHERE d.datname = current_database();"
      ].join(" ");
      const identityOutput = await executeDocker({
        purpose: "profile-identity",
        args: [
          "exec",
          "--env",
          "PGPASSWORD",
          record.container.id,
          "psql",
          "--host",
          "127.0.0.1",
          "--username",
          secret.username,
          "--dbname",
          secret.database,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--field-separator",
          "\t",
          "--command",
          identitySql
        ],
        environment: { PGPASSWORD: secret.password }
      });
      const [databaseOid, databaseMarker, serverVersionNum, roleName, databaseName] = identityOutput
        .trim()
        .split("\t");

      return {
        containerId: inspected.Id,
        imageDigest,
        markerLabel: `${labels["subscription-s1-controlled"] === "v1" ? "subscription-s1-controlled/v1" : ""}`,
        databaseMarker,
        databaseName,
        databaseOid,
        host: portMatch[1],
        port: Number(portMatch[2]),
        serverVersionNum,
        roleName,
        tlsMode: "disable"
      };
    },

    async readMigrationHead({ record, secret }) {
      const migrationHeadOutput = await executeDocker({
        purpose: "migration-head",
        args: [
          "exec",
          "--env",
          "PGPASSWORD",
          record.container.id,
          "psql",
          "--host",
          "127.0.0.1",
          "--username",
          secret.username,
          "--dbname",
          secret.database,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1;'
        ],
        environment: { PGPASSWORD: secret.password }
      });
      const migrationHead = migrationHeadOutput.trim();
      if (!/^\d{14}_[a-z0-9_]+$/.test(migrationHead)) {
        throw task0Error("CONTROLLED_TARGET_MIGRATION_HEAD_INVALID");
      }
      return migrationHead;
    },

    async removeExactTarget({ containerId, databaseName, runId }) {
      if (!/^s1dev_[0-9a-f]{24}$/.test(databaseName)) {
        throw task0Error("CONTROLLED_TARGET_CLEANUP_SCOPE_INVALID");
      }
      const inspectOutput = await executeDocker({
        purpose: "container-inspect",
        args: ["inspect", containerId]
      });
      let inspected;
      try {
        [inspected] = JSON.parse(inspectOutput);
      } catch {
        throw task0Error("CONTROLLED_TARGET_CONTAINER_INSPECT_INVALID");
      }
      const labels = inspected?.Config?.Labels ?? {};
      if (
        inspected?.Id !== containerId ||
        labels["subscription-s1-controlled"] !== "v1" ||
        labels["subscription-s1-controlled.run-id"] !== runId
      ) {
        throw task0Error("CONTROLLED_TARGET_CLEANUP_IDENTITY_MISMATCH");
      }
      await executeDocker({
        purpose: "remove",
        args: ["rm", "--force", containerId]
      });
    }
  };
}

export async function bootstrapControlledPostgres({
  environment = process.env,
  imageContract,
  repoRoot = process.cwd(),
  sourceSha,
  outputDirectory,
  docker
}) {
  if (environment.DATABASE_URL) throw task0Error("AMBIENT_DATABASE_URL_FORBIDDEN");
  if (!/^sha256:[0-9a-f]{64}$/.test(imageContract?.resolvedDigest ?? "")) {
    throw task0Error("POSTGRES_IMAGE_DIGEST_REQUIRED");
  }
  if (imageContract.platform !== "linux/amd64" || imageContract.serverVersionMajor !== 17) {
    throw task0Error("POSTGRES_IMAGE_CONTRACT_INVALID");
  }
  const dockerClient = docker ?? createDockerCli();
  if (!dockerClient?.createExactTarget) throw task0Error("CONTROLLED_TARGET_DOCKER_REQUIRED");
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw task0Error("CONTROLLED_TARGET_SOURCE_SHA_INVALID");
  }
  if (!outputDirectory) throw task0Error("CONTROLLED_TARGET_OUTPUT_DIRECTORY_REQUIRED");
  if (!sameFilesystemPath(outputDirectory, path.join(repoRoot, ".release-local"))) {
    throw task0Error("CONTROLLED_TARGET_OUTPUT_SCOPE_INVALID");
  }

  const runId = randomUUID();
  const databaseName = `s1dev_${task0Sha256Text(`${runId}:${repoRoot}`).slice(0, 24)}`;
  const roleSuffix = task0Sha256Text(runId).slice(0, 8);
  const roles = {
    bootstrap: `s1_bootstrap_${roleSuffix}`,
    migrate: `s1_migrate_${roleSuffix}`,
    verify: `s1_verify_${roleSuffix}`,
    "runtime-test": `s1_runtime_test_${roleSuffix}`
  };
  const credentials = Object.fromEntries(
    Object.entries(roles).map(([profile, username]) => [
      profile,
      {
        username,
        password: task0Sha256Text(`${randomUUID()}:${profile}:${runId}`)
      }
    ])
  );
  const target = await dockerClient.createExactTarget({
    credentials,
    image: `${imageContract.repository}@${imageContract.resolvedDigest}`,
    databaseName,
    outputDirectory,
    runId
  });
  if (
    target.actualImageDigest !== imageContract.resolvedDigest ||
    target.databaseName !== databaseName ||
    target.databaseMarker !== `subscription-s1-controlled/${runId}` ||
    !String(target.serverVersionNum).startsWith("17")
  ) {
    throw task0Error("CONTROLLED_TARGET_IDENTITY_MISMATCH");
  }

  const secretDirectory = path.join(outputDirectory, "secrets");
  await mkdir(secretDirectory, { recursive: true });
  const secretFiles = {};
  for (const [profile, credential] of Object.entries(credentials)) {
    const secretPath = path.join(secretDirectory, `${profile}.json`);
    await writeFile(
      secretPath,
      `${JSON.stringify({
        host: target.host,
        port: target.port,
        username: credential.username,
        password: credential.password,
        database: databaseName,
        tlsMode: target.tlsMode
      })}\n`,
      { mode: 0o600 }
    );
    await hardenOwnerOnlyFile(secretPath);
    secretFiles[profile] = path.relative(repoRoot, secretPath);
  }

  const record = {
    recordVersion: "controlled-target-record.v1",
    sourceSha,
    image: {
      repository: imageContract.repository,
      resolvedDigest: imageContract.resolvedDigest,
      platform: imageContract.platform
    },
    container: {
      id: target.containerId,
      markerLabel: "subscription-s1-controlled/v1",
      runId
    },
    cluster: {
      fingerprint: task0Sha256Text(
        `${target.containerId}:${target.serverVersionNum}:${target.databaseOid}:${target.databaseMarker}`
      ),
      serverVersionNum: String(target.serverVersionNum),
      tlsMode: target.tlsMode
    },
    database: {
      name: databaseName,
      oid: String(target.databaseOid),
      marker: target.databaseMarker,
      migrationHead: null
    },
    roles,
    secretFiles
  };

  const serializedRecord = JSON.stringify(record, null, 2);
  if (/postgres(?:ql)?:\/\//i.test(serializedRecord) || /"password"\s*:/i.test(serializedRecord)) {
    throw task0Error("CONTROLLED_TARGET_RECORD_CONTAINS_SECRET");
  }
  await writeFile(
    path.join(outputDirectory, "controlled-target.v1.json"),
    `${serializedRecord}\n`,
    {
      mode: 0o600
    }
  );
  return record;
}

export async function cleanupControlledPostgres({ record, docker }) {
  const exactDatabaseName = /^s1dev_[0-9a-f]{24}$/;
  const exactRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const markerMatchesRun =
    record?.database?.marker === `subscription-s1-controlled/${record?.container?.runId}`;
  if (
    !exactDatabaseName.test(record?.database?.name ?? "") ||
    !exactRunId.test(record?.container?.runId ?? "") ||
    record?.container?.markerLabel !== "subscription-s1-controlled/v1" ||
    !markerMatchesRun ||
    !record?.container?.id
  ) {
    throw task0Error("CONTROLLED_TARGET_CLEANUP_SCOPE_INVALID");
  }
  if (!docker?.removeExactTarget) throw task0Error("CONTROLLED_TARGET_DOCKER_REQUIRED");
  await docker.removeExactTarget({
    containerId: record.container.id,
    databaseName: record.database.name,
    runId: record.container.runId
  });
}

const BOOTSTRAP_USAGE = `Usage:
  node scripts/release/bootstrap-controlled-postgres.mjs --output <controlled-target-record>
  node scripts/release/bootstrap-controlled-postgres.mjs --cleanup <controlled-target-record>
`;

async function bootstrapCli(argv) {
  if (argv.includes("--help")) {
    process.stdout.write(BOOTSTRAP_USAGE);
    return 0;
  }
  const outputIndex = argv.indexOf("--output");
  const cleanupIndex = argv.indexOf("--cleanup");
  if (outputIndex >= 0 === cleanupIndex >= 0) throw task0Error("CONTROLLED_TARGET_CLI_USAGE");

  const repoRoot = process.cwd();
  const docker = createDockerCli();
  if (cleanupIndex >= 0) {
    const recordPath = path.resolve(repoRoot, argv[cleanupIndex + 1] ?? "");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await cleanupControlledPostgres({ record, docker });
    process.stdout.write(`CONTROLLED_TARGET_REMOVED ${record.container.id}\n`);
    return 0;
  }

  const outputPath = path.resolve(repoRoot, argv[outputIndex + 1] ?? "");
  if (path.basename(outputPath) !== "controlled-target.v1.json") {
    throw task0Error("CONTROLLED_TARGET_OUTPUT_PATH_INVALID");
  }
  const imageContract = JSON.parse(
    await readFile(path.join(repoRoot, "release/contracts/postgres-image.v1.json"), "utf8")
  );
  const sourceSha = await executeCommandCapture("git", ["rev-parse", "HEAD"]);
  const record = await bootstrapControlledPostgres({
    environment: process.env,
    imageContract,
    repoRoot,
    sourceSha,
    outputDirectory: path.dirname(outputPath),
    docker
  });
  process.stdout.write(
    `CONTROLLED_TARGET_READY ${outputPath} postgres=${record.cluster.serverVersionNum} database=${record.database.name}\n`
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrapCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.code ?? "CONTROLLED_TARGET_BOOTSTRAP_FAILED"}\n`);
      process.exitCode = 1;
    }
  );
}
