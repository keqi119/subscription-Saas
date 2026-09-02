import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapControlledPostgres,
  pullExactPostgresImage
} from "./bootstrap-controlled-postgres.mjs";
import { runWithControlledTarget } from "./with-controlled-target.mjs";

function controlledTargetRecord() {
  return {
    recordVersion: "controlled-target-record.v1",
    sourceSha: "6d1a489c4081ec8ac2e2ed8e77d8683889811aad",
    image: {
      repository: "postgres",
      resolvedDigest: `sha256:${"1".repeat(64)}`,
      platform: "linux/amd64"
    },
    container: {
      id: "controlled-container-id",
      markerLabel: "subscription-s1-controlled/v1",
      runId: "7b109876-9b02-49cc-a827-e150523e59b4"
    },
    cluster: {
      fingerprint: "postgres-17:controlled-container-id",
      serverVersionNum: "170000",
      tlsMode: "disable"
    },
    database: {
      name: "s1dev_1234567890abcdef12345678",
      oid: "43",
      marker: "subscription-s1-controlled/7b109876-9b02-49cc-a827-e150523e59b4",
      migrationHead: null
    },
    roles: {
      bootstrap: "s1_bootstrap_12345678",
      migrate: "s1_migrate_12345678",
      verify: "s1_verify_12345678",
      "runtime-test": "s1_runtime_test_12345678"
    },
    secretFiles: {
      bootstrap: ".release-local/secrets/bootstrap.json",
      migrate: ".release-local/secrets/migrate.json",
      verify: ".release-local/secrets/verify.json",
      "runtime-test": ".release-local/secrets/runtime-test.json"
    }
  };
}

test("retries only the pre-state digest-pinned PostgreSQL pull", async () => {
  const image = `docker.io/library/postgres@sha256:${"1".repeat(64)}`;
  const calls = [];
  const waits = [];
  await pullExactPostgresImage({
    image,
    executeDocker: async (input) => {
      calls.push(input);
      if (calls.length < 3) {
        throw Object.assign(new Error("transient pull failure"), {
          code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED"
        });
      }
      return "pulled";
    },
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  assert.deepEqual(
    calls.map(({ purpose, args }) => ({ purpose, args })),
    Array.from({ length: 3 }, () => ({
      purpose: "pull",
      args: ["pull", "--platform", "linux/amd64", image]
    }))
  );
  assert.deepEqual(waits, [1000, 2000]);

  let nonPullAttempts = 0;
  await assert.rejects(
    pullExactPostgresImage({
      image,
      executeDocker: async () => {
        nonPullAttempts += 1;
        throw Object.assign(new Error("policy failure"), { code: "IMAGE_POLICY_REJECTED" });
      },
      wait: async () => {
        throw new Error("must not wait for a non-pull failure");
      }
    }),
    { code: "IMAGE_POLICY_REJECTED" }
  );
  assert.equal(nonPullAttempts, 1);

  let exhaustedAttempts = 0;
  const exhaustedWaits = [];
  await assert.rejects(
    pullExactPostgresImage({
      image,
      executeDocker: async () => {
        exhaustedAttempts += 1;
        throw Object.assign(new Error("persistent pull failure"), {
          code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED"
        });
      },
      wait: async (milliseconds) => exhaustedWaits.push(milliseconds)
    }),
    { code: "CONTROLLED_TARGET_DOCKER_COMMAND_FAILED" }
  );
  assert.equal(exhaustedAttempts, 3);
  assert.deepEqual(exhaustedWaits, [1000, 2000]);
});

function matchingInspection(record, profile = "verify") {
  return {
    containerId: record.container.id,
    imageDigest: record.image.resolvedDigest,
    markerLabel: record.container.markerLabel,
    databaseMarker: record.database.marker,
    databaseName: record.database.name,
    databaseOid: record.database.oid,
    host: "127.0.0.1",
    port: 55432,
    serverVersionNum: record.cluster.serverVersionNum,
    roleName: record.roles[profile],
    tlsMode: record.cluster.tlsMode
  };
}

async function assertOwnerOnlyFile(filePath) {
  if (process.platform === "win32") {
    const acl = spawnSync("icacls", [filePath], { encoding: "utf8" });
    assert.equal(acl.status, 0);
    assert.doesNotMatch(acl.stdout, /Authenticated Users|BUILTIN\\Users/i);
    assert.match(
      acl.stdout,
      new RegExp(`${process.env.USERDOMAIN}\\\\${process.env.USERNAME}`, "i")
    );
    return;
  }
  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o077, 0);
}

test("refuses ambient DATABASE_URL before Docker access", async () => {
  const calls = [];
  const docker = {
    async createExactTarget(input) {
      calls.push(input);
      throw new Error("Docker must not be called");
    }
  };

  await assert.rejects(
    () =>
      bootstrapControlledPostgres({
        environment: { DATABASE_URL: "postgres://ambient" },
        docker
      }),
    { code: "AMBIENT_DATABASE_URL_FORBIDDEN" }
  );
  assert.equal(calls.length, 0);
});

test("refuses a target record whose database oid changed", async () => {
  const record = controlledTargetRecord();

  await assert.rejects(
    () =>
      runWithControlledTarget({
        record,
        profile: "verify",
        command: ["node", "--version"],
        docker: {
          async inspectExactTarget() {
            return {
              containerId: record.container.id,
              imageDigest: record.image.resolvedDigest,
              markerLabel: record.container.markerLabel,
              databaseMarker: record.database.marker,
              databaseName: record.database.name,
              databaseOid: "44",
              serverVersionNum: record.cluster.serverVersionNum,
              roleName: record.roles.verify
            };
          }
        },
        readSecretFile: async () => ({
          host: "127.0.0.1",
          port: 5432,
          username: record.roles.verify,
          password: "not-printed"
        }),
        spawnChild: async () => 0
      }),
    { code: "CONTROLLED_TARGET_IDENTITY_MISMATCH" }
  );
});

test("refuses a tag-only PostgreSQL image contract before Docker access", async () => {
  const calls = [];

  await assert.rejects(
    () =>
      bootstrapControlledPostgres({
        environment: {},
        imageContract: {
          repository: "docker.io/library/postgres",
          tag: "17-bookworm",
          platform: "linux/amd64",
          serverVersionMajor: 17
        },
        docker: {
          async createExactTarget(input) {
            calls.push(input);
          }
        }
      }),
    { code: "POSTGRES_IMAGE_DIGEST_REQUIRED" }
  );
  assert.equal(calls.length, 0);
});

test("spawns the command with only the controlled database URL", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-controlled-target-"));
  try {
    const record = controlledTargetRecord();
    const secretPath = path.join(repoRoot, record.secretFiles.verify);
    const observationPath = path.join(repoRoot, "child-environment.json");
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(
      secretPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 55432,
        username: record.roles.verify,
        password: "p@ss word",
        database: record.database.name,
        tlsMode: "disable"
      }),
      { mode: 0o600 }
    );

    const exitCode = await runWithControlledTarget({
      repoRoot,
      record,
      profile: "verify",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({databaseUrl:process.env.DATABASE_URL,source:process.env.STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL,target:process.env.STAGE1_ACCEPTANCE_TARGET_DATABASE_URL,skipDotenv:process.env.STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV}))",
        observationPath
      ],
      environment: {
        PATH: process.env.PATH,
        DATABASE_URL: "postgresql://ambient/production",
        STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL: "postgresql://ambient/source",
        STAGE1_ACCEPTANCE_TARGET_DATABASE_URL: "postgresql://ambient/target"
      },
      docker: {
        async inspectExactTarget() {
          return matchingInspection(record);
        }
      }
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(observationPath, "utf8")), {
      databaseUrl:
        "postgresql://s1_verify_12345678:p%40ss%20word@127.0.0.1:55432/s1dev_1234567890abcdef12345678?sslmode=disable",
      skipDotenv: "1"
    });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("persists a non-secret controlled target record under the requested output directory", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-bootstrap-output-"));
  try {
    if (process.platform === "win32") {
      const broadenAcl = spawnSync("icacls", [repoRoot, "/grant", "*S-1-5-11:(OI)(CI)(RX)"], {
        encoding: "utf8"
      });
      assert.equal(broadenAcl.status, 0);
    }
    const resolvedDigest = `sha256:${"1".repeat(64)}`;
    const result = await bootstrapControlledPostgres({
      environment: {},
      repoRoot,
      sourceSha: "6d1a489c4081ec8ac2e2ed8e77d8683889811aad",
      outputDirectory: path.join(repoRoot, ".release-local"),
      imageContract: {
        repository: "docker.io/library/postgres",
        resolvedDigest,
        platform: "linux/amd64",
        serverVersionMajor: 17
      },
      docker: {
        async createExactTarget({ databaseName, runId }) {
          return {
            containerId: "controlled-container-id",
            actualImageDigest: resolvedDigest,
            databaseName,
            databaseOid: "43",
            databaseMarker: `subscription-s1-controlled/${runId}`,
            host: "127.0.0.1",
            port: 55432,
            serverVersionNum: "170011",
            tlsMode: "disable"
          };
        }
      }
    });

    const persisted = JSON.parse(
      await readFile(path.join(repoRoot, ".release-local", "controlled-target.v1.json"), "utf8")
    );
    assert.deepEqual(result, persisted);
    assert.equal(persisted.sourceSha, "6d1a489c4081ec8ac2e2ed8e77d8683889811aad");
    assert.equal(persisted.image.resolvedDigest, resolvedDigest);
    assert.equal(persisted.database.oid, "43");
    assert.equal(persisted.database.migrationHead, null);
    assert.equal(persisted.container.markerLabel, "subscription-s1-controlled/v1");
    const secrets = await Promise.all(
      Object.values(persisted.secretFiles).map(async (relativeSecretPath) =>
        JSON.parse(await readFile(path.join(repoRoot, relativeSecretPath), "utf8"))
      )
    );
    assert.equal(new Set(secrets.map((secret) => secret.username)).size, 4);
    assert.equal(new Set(secrets.map((secret) => secret.password)).size, 4);
    assert.ok(secrets.every((secret) => secret.database === persisted.database.name));
    for (const relativeSecretPath of Object.values(persisted.secretFiles)) {
      await assertOwnerOnlyFile(path.join(repoRoot, relativeSecretPath));
    }
    assert.doesNotMatch(JSON.stringify(persisted), /password|postgresql:\/\//i);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("cleanup refuses a database prefix and never calls Docker", async () => {
  const { cleanupControlledPostgres } = await import("./bootstrap-controlled-postgres.mjs");
  const record = controlledTargetRecord();
  record.database.name = "s1dev_";
  const calls = [];

  await assert.rejects(
    () =>
      cleanupControlledPostgres({
        record,
        docker: {
          async removeExactTarget(input) {
            calls.push(input);
          }
        }
      }),
    { code: "CONTROLLED_TARGET_CLEANUP_SCOPE_INVALID" }
  );
  assert.equal(calls.length, 0);
});

test("Docker adapter starts the exact digest without putting credentials in arguments", async () => {
  const { createDockerCli } = await import("./bootstrap-controlled-postgres.mjs");
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "s1-docker-adapter-"));
  const digest = `sha256:${"2".repeat(64)}`;
  const runId = "67f98944-6ef5-44a9-91f3-cb50f3c03438";
  const marker = `subscription-s1-controlled/${runId}`;
  const calls = [];
  const executeDocker = async ({ args, environment, input, purpose }) => {
    calls.push({ args, environment, input, purpose });
    if (purpose === "pull") return "pulled exact digest\n";
    if (args[0] === "image" && args[1] === "inspect") {
      return `${JSON.stringify([`docker.io/library/postgres@${digest}`])}\n`;
    }
    if (args[0] === "run") return `${"a".repeat(64)}\n`;
    if (args[0] === "port") return "127.0.0.1:55432\n";
    if (args.includes("pg_isready")) return "accepting connections\n";
    if (purpose === "setup") return "";
    if (purpose === "identity") return `43\t${marker}\t170011\n`;
    if (purpose === "bootstrap-disable") return "";
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  try {
    const adapter = createDockerCli({ executeDocker });
    const target = await adapter.createExactTarget({
      image: `docker.io/library/postgres@${digest}`,
      databaseName: "s1dev_1234567890abcdef12345678",
      runId,
      outputDirectory,
      credentials: {
        bootstrap: { username: "s1_bootstrap_12345678", password: "bootstrap-secret" },
        migrate: { username: "s1_migrate_12345678", password: "migrate-secret" },
        verify: { username: "s1_verify_12345678", password: "verify-secret" },
        "runtime-test": {
          username: "s1_runtime_test_12345678",
          password: "runtime-secret"
        }
      }
    });

    assert.equal(target.actualImageDigest, digest);
    assert.equal(target.databaseOid, "43");
    assert.equal(target.serverVersionNum, "170011");
    assert.equal(target.port, 55432);
    const runCall = calls.find(({ args }) => args[0] === "run");
    const pullCall = calls.find(({ purpose }) => purpose === "pull");
    assert.deepEqual(pullCall.args, [
      "pull",
      "--platform",
      "linux/amd64",
      `docker.io/library/postgres@${digest}`
    ]);
    assert.ok(runCall.args.includes(`docker.io/library/postgres@${digest}`));
    assert.doesNotMatch(
      runCall.args.join(" "),
      /bootstrap-secret|migrate-secret|verify-secret|runtime-secret/
    );
    assert.equal(runCall.environment?.PGPASSWORD, undefined);
    const setupCall = calls.find(({ purpose }) => purpose === "setup");
    assert.equal(setupCall.environment.PGPASSWORD, "bootstrap-secret");
    assert.match(setupCall.input, /CREATE ROLE "s1_migrate_12345678"/);
    assert.match(setupCall.input, /COMMENT ON DATABASE "s1dev_1234567890abcdef12345678"/);
    const identityCall = calls.find(({ purpose }) => purpose === "identity");
    assert.equal(identityCall.environment.PGPASSWORD, "migrate-secret");
    assert.ok(identityCall.args.includes("s1_migrate_12345678"));
    assert.ok(identityCall.args.includes("s1dev_1234567890abcdef12345678"));
    const disableCall = calls.find(({ purpose }) => purpose === "bootstrap-disable");
    assert.equal(disableCall.environment.PGPASSWORD, "bootstrap-secret");
    assert.match(disableCall.args.join(" "), /ALTER ROLE "s1_bootstrap_12345678" NOLOGIN/);
    await assert.rejects(() => readFile(path.join(outputDirectory, "bootstrap-password")), {
      code: "ENOENT"
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("Docker adapter re-reads the exact container, image, database marker, oid, version, and role", async () => {
  const { createDockerCli } = await import("./bootstrap-controlled-postgres.mjs");
  const record = controlledTargetRecord();
  const calls = [];
  const executeDocker = async ({ args, purpose }) => {
    calls.push({ args, purpose });
    if (purpose === "container-inspect") {
      return `${JSON.stringify([
        {
          Id: record.container.id,
          Config: {
            Image: `${record.image.repository}@${record.image.resolvedDigest}`,
            Labels: {
              "subscription-s1-controlled": "v1",
              "subscription-s1-controlled.run-id": record.container.runId
            }
          }
        }
      ])}\n`;
    }
    if (purpose === "image-inspect") {
      return `${JSON.stringify([`${record.image.repository}@${record.image.resolvedDigest}`])}\n`;
    }
    if (purpose === "port") return "127.0.0.1:55432\n";
    if (purpose === "profile-identity") {
      return [
        record.database.oid,
        record.database.marker,
        record.cluster.serverVersionNum,
        record.roles.verify,
        record.database.name
      ].join("\t");
    }
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  const actual = await createDockerCli({ executeDocker }).inspectExactTarget({
    record,
    profile: "verify",
    secret: {
      username: record.roles.verify,
      password: "verify-secret",
      database: record.database.name
    }
  });

  assert.deepEqual(actual, matchingInspection(record));
  const identityCall = calls.find(({ purpose }) => purpose === "profile-identity");
  assert.ok(identityCall.args.includes(record.container.id));
  assert.doesNotMatch(identityCall.args.join(" "), /verify-secret/);
});

test("Docker adapter refuses cleanup when the exact container marker is forged", async () => {
  const { createDockerCli } = await import("./bootstrap-controlled-postgres.mjs");
  const record = controlledTargetRecord();
  const calls = [];
  const executeDocker = async ({ args, purpose }) => {
    calls.push({ args, purpose });
    if (purpose === "container-inspect") {
      return JSON.stringify([
        {
          Id: record.container.id,
          Config: {
            Labels: {
              "subscription-s1-controlled": "forged",
              "subscription-s1-controlled.run-id": record.container.runId
            }
          }
        }
      ]);
    }
    throw new Error("remove must not be called");
  };

  await assert.rejects(
    () =>
      createDockerCli({ executeDocker }).removeExactTarget({
        containerId: record.container.id,
        databaseName: record.database.name,
        runId: record.container.runId
      }),
    { code: "CONTROLLED_TARGET_CLEANUP_IDENTITY_MISMATCH" }
  );
  assert.equal(calls.filter(({ purpose }) => purpose === "remove").length, 0);
});

test("Task 0 CLIs publish only the supported bootstrap, cleanup, and controlled-command entry points", () => {
  const bootstrapHelp = spawnSync(
    process.execPath,
    [path.resolve("scripts/release/bootstrap-controlled-postgres.mjs"), "--help"],
    { encoding: "utf8" }
  );
  const wrapperHelp = spawnSync(
    process.execPath,
    [path.resolve("scripts/release/with-controlled-target.mjs"), "--help"],
    { encoding: "utf8" }
  );

  assert.equal(bootstrapHelp.status, 0);
  assert.match(bootstrapHelp.stdout, /--output <controlled-target-record>/);
  assert.match(bootstrapHelp.stdout, /--cleanup <controlled-target-record>/);
  assert.equal(wrapperHelp.status, 0);
  assert.match(wrapperHelp.stdout, /--profile <migrate\|verify\|runtime-test>/);
  assert.match(wrapperHelp.stdout, /-- <command> \[args\.\.\.\]/);
});

test("controlled subprocess resolves the package-manager shim on the host platform", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-controlled-pnpm-"));
  try {
    const record = controlledTargetRecord();
    const secretPath = path.join(repoRoot, record.secretFiles.verify);
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(
      secretPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 55432,
        username: record.roles.verify,
        password: "not-printed",
        database: record.database.name,
        tlsMode: "disable"
      }),
      { mode: 0o600 }
    );

    const exitCode = await runWithControlledTarget({
      repoRoot,
      record,
      profile: "verify",
      command: ["pnpm", "--version"],
      docker: {
        async inspectExactTarget() {
          return matchingInspection(record);
        }
      }
    });
    assert.equal(exitCode, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("successful migration execution freezes the observed migration head in the target record", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-controlled-migration-head-"));
  try {
    const record = controlledTargetRecord();
    const recordPath = path.join(repoRoot, ".release-local", "controlled-target.v1.json");
    const secretPath = path.join(repoRoot, record.secretFiles.migrate);
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await writeFile(
      secretPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 55432,
        username: record.roles.migrate,
        password: "not-printed",
        database: record.database.name,
        tlsMode: "disable"
      }),
      { mode: 0o600 }
    );

    const exitCode = await runWithControlledTarget({
      repoRoot,
      recordPath,
      record,
      profile: "migrate",
      command: [process.execPath, "--version"],
      docker: {
        async inspectExactTarget() {
          return matchingInspection(record, "migrate");
        },
        async readMigrationHead() {
          return "20260901010000_stage1_schema_drift_convergence";
        }
      }
    });

    assert.equal(exitCode, 0);
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(
      persisted.database.migrationHead,
      "20260901010000_stage1_schema_drift_convergence"
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("bootstrap refuses to place controlled credentials outside the repository .release-local directory", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-bootstrap-scope-"));
  const calls = [];
  try {
    await assert.rejects(
      () =>
        bootstrapControlledPostgres({
          environment: {},
          repoRoot,
          sourceSha: "6d1a489c4081ec8ac2e2ed8e77d8683889811aad",
          outputDirectory: path.join(repoRoot, "other"),
          imageContract: {
            repository: "docker.io/library/postgres",
            resolvedDigest: `sha256:${"1".repeat(64)}`,
            platform: "linux/amd64",
            serverVersionMajor: 17
          },
          docker: {
            async createExactTarget(input) {
              calls.push(input);
            }
          }
        }),
      { code: "CONTROLLED_TARGET_OUTPUT_SCOPE_INVALID" }
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("wrapper refuses a secret reference outside .release-local/secrets before reading it", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-wrapper-secret-scope-"));
  const calls = [];
  try {
    const record = controlledTargetRecord();
    record.secretFiles.verify = "../outside.json";
    await assert.rejects(
      () =>
        runWithControlledTarget({
          repoRoot,
          record,
          profile: "verify",
          command: [process.execPath, "--version"],
          docker: {
            async inspectExactTarget(input) {
              calls.push(input);
            }
          }
        }),
      { code: "CONTROLLED_TARGET_SECRET_REFERENCE_INVALID" }
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

for (const [name, mutateInspection] of [
  ["image digest", (actual) => ({ ...actual, imageDigest: `sha256:${"9".repeat(64)}` })],
  ["database marker", (actual) => ({ ...actual, databaseMarker: "forged-marker" })],
  ["requested role", (actual) => ({ ...actual, roleName: "s1_verify_other" })]
]) {
  test(`wrapper refuses a changed ${name} before spawning the command`, async () => {
    const record = controlledTargetRecord();
    let spawned = false;
    await assert.rejects(
      () =>
        runWithControlledTarget({
          repoRoot: process.cwd(),
          record,
          profile: "verify",
          command: [process.execPath, "--version"],
          readSecretFile: async () => ({
            host: "127.0.0.1",
            port: 55432,
            username: record.roles.verify,
            password: "not-printed",
            database: record.database.name,
            tlsMode: "disable"
          }),
          docker: {
            async inspectExactTarget() {
              return mutateInspection(matchingInspection(record));
            }
          },
          spawnChild: async () => {
            spawned = true;
            return 0;
          }
        }),
      { code: "CONTROLLED_TARGET_IDENTITY_MISMATCH" }
    );
    assert.equal(spawned, false);
  });
}

test("wrapper refuses a missing profile secret before Docker access", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "s1-wrapper-missing-secret-"));
  const calls = [];
  try {
    const record = controlledTargetRecord();
    await assert.rejects(
      () =>
        runWithControlledTarget({
          repoRoot,
          record,
          profile: "verify",
          command: [process.execPath, "--version"],
          docker: {
            async inspectExactTarget(input) {
              calls.push(input);
            }
          }
        }),
      { code: "CONTROLLED_TARGET_SECRET_MISSING" }
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("Docker adapter removes only the container it created when bootstrap setup fails", async () => {
  const { createDockerCli } = await import("./bootstrap-controlled-postgres.mjs");
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "s1-docker-rollback-"));
  const digest = `sha256:${"3".repeat(64)}`;
  const containerId = "b".repeat(64);
  const calls = [];
  const executeDocker = async ({ args, purpose }) => {
    calls.push({ args, purpose });
    if (purpose === "pull") return "";
    if (purpose === "image-inspect") {
      return JSON.stringify([`docker.io/library/postgres@${digest}`]);
    }
    if (purpose === "run") return containerId;
    if (purpose === "readiness") return "accepting connections";
    if (purpose === "setup")
      throw Object.assign(new Error("setup failed"), { code: "SETUP_FAILED" });
    if (purpose === "bootstrap-rollback-remove") return "";
    throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
  };

  try {
    await assert.rejects(
      () =>
        createDockerCli({ executeDocker }).createExactTarget({
          image: `docker.io/library/postgres@${digest}`,
          databaseName: "s1dev_1234567890abcdef12345678",
          runId: "67f98944-6ef5-44a9-91f3-cb50f3c03438",
          outputDirectory,
          credentials: {
            bootstrap: { username: "s1_bootstrap_12345678", password: "bootstrap-secret" },
            migrate: { username: "s1_migrate_12345678", password: "migrate-secret" },
            verify: { username: "s1_verify_12345678", password: "verify-secret" },
            "runtime-test": {
              username: "s1_runtime_test_12345678",
              password: "runtime-secret"
            }
          }
        }),
      { code: "SETUP_FAILED" }
    );
    const removeCalls = calls.filter(({ purpose }) => purpose === "bootstrap-rollback-remove");
    assert.deepEqual(
      removeCalls.map(({ args }) => args),
      [["rm", "--force", containerId]]
    );
    await assert.rejects(() => readFile(path.join(outputDirectory, "bootstrap-password")), {
      code: "ENOENT"
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("wrapper refuses a secret whose host or port does not match the exact Docker target", async () => {
  const record = controlledTargetRecord();
  let spawned = false;
  await assert.rejects(
    () =>
      runWithControlledTarget({
        repoRoot: process.cwd(),
        record,
        profile: "verify",
        command: [process.execPath, "--version"],
        readSecretFile: async () => ({
          host: "203.0.113.10",
          port: 6432,
          username: record.roles.verify,
          password: "not-printed",
          database: record.database.name,
          tlsMode: "disable"
        }),
        docker: {
          async inspectExactTarget() {
            return matchingInspection(record);
          }
        },
        spawnChild: async () => {
          spawned = true;
          return 0;
        }
      }),
    { code: "CONTROLLED_TARGET_CONNECTION_IDENTITY_MISMATCH" }
  );
  assert.equal(spawned, false);
});
