// Pure proof builder. The session separately verifies originals, custody, and live authority.
import { canonicalJson } from "./canonical-json.mjs";
import { sha256Canonical } from "./digest.mjs";
import { verifyOwnershipMap } from "./snapshot/normalize-ownership.mjs";

const CODE = "R3_SNAPSHOT_CONSUMER_RESULT_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OID = /^[1-9][0-9]*$/u;
const CID = /^[0-9a-f]{64}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
function copy(value) {
  return JSON.parse(canonicalJson(value));
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function timestamp(value) {
  need(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value));
  need(!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
  return Date.parse(value);
}
function keys(value, names) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
  );
}
function readback(value, status, destination, executionDigest, inputDigest) {
  need(
    value?.status === status &&
      value.operationRef === destination.operationRef &&
      value.sessionId === destination.sessionId &&
      value.inputIndexDigest === inputDigest &&
      value.consumerExecutionRecordDigest === executionDigest
  );
  return sha256Canonical(value);
}
function directoryNode(value) {
  need(
    value?.type === "directory" &&
      value.mode === "700" &&
      value.uid === 0 &&
      value.gid === 0 &&
      OID.test(value.device) &&
      OID.test(value.inode) &&
      Number.isSafeInteger(value.links) &&
      value.links > 0
  );
}
function fileNode(value) {
  need(
    value?.type === "regular file" &&
      value.mode === "600" &&
      value.uid === 0 &&
      value.gid === 0 &&
      value.links === 1 &&
      Number.isSafeInteger(value.size) &&
      value.size > 0 &&
      OID.test(value.device) &&
      OID.test(value.inode)
  );
}
function absence(value, target, cid) {
  need(
    same(value?.command, ["/usr/bin/stat", "--", target]) &&
      value.containerId === cid &&
      value.running === false &&
      value.exitCode === 1 &&
      value.stdout === "" &&
      value.stderr === `stat: cannot statx '${target}': No such file or directory\n`
  );
}
function role(value, name, oid, phase, migrate) {
  need(
    value?.name === name &&
      value.oid === oid &&
      value.superuser === false &&
      value.createdb === false &&
      value.createrole === false &&
      value.inherit === false &&
      value.replication === false &&
      value.bypassrls === false &&
      value.grantedTo === 0 &&
      value.canCreateDatabase === false &&
      value.canCreateTemporary === false
  );
  if (phase === "granted")
    need(
      value.canLogin === true &&
        value.canConnect === true &&
        value.memberships === 1 &&
        value.passwordNull === false &&
        value.membership?.role === migrate &&
        value.membership.inherit === false &&
        value.membership.set === true &&
        value.membership.admin === false
    );
  else
    need(
      value.canLogin === false &&
        value.canConnect === false &&
        value.memberships === 0 &&
        value.membership === null &&
        value.passwordNull === true
    );
}
function restoreProof(value, target, destination, copyReadback, snapshotDigest, ownershipMap) {
  const name = target.databaseName;
  const migrate = target.roles?.migrate;
  const runtime = target.roles?.["runtime-test"];
  const restore = target.roles?.restore;
  const cid = destination.postgres.containerId;
  const pg = destination.postgres.postgres;
  const identity = {
    kind: "r3-database-target",
    engineId: destination.postgres.engineId,
    systemIdentifier: pg.systemIdentifier,
    databaseOid: target.databaseOid,
    marker: target.marker
  };
  const identityDigest = sha256Canonical(identity);
  const lockMatches = destination.databaseTargetSet.targetLocks.filter(
    (lock) => lock.identity?.kind === "r3-database-target" && lock.databaseName === name
  );
  need(
    lockMatches.length === 1 &&
      lockMatches[0].lockDigest === identityDigest &&
      same(lockMatches[0].identity, identity) &&
      value.copyReadbackDigest === sha256Canonical(copyReadback) &&
      value.databaseIdentityDigest === identityDigest
  );
  const facts = value.facts;
  const observed = value.observations;
  need(
    facts?.containerId === cid &&
      facts.databaseName === name &&
      facts.databaseOid === target.databaseOid &&
      facts.directory === copyReadback.facts.directory &&
      facts.snapshotDigest === snapshotDigest &&
      facts.restoreRoleDisabled === true &&
      facts.credentialFilesRemoved === true &&
      facts.ownershipObservationDigest === sha256Canonical(observed?.ownershipObservation)
  );
  const before = observed.before;
  need(
    before?.systemIdentifier === pg.systemIdentifier &&
      before.serverVersionNum === pg.serverVersionNum &&
      before.sessionUser === "release_provisioner" &&
      before.currentUser === "release_provisioner" &&
      before.serverAddress === destination.postgres.containerAddress &&
      before.tls === true &&
      before.databaseName === name &&
      before.databaseOid === target.databaseOid &&
      before.marker === target.marker &&
      before.owner === migrate &&
      observed.schema?.schemaOwner === migrate &&
      observed.schema.restoreCanCreate === false
  );
  role(observed.granted, restore, target.roleReadback?.restore?.oid, "granted", migrate);
  role(observed.revokedRole, restore, target.roleReadback?.restore?.oid, "revoked", migrate);
  const execution = observed.restoreExecution;
  need(
    execution?.containerId === cid &&
      execution.running === false &&
      execution.exitCode === 0 &&
      execution.stderr === "" &&
      same(execution.command, [
        "/usr/bin/pg_restore",
        "--host",
        destination.postgres.containerAddress,
        "--port",
        "5432",
        "--username",
        restore,
        "--dbname",
        name,
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        `--role=${migrate}`,
        copyReadback.facts.path
      ])
  );
  const connected = observed.migrationReconnect;
  need(
    connected?.databaseName === name &&
      connected.role === migrate &&
      connected.databaseOid === target.databaseOid &&
      connected.marker === target.marker &&
      connected.owner === migrate &&
      connected.serverVersionNum === pg.serverVersionNum &&
      connected.tls === true
  );
  need(
    observed.restoreLoginDenial?.exitCode === 2 &&
      observed.restoreLoginDenial.stderr ===
        `psql: error: connection to server at "${destination.postgres.containerAddress}", port 5432 failed: FATAL:  password authentication failed for user "${restore}"\n`
  );
  const credentialDirectory = `/tmp/stage1-r3-${destination.operationRef.replaceAll("-", "")}-restore-${name.slice(5)}`;
  const cleanup = observed.credentialCleanup;
  directoryNode(cleanup?.directory);
  keys(cleanup.files, [
    `${credentialDirectory}/restore.pgpass`,
    `${credentialDirectory}/migration.pgpass`
  ]);
  for (const file of Object.values(cleanup.files)) fileNode(file);
  need(
    cleanup.absentExitCode === 1 &&
      cleanup.absentStderr ===
        `stat: cannot statx '${credentialDirectory}': No such file or directory\n`
  );
  const observation = observed.ownershipObservation;
  const inventories = observed.ownershipInventories;
  const ownerTarget = {
    databaseIdentityDigest: identityDigest,
    migrationRole: migrate,
    runtimeRole: runtime
  };
  const observedAt = timestamp(observation?.observedAt);
  need(
    observedAt >= timestamp(destination.observedAt) &&
      inventories?.before?.databaseIdentityDigest === identityDigest &&
      inventories?.after?.databaseIdentityDigest === identityDigest
  );
  verifyOwnershipMap({
    ownershipMap,
    target: ownerTarget,
    inventory: inventories.before,
    now: new Date(observation.observedAt)
  });
  const recomputed = verifyOwnershipMap({
    ownershipMap,
    target: ownerTarget,
    inventory: inventories.after,
    now: new Date(observation.observedAt)
  });
  need(same(recomputed, observation));
  return {
    databaseName: name,
    databaseOid: target.databaseOid,
    databaseIdentity: identity,
    databaseIdentityDigest: identityDigest,
    targetLockDigest: lockMatches[0].lockDigest,
    ownershipObservationDigest: sha256Canonical(observation),
    restoreReadbackDigest: sha256Canonical(value)
  };
}

export function buildR3SnapshotConsumerResult(input) {
  try {
    keys(input, ["destination", "initialExecution", "snapshotInput", "readbacks", "completedAt"]);
    const { destination, initialExecution, snapshotInput, readbacks, completedAt } = copy(input);
    need(
      destination?.schemaVersion === "manual-r3-destination.v1" &&
        UUID.test(destination.operationRef) &&
        UUID.test(destination.sessionId) &&
        NONCE.test(destination.sessionNonce) &&
        ["source", "final"].includes(destination.phase) &&
        destination.chain === "snapshot" &&
        destination.promotionEligible === false &&
        DIGEST.test(destination.initialExecutionRecordDigest)
    );
    need(
      initialExecution?.kind === "execution" &&
        initialExecution.stage === "snapshot-consumer" &&
        initialExecution.status === "INTERRUPTED_UNKNOWN" &&
        initialExecution.operationId === destination.operationRef &&
        initialExecution.sessionId === destination.sessionId &&
        initialExecution.sessionNonce === destination.sessionNonce &&
        initialExecution.resultDigest === null &&
        initialExecution.processEvidenceDigest === null &&
        initialExecution.startedAt === null &&
        initialExecution.finishedAt === null
    );
    const executionDigest = sha256Canonical(initialExecution);
    const completedMs = timestamp(completedAt);
    need(
      timestamp(initialExecution.recordedAt) <= completedMs &&
        timestamp(destination.observedAt) <= completedMs &&
        completedMs < timestamp(snapshotInput?.metadata?.expiresAt) &&
        DIGEST.test(snapshotInput?.inputIndexDigest) &&
        snapshotInput.metadata?.schemaVersion === "snapshot-metadata.v1" &&
        DIGEST.test(snapshotInput.metadata.dumpDigest) &&
        snapshotInput.metadata.ownershipMapDigest === sha256Canonical(snapshotInput.ownershipMap) &&
        snapshotInput.cryptoInputs?.envelope?.schemaVersion === "snapshot-encryption-envelope.v2" &&
        snapshotInput.cryptoInputs.envelope.snapshotDigest === snapshotInput.metadata.dumpDigest &&
        snapshotInput.cryptoInputs.envelope.ciphertextDigest ===
          snapshotInput.storageSubject?.ciphertextDigest &&
        snapshotInput.cryptoInputs.envelope.ciphertextSizeBytes ===
          snapshotInput.storageSubject.ciphertextSizeBytes
    );
    keys(readbacks, ["fetch", "decryption", "copy", "restores", "cleanup"]);
    const fetchDigest = readback(
      readbacks.fetch,
      "CIPHERTEXT_OBSERVED",
      destination,
      executionDigest,
      snapshotInput.inputIndexDigest
    );
    need(same(readbacks.fetch.storageSubject, snapshotInput.storageSubject));
    const decryptionDigest = readback(
      readbacks.decryption,
      "PLAINTEXT_AUTHENTICATED",
      destination,
      executionDigest,
      snapshotInput.inputIndexDigest
    );
    need(
      readbacks.decryption.ciphertextReadbackDigest === fetchDigest &&
        readbacks.decryption.snapshotDigest === snapshotInput.metadata.dumpDigest &&
        readbacks.decryption.plaintextSizeBytes ===
          snapshotInput.cryptoInputs.envelope.ciphertextSizeBytes &&
        readbacks.decryption.keyFingerprint ===
          snapshotInput.cryptoInputs.envelope.localKeyReadback?.keyFingerprint
    );
    const copyDigest = readback(
      readbacks.copy,
      "PLAINTEXT_COPIED",
      destination,
      executionDigest,
      snapshotInput.inputIndexDigest
    );
    const copied = readbacks.copy.facts;
    const remoteDirectory = `/tmp/stage1-r3-${destination.operationRef.replaceAll("-", "")}`;
    need(
      readbacks.copy.decryptionReadbackDigest === decryptionDigest &&
        readbacks.copy.engineId === destination.postgres?.engineId &&
        CID.test(copied?.containerId) &&
        copied.containerId === destination.postgres.containerId &&
        copied.directory === remoteDirectory &&
        copied.path === `${remoteDirectory}/snapshot.dump` &&
        copied.snapshotDigest === snapshotInput.metadata.dumpDigest &&
        copied.plaintextSizeBytes === readbacks.decryption.plaintextSizeBytes
    );
    const records = destination.databaseTargetSet?.records;
    const locks = destination.databaseTargetSet?.targetLocks;
    need(
      Array.isArray(records) &&
        records.length > 0 &&
        records.length <= 128 &&
        Array.isArray(locks) &&
        Array.isArray(readbacks.restores) &&
        readbacks.restores.length === records.length &&
        new Set(records.map((record) => record.databaseName)).size === records.length &&
        locks.filter((lock) => lock.identity?.kind === "r3-database-target").length ===
          records.length
    );
    const databaseResults = [],
      ownershipDigests = [];
    for (const [index, target] of records.entries()) {
      const restore = readbacks.restores[index];
      readback(
        restore,
        "SNAPSHOT_DATABASE_RESTORED",
        destination,
        executionDigest,
        snapshotInput.inputIndexDigest
      );
      need(restore?.facts?.databaseName === target.databaseName);
      const result = restoreProof(
        restore,
        target,
        destination,
        readbacks.copy,
        snapshotInput.metadata.dumpDigest,
        snapshotInput.ownershipMap
      );
      need(timestamp(restore.observations.ownershipObservation.observedAt) <= completedMs);
      databaseResults.push(result);
      ownershipDigests.push(result.ownershipObservationDigest);
    }
    const cleanupDigest = readback(
      readbacks.cleanup,
      "SNAPSHOT_REMOTE_DUMP_CLEANED",
      destination,
      executionDigest,
      snapshotInput.inputIndexDigest
    );
    need(
      readbacks.cleanup.sessionNonce === destination.sessionNonce &&
        readbacks.cleanup.copyReadbackDigest === copyDigest &&
        same(readbacks.cleanup.facts, copied) &&
        Array.isArray(readbacks.cleanup.restoreReadbacks) &&
        same(
          readbacks.cleanup.restoreReadbacks,
          databaseResults.map((item) => ({
            databaseName: item.databaseName,
            digest: item.restoreReadbackDigest
          }))
        )
    );
    const cleanup = readbacks.cleanup.observations;
    directoryNode(cleanup?.preDirectory);
    fileNode(cleanup?.preFile);
    directoryNode(cleanup?.directoryBeforeRmdir);
    need(
      cleanup.preFile.size === copied.plaintextSizeBytes &&
        same(cleanup.preDirectory, readbacks.copy.observations?.finalDirectory) &&
        same(cleanup.preFile, readbacks.copy.observations?.finalFile) &&
        cleanup.preDirectory.device === cleanup.directoryBeforeRmdir.device &&
        cleanup.preDirectory.inode === cleanup.directoryBeforeRmdir.inode
    );
    absence(cleanup.fileAbsentAfterUnlink, copied.path, copied.containerId);
    absence(cleanup.directoryAbsent, copied.directory, copied.containerId);
    absence(cleanup.fileAbsent, copied.path, copied.containerId);
    const destructive = cleanup.transcript?.filter((item) =>
      ["/usr/bin/unlink", "/usr/bin/rmdir"].includes(item?.command?.[0])
    );
    need(
      Array.isArray(destructive) &&
        destructive.length === 2 &&
        same(
          destructive.map((item) => item.command),
          [
            ["/usr/bin/unlink", "--", copied.path],
            ["/usr/bin/rmdir", "--", copied.directory]
          ]
        ) &&
        destructive.every(
          (item) =>
            item.containerId === copied.containerId &&
            item.running === false &&
            item.exitCode === 0 &&
            item.stdout === "" &&
            item.stderr === ""
        )
    );
    need(
      cleanup.transcript.some(
        (item) =>
          same(item?.command, ["/usr/bin/sha256sum", "--", copied.path]) &&
          item.containerId === copied.containerId &&
          item.running === false &&
          item.exitCode === 0 &&
          item.stderr === "" &&
          item.stdout === `${copied.snapshotDigest.slice(7)}  ${copied.path}\n`
      )
    );
    const readbackIndex = {
      fetchDigest,
      decryptionDigest,
      copyDigest,
      restoreDigests: databaseResults.map(({ databaseName, restoreReadbackDigest }) => ({
        databaseName,
        digest: restoreReadbackDigest
      })),
      cleanupDigest
    };
    const destinationDigest = sha256Canonical(destination);
    const processEvidence = freeze({
      recordVersion: "r3-snapshot-consumer-process.v1",
      ...(destination.phase === "final" ? { phase: destination.phase } : {}),
      operationRef: destination.operationRef,
      sessionId: destination.sessionId,
      consumerExecutionRecordDigest: executionDigest,
      inputIndexDigest: snapshotInput.inputIndexDigest,
      destinationDigest,
      completedAt,
      readbacks: readbackIndex
    });
    const result = freeze({
      recordVersion: "r3-snapshot-consumer-result.v1",
      ...(destination.phase === "final" ? { phase: destination.phase } : {}),
      operationRef: destination.operationRef,
      sessionId: destination.sessionId,
      consumerExecutionRecordDigest: executionDigest,
      inputIndexDigest: snapshotInput.inputIndexDigest,
      destinationDigest,
      snapshotDigest: snapshotInput.metadata.dumpDigest,
      metadataDigest: sha256Canonical(snapshotInput.metadata),
      ownershipMapDigest: sha256Canonical(snapshotInput.ownershipMap),
      processEvidenceDigest: sha256Canonical(processEvidence),
      databaseResults,
      completedAt,
      promotionEligible: false
    });
    const originals = new Map();
    const add = (value) => {
      const digest = sha256Canonical(value);
      if (originals.has(digest)) need(same(originals.get(digest), value));
      else originals.set(digest, value);
    };
    for (const value of [readbacks.fetch, readbacks.decryption, readbacks.copy]) add(value);
    for (const value of readbacks.restores) {
      add(value);
      add(value.observations.ownershipObservation);
    }
    for (const value of [readbacks.cleanup, processEvidence, result]) add(value);
    return freeze({
      phase: destination.phase,
      result,
      processEvidence,
      originals: [...originals].map(([digest, value]) => ({ digest, value })),
      ownershipDigests
    });
  } catch {
    fail();
  }
}
