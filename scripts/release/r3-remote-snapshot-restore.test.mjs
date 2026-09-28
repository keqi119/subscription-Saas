import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { verifyOwnershipMap } from "../../packages/release-foundation/src/snapshot/normalize-ownership.mjs";
import { restoreR3SnapshotDatabase } from "./r3-remote-snapshot-restore.mjs";

const operationRef = "11111111-2222-4333-8444-555555555555";
const containerId = "a".repeat(64);
const engineId = "local77845847-6e93-43a1-a04a-72c4d89085b3";
const containerAddress = "172.19.0.2";
const databaseName = `s1ci_${"b".repeat(24)}`;
const suffix = databaseName.slice(5);
const migrate = `s1m_${"c".repeat(24)}`;
const runtime = `s1r_${"d".repeat(24)}`;
const restore = `s1x_${"e".repeat(24)}`;
const directory = `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}-restore-${suffix}`;
const copiedPath = `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}/snapshot.dump`;
const password1 = "1".repeat(64),
  password2 = "2".repeat(64);
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const encode = (value) => Buffer.from(JSON.stringify(value));
function frame(stdout = "", stderr = "") {
  const parts = [];
  for (const [channel, value] of [
    [1, stdout],
    [2, stderr]
  ]) {
    if (!value) continue;
    const body = Buffer.from(value),
      header = Buffer.alloc(8);
    header[0] = channel;
    header.writeUInt32BE(body.length, 4);
    parts.push(header, body);
  }
  return Buffer.concat(parts);
}
const ownershipMap = {
  schemaVersion: "ownership-map.v1",
  mapId: "stage1-snapshot-owner-map",
  mapVersion: "1",
  sourceOwners: ["subscription", "subscription_saas"],
  targetOwnerProfile: "migrate",
  schemas: ["public"],
  objectClasses: [
    "function",
    "materialized-view",
    "partitioned-table",
    "schema",
    "sequence",
    "table",
    "type",
    "view"
  ],
  excludedExtensions: ["btree_gist", "pgcrypto", "plpgsql"]
};

function fixture({
  wrongSystem = false,
  failRestore = false,
  badCopy = false,
  networkDenial = false,
  extraSchema = false
} = {}) {
  const target = {
    databaseName,
    databaseOid: "17001",
    marker: "fixture-r3-marker",
    owner: migrate,
    schemaOwner: migrate,
    roles: { migrate, "runtime-test": runtime, restore },
    roleReadback: { restore: { oid: "17003" }, migrate: { oid: "17002" } },
    databaseIdentityDigest: sha256Canonical({
      kind: "r3-database-target",
      engineId,
      systemIdentifier: "7340000000000000001",
      databaseOid: "17001",
      marker: "fixture-r3-marker"
    })
  };
  const postgres = {
    engineId,
    containerId,
    containerAddress,
    postgres: { systemIdentifier: "7340000000000000001", serverVersionNum: 170011 }
  };
  let copiedChecks = 0,
    grant = false,
    disabled = false,
    passwordNull = false,
    dir = false,
    execution,
    nextExec = 1,
    restoreCalls = 0;
  const files = new Map(),
    events = [],
    stages = [];
  const copied = {
    facts: { containerId, path: copiedPath, snapshotDigest: digest("dump"), plaintextSizeBytes: 4 },
    async recheck() {
      copiedChecks++;
      if (badCopy) throw Error("copy changed");
    }
  };
  const credential = (username, password) => ({
    username,
    password,
    host: "127.0.0.1",
    port: 55441,
    database: databaseName,
    tlsMode: "require"
  });
  const roleState = (name) => ({
    name,
    oid: name === restore ? "17003" : "17002",
    canLogin: name === restore ? !disabled : true,
    superuser: false,
    createdb: false,
    createrole: false,
    inherit: false,
    replication: false,
    bypassrls: false,
    memberships: name === restore && grant ? 1 : 0,
    grantedTo: 0,
    canConnect: name === restore ? !disabled : true,
    canCreateDatabase: name === migrate,
    canCreateTemporary: name === migrate,
    passwordNull: name === restore ? passwordNull : false,
    membership:
      name === restore && grant ? { role: migrate, inherit: false, set: true, admin: false } : null
  });
  const identity = {
    systemIdentifier: wrongSystem ? "7340000000000000002" : postgres.postgres.systemIdentifier,
    serverVersionNum: 170011,
    sessionUser: "release_provisioner",
    currentUser: "release_provisioner",
    serverAddress: containerAddress,
    tls: true,
    databaseName,
    databaseOid: target.databaseOid,
    marker: target.marker,
    owner: migrate
  };
  const connected = (role) => ({
    databaseName,
    role,
    databaseOid: target.databaseOid,
    marker: target.marker,
    owner: migrate,
    serverVersionNum: 170011,
    tls: true
  });
  const inventory = [
    {
      objectClass: "schema",
      schemaName: "public",
      objectName: "public",
      owner: migrate,
      extensionName: null
    },
    {
      objectClass: "table",
      schemaName: "public",
      objectName: "_prisma_migrations",
      owner: migrate,
      extensionName: null
    }
  ];
  function execute(command) {
    const [program, ...args] = command.Cmd;
    if (program === "/usr/bin/mkdir") {
      assert.deepEqual(args, ["-m", "0700", "--", directory]);
      if (dir) return { exit: 1 };
      dir = true;
      return {};
    }
    if (program === "/usr/bin/stat") {
      const item = args.at(-1),
        isDir = item === directory;
      if (isDir && dir)
        return {
          stdout:
            "directory|700|0|0|4096|42|99|2|2026-09-29 00:00:00.000000000 +0000|2026-09-29 00:00:00.000000000 +0000\n"
        };
      if (files.has(item))
        return {
          stdout: `regular file|600|0|0|${files.get(item).length}|42|${item.includes("migration") ? 101 : 100}|1|2026-09-29 00:00:00.000000000 +0000|2026-09-29 00:00:00.000000000 +0000\n`
        };
      return { exit: 1, stderr: `stat: cannot statx '${item}': No such file or directory\n` };
    }
    if (program === "/usr/bin/rm") {
      const item = args.at(-1);
      assert.ok(files.has(item));
      files.delete(item);
      return {};
    }
    if (program === "/usr/bin/rmdir") {
      assert.deepEqual(args, ["--", directory]);
      if (files.size) return { exit: 1 };
      dir = false;
      return {};
    }
    if (program === "/usr/bin/pg_restore") {
      restoreCalls++;
      assert.ok(command.Env.some((item) => item.startsWith("PGPASSFILE=")));
      assert.ok(command.Env.includes("LC_ALL=C"));
      assert.ok(args.includes(`--role=${migrate}`));
      assert.ok(args.includes(copiedPath));
      return failRestore ? { exit: 1, stderr: "pg_restore: error: fixture failure\n" } : {};
    }
    const sql = command.Cmd.at(-1);
    if (program !== "/bin/bash" && program !== "/usr/bin/psql") throw Error("unexpected command");
    if (sql.includes("/*r3:target*/")) {
      assert.ok(sql.includes("current_setting('server_version_num')::int"));
      return { stdout: `${JSON.stringify(identity)}\n` };
    }
    if (sql.includes("/*r3:role-restore*/"))
      return { stdout: `${JSON.stringify(roleState(restore))}\n` };
    if (sql.includes("/*r3:role-migrate*/"))
      return { stdout: `${JSON.stringify(roleState(migrate))}\n` };
    if (sql.includes("/*r3:schema*/"))
      return { stdout: `${JSON.stringify({ schemaOwner: migrate, restoreCanCreate: false })}\n` };
    if (sql.includes("/*r3:grant*/")) {
      grant = true;
      return {};
    }
    if (sql.includes("/*r3:revoke*/")) {
      grant = false;
      disabled = true;
      passwordNull = true;
      return {};
    }
    if (sql.includes("/*r3:connected-restore*/")) {
      assert.ok(sql.includes("current_setting('server_version_num')::int"));
      if (disabled)
        return {
          exit: 2,
          stderr: networkDenial
            ? `psql: error: connection to server at "${containerAddress}", port 5432 failed: Connection refused\n`
            : `psql: error: connection to server at "${containerAddress}", port 5432 failed: FATAL:  password authentication failed for user "${restore}"\n`
        };
      return { stdout: `${JSON.stringify(connected(restore))}\n` };
    }
    if (sql.includes("/*r3:connected-migrate*/")) {
      assert.ok(sql.includes("current_setting('server_version_num')::int"));
      return { stdout: `${JSON.stringify(connected(migrate))}\n` };
    }
    if (sql.includes("/*r3:inventory*/")) {
      const schemaBranch = sql.slice(0, sql.indexOf("UNION ALL"));
      const visible =
        extraSchema && !schemaBranch.includes("n.nspname='public'")
          ? [
              ...inventory,
              {
                objectClass: "schema",
                schemaName: "extra",
                objectName: "extra",
                owner: migrate,
                extensionName: null
              }
            ]
          : inventory;
      return { stdout: `${JSON.stringify(visible)}\n` };
    }
    throw Error("unexpected SQL");
  }
  const engineCall = async (method, url, value, status, options) => {
    events.push({ method, url, value, status, options });
    if (method === "POST" && url === `/containers/${containerId}/exec`) {
      assert.equal(status, 201);
      assert.equal(value.User, "0");
      assert.equal(value.Tty, false);
      assert.equal(JSON.stringify(value).includes(password1), false);
      assert.equal(JSON.stringify(value).includes(password2), false);
      execution = { id: (nextExec++).toString(16).padStart(64, "0"), command: value };
      return encode({ Id: execution.id });
    }
    if (method === "POST" && url === `/exec/${execution.id}/start`) {
      if (execution.command.Cmd[0] === "/usr/bin/pg_restore") assert.equal(options.timeout, 120000);
      const result = execute(execution.command);
      execution.exit = result.exit ?? 0;
      return frame(result.stdout, result.stderr);
    }
    if (method === "GET" && url === `/exec/${execution.id}/json`)
      return encode({
        ID: execution.id,
        ContainerID: containerId,
        Running: false,
        ExitCode: execution.exit
      });
    if (
      method === "PUT" &&
      url === `/containers/${containerId}/archive?path=${encodeURIComponent(directory)}`
    ) {
      assert.equal(options.contentType, "application/x-tar");
      const name = value.subarray(0, 100).toString("ascii").split("\0")[0];
      const length = Number.parseInt(value.subarray(124, 136).toString("ascii"), 8);
      assert.ok(["restore.pgpass", "migration.pgpass"].includes(name));
      assert.equal(value.subarray(100, 108).toString("ascii"), "0000600\0");
      files.set(`${directory}/${name}`, Buffer.from(value.subarray(512, 512 + length)));
      return Buffer.alloc(0);
    }
    throw Error(`unexpected Engine call ${method} ${url}`);
  };
  return {
    operationRef,
    postgres,
    target,
    copied,
    ownershipMap,
    restoreCredential: credential(restore, password1),
    migrationCredential: credential(migrate, password2),
    engineCall,
    recheck: async () => {},
    transition(stage) {
      stages.push(stage);
    },
    signal: new AbortController().signal,
    events,
    stages,
    get copiedChecks() {
      return copiedChecks;
    },
    get restoreCalls() {
      return restoreCalls;
    },
    get disabled() {
      return disabled;
    },
    get files() {
      return files;
    },
    get dir() {
      return dir;
    }
  };
}

test("restores through the dedicated role, proves ownership and revocation, then cleans owned files", async () => {
  const f = fixture();
  let result;
  try {
    result = await restoreR3SnapshotDatabase(f);
  } catch {
    assert.fail(
      `stages=${f.stages.join(",")} restoreCalls=${f.restoreCalls} copiedChecks=${f.copiedChecks} dir=${f.dir} files=${f.files.size}`
    );
  }
  assert.equal(result.facts.databaseName, databaseName);
  assert.equal(result.facts.databaseOid, f.target.databaseOid);
  assert.equal(result.observations.restoreExecution.containerId, containerId);
  assert.equal(result.observations.restoreExecution.running, false);
  assert.equal(result.observations.restoreExecution.command[0], "/usr/bin/pg_restore");
  assert.equal(result.observations.restoreExecution.command.at(-1), f.copied.facts.path);
  assert.deepEqual(
    verifyOwnershipMap({
      ownershipMap: f.ownershipMap,
      target: {
        databaseIdentityDigest: f.target.databaseIdentityDigest,
        migrationRole: f.target.roles.migrate,
        runtimeRole: f.target.roles["runtime-test"]
      },
      inventory: result.observations.ownershipInventories.after,
      now: new Date(result.observations.ownershipObservation.observedAt)
    }),
    result.observations.ownershipObservation
  );
  assert.deepEqual(
    result.observations.ownershipInventories.before,
    result.observations.ownershipInventories.after
  );
  assert.ok(Object.isFrozen(result.observations.ownershipInventories.after.objects));
  assert.deepEqual(f.stages, ["GRANTING", "GRANTED", "REVOKING", "REVOKED"]);
  assert.equal(f.restoreCalls, 1);
  assert.ok(f.copiedChecks >= 2);
  assert.equal(f.disabled, true);
  assert.equal(f.dir, false);
  assert.equal(f.files.size, 0);
  assert.equal(JSON.stringify(result).includes(password1), false);
  assert.equal(JSON.stringify(result).includes(password2), false);
  assert.ok(
    f.events
      .filter((event) => event.method === "PUT")
      .every((event) => event.value.every((byte) => byte === 0))
  );
});

test("copy or target identity mismatch cannot launch pg_restore", async () => {
  for (const option of [{ badCopy: true }, { wrongSystem: true }]) {
    const f = fixture(option);
    await assert.rejects(restoreR3SnapshotDatabase(f), {
      code: "R3_REMOTE_SNAPSHOT_RESTORE_UNAVAILABLE"
    });
    assert.equal(f.restoreCalls, 0);
    assert.deepEqual(f.stages, []);
  }
});

test("a failed pg_restore still revokes capability and removes owned credential files", async () => {
  const f = fixture({ failRestore: true });
  await assert.rejects(restoreR3SnapshotDatabase(f), {
    code: "R3_REMOTE_SNAPSHOT_RESTORE_UNAVAILABLE"
  });
  assert.equal(f.restoreCalls, 1);
  assert.deepEqual(f.stages, ["GRANTING", "GRANTED", "REVOKING", "REVOKED"]);
  assert.equal(f.disabled, true);
  assert.equal(f.dir, false);
  assert.equal(f.files.size, 0);
});

test("a network failure is not proof that restore login was revoked", async () => {
  const f = fixture({ networkDenial: true });
  await assert.rejects(restoreR3SnapshotDatabase(f), {
    code: "R3_REMOTE_SNAPSHOT_RESTORE_UNAVAILABLE"
  });
  assert.deepEqual(f.stages, ["GRANTING", "GRANTED", "REVOKING", "REVOKED"]);
  assert.equal(f.disabled, true);
  assert.equal(f.dir, false);
});

test("an extra user schema rejects ownership after restore and still revokes and cleans", async () => {
  const f = fixture({ extraSchema: true });
  await assert.rejects(restoreR3SnapshotDatabase(f), {
    code: "R3_REMOTE_SNAPSHOT_RESTORE_UNAVAILABLE"
  });
  assert.equal(f.restoreCalls, 1);
  assert.deepEqual(f.stages, ["GRANTING", "GRANTED", "REVOKING", "REVOKED"]);
  assert.equal(f.disabled, true);
  assert.equal(f.dir, false);
  assert.equal(f.files.size, 0);
});
