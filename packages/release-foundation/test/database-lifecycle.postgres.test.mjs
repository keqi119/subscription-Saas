import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanupSuiteDatabase,
  grantRuntimeEquivalentAccess,
  provisionSuiteDatabase,
  scanMigrationGlobalObjects,
  sha256Canonical
} from "../src/index.mjs";
import {
  executeDockerCommand,
  hardenOwnerOnlyFile
} from "../../../scripts/release/bootstrap-controlled-postgres.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function contractError(code) {
  return Object.assign(new Error(code), { code });
}

function controlledChildEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /DATABASE_URL$/i.test(key) ||
      /^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$/i.test(key)
    ) {
      delete environment[key];
    }
  }
  return { ...environment, ...overrides };
}

function databaseUrl(secret) {
  return `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${encodeURIComponent(secret.database)}?sslmode=disable`;
}

async function runCommand(executable, args, { environment = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(contractError("DATABASE_LIFECYCLE_CHILD_FAILED"));
        return;
      }
      resolve();
    });
  });
}

async function runMigration(secret) {
  const command = migrationPackageManagerCommand();
  await runCommand(command.executable, command.arguments, {
    environment: controlledChildEnvironment({
      DATABASE_URL: databaseUrl(secret),
      STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
    })
  });
}

export function migrationPackageManagerCommand(
  platform = process.platform,
  executablePath = process.execPath
) {
  const arguments_ = [
    "--filter",
    "@subscription-saas/api",
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "prisma/schema.prisma"
  ];
  if (platform !== "win32") return { executable: "pnpm", arguments: arguments_ };
  return {
    executable: executablePath,
    arguments: [
      path.join(path.dirname(executablePath), "node_modules/corepack/dist/pnpm.js"),
      ...arguments_
    ]
  };
}

function rowsFromOutput(output, columns) {
  if (!output.trim()) return [];
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value]))
    );
}

async function executePsql({ containerId, credential, databaseName, sql, columns = [] }) {
  const output = await executeDockerCommand({
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
      credential.username,
      "--dbname",
      databaseName,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "\t"
    ],
    environment: { PGPASSWORD: credential.password },
    input: `${sql}\n`
  });
  return { rows: rowsFromOutput(output, columns) };
}

async function waitForPostgres(containerId, username) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await executeDockerCommand({
        args: ["exec", containerId, "pg_isready", "--username", username, "--dbname", "postgres"]
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw contractError("DATABASE_LIFECYCLE_POSTGRES_NOT_READY");
}

async function assertExactContainer(containerId, runId, image) {
  const output = await executeDockerCommand({ args: ["inspect", containerId] });
  const [inspected] = JSON.parse(output);
  if (
    inspected?.Id !== containerId ||
    inspected?.Config?.Image !== image ||
    inspected?.Config?.Labels?.["subscription-s1-controlled"] !== "v1" ||
    inspected?.Config?.Labels?.["subscription-s1-lifecycle.run-id"] !== runId
  ) {
    throw contractError("DATABASE_LIFECYCLE_CONTAINER_IDENTITY_MISMATCH");
  }
}

export async function runDatabaseLifecyclePostgresContract() {
  if (process.env.DATABASE_URL) throw contractError("AMBIENT_DATABASE_URL_FORBIDDEN");
  const imageContract = JSON.parse(
    await readFile(path.join(repoRoot, "release/contracts/postgres-image.v1.json"), "utf8")
  );
  const targetPolicies = JSON.parse(
    await readFile(
      path.join(repoRoot, "release/contracts/database-target-policies.v1.json"),
      "utf8"
    )
  );
  const migrationPolicy = JSON.parse(
    await readFile(
      path.join(repoRoot, "release/contracts/migration-global-object-policy.v1.json"),
      "utf8"
    )
  );
  const policy = targetPolicies.policies.find(
    (candidate) => candidate.policyId === "s1-release-ephemeral"
  );
  assert.ok(policy);
  const migrationScan = await scanMigrationGlobalObjects(repoRoot, migrationPolicy);
  assert.deepEqual(migrationScan.extensions, ["btree_gist", "pgcrypto"]);

  const runId = randomUUID();
  const provisioner = {
    username: `s1p_${randomBytes(12).toString("hex")}`,
    password: randomBytes(32).toString("hex")
  };
  const taskDirectory = path.join(repoRoot, ".release-local", "task3", runId);
  const passwordPath = path.join(taskDirectory, "provisioner-password");
  const image = `${imageContract.repository}@${imageContract.resolvedDigest}`;
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(passwordPath, `${provisioner.password}\n`, { mode: 0o600 });
  await hardenOwnerOnlyFile(passwordPath);

  let containerId;
  const provisioned = [];
  try {
    await executeDockerCommand({ args: ["pull", "--platform", "linux/amd64", image] });
    const repoDigests = JSON.parse(
      await executeDockerCommand({
        args: ["image", "inspect", image, "--format", "{{json .RepoDigests}}"]
      })
    );
    assert.ok(repoDigests.some((value) => value.endsWith(`@${imageContract.resolvedDigest}`)));
    containerId = (
      await executeDockerCommand({
        args: [
          "run",
          "--detach",
          "--platform",
          "linux/amd64",
          "--label",
          "subscription-s1-controlled=v1",
          "--label",
          "subscription-s1-lifecycle=v1",
          "--label",
          `subscription-s1-lifecycle.run-id=${runId}`,
          "--env",
          `POSTGRES_USER=${provisioner.username}`,
          "--env",
          "POSTGRES_DB=postgres",
          "--env",
          "POSTGRES_PASSWORD_FILE=/run/secrets/provisioner-password",
          "--mount",
          `type=bind,source=${passwordPath},target=/run/secrets/provisioner-password,readonly`,
          "--publish",
          "127.0.0.1::5432",
          image
        ]
      })
    ).trim();
    assert.match(containerId, /^[0-9a-f]{64}$/);
    await waitForPostgres(containerId, provisioner.username);
    await assertExactContainer(containerId, runId, image);
    await rm(passwordPath, { force: true });

    const portOutput = await executeDockerCommand({ args: ["port", containerId, "5432/tcp"] });
    const port = Number(portOutput.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1]);
    assert.ok(Number.isInteger(port) && port > 0);
    const version = await executePsql({
      containerId,
      credential: provisioner,
      databaseName: "postgres",
      sql: "SELECT current_setting('server_version_num');",
      columns: ["serverVersionNum"]
    });
    const serverVersionNum = version.rows[0]?.serverVersionNum;
    assert.match(serverVersionNum, /^17[0-9]{4}$/);

    const target = {
      policyId: policy.policyId,
      environment: "local-controlled",
      host: "127.0.0.1",
      clusterMarker: "subscription-s1-controlled/v1",
      clusterFingerprint: sha256Canonical({
        containerId,
        imageDigest: imageContract.resolvedDigest,
        serverVersionNum
      }),
      imageDigest: imageContract.resolvedDigest,
      serverVersionNum
    };
    const credentials = new Map();
    const secretStore = {
      async create({ profile, databaseName, username }) {
        const secret = {
          host: "127.0.0.1",
          port,
          database: databaseName,
          username,
          password: randomBytes(32).toString("hex"),
          tlsMode: "disable"
        };
        const secretPath = path.join(taskDirectory, "secrets", databaseName, `${profile}.json`);
        await mkdir(path.dirname(secretPath), { recursive: true });
        await writeFile(secretPath, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
        await hardenOwnerOnlyFile(secretPath);
        credentials.set(`${databaseName}:${profile}`, secret);
        return {
          ...secret,
          reference: path.relative(repoRoot, secretPath).replaceAll("\\", "/")
        };
      }
    };
    const executeAdmin = ({ databaseName, sql }) =>
      executePsql({
        containerId,
        credential: provisioner,
        databaseName,
        sql,
        columns: sql.includes("AS oid") ? ["oid", "marker"] : []
      });

    provisioned.push(
      ...(await Promise.all(
        [0, 1].map((shard) =>
          provisionSuiteDatabase({
            target,
            policy,
            runId,
            suiteId: "database-lifecycle",
            shard,
            executeAdmin,
            secretStore
          })
        )
      ))
    );
    assert.equal(new Set(provisioned.map((record) => record.databaseName)).size, 2);

    await Promise.all(
      provisioned.map((record) => runMigration(credentials.get(`${record.databaseName}:migrate`)))
    );
    await Promise.all(
      provisioned.map((record) =>
        grantRuntimeEquivalentAccess({
          databaseName: record.databaseName,
          migrationRole: record.roles.migrate,
          runtimeRole: record.roles["runtime-test"],
          executeDatabase: ({ databaseName, sql }) =>
            executePsql({
              containerId,
              credential: credentials.get(`${databaseName}:migrate`),
              databaseName,
              sql
            })
        })
      )
    );

    for (const record of provisioned) {
      const runtime = credentials.get(`${record.databaseName}:runtime-test`);
      const role = await executePsql({
        containerId,
        credential: runtime,
        databaseName: record.databaseName,
        sql: [
          "SELECT rolsuper::text, rolcreatedb::text, rolcreaterole::text,",
          "       rolbypassrls::text, rolcanlogin::text",
          "FROM pg_roles WHERE rolname = current_user;"
        ].join(" "),
        columns: ["super", "createdb", "createrole", "bypassrls", "login"]
      });
      assert.deepEqual(role.rows[0], {
        super: "false",
        createdb: "false",
        createrole: "false",
        bypassrls: "false",
        login: "true"
      });
      const ownership = await executePsql({
        containerId,
        credential: runtime,
        databaseName: record.databaseName,
        sql: [
          "SELECT pg_get_userbyid(n.nspowner) AS schema_owner,",
          "       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') AS migration_owner,",
          "       has_schema_privilege(current_user, 'public', 'CREATE')::text AS can_create,",
          "       (SELECT COUNT(*)::text FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS memberships,",
          "       (SELECT COUNT(*)::text FROM public._prisma_migrations) AS migration_count",
          "FROM pg_namespace AS n WHERE n.nspname = 'public';"
        ].join(" "),
        columns: ["schemaOwner", "migrationOwner", "canCreate", "memberships", "migrationCount"]
      });
      assert.equal(ownership.rows[0]?.schemaOwner, record.roles.migrate);
      assert.equal(ownership.rows[0]?.migrationOwner, record.roles.migrate);
      assert.equal(ownership.rows[0]?.canCreate, "false");
      assert.equal(ownership.rows[0]?.memberships, "0");
      assert.equal(Number(ownership.rows[0]?.migrationCount), 126);
      await assert.rejects(
        executePsql({
          containerId,
          credential: runtime,
          databaseName: record.databaseName,
          sql: 'CREATE TABLE "runtime_must_not_create" ("id" integer);'
        }),
        { code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED" }
      );
    }

    await assert.rejects(
      cleanupSuiteDatabase(
        { ...provisioned[0], databaseName: `${provisioned[0].databaseName}_forged` },
        { target, policy, executeAdmin }
      ),
      { code: "CLEANUP_IDENTITY_MISMATCH" }
    );
    await assert.rejects(
      cleanupSuiteDatabase(
        { ...provisioned[0], marker: "forged" },
        { target, policy, executeAdmin }
      ),
      { code: "CLEANUP_IDENTITY_MISMATCH" }
    );

    const interruptedRecord = provisioned.shift();
    const siblingRecord = provisioned[0];
    await cleanupSuiteDatabase(interruptedRecord, { target, policy, executeAdmin });
    const interruptedResidue = await executePsql({
      containerId,
      credential: provisioner,
      databaseName: "postgres",
      sql: `SELECT COUNT(*)::text FROM pg_database WHERE datname = '${interruptedRecord.databaseName}';`,
      columns: ["count"]
    });
    assert.equal(interruptedResidue.rows[0]?.count, "0");
    const sibling = await executePsql({
      containerId,
      credential: credentials.get(`${siblingRecord.databaseName}:runtime-test`),
      databaseName: siblingRecord.databaseName,
      sql: "SELECT current_database() AS database_name;",
      columns: ["databaseName"]
    });
    assert.equal(sibling.rows[0]?.databaseName, siblingRecord.databaseName);

    for (const record of provisioned) {
      await cleanupSuiteDatabase(record, { target, policy, executeAdmin });
    }
    provisioned.length = 0;
    const residue = await executePsql({
      containerId,
      credential: provisioner,
      databaseName: "postgres",
      sql: "SELECT COUNT(*)::text FROM pg_database WHERE datname LIKE 's1ci\\_%' ESCAPE '\\';",
      columns: ["count"]
    });
    assert.equal(residue.rows[0]?.count, "0");
  } finally {
    await rm(passwordPath, { force: true });
    if (containerId) {
      await assertExactContainer(containerId, runId, image);
      await executeDockerCommand({ args: ["rm", "--force", containerId] });
    }
    await rm(taskDirectory, { recursive: true, force: true });
  }
}

test(
  "provisions, migrates, isolates, and exactly cleans concurrent PostgreSQL databases",
  {
    timeout: 600_000
  },
  async () => {
    await runDatabaseLifecyclePostgresContract();
  }
);

test("uses the platform package-manager entrypoint for lifecycle migrations", () => {
  assert.deepEqual(migrationPackageManagerCommand("linux", "/opt/node/bin/node"), {
    executable: "pnpm",
    arguments: [
      "--filter",
      "@subscription-saas/api",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ]
  });
  assert.deepEqual(migrationPackageManagerCommand("win32", "C:\\node\\node.exe"), {
    executable: "C:\\node\\node.exe",
    arguments: [
      "C:\\node\\node_modules\\corepack\\dist\\pnpm.js",
      "--filter",
      "@subscription-saas/api",
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ]
  });
});
