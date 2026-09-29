import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/digest.mjs";
import { verifyOwnershipMap } from "../src/snapshot/normalize-ownership.mjs";
import { buildR3SnapshotConsumerResult } from "../src/r3-snapshot-consumer-result.mjs";

const operationRef = "11111111-2222-4333-8444-555555555555";
const sessionId = "22222222-3333-4444-8555-666666666666";
const sessionNonce = "a".repeat(64);
const containerId = "b".repeat(64);
const engineId = "engine-12345678";
const systemIdentifier = "7340000000000000001";
const containerAddress = "172.19.0.2";
const completedAt = "2026-09-29T12:00:00.000Z";
const digest = (word) => sha256Canonical(word);
const directory = `/tmp/stage1-r3-${operationRef.replaceAll("-", "")}`;
const path = `${directory}/snapshot.dump`;
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
const common = (consumerExecutionRecordDigest, inputIndexDigest) => ({
  operationRef,
  sessionId,
  inputIndexDigest,
  consumerExecutionRecordDigest
});
const node = (type, inode) => ({
  type,
  mode: type === "directory" ? "700" : "600",
  uid: 0,
  gid: 0,
  size: type === "directory" ? 4096 : 256,
  device: "42",
  inode: String(inode),
  links: type === "directory" ? 2 : 1,
  modifiedAt: "x",
  changedAt: "y"
});
const absent = (target) => ({
  command: ["/usr/bin/stat", "--", target],
  stdout: "",
  stderr: `stat: cannot statx '${target}': No such file or directory\n`,
  exitCode: 1,
  containerId,
  running: false,
  executionId: "c".repeat(64)
});
function fixture() {
  const initialExecution = {
    kind: "execution",
    stage: "snapshot-consumer",
    status: "INTERRUPTED_UNKNOWN",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    resultDigest: null,
    processEvidenceDigest: null,
    startedAt: null,
    finishedAt: null,
    recordedAt: "2026-09-29T10:00:00.000Z"
  };
  const executionDigest = sha256Canonical(initialExecution);
  const inputIndexDigest = digest("index");
  const snapshotDigest = digest("dump");
  const ciphertextDigest = digest("ciphertext");
  const keyFingerprint = digest("key");
  const snapshotInput = {
    inputIndexDigest,
    metadata: {
      schemaVersion: "snapshot-metadata.v1",
      dumpDigest: snapshotDigest,
      ownershipMapDigest: sha256Canonical(ownershipMap),
      expiresAt: "2026-09-29T13:00:00.000Z"
    },
    ownershipMap,
    storageSubject: { ciphertextDigest, ciphertextSizeBytes: 256, writerPrincipal: "writer" },
    cryptoInputs: {
      envelope: {
        schemaVersion: "snapshot-encryption-envelope.v2",
        sourceSha: "1".repeat(40),
        snapshotDigest,
        ciphertextDigest,
        ciphertextSizeBytes: 256,
        localKeyReadback: { keyFingerprint }
      },
      authorization: { schemaVersion: "producer-crypto-run-authorization.v2" },
      aad: {}
    }
  };
  const base = common(executionDigest, inputIndexDigest);
  const fetch = {
    status: "CIPHERTEXT_OBSERVED",
    ...base,
    storageSubject: snapshotInput.storageSubject,
    observations: { observed: true }
  };
  const decryption = {
    status: "PLAINTEXT_AUTHENTICATED",
    ...base,
    ciphertextReadbackDigest: sha256Canonical(fetch),
    snapshotDigest,
    plaintextSizeBytes: 256,
    keyFingerprint,
    observations: { authenticated: true }
  };
  const copyFacts = { containerId, directory, path, snapshotDigest, plaintextSizeBytes: 256 };
  const copy = {
    status: "PLAINTEXT_COPIED",
    ...base,
    decryptionReadbackDigest: sha256Canonical(decryption),
    engineId,
    facts: copyFacts,
    observations: {
      copiedDigest: snapshotDigest,
      finalDirectory: node("directory", 99),
      finalFile: node("regular file", 98)
    }
  };
  const records = [],
    targetLocks = [],
    restores = [];
  for (let index = 1; index <= 2; index++) {
    const digit = String(index);
    const databaseName = `s1ci_${digit.repeat(24)}`;
    const migrate = `s1m_${digit.repeat(24)}`;
    const runtime = `s1r_${digit.repeat(24)}`;
    const restore = `s1x_${digit.repeat(24)}`;
    const databaseOid = String(17000 + index);
    const marker = `marker-${index}`;
    const identity = {
      kind: "r3-database-target",
      engineId,
      systemIdentifier,
      databaseOid,
      marker
    };
    const databaseIdentityDigest = sha256Canonical(identity);
    const record = {
      databaseName,
      databaseOid,
      marker,
      owner: migrate,
      schemaOwner: migrate,
      roles: { migrate, "runtime-test": runtime, restore },
      roleReadback: { restore: { oid: String(18000 + index) } }
    };
    records.push(record);
    targetLocks.push({ databaseName, lockDigest: databaseIdentityDigest, identity });
    const inventory = {
      databaseIdentityDigest,
      objects: [
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
      ]
    };
    const ownershipObservation = verifyOwnershipMap({
      ownershipMap,
      target: { databaseIdentityDigest, migrationRole: migrate, runtimeRole: runtime },
      inventory,
      now: new Date(completedAt)
    });
    const roleDir = `${directory}-restore-${databaseName.slice(5)}`;
    const restoreFile = `${roleDir}/restore.pgpass`;
    const migrationFile = `${roleDir}/migration.pgpass`;
    restores.push({
      status: "SNAPSHOT_DATABASE_RESTORED",
      ...base,
      copyReadbackDigest: sha256Canonical(copy),
      databaseIdentityDigest,
      facts: {
        containerId,
        databaseName,
        databaseOid,
        directory,
        snapshotDigest,
        ownershipObservationDigest: sha256Canonical(ownershipObservation),
        restoreRoleDisabled: true,
        credentialFilesRemoved: true
      },
      observations: {
        before: {
          systemIdentifier,
          serverVersionNum: 170011,
          sessionUser: "release_provisioner",
          currentUser: "release_provisioner",
          serverAddress: containerAddress,
          tls: true,
          databaseName,
          databaseOid,
          marker,
          owner: migrate
        },
        schema: { schemaOwner: migrate, restoreCanCreate: false },
        granted: {
          name: restore,
          oid: record.roleReadback.restore.oid,
          canLogin: true,
          canConnect: true,
          memberships: 1,
          membership: { role: migrate, inherit: false, set: true, admin: false },
          passwordNull: false,
          superuser: false,
          createdb: false,
          createrole: false,
          inherit: false,
          replication: false,
          bypassrls: false,
          grantedTo: 0,
          canCreateDatabase: false,
          canCreateTemporary: false
        },
        restoreExecution: {
          command: [
            "/usr/bin/pg_restore",
            "--host",
            containerAddress,
            "--port",
            "5432",
            "--username",
            restore,
            "--dbname",
            databaseName,
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            `--role=${migrate}`,
            path
          ],
          containerId,
          running: false,
          exitCode: 0,
          stderr: ""
        },
        revokedRole: {
          name: restore,
          oid: record.roleReadback.restore.oid,
          canLogin: false,
          canConnect: false,
          memberships: 0,
          membership: null,
          passwordNull: true,
          superuser: false,
          createdb: false,
          createrole: false,
          inherit: false,
          replication: false,
          bypassrls: false,
          grantedTo: 0,
          canCreateDatabase: false,
          canCreateTemporary: false
        },
        ownershipObservation,
        ownershipInventories: { before: inventory, after: inventory },
        restoreLoginDenial: {
          exitCode: 2,
          stderr: `psql: error: connection to server at "${containerAddress}", port 5432 failed: FATAL:  password authentication failed for user "${restore}"\n`
        },
        migrationReconnect: {
          databaseName,
          role: migrate,
          databaseOid,
          marker,
          owner: migrate,
          serverVersionNum: 170011,
          tls: true
        },
        credentialCleanup: {
          directory: node("directory", 100 + index),
          files: {
            [restoreFile]: node("regular file", 200 + index),
            [migrationFile]: node("regular file", 300 + index)
          },
          absentExitCode: 1,
          absentStderr: `stat: cannot statx '${roleDir}': No such file or directory\n`
        }
      }
    });
  }
  const restoreReadbacks = restores.map((value) => ({
    databaseName: value.facts.databaseName,
    digest: sha256Canonical(value)
  }));
  const cleanup = {
    status: "SNAPSHOT_REMOTE_DUMP_CLEANED",
    ...base,
    sessionNonce,
    copyReadbackDigest: sha256Canonical(copy),
    restoreReadbacks,
    facts: copyFacts,
    observations: {
      preDirectory: node("directory", 99),
      preFile: node("regular file", 98),
      fileAbsentAfterUnlink: absent(path),
      directoryBeforeRmdir: node("directory", 99),
      directoryAbsent: absent(directory),
      fileAbsent: absent(path),
      transcript: [
        {
          command: ["/usr/bin/sha256sum", "--", path],
          containerId,
          running: false,
          exitCode: 0,
          stdout: `${snapshotDigest.slice(7)}  ${path}\n`,
          stderr: ""
        },
        {
          command: ["/usr/bin/unlink", "--", path],
          containerId,
          running: false,
          exitCode: 0,
          stdout: "",
          stderr: ""
        },
        {
          command: ["/usr/bin/rmdir", "--", directory],
          containerId,
          running: false,
          exitCode: 0,
          stdout: "",
          stderr: ""
        }
      ]
    }
  };
  const destination = {
    schemaVersion: "manual-r3-destination.v1",
    operationRef,
    sessionId,
    sessionNonce,
    phase: "source",
    chain: "snapshot",
    initialExecutionRecordDigest: digest("creation"),
    promotionEligible: false,
    observedAt: "2026-09-29T10:00:00.000Z",
    sourceSha: "1".repeat(40),
    postgres: {
      engineId,
      containerId,
      containerAddress,
      postgres: { systemIdentifier, serverVersionNum: 170011 }
    },
    databaseTargetSet: { records, targetLocks }
  };
  return {
    destination,
    initialExecution,
    snapshotInput,
    readbacks: { fetch, decryption, copy, restores, cleanup },
    completedAt
  };
}

test("builds a complete frozen digest chain and preserves every original", () => {
  const input = fixture();
  // An admitted historical snapshot may have been exported by another source
  // revision. The current input permission binds its use to this destination.
  input.snapshotInput.cryptoInputs.envelope.sourceSha = "b".repeat(40);
  const built = buildR3SnapshotConsumerResult(input);
  assert.equal(built.phase, "source");
  assert.equal(Object.hasOwn(built.result, "phase"), false);
  assert.equal(Object.hasOwn(built.processEvidence, "phase"), false);
  assert.equal(built.result.processEvidenceDigest, sha256Canonical(built.processEvidence));
  assert.equal(built.processEvidence.readbacks.restoreDigests.length, 2);
  assert.equal(built.ownershipDigests.length, 2);
  assert.equal(built.result.destinationDigest, sha256Canonical(input.destination));
  assert.equal(built.result.inputIndexDigest, input.snapshotInput.inputIndexDigest);
  assert.equal(built.result.promotionEligible, false);
  assert.equal(built.originals.length, 10);
  assert.equal(new Set(built.originals.map((entry) => entry.digest)).size, 10);
  assert.ok(built.originals.every((entry) => entry.digest === sha256Canonical(entry.value)));
  assert.ok(
    Object.isFrozen(built) &&
      Object.isFrozen(built.result) &&
      Object.isFrozen(built.processEvidence) &&
      Object.isFrozen(built.originals)
  );
});

test("builds a final snapshot result and rejects foreign-target readbacks", () => {
  const final = fixture();
  final.destination.phase = "final";
  const built = buildR3SnapshotConsumerResult(final);
  assert.equal(built.phase, "final");
  assert.equal(built.result.phase, "final");
  assert.equal(built.processEvidence.phase, "final");
  assert.equal(built.result.destinationDigest, sha256Canonical(final.destination));

  const sourceReadbacks = fixture().readbacks;
  final.destination.postgres.containerId = "d".repeat(64);
  final.readbacks = sourceReadbacks;
  assert.throws(() => buildR3SnapshotConsumerResult(final), {
    code: "R3_SNAPSHOT_CONSUMER_RESULT_INVALID"
  });
});

test("rejects incomplete, duplicated, or misbound target/readback chains", () => {
  for (const change of [
    (x) => x.readbacks.restores.pop(),
    (x) => (x.readbacks.restores[1] = x.readbacks.restores[0]),
    (x) => (x.readbacks.restores[1].databaseIdentityDigest = digest("wrong")),
    (x) => (x.readbacks.cleanup.restoreReadbacks[0].digest = digest("wrong")),
    (x) => (x.readbacks.decryption.ciphertextReadbackDigest = digest("wrong")),
    (x) => x.destination.databaseTargetSet.targetLocks.pop(),
    (x) => {
      x.initialExecution.status = "SUCCEEDED";
    },
    (x) => {
      x.completedAt = "2026-09-29T11:59:59.000Z";
    },
    (x) => {
      x.completedAt = "2026-09-29T13:00:00.000Z";
    }
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => buildR3SnapshotConsumerResult(input), {
      code: "R3_SNAPSHOT_CONSUMER_RESULT_INVALID"
    });
  }
});

test("rejects claimed success without observed ownership, revoked login, or cleanup", () => {
  for (const change of [
    (x) =>
      (x.readbacks.restores[0].observations.ownershipInventories.after.objects[1].owner = "other"),
    (x) => (x.readbacks.restores[0].observations.revokedRole.canLogin = true),
    (x) => (x.readbacks.restores[0].observations.restoreExecution.exitCode = 1),
    (x) => (x.readbacks.restores[0].observations.credentialCleanup.absentExitCode = 0),
    (x) => (x.readbacks.cleanup.observations.directoryAbsent.exitCode = 0),
    (x) => (x.readbacks.restores[0].observations.revokedRole.superuser = true),
    (x) => (x.readbacks.restores[0].observations.restoreExecution.command[6] = "postgres"),
    (x) => (x.readbacks.cleanup.observations.preFile.inode = "999"),
    (x) => (x.readbacks.cleanup.observations.transcript[0].stdout = "wrong\n")
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => buildR3SnapshotConsumerResult(input), {
      code: "R3_SNAPSHOT_CONSUMER_RESULT_INVALID"
    });
  }
});
