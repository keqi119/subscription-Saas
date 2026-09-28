// Replayable observations of an R3 destination. Neither result authorizes
// snapshot use, changes the UNKNOWN execution, nor releases a held target lock.
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { planManualR3TargetLocks } from "../../packages/release-foundation/src/manual-r3-target-locks.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { planR3DatabaseTargets, recheckR3DatabaseTargets } from "./r3-database-targets.mjs";
import { assessR3PostgresObservation } from "./r3-postgres-observation.mjs";

const CODE = "R3_DESTINATION_INVALID";
const LIMIT = 1048576;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
const CID = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
function exact(value, names) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
  );
}
function same(left, right) {
  return sha256Canonical(left) === sha256Canonical(right);
}
function instant(value) {
  need(
    typeof value === "string" &&
      TIMESTAMP.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
  return Date.parse(value);
}
function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozen(item)]))
    );
  return value;
}
const DB_ROW = ["databaseOid", "marker", "owner"];
const ROLE_ROW = [
  "oid",
  "name",
  "canLogin",
  "superuser",
  "createdb",
  "createrole",
  "inherit",
  "replication",
  "bypassrls",
  "memberships",
  "grantedTo",
  "canConnect",
  "canCreateDatabase",
  "canCreateTemporary"
];
const SCHEMA_ROW = ["schemaOwner", "canCreate", "canUse"];
function selectRow(row) {
  exact(row, ["databaseName", "sql", "rows"]);
  need(
    typeof row.databaseName === "string" &&
      (row.databaseName === "postgres" || /^s1ci_[0-9a-f]{24}$/u.test(row.databaseName)) &&
      typeof row.sql === "string" &&
      row.sql.length <= 4096 &&
      !row.sql.includes(";") &&
      Array.isArray(row.rows) &&
      row.rows.length <= 1
  );
  const columns = row.sql.startsWith('SELECT d.oid::text AS "databaseOid"')
    ? DB_ROW
    : row.sql.startsWith('SELECT r.oid::text AS "oid"')
      ? ROLE_ROW
      : row.sql.startsWith("SELECT pg_get_userbyid(n.nspowner)")
        ? SCHEMA_ROW
        : null;
  need(columns);
  if (row.rows.length) exact(row.rows[0], columns);
}

export function assessR3PostgresReadback(readback) {
  try {
    exact(readback, ["resources", "execution", "streamBase64", "completed"]);
    const resources = readback.resources;
    exact(resources, [
      "operationRef",
      "workspaceMountPath",
      "engineId",
      "imageDigest",
      "engine",
      "image",
      "container",
      "network",
      "volume",
      "postgres"
    ]);
    const facts = assessR3PostgresObservation(resources);
    need(
      readback.execution &&
        typeof readback.execution === "object" &&
        CID.test(readback.execution.Id) &&
        readback.completed &&
        typeof readback.completed === "object" &&
        readback.completed.ContainerID === facts.containerId &&
        readback.completed.Running === false &&
        readback.completed.ExitCode === 0 &&
        (!Object.hasOwn(readback.completed, "ID") ||
          readback.completed.ID === readback.execution.Id)
    );
    need(
      typeof readback.streamBase64 === "string" &&
        readback.streamBase64.length <= Math.ceil(LIMIT / 3) * 4
    );
    const stream = Buffer.from(readback.streamBase64, "base64");
    need(
      stream.length > 0 &&
        stream.length <= LIMIT &&
        stream.toString("base64") === readback.streamBase64
    );
    const output = [],
      errors = [];
    for (let offset = 0; offset < stream.length; ) {
      need(
        stream.length - offset >= 8 &&
          [1, 2].includes(stream[offset]) &&
          stream.subarray(offset + 1, offset + 4).every((byte) => byte === 0)
      );
      const end = offset + 8 + stream.readUInt32BE(offset + 4);
      need(end <= stream.length);
      (stream[offset] === 1 ? output : errors).push(stream.subarray(offset + 8, end));
      offset = end;
    }
    need(Buffer.concat(errors).length === 0);
    const inner = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)).trim()
    );
    need(same(inner, resources.postgres));
    return facts;
  } catch {
    fail();
  }
}

export async function buildR3Destination(input) {
  try {
    exact(input, [
      "spec",
      "jobAdmissionDigest",
      "hostedEvidence",
      "session",
      "initialExecution",
      "manifest",
      "manifestRawDigest",
      "policy",
      "postgresReadback",
      "databaseTargetSet",
      "databaseReadback",
      "observedAt"
    ]);
    const {
      spec,
      jobAdmissionDigest,
      hostedEvidence,
      session,
      initialExecution,
      manifest,
      manifestRawDigest,
      policy,
      postgresReadback,
      databaseTargetSet,
      databaseReadback,
      observedAt
    } = input;
    need(
      spec?.schemaVersion === "manual-r3-creation-spec.v1" &&
        UUID.test(spec.operationRef) &&
        DIGEST.test(jobAdmissionDigest) &&
        DIGEST.test(manifestRawDigest) &&
        DIGEST.test(spec.profileDigest) &&
        DIGEST.test(spec.targetPolicyDigest) &&
        DIGEST.test(spec.buildProofDigest) &&
        /^[0-9a-f]{40}$/u.test(spec.sourceSha) &&
        ["source", "final"].includes(spec.phase) &&
        ["fresh", "snapshot"].includes(spec.chain) &&
        instant(spec.createdAt) <= instant(observedAt) &&
        instant(observedAt) <= instant(spec.expiresAt)
    );
    exact(hostedEvidence, [
      "bundleDigest",
      "engine",
      "workspaceObservation",
      "jobAdmissionDigest",
      "spec"
    ]);
    need(
      DIGEST.test(hostedEvidence.bundleDigest) &&
        hostedEvidence.jobAdmissionDigest === jobAdmissionDigest &&
        same(hostedEvidence.spec, spec) &&
        hostedEvidence.engine?.id === hostedEvidence.engine?.info?.ID &&
        hostedEvidence.workspaceObservation?.state === "active" &&
        hostedEvidence.workspaceObservation?.status === "OBSERVED" &&
        same(hostedEvidence.workspaceObservation.workspace, spec.workspace)
    );
    exact(session, ["profileDigest", "sessionId", "sessionNonce", "scope"]);
    exact(session.scope, [
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest",
      "buildProofDigest",
      "sourceSha",
      "phase",
      "chain"
    ]);
    need(
      session.profileDigest === spec.profileDigest &&
        UUID.test(session.sessionId) &&
        NONCE.test(session.sessionNonce) &&
        session.scope.targetPolicyDigest === spec.targetPolicyDigest &&
        session.scope.creationSpecDigest === sha256Canonical(spec) &&
        session.scope.jobAdmissionDigest === jobAdmissionDigest &&
        session.scope.buildProofDigest === spec.buildProofDigest &&
        session.scope.sourceSha === spec.sourceSha &&
        session.scope.phase === spec.phase &&
        session.scope.chain === spec.chain
    );
    validateContract("manual-operation-record.v3", initialExecution);
    need(
      initialExecution.kind === "execution" &&
        initialExecution.stage === "target-create" &&
        initialExecution.status === "INTERRUPTED_UNKNOWN" &&
        initialExecution.profileDigest === spec.profileDigest &&
        initialExecution.sessionId === session.sessionId &&
        initialExecution.sessionNonce === session.sessionNonce &&
        initialExecution.operationId === spec.operationRef &&
        initialExecution.predecessorExecutionRecordDigest === null &&
        initialExecution.startedAt === null &&
        initialExecution.finishedAt === null &&
        initialExecution.resultDigest === null &&
        initialExecution.processEvidenceDigest === null &&
        DIGEST.test(initialExecution.consumptionRecordDigest) &&
        instant(initialExecution.recordedAt) <= instant(observedAt)
    );
    const postgres = assessR3PostgresReadback(postgresReadback);
    need(
      postgres.operationRef === spec.operationRef &&
        postgres.workspaceMountPath === spec.workspace.mountPath &&
        postgres.engineId === hostedEvidence.engine.id &&
        postgresReadback.resources.engine.ID === hostedEvidence.engine.id &&
        postgresReadback.resources.engine.DockerRootDir ===
          hostedEvidence.engine.info.DockerRootDir &&
        postgresReadback.resources.engine.Driver === hostedEvidence.engine.info.Driver &&
        postgresReadback.resources.engine.LoggingDriver ===
          hostedEvidence.engine.info.LoggingDriver &&
        policy?.schemaVersion === "database-target-policy.v1" &&
        policy.policyId === "s1-release-compose-ephemeral" &&
        policy.requiredEphemeralMarker === "subscription-s1-ephemeral/v1" &&
        postgres.imageDigest === policy.requiredImageDigest &&
        postgres.postgres.clusterMarker === policy.requiredClusterMarker
    );
    const plan = planR3DatabaseTargets({
      operationRef: spec.operationRef,
      phase: spec.phase,
      chain: spec.chain,
      manifest
    });
    exact(databaseTargetSet, [
      "plan",
      "records",
      "targetLocks",
      "status",
      "manifestRawDigest",
      "engineId",
      "systemIdentifier",
      "promotionEligible",
      "targetSetComplete"
    ]);
    need(
      same(databaseTargetSet.plan, plan) &&
        Array.isArray(databaseTargetSet.records) &&
        databaseTargetSet.records.length === plan.targets.length &&
        databaseTargetSet.status === "DATABASES_OBSERVED" &&
        databaseTargetSet.promotionEligible === false &&
        databaseTargetSet.targetSetComplete === false &&
        databaseTargetSet.manifestRawDigest === manifestRawDigest &&
        databaseTargetSet.engineId === postgres.engineId &&
        databaseTargetSet.systemIdentifier === postgres.postgres.systemIdentifier
    );
    for (const [index, record] of databaseTargetSet.records.entries()) {
      const item = plan.targets[index];
      need(
        record.databaseName === item.databaseName &&
          same(record.roles, item.roles) &&
          instant(spec.createdAt) <= instant(record.createdAt) &&
          instant(record.createdAt) <= instant(observedAt)
      );
      exact(record.secretReferences, Object.keys(item.roles));
      for (const profile of Object.keys(item.roles))
        need(
          record.secretReferences[profile] ===
            `r3/${spec.operationRef}/database-credentials/${item.databaseName}-${profile}.json`
        );
    }
    const lockPlan = planManualR3TargetLocks({
      operationRef: spec.operationRef,
      engineId: postgres.engineId,
      systemIdentifier: postgres.postgres.systemIdentifier,
      targets: databaseTargetSet.records.map(({ databaseName, databaseOid, marker }) => ({
        databaseName,
        databaseOid,
        marker
      }))
    });
    need(
      same(databaseTargetSet.targetLocks, lockPlan.entries) &&
        Array.isArray(databaseReadback) &&
        databaseReadback.length > 0
    );
    let index = 0;
    const executeAdmin = async ({ databaseName, sql }) => {
      const row = databaseReadback[index++];
      need(row);
      selectRow(row);
      need(row.databaseName === databaseName && row.sql === sql);
      return { rows: row.rows };
    };
    need(
      (await recheckR3DatabaseTargets({
        plan,
        records: databaseTargetSet.records,
        executeAdmin
      })) && index === databaseReadback.length
    );
    const observations = frozen({
      schemaVersion: "manual-r3-destination-observations.v1",
      operationRef: spec.operationRef,
      postgres: postgresReadback,
      databases: databaseReadback
    });
    const destination = frozen({
      schemaVersion: "manual-r3-destination.v1",
      operationRef: spec.operationRef,
      profileDigest: spec.profileDigest,
      ownerId: spec.ownerId,
      sourceSha: spec.sourceSha,
      buildProofDigest: spec.buildProofDigest,
      targetPolicyDigest: spec.targetPolicyDigest,
      creationSpecDigest: sha256Canonical(spec),
      jobAdmissionDigest,
      phase: spec.phase,
      chain: spec.chain,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      consumptionRecordDigest: initialExecution.consumptionRecordDigest,
      initialExecutionRecordDigest: sha256Canonical(initialExecution),
      hostedEvidenceDigest: hostedEvidence.bundleDigest,
      observationEvidenceDigest: sha256Canonical(observations),
      manifestRawDigest,
      postgres,
      databaseTargetSet,
      observedAt,
      promotionEligible: false
    });
    need(
      Buffer.byteLength(canonicalJson(observations)) <= LIMIT &&
        Buffer.byteLength(canonicalJson(destination)) <= LIMIT
    );
    return Object.freeze({ destination, observations });
  } catch {
    fail();
  }
}
