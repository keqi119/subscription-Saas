import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Canonical, sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { suiteDatabaseName } from "../../packages/release-foundation/src/database-target.mjs";
import { planManualR3TargetLocks } from "../../packages/release-foundation/src/manual-r3-target-locks.mjs";
import { assessR3PostgresReadback, buildR3Destination } from "./r3-destination.mjs";
import {
  planR3DatabaseTargets,
  provisionR3DatabaseTargets,
  recheckR3DatabaseTargets
} from "./r3-database-targets.mjs";

const repo = new URL("../../release/contracts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("database-test-manifest.v1.json", repo)));
const policy = JSON.parse(
  readFileSync(new URL("database-target-policies.v1.json", repo))
).policies.find((item) => item.policyId === "s1-release-compose-ephemeral");
const operationRef = "10000000-0000-4000-8000-000000000001";
const createdAt = "2026-09-28T00:00:00.000Z";
const input = (phase = "source", chain = "fresh") => ({ operationRef, phase, chain, manifest });
const invalid = { code: "R3_DATABASE_TARGETS_UNAVAILABLE" };

function fakeAdmin({ failAfterCreate = Infinity, grantedTo = 0 } = {}) {
  const databases = new Map(),
    roles = new Map(),
    calls = [],
    restoreGrants = [],
    absentPasswords = new Set();
  let creates = 0;
  const executeAdmin = async ({ databaseName, sql }) => {
    calls.push({ databaseName, sql });
    if (/^CREATE ROLE /u.test(sql)) {
      const name = sql.match(/^CREATE ROLE "([^"]+)"/u)?.[1];
      assert.ok(name);
      roles.set(name, {
        oid: String(2000 + roles.size),
        name,
        canLogin: true,
        superuser: false,
        createdb: false,
        createrole: false,
        inherit: false,
        replication: false,
        bypassrls: false,
        memberships: 0,
        grantedTo,
        canConnect: true,
        canCreateDatabase: false,
        canCreateTemporary: false
      });
    } else if (/^CREATE DATABASE /u.test(sql)) {
      creates++;
      if (creates > failAfterCreate) throw new Error("synthetic creation failure");
      const [, name, owner] = sql.match(/^CREATE DATABASE "([^"]+)" OWNER "([^"]+)"$/u) ?? [];
      assert.ok(name && owner);
      databases.set(name, {
        databaseOid: String(3000 + creates),
        marker: "",
        owner,
        schemaOwner: owner
      });
    } else if (/^COMMENT ON DATABASE /u.test(sql)) {
      const [, name, marker] = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '(.+)'$/u) ?? [];
      databases.get(name).marker = marker.replaceAll("''", "'");
    } else if (/^SELECT d\.oid::text AS "databaseOid"/u.test(sql)) {
      const name = sql.match(/WHERE d\.datname='([^']+)'$/u)?.[1];
      const db = databases.get(name);
      return {
        rows: db ? [{ databaseOid: db.databaseOid, marker: db.marker, owner: db.owner }] : []
      };
    } else if (/^SELECT r\.oid::text AS "oid"/u.test(sql)) {
      const name = sql.match(/WHERE r\.rolname='([^']+)'$/u)?.[1];
      if (!roles.has(name)) return { rows: [] };
      const { grantedTo: grantees, ...row } = roles.get(name);
      if (sql.includes("m.roleid=r.oid")) row.grantedTo = grantees;
      return { rows: [row] };
    } else if (/^SELECT pg_get_userbyid\(n\.nspowner\)/u.test(sql)) {
      const db = databases.get(databaseName);
      return { rows: db ? [{ schemaOwner: db.schemaOwner, canCreate: false, canUse: true }] : [] };
    } else if (sql.startsWith('SELECT pg_get_userbyid(m.roleid) AS "roleName"')) {
      return { rows: restoreGrants.map((row) => ({ ...row })) };
    } else if (sql.startsWith('SELECT (r.rolpassword IS NULL) AS "passwordAbsent"')) {
      const name = sql.match(/WHERE r\.rolname='([^']+)'$/u)?.[1];
      return { rows: [{ passwordAbsent: absentPasswords.has(name) }] };
    }
    return { rows: [] };
  };
  return { executeAdmin, databases, roles, calls, restoreGrants, absentPasswords };
}
const createSecret = async ({ databaseName, profile, username }) => ({
  username,
  password: "synthetic-password-do-not-log",
  reference: `private/${databaseName}/${profile}`
});

test("R3 database plan covers every manifest suite with only lifecycle reserved", () => {
  const source = planR3DatabaseTargets(input());
  const final = planR3DatabaseTargets(input("final", "snapshot"));
  assert.equal(source.manifestDigest, sha256Canonical(manifest));
  assert.equal(source.targets.length, 37);
  assert.equal(source.reservations.length, 2);
  assert.equal(final.targets.length, 38);
  assert.equal(final.targets.at(-1).suiteId, "r3.application");
  assert.deepEqual(Object.keys(final.targets.at(-1).roles), [
    "migrate",
    "runtime-test",
    "restore",
    "api-runtime",
    "verify"
  ]);
  assert.equal(source.targets.filter((item) => item.name === "source").length, 1);
  assert.equal(
    source.targets.filter((item) => item.suiteId === "node.release-database-lifecycle.postgres")
      .length,
    0
  );
  for (const [shard, reservation] of source.reservations.entries()) {
    assert.equal(
      reservation.databaseName,
      suiteDatabaseName(operationRef, "database-lifecycle", shard)
    );
    assert.equal(Object.hasOwn(reservation, "databaseOid"), false);
    assert.equal(Object.hasOwn(reservation, "marker"), false);
  }
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.targets[0].roles));
  const duplicate = structuredClone(manifest);
  duplicate.suites[1].files = [...duplicate.suites[0].files];
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: duplicate }), invalid);
  const extraTopology = structuredClone(manifest);
  extraTopology.suites[0].databaseTopology = "source-target";
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: extraTopology }), invalid);
});

test("R3 database provision executes single statements, bounds roles and rechecks actual identities", async () => {
  const plan = planR3DatabaseTargets(input("final", "snapshot"));
  const admin = fakeAdmin();
  let checks = 0;
  const result = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {
      checks++;
    },
    createdAt
  });
  assert.equal(result.records.length, 38);
  assert.ok(result.records[0].marker.startsWith("{"));
  assert.ok(result.records.at(-1).marker.startsWith("subscription-s1-ephemeral/v1:{"));
  assert.equal(
    admin.databases.get(result.records.at(-1).databaseName).marker,
    result.records.at(-1).marker
  );
  assert.equal(checks, 76);
  assert.equal(admin.calls.filter((call) => /^CREATE DATABASE /u.test(call.sql)).length, 38);
  assert.ok(
    admin.calls.every(
      (call) => !call.sql.includes(";") || call.sql.startsWith("COMMENT ON DATABASE")
    ),
    "one SQL statement per call"
  );
  assert.ok(
    admin.calls
      .filter((call) => /^CREATE ROLE /u.test(call.sql))
      .every((call) =>
        /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS$/u.test(call.sql)
      )
  );
  assert.ok(admin.calls.some((call) => /^GRANT SELECT ON ALL TABLES/u.test(call.sql)));
  assert.ok(
    admin.calls.some((call) =>
      /^GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/u.test(call.sql)
    )
  );
  assert.ok(admin.calls.some((call) => /^REVOKE ALL ON DATABASE /u.test(call.sql)));
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
  assert.ok(!JSON.stringify(result).includes("synthetic-password"));
  assert.equal(result.records[0].owner, plan.targets[0].roles.migrate);
  assert.equal(result.records[0].runtimeCanCreate, false);
  assert.equal(result.records[0].roleReadback["runtime-test"].memberships, 0);
  assert.equal(result.records[0].roleReadback["runtime-test"].canCreateTemporary, false);
  assert.equal(result.records[0].schemaPrivileges["runtime-test"].canUse, true);
  assert.equal(
    await recheckR3DatabaseTargets({
      plan,
      records: result.records,
      executeAdmin: admin.executeAdmin
    }),
    true
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 0;
  admin.roles.get(result.records[0].roles["runtime-test"]).grantedTo = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  const delegated = fakeAdmin({ grantedTo: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: delegated.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    invalid
  );
});

test("R3 database provision preserves completed facts and partial resources on failure", async () => {
  const plan = planR3DatabaseTargets(input());
  const admin = fakeAdmin({ failAfterCreate: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: admin.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    (error) => {
      assert.equal(error.code, invalid.code);
      assert.equal(error.records.length, 1);
      assert.equal(error.records[0].databaseName, plan.targets[0].databaseName);
      assert.deepEqual(Object.keys(error).sort(), ["code", "records"]);
      return true;
    }
  );
  assert.equal(admin.databases.size, 1);
  assert.ok(
    admin.roles.size > Object.keys(plan.targets[0].roles).length,
    "the partially created second target remains visible for UNKNOWN"
  );
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
});

test("R3 restore recheck binds exact temporary membership and proven credential revocation", async () => {
  const plan = planR3DatabaseTargets(input("source", "snapshot"));
  const admin = fakeAdmin();
  const { records } = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {},
    createdAt
  });
  const originalDigest = sha256Canonical(records);
  const record = records[0];
  admin.roles.get(record.roles.restore).memberships = 1;
  admin.roles.get(record.roles.migrate).grantedTo = 1;
  admin.restoreGrants.push({
    roleName: record.roles.migrate,
    memberName: record.roles.restore,
    adminOption: false,
    inheritOption: false,
    setOption: true
  });
  const request = { plan, records, executeAdmin: admin.executeAdmin };
  await assert.rejects(recheckR3DatabaseTargets(request), invalid);
  assert.equal(
    await recheckR3DatabaseTargets({
      ...request,
      restoreStates: [{ databaseName: record.databaseName, phase: "GRANTED" }]
    }),
    true
  );
  admin.restoreGrants[0].memberName = records[1].roles.restore;
  await assert.rejects(
    recheckR3DatabaseTargets({
      ...request,
      restoreStates: [{ databaseName: record.databaseName, phase: "GRANTED" }]
    }),
    invalid
  );
  admin.restoreGrants.length = 0;
  admin.roles.get(record.roles.restore).memberships = 0;
  admin.roles.get(record.roles.restore).canLogin = false;
  admin.roles.get(record.roles.restore).canConnect = false;
  admin.roles.get(record.roles.migrate).grantedTo = 0;
  const revoked = {
    ...request,
    restoreStates: [{ databaseName: record.databaseName, phase: "REVOKED" }]
  };
  await assert.rejects(recheckR3DatabaseTargets(revoked), invalid);
  admin.absentPasswords.add(record.roles.restore);
  assert.equal(await recheckR3DatabaseTargets(revoked), true);
  assert.equal(sha256Canonical(records), originalDigest);
});

test("R3 restore recheck refuses an unobserved or duplicate transition", async () => {
  const plan = planR3DatabaseTargets(input("source", "snapshot"));
  const admin = fakeAdmin();
  const { records } = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {},
    createdAt
  });
  for (const restoreStates of [
    [{ databaseName: records[0].databaseName, phase: "GRANTING" }],
    [{ databaseName: records[0].databaseName, phase: "REVOKING" }],
    [
      { databaseName: records[0].databaseName, phase: "REVOKED" },
      { databaseName: records[0].databaseName, phase: "REVOKED" }
    ]
  ])
    await assert.rejects(
      recheckR3DatabaseTargets({
        plan,
        records,
        executeAdmin: admin.executeAdmin,
        restoreStates
      }),
      invalid
    );
});

function postgresReadback(engineId) {
  const id = operationRef.replaceAll("-", "");
  const mount = `/srv/stage1-snapshot/${id}`;
  const imageDigest = policy.requiredImageDigest;
  const containerId = "b".repeat(64);
  const networkId = "c".repeat(64);
  const networkName = `s1r3net_${id}`;
  const volumeName = `s1r3data_${id}`;
  const containerName = `s1r3pg_${id}`;
  const volumePath = `${mount}/docker/volumes/${volumeName}/_data`;
  const labels = { "com.subscription.release.operation-ref": operationRef };
  const postgres = {
    systemIdentifier: "7340000000000000001",
    serverVersionNum: 170011,
    serverAddress: "172.28.0.2",
    serverPort: 5432,
    databaseName: "postgres",
    databaseOid: "5",
    role: "release_provisioner",
    tls: true,
    clusterMarker: policy.requiredClusterMarker
  };
  const resources = {
    operationRef,
    workspaceMountPath: mount,
    engineId,
    imageDigest,
    engine: {
      ID: engineId,
      Driver: "overlay2",
      LoggingDriver: "json-file",
      DockerRootDir: `${mount}/docker`
    },
    image: {
      Id: `sha256:${"e".repeat(64)}`,
      RepoDigests: [`postgres@${imageDigest}`],
      Os: "linux",
      Architecture: "amd64"
    },
    container: {
      Id: containerId,
      Name: `/${containerName}`,
      Image: `sha256:${"e".repeat(64)}`,
      Config: { Image: `postgres:17-bookworm@${imageDigest}`, Labels: labels },
      State: { Running: true, Paused: false, Restarting: false, Dead: false, Pid: 321 },
      HostConfig: {
        NetworkMode: networkName,
        Privileged: false,
        PidMode: "",
        PortBindings: {},
        Binds: null
      },
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: networkId, IPAddress: "172.28.0.2" } },
        Ports: { "5432/tcp": null }
      },
      Mounts: [
        {
          Type: "volume",
          Name: volumeName,
          Source: volumePath,
          Destination: "/var/lib/postgresql/data",
          Driver: "local",
          RW: true
        }
      ]
    },
    network: {
      Id: networkId,
      Name: networkName,
      Driver: "bridge",
      Internal: true,
      Ingress: false,
      EnableIPv6: false,
      Labels: labels,
      Containers: { [containerId]: { Name: containerName, IPv4Address: "172.28.0.2/16" } }
    },
    volume: {
      Name: volumeName,
      Driver: "local",
      Mountpoint: volumePath,
      Options: null,
      Labels: labels
    },
    postgres
  };
  const payload = Buffer.from(JSON.stringify(postgres));
  const stream = Buffer.alloc(8 + payload.length);
  stream[0] = 1;
  stream.writeUInt32BE(payload.length, 4);
  payload.copy(stream, 8);
  return {
    resources,
    execution: { Id: "f".repeat(64) },
    streamBase64: stream.toString("base64"),
    completed: { ID: "f".repeat(64), ContainerID: containerId, Running: false, ExitCode: 0 }
  };
}

async function destinationFixture() {
  const engineId = operationRef;
  const plan = planR3DatabaseTargets(input());
  const admin = fakeAdmin();
  const spec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: `sha256:${"1".repeat(64)}`,
    ownerId: "owner",
    sourceSha: "a".repeat(40),
    buildProofDigest: `sha256:${"2".repeat(64)}`,
    targetPolicyDigest: `sha256:${"3".repeat(64)}`,
    phase: "source",
    chain: "fresh",
    createdAt: "2026-09-27T23:59:59.000Z",
    expiresAt: "2026-09-28T00:05:00.000Z",
    workspace: {
      id: operationRef.replaceAll("-", ""),
      mountPath: `/srv/stage1-snapshot/${operationRef.replaceAll("-", "")}`
    }
  };
  const jobAdmissionDigest = `sha256:${"4".repeat(64)}`;
  const sessionId = "20000000-0000-4000-8000-000000000001";
  const sessionNonce = "5".repeat(64);
  const created = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    recheck: async () => {},
    createdAt,
    createSecret: async ({ databaseName, profile, username }) => ({
      username,
      password: "synthetic-password-do-not-log",
      reference: `r3/${operationRef}/database-credentials/${databaseName}-${profile}.json`
    })
  });
  const pg = postgresReadback(engineId);
  const targetLocks = planManualR3TargetLocks({
    operationRef,
    engineId,
    systemIdentifier: pg.resources.postgres.systemIdentifier,
    targets: created.records.map(({ databaseName, databaseOid, marker }) => ({
      databaseName,
      databaseOid,
      marker
    }))
  }).entries;
  const databaseReadback = [];
  await recheckR3DatabaseTargets({
    plan,
    records: created.records,
    executeAdmin: async (query) => {
      const result = await admin.executeAdmin(query);
      databaseReadback.push({ ...query, rows: result.rows });
      return result;
    }
  });
  const initialExecution = {
    schemaVersion: "manual-operation-record.v3",
    profileDigest: spec.profileDigest,
    recordedAt: createdAt,
    promotionEligible: false,
    kind: "execution",
    stage: "target-create",
    sessionId,
    sessionNonce,
    operationId: operationRef,
    idempotencyKey: "r3-create",
    attemptId: operationRef,
    requestDigest: `sha256:${"6".repeat(64)}`,
    authorizationDigest: `sha256:${"7".repeat(64)}`,
    consumptionRecordDigest: `sha256:${"8".repeat(64)}`,
    predecessorExecutionRecordDigest: null,
    startedAt: null,
    finishedAt: null,
    status: "INTERRUPTED_UNKNOWN",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    resultDigest: null,
    processEvidenceDigest: null
  };
  const manifestRawDigest = sha256Bytes(Buffer.from(JSON.stringify(manifest)));
  return {
    spec,
    jobAdmissionDigest,
    hostedEvidence: {
      bundleDigest: `sha256:${"9".repeat(64)}`,
      engine: {
        id: engineId,
        info: {
          ID: engineId,
          DockerRootDir: pg.resources.engine.DockerRootDir,
          Driver: "overlay2",
          LoggingDriver: "json-file"
        }
      },
      workspaceObservation: { state: "active", status: "OBSERVED", workspace: spec.workspace },
      jobAdmissionDigest,
      spec
    },
    session: {
      profileDigest: spec.profileDigest,
      sessionId,
      sessionNonce,
      scope: {
        targetPolicyDigest: spec.targetPolicyDigest,
        creationSpecDigest: sha256Canonical(spec),
        jobAdmissionDigest,
        buildProofDigest: spec.buildProofDigest,
        sourceSha: spec.sourceSha,
        phase: spec.phase,
        chain: spec.chain
      }
    },
    initialExecution,
    manifest,
    manifestRawDigest,
    policy,
    postgresReadback: pg,
    databaseTargetSet: {
      ...created,
      targetLocks,
      status: "DATABASES_OBSERVED",
      manifestRawDigest,
      engineId,
      systemIdentifier: pg.resources.postgres.systemIdentifier,
      promotionEligible: false,
      targetSetComplete: false
    },
    databaseReadback,
    observedAt: "2026-09-28T00:00:02.000Z"
  };
}

test("R3 destination binds PG dual readback, full manifest targets and replayed SELECT originals", async () => {
  const input = await destinationFixture();
  const pg = assessR3PostgresReadback(input.postgresReadback);
  assert.equal(pg.postgres.systemIdentifier, input.databaseTargetSet.systemIdentifier);
  const result = await buildR3Destination(input);
  assert.equal(result.destination.observationEvidenceDigest, sha256Canonical(result.observations));
  assert.equal(result.destination.databaseTargetSet.records.length, 37);
  assert.equal(result.destination.databaseTargetSet.targetLocks.length, 39);
  assert.equal(result.destination.promotionEligible, false);
});

test("R3 destination rejects a mixed target and an incomplete SELECT transcript", async () => {
  const input = await destinationFixture();
  const missing = { ...input, databaseReadback: input.databaseReadback.slice(0, -1) };
  await assert.rejects(buildR3Destination(missing), { code: "R3_DESTINATION_INVALID" });
  const mixed = structuredClone(input);
  mixed.databaseTargetSet.records[0].databaseOid = "9999";
  await assert.rejects(buildR3Destination(mixed), { code: "R3_DESTINATION_INVALID" });
});
