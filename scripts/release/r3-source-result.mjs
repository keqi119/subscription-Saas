// Reconstruct a source result from retained originals. Callers must separately
// establish the fixed candidate, private readbacks, live authority and custody.
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import {
  encodeManualJson,
  encodePrivateObservationJson
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest,
  runSourceDatabaseGate
} from "../../packages/release-foundation/src/database-test-launcher.mjs";
import { bindR3SourceManifest } from "./r3-database-targets.mjs";
import {
  databaseTestCounts,
  prismaPostSchemaArguments,
  summarizeDatabaseTestLog
} from "./database-test-launcher-runtime.mjs";
import { r3RuntimeBoundary } from "./r3-source-suite.mjs";
import { assertR3LifecycleOriginals } from "./r3-lifecycle-test-runner.mjs";

const CODE = "R3_SOURCE_RESULT_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ORIGINAL_LIMIT = 33554432;
const need = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const commands = () => [
  ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
  ["migrate", "status", "--schema", "prisma/schema.prisma"],
  [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--exit-code"
  ],
  prismaPostSchemaArguments()
];
function processResult(result) {
  need(
    result?.code === 0 &&
      result.signal === null &&
      result.truncated === false &&
      [result.processError, result.timedOut].every(
        (value) => value === undefined || value === false
      ) &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string" &&
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 524288
  );
  return result;
}
function migrations(execution, records, processes) {
  const expected = commands();
  need(Array.isArray(processes) && processes.length === records.length * expected.length);
  return records.map((record, index) => {
    const results = expected.map((args, commandIndex) => {
      const entry = processes[index * expected.length + commandIndex];
      need(entry.databaseName === record.databaseName && same(entry.arguments, args));
      return processResult(entry.result);
    });
    return {
      name: index === 0 ? "target" : execution.additionalAssignments[index - 1].name,
      migrationStatusDigest: sha256Canonical(results[1]),
      schemaDiffDigest: sha256Canonical(results[2]),
      postSchemaDigest: sha256Bytes(Buffer.from(results[3].stdout, "utf8"))
    };
  });
}
function ordinary(execution, expected, binding, originals, credentials) {
  need(
    same(originals.databases, expected) &&
      Array.isArray(originals.runtimeReadbacks) &&
      originals.runtimeReadbacks.length === expected.length
  );
  const migrationObservations = migrations(execution, expected, originals.processes);
  const primary = originals.context;
  const contexts = expected.map((record, index) => {
    const name = index === 0 ? "target" : execution.additionalAssignments[index - 1].name;
    const context = expected.length > 1 ? primary.namedDatabases?.[name] : primary;
    need(
      context &&
        DIGEST.test(context.migrationCredentialFingerprint) &&
        DIGEST.test(context.runtimeCredentialFingerprint)
    );
    for (const digest of [
      context.migrationCredentialFingerprint,
      context.runtimeCredentialFingerprint
    ]) {
      need(!credentials.has(digest));
      credentials.add(digest);
    }
    const value = {
      databaseName: record.databaseName,
      databaseOid: record.databaseOid,
      targetFingerprint: binding.clusterFingerprint,
      runtimeSecretReference: record.secretReferences["runtime-test"],
      migrationCredentialFingerprint: context.migrationCredentialFingerprint,
      runtimeCredentialFingerprint: context.runtimeCredentialFingerprint
    };
    if (expected.length > 1) need(same(context, value));
    return [name, value];
  });
  const context = {
    schemaVersion: "release-database-test-context.v1",
    operationRef: binding.operationRef,
    suiteId: execution.suiteId,
    profileDigest: binding.profileDigest,
    allowedFiles: [...execution.files],
    containerId: binding.containerId,
    ...contexts[0][1],
    ...(expected.length > 1 ? { namedDatabases: Object.fromEntries(contexts) } : {})
  };
  need(same(primary, context));
  need(
    Array.isArray(originals.fixtures) &&
      originals.fixtures.length === (execution.fixtures ? expected.length : 0)
  );
  if (execution.fixtures)
    for (const [index, entry] of originals.fixtures.entries()) {
      const [name, identity] = contexts[index];
      need(
        entry.database === name &&
          entry.migration.fixturePath === execution.fixtures.schema &&
          entry.runtime.fixturePath === execution.fixtures.seed &&
          entry.migration.credentialFingerprint === identity.migrationCredentialFingerprint &&
          entry.runtime.credentialFingerprint === identity.runtimeCredentialFingerprint &&
          DIGEST.test(entry.migration.sqlDigest) &&
          DIGEST.test(entry.runtime.sqlDigest)
      );
    }
  const roleBoundaries = originals.runtimeReadbacks.map((entry, index) => {
    need(entry.databaseName === expected[index].databaseName);
    return r3RuntimeBoundary(contexts[index][0], entry.readback);
  });
  const log = processResult(originals.test);
  return {
    migrationObservations,
    roleBoundaries,
    log,
    fixtureObservations: execution.fixtures ? originals.fixtures : undefined
  };
}
function lifecycle(execution, expected, binding, originals) {
  need(
    originals.status === "LIFECYCLE_OBSERVED" &&
      originals.promotionEligible === false &&
      [
        "operationRef",
        "sessionId",
        "sessionNonce",
        "destinationDigest",
        "creationExecutionRecordDigest",
        "candidateUseExecutionRecordDigest",
        "snapshotExecutionRecordDigest"
      ].every((key) => originals[key] === binding[key])
  );
  assertR3LifecycleOriginals(originals.originals);
  need(same(originals.originals.counts, originals.originals.summaries[0].counts));
  const observations = originals.observations;
  need(Array.isArray(observations));
  const stages = (stage) => observations.filter((entry) => entry.stage === stage);
  need(
    same(
      stages("provision").map((entry) => entry.record),
      expected
    )
  );
  const migrationObservations = migrations(execution, expected, stages("source-migration-process"));
  need(
    same(
      stages("source-migration").map((entry) => entry.value),
      migrationObservations
    )
  );
  const roles = stages("source-runtime-boundary");
  need(roles.length === expected.length);
  const roleBoundaries = roles.map((entry, index) => {
    need(entry.databaseName === expected[index].databaseName);
    return r3RuntimeBoundary(index === 0 ? "target" : "sibling", entry.value);
  });
  const cleanup = stages("cleanup"),
    absence = stages("database-absence"),
    sibling = stages("sibling-connection"),
    owned = stages("owned-absence");
  need(cleanup.length === 2 && absence.length === 2 && sibling.length === 1 && owned.length === 1);
  for (const [index, record] of expected.entries()) {
    need(
      cleanup[index].databaseName === record.databaseName &&
        cleanup[index].recordDigest === sha256Canonical(record) &&
        absence[index].databaseName === record.databaseName &&
        same(absence[index].value, { rows: [{ count: "0" }] }) &&
        observations.indexOf(cleanup[index]) < observations.indexOf(absence[index])
    );
  }
  need(
    sibling[0].databaseName === expected[1].databaseName &&
      same(sibling[0].value, { rows: [{ databaseName: expected[1].databaseName }] }) &&
      observations.indexOf(absence[0]) < observations.indexOf(sibling[0]) &&
      observations.indexOf(sibling[0]) < observations.indexOf(cleanup[1]) &&
      observations.indexOf(absence[1]) < observations.indexOf(owned[0]) &&
      same(owned[0].value, { rows: [{ count: "0" }] })
  );
  const log = { stdout: originals.originals.tap, stderr: "" };
  const counts = databaseTestCounts(log.stdout);
  need(
    counts.executed === originals.originals.counts.tests &&
      counts.passed === originals.originals.counts.passed
  );
  return { migrationObservations, roleBoundaries, log };
}

export async function buildR3SourceResult({
  manifest,
  plan,
  discoveryDigest,
  binding,
  records,
  lifecycleRecords,
  attempt,
  suiteReadbacks,
  manifestReport
}) {
  try {
    need(
      binding &&
        binding.operationRef === plan.operationRef &&
        binding.chain === plan.chain &&
        [
          binding.profileDigest,
          binding.destinationDigest,
          binding.clusterFingerprint,
          binding.creationExecutionRecordDigest,
          binding.candidateUseExecutionRecordDigest
        ].every((value) => DIGEST.test(value)) &&
        /^[0-9a-f]{64}$/u.test(binding.containerId) &&
        /^[0-9a-f]{64}$/u.test(binding.sessionNonce) &&
        /^[0-9a-f]{40}$/u.test(binding.sourceSha) &&
        (binding.chain === "snapshot"
          ? DIGEST.test(binding.snapshotExecutionRecordDigest)
          : binding.snapshotExecutionRecordDigest === null)
    );
    need(
      same(attempt, {
        status: "SOURCE_MANIFEST_INTERRUPTED_UNKNOWN",
        operationRef: binding.operationRef,
        sessionId: binding.sessionId,
        sessionNonce: binding.sessionNonce,
        sourceSha: binding.sourceSha,
        destinationDigest: binding.destinationDigest,
        manifestDigest: sha256Canonical(manifest),
        candidateUseExecutionRecordDigest: binding.candidateUseExecutionRecordDigest,
        promotionEligible: false
      })
    );
    const selections = bindR3SourceManifest({
      operationRef: binding.operationRef,
      chain: binding.chain,
      manifest,
      plan,
      discoveryDigest,
      discoveryUnclassifiedCount: 0
    });
    need(
      Array.isArray(suiteReadbacks) &&
        suiteReadbacks.length === selections.length &&
        Array.isArray(records) &&
        records.length === plan.targets.length &&
        Array.isArray(lifecycleRecords) &&
        lifecycleRecords.length === plan.reservations.length
    );
    const all = [...records, ...lifecycleRecords],
      planned = [...plan.targets, ...plan.reservations];
    need(new Set(all.map((item) => item.databaseOid)).size === all.length);
    for (const [index, record] of all.entries())
      need(
        record.databaseName === planned[index].databaseName &&
          /^[1-9][0-9]*$/u.test(record.databaseOid) &&
          record.shard === planned[index].shard &&
          same(record.roles, planned[index].roles)
      );
    const credentials = new Set(),
      references = [],
      migrationValues = [];
    const reconstructed = await runDatabaseManifest({
      selections,
      executeSuite: async (execution) => {
        const index = selections.indexOf(execution),
          stored = suiteReadbacks[index];
        need(
          stored?.status === "SOURCE_SUITE_OBSERVED" &&
            stored.promotionEligible === false &&
            stored.operationRef === binding.operationRef &&
            stored.sessionId === binding.sessionId &&
            stored.destinationDigest === binding.destinationDigest &&
            stored.attemptDigest === sha256Canonical(attempt)
        );
        const assignments = [execution.assignment, ...execution.additionalAssignments];
        const expected = assignments.map((assignment) =>
          all.find((record) => record.databaseName === assignment.databaseName)
        );
        need(
          expected.every(
            (record, n) => record && same(record.secretReferences, assignments[n].secretReferences)
          )
        );
        const derived =
          execution.r3ExecutionMode === "lifecycle-owned"
            ? lifecycle(execution, expected, binding, stored.originals)
            : ordinary(execution, expected, binding, stored.originals, credentials);
        const logSummary = summarizeDatabaseTestLog(derived.log),
          counts = databaseTestCounts(derived.log.stdout);
        need(
          counts.executed > 0 &&
            same(stored.logSummary, logSummary) &&
            same(stored.migrationObservations, derived.migrationObservations)
        );
        const report = buildDatabaseSuiteReport({
          execution,
          operationId: binding.operationRef,
          provisioned: {
            ...expected[0],
            targetFingerprint: binding.clusterFingerprint,
            additionalDatabases: expected.slice(1).map((record, n) => ({
              ...record,
              name: execution.additionalAssignments[n].name,
              targetFingerprint: binding.clusterFingerprint
            }))
          },
          result: {
            counts,
            sanitizedLogDigest: sha256Canonical(logSummary),
            roleBoundaries: derived.roleBoundaries,
            ...(derived.fixtureObservations
              ? { fixtureObservations: derived.fixtureObservations }
              : {})
          }
        });
        need(report.terminalStatus === "PASSED" && same(report, stored.report));
        references.push({
          suiteId: execution.suiteId,
          readbackDigest: sha256Canonical(stored),
          reportDigest: sha256Canonical(report)
        });
        migrationValues.push(derived.migrationObservations);
        return report;
      }
    });
    need(same(reconstructed, manifestReport));
    const postSchemaDigests = new Set(
      migrationValues.flatMap((items) => items.map((item) => item.postSchemaDigest))
    );
    need(postSchemaDigests.size === 1);
    return Object.freeze({
      manifestReport: reconstructed,
      suiteReadbacks: Object.freeze(references),
      migrationStatusDigest: sha256Canonical(
        migrationValues.map((items) =>
          sha256Canonical(
            items.map(({ name, migrationStatusDigest }) => ({ name, migrationStatusDigest }))
          )
        )
      ),
      schemaDiffDigest: sha256Canonical(
        migrationValues.map((items) =>
          sha256Canonical(items.map(({ name, schemaDiffDigest }) => ({ name, schemaDiffDigest })))
        )
      ),
      postSchemaDigest: [...postSchemaDigests][0]
    });
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

// Read only the fixed source originals through the holder's captured reader.
// This proves matching, stable private bytes and result consistency, not custody
// or authority to promote the reconstructed result.
export async function readR3SourceOriginals({
  manifest,
  plan,
  binding,
  records,
  lifecycleRecords,
  discovery,
  readObservation,
  recheck
}) {
  try {
    need(
      typeof readObservation === "function" &&
        typeof recheck === "function" &&
        DIGEST.test(discovery?.discoveryDigest) &&
        Array.isArray(discovery.candidates) &&
        Array.isArray(discovery.classification?.unclassified) &&
        discovery.classification.unclassified.length === 0
    );
    const selections = bindR3SourceManifest({
      operationRef: binding.operationRef,
      chain: binding.chain,
      manifest,
      plan,
      discoveryDigest: discovery.discoveryDigest,
      discoveryUnclassifiedCount: discovery.classification.unclassified.length
    });
    const names = ["attempt", ...selections.map(({ suiteId }) => suiteId), "manifest"];
    need(new Set(names).size === names.length);
    const held = [],
      originals = [];
    const values = new Map();
    for (const name of names) {
      let first;
      for (const storageRole of ["archive", "backup"]) {
        const original = await readObservation({ storageRole, name });
        need(original instanceof Uint8Array && original.byteLength > 0);
        need(original.byteLength <= ORIGINAL_LIMIT);
        const bytes = Buffer.from(original);
        if (first) need(first.equals(bytes));
        else first = bytes;
        held.push({ storageRole, name, bytes });
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(first));
      need(encodePrivateObservationJson(value).equals(first));
      values.set(name, value);
      originals.push(Object.freeze({ name, digest: sha256Bytes(first), bytes: first.length }));
    }
    const attempt = values.get("attempt"),
      observed = values.get("manifest"),
      suiteReadbacks = selections.map(({ suiteId }) => values.get(suiteId));
    need(
      observed?.status === "SOURCE_MANIFEST_OBSERVED" &&
        observed.promotionEligible === false &&
        observed.attemptDigest === sha256Canonical(attempt) &&
        observed.operationRef === binding.operationRef &&
        observed.sessionId === binding.sessionId &&
        observed.sessionNonce === binding.sessionNonce &&
        observed.sourceSha === binding.sourceSha &&
        observed.destinationDigest === binding.destinationDigest &&
        same(observed.discovery, discovery)
    );
    processResult(observed.generation);
    const reconstructed = await buildR3SourceResult({
      manifest,
      plan,
      discoveryDigest: discovery.discoveryDigest,
      binding,
      records,
      lifecycleRecords,
      attempt,
      suiteReadbacks,
      manifestReport: observed.manifestReport
    });
    need(same(observed.reconstructed, reconstructed));
    need(
      same(
        observed.observations,
        selections.map(({ suiteId }, index) => ({
          suiteId,
          readbackDigest: sha256Canonical(suiteReadbacks[index]),
          migrationObservations: suiteReadbacks[index].migrationObservations
        }))
      )
    );
    await recheck();
    for (const { storageRole, name, bytes } of held) {
      const actual = await readObservation({ storageRole, name });
      need(
        actual instanceof Uint8Array &&
          actual.byteLength > 0 &&
          actual.byteLength <= ORIGINAL_LIMIT &&
          Buffer.from(actual).equals(bytes)
      );
    }
    return Object.freeze({
      readbackDigest: sha256Canonical(observed),
      reconstructedDigest: sha256Canonical(reconstructed),
      // Internal derived fact, not a new field in the persisted source result.
      postSchemaDigest: reconstructed.postSchemaDigest,
      suiteReadbacks: reconstructed.suiteReadbacks,
      originals: Object.freeze(originals)
    });
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

// Compact private proof of the fixed source readback and its per-copy custody.
// The holder establishes authority and reads the actual originals before calling this.
export function buildR3SourceCompletion({
  request,
  initialExecution,
  manifest,
  verified,
  custodyRecords,
  completedAt
}) {
  try {
    const time = (value) => {
      need(
        typeof value === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString() === value
      );
      return Date.parse(value);
    };
    need(
      request?.schemaVersion === "manual-runner-request.v5" &&
        request.stage === "candidate-use" &&
        request.capability === "execute-source-database-tests" &&
        request.purpose === "stage1-isolated-database-tests" &&
        request.phase === "source" &&
        ["fresh", "snapshot"].includes(request.chain) &&
        typeof request.operationId === "string" &&
        typeof request.ownerId === "string" &&
        request.ownerId.length > 0 &&
        typeof request.sessionId === "string" &&
        /^[0-9a-f]{64}$/u.test(request.sessionNonce) &&
        /^[0-9a-f]{40}$/u.test(request.sourceSha) &&
        [
          request.profileDigest,
          request.candidate?.buildProofDigest,
          request.targetPolicyDigest,
          request.creationSpecDigest,
          request.jobAdmissionDigest,
          request.destinationAdmissionDigest,
          request.preparationExecutionRecordDigest,
          request.databaseTestManifestDigest
        ].every((value) => DIGEST.test(value)) &&
        sha256Canonical(manifest) === request.databaseTestManifestDigest
    );
    const requestDigest = sha256Canonical(request);
    need(
      initialExecution?.schemaVersion === "manual-operation-record.v3" &&
        initialExecution.kind === "execution" &&
        initialExecution.stage === "candidate-use" &&
        initialExecution.status === "INTERRUPTED_UNKNOWN" &&
        initialExecution.promotionEligible === false &&
        initialExecution.reasonCode === "MANUAL_EVIDENCE_INCOMPLETE" &&
        initialExecution.startedAt === null &&
        initialExecution.finishedAt === null &&
        initialExecution.resultDigest === null &&
        initialExecution.processEvidenceDigest === null &&
        initialExecution.requestDigest === requestDigest &&
        initialExecution.predecessorExecutionRecordDigest ===
          request.preparationExecutionRecordDigest &&
        [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId"
        ].every((key) => initialExecution[key] === request[key]) &&
        DIGEST.test(initialExecution.authorizationDigest) &&
        DIGEST.test(initialExecution.consumptionRecordDigest)
    );
    const initialAt = time(initialExecution.recordedAt);
    const completed = time(completedAt);
    need(initialAt <= completed);
    const names = ["attempt", ...manifest.suites.map(({ suiteId }) => suiteId), "manifest"];
    need(
      names.length === 39 &&
        new Set(names).size === names.length &&
        DIGEST.test(verified?.readbackDigest) &&
        DIGEST.test(verified?.reconstructedDigest) &&
        Array.isArray(verified.originals) &&
        verified.originals.length === names.length &&
        Array.isArray(verified.suiteReadbacks) &&
        verified.suiteReadbacks.length === manifest.suites.length
    );
    const digests = new Set();
    const originals = verified.originals.map((original, index) => {
      need(
        original?.name === names[index] &&
          DIGEST.test(original.digest) &&
          Number.isSafeInteger(original.bytes) &&
          original.bytes > 0 &&
          original.bytes <= ORIGINAL_LIMIT &&
          !digests.has(original.digest)
      );
      digests.add(original.digest);
      return { name: original.name, digest: original.digest, bytes: original.bytes };
    });
    need(originals.at(-1).digest === verified.readbackDigest);
    for (const [index, reference] of verified.suiteReadbacks.entries())
      need(
        reference?.suiteId === names[index + 1] &&
          reference.readbackDigest === originals[index + 1].digest &&
          DIGEST.test(reference.reportDigest)
      );
    need(Array.isArray(custodyRecords) && custodyRecords.length === originals.length * 2);
    const custodyByPair = new Map();
    for (const custody of custodyRecords) {
      const role = custody?.storageRole;
      const pair = `${custody?.subjectDigest}:${role}`;
      need(
        custody.schemaVersion === "manual-operation-record.v3" &&
          custody.kind === "custody" &&
          custody.promotionEligible === false &&
          custody.profileDigest === request.profileDigest &&
          custody.ownerId === request.ownerId &&
          custody.subjectType === "record" &&
          ["archive", "backup"].includes(role) &&
          custody.purpose === `${role}-readback` &&
          custody.outcome === "MATCH" &&
          custody.observedDigest === custody.subjectDigest &&
          custody.retentionDays === 90 &&
          custody.reasonCode === null &&
          digests.has(custody.subjectDigest) &&
          !custodyByPair.has(pair)
      );
      const observedAt = time(custody.observedAt);
      const recordedAt = time(custody.recordedAt);
      need(initialAt <= observedAt && observedAt <= recordedAt && recordedAt <= completed);
      custodyByPair.set(pair, sha256Canonical(custody));
    }
    const custodyRecordDigests = originals.flatMap(({ digest }) =>
      ["archive", "backup"].map((role) => {
        const value = custodyByPair.get(`${digest}:${role}`);
        need(DIGEST.test(value));
        return value;
      })
    );
    const result = {
      schemaVersion: "manual-r3-source-result.v1",
      operationRef: request.operationId,
      profileDigest: request.profileDigest,
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      sessionNonce: request.sessionNonce,
      sourceSha: request.sourceSha,
      buildProofDigest: request.candidate.buildProofDigest,
      targetPolicyDigest: request.targetPolicyDigest,
      creationSpecDigest: request.creationSpecDigest,
      jobAdmissionDigest: request.jobAdmissionDigest,
      phase: "source",
      chain: request.chain,
      destinationAdmissionDigest: request.destinationAdmissionDigest,
      preparationExecutionRecordDigest: request.preparationExecutionRecordDigest,
      databaseTestManifestDigest: request.databaseTestManifestDigest,
      candidateUseExecutionRecordDigest: sha256Canonical(initialExecution),
      requestDigest,
      readbackDigest: verified.readbackDigest,
      reconstructedDigest: verified.reconstructedDigest,
      originals,
      custodyRecordDigests,
      completedAt,
      promotionEligible: false
    };
    encodeManualJson(result);
    return Object.freeze({
      ...result,
      originals: Object.freeze(originals.map((item) => Object.freeze(item))),
      custodyRecordDigests: Object.freeze(custodyRecordDigests)
    });
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

function acknowledgementTime(value) {
  need(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
  return Date.parse(value);
}

// Projection only: the native holder supplies the verified originals and live
// target. Public delivery still requires its separate owner ACK and CLOSED.
export function buildR3SourceFreshGateEvidence(input) {
  if (input?.spec?.chain !== "fresh")
    throw Object.assign(new Error("R3_SOURCE_GATE_RESULT_INVALID"), {
      code: "R3_SOURCE_GATE_RESULT_INVALID"
    });
  return buildR3SourceGateEvidence(input);
}

function sourceSnapshotProjection(snapshot, source) {
  const { metadata, bundleInputs, execution, result } = snapshot;
  validateContract("snapshot-metadata.v1", metadata);
  validateContract("manual-operation-record.v3", execution);
  need(
    execution.kind === "execution" &&
      execution.stage === "snapshot-consumer" &&
      execution.status === "SUCCEEDED" &&
      execution.reasonCode === null &&
      execution.promotionEligible === false &&
      execution.operationId === source.operationRef &&
      ["profileDigest", "sessionId", "sessionNonce"].every(
        (field) => execution[field] === source[field]
      ) &&
      sha256Canonical(execution) === source.preparationExecutionRecordDigest &&
      execution.resultDigest === sha256Canonical(result) &&
      execution.processEvidenceDigest === result.processEvidenceDigest &&
      execution.predecessorExecutionRecordDigest === result.consumerExecutionRecordDigest &&
      result.recordVersion === "r3-snapshot-consumer-result.v1" &&
      !Object.hasOwn(result, "phase") &&
      result.promotionEligible === false &&
      result.operationRef === source.operationRef &&
      result.sessionId === source.sessionId &&
      result.destinationDigest === source.destinationAdmissionDigest &&
      result.snapshotDigest === metadata.dumpDigest &&
      result.metadataDigest === sha256Canonical(metadata) &&
      result.ownershipMapDigest === metadata.ownershipMapDigest
  );
  need(
    acknowledgementTime(result.completedAt) <= acknowledgementTime(execution.finishedAt) &&
      acknowledgementTime(execution.finishedAt) <= acknowledgementTime(execution.recordedAt) &&
      acknowledgementTime(execution.recordedAt) <= acknowledgementTime(source.completedAt)
  );
  // This is the admitted declaration, usable here only after the native holder
  // has completed the real consumer and retained its matching result above.
  const bundle = bundleInputs.manifest;
  need(
    Object.keys(bundle).length === 5 &&
      bundle.dumpDigest === metadata.dumpDigest &&
      bundle.metadataDigest === result.metadataDigest &&
      bundle.privilegeObservationDigest === metadata.sourcePrivilegeObservationDigest &&
      DIGEST.test(bundle.fingerprintObservationDigest) &&
      bundle.scanDigest === metadata.scanDigest &&
      sha256Canonical(bundle) === bundleInputs.digest
  );
  need(Array.isArray(result.databaseResults) && result.databaseResults.length > 0);
  const names = new Set();
  const observations = result.databaseResults.map((database) => {
    need(
      /^s1ci_[0-9a-f]{24}$/u.test(database.databaseName) &&
        /^[1-9][0-9]*$/u.test(database.databaseOid) &&
        !names.has(database.databaseName) &&
        DIGEST.test(database.ownershipObservationDigest)
    );
    names.add(database.databaseName);
    return {
      databaseName: database.databaseName,
      ownershipObservationDigest: database.ownershipObservationDigest
    };
  });
  return Object.freeze({
    snapshotMetadataDigest: result.metadataDigest,
    snapshotBundleDigest: bundleInputs.digest,
    sourceMigrationHead: metadata.sourceMigrationHead,
    ownershipMapDigest: result.ownershipMapDigest,
    ownershipObservationDigest: sha256Canonical(observations)
  });
}

export function buildR3SourceGateEvidence({
  spec,
  job,
  execution,
  result,
  reconstructed,
  postgres,
  migrationCatalogDigest,
  repositoryContractDigest,
  snapshot
}) {
  const code = "R3_SOURCE_GATE_RESULT_INVALID";
  try {
    need(spec.phase === "source" && ["fresh", "snapshot"].includes(spec.chain));
    need(spec.chain === "snapshot" ? snapshot !== undefined : snapshot === undefined);
    need(
      result.schemaVersion === "manual-r3-source-result.v1" && result.promotionEligible === false
    );
    need(result.operationRef === spec.operationRef && job.operationRef === spec.operationRef);
    for (const field of [
      "profileDigest",
      "ownerId",
      "sourceSha",
      "buildProofDigest",
      "targetPolicyDigest",
      "phase",
      "chain"
    ])
      need(
        result[field] === spec[field] &&
          (field === "targetPolicyDigest" || job[field] === spec[field])
      );
    need(
      result.creationSpecDigest === sha256Canonical(spec) &&
        job.creationSpecDigest === result.creationSpecDigest &&
        result.jobAdmissionDigest === sha256Canonical(job) &&
        execution.schemaVersion === "manual-operation-record.v3" &&
        execution.kind === "execution" &&
        execution.stage === "candidate-use" &&
        execution.status === "SUCCEEDED" &&
        execution.reasonCode === null &&
        execution.promotionEligible === false &&
        execution.operationId === spec.operationRef &&
        execution.resultDigest === sha256Canonical(result) &&
        execution.processEvidenceDigest === result.readbackDigest &&
        ["profileDigest", "sessionId", "sessionNonce"].every(
          (field) => execution[field] === result[field]
        ) &&
        result.reconstructedDigest === sha256Canonical(reconstructed) &&
        result.databaseTestManifestDigest === reconstructed.manifestReport.manifestDigest
    );
    const report = reconstructed.manifestReport,
      counts = report.counts,
      ci = job.ci;
    need(
      report.chain === spec.chain &&
        report.terminalStatus === "PASSED" &&
        counts.executed > 0 &&
        counts.collected === counts.selected &&
        counts.selected === counts.executed &&
        counts.executed === counts.passed &&
        ["failed", "skipped", "todo", "filtered", "cancelled"].every((field) => counts[field] === 0)
    );
    need(
      ci.repository === "keqi119/subscription-Saas" &&
        /^[1-9][0-9]*$/u.test(ci.runId) &&
        ci.runAttempt === 1 &&
        ci.workflowPath === ".github/workflows/release-candidate-gate.yml" &&
        ci.callerWorkflowPath === ci.workflowPath &&
        ci.jobKey === `source-${spec.chain}` &&
        ci.jobName === `source-${spec.chain}`
    );
    need(
      acknowledgementTime(result.completedAt) <= acknowledgementTime(execution.finishedAt) &&
        acknowledgementTime(execution.finishedAt) <= acknowledgementTime(execution.recordedAt)
    );
    return runSourceDatabaseGate({
      manifestReport: report,
      sourceSha: spec.sourceSha,
      migrationCatalogDigest,
      repositoryContractDigest,
      postgres: Object.freeze({ ...postgres }),
      schemaDiffDigest: reconstructed.schemaDiffDigest,
      migrationStatusDigest: reconstructed.migrationStatusDigest,
      postSchemaDigest: reconstructed.postSchemaDigest,
      ...(spec.chain === "snapshot"
        ? { snapshot: sourceSnapshotProjection(snapshot, result) }
        : {}),
      provenance: Object.freeze({
        generatedAt: result.completedAt,
        ciRunRef: `github://${ci.repository}/actions/runs/${ci.runId}/attempts/${ci.runAttempt}`,
        executorVersion: "manual-r3-source-database-gate.v1"
      })
    });
  } catch {
    throw Object.assign(new Error(code), { code });
  }
}

// A record shape only. The caller must first replay the complete source proof
// and obtain the owner's explicit acknowledgement; this never grants authority.
export function buildR3SourceAcknowledgement({
  profileDigest,
  ownerId,
  execution,
  result,
  observedAt,
  recordedAt
}) {
  try {
    validateContract("manual-operation-record.v3", execution);
    need(
      DIGEST.test(profileDigest) &&
        typeof ownerId === "string" &&
        ownerId.length > 0 &&
        execution.kind === "execution" &&
        execution.stage === "candidate-use" &&
        execution.status === "SUCCEEDED" &&
        execution.promotionEligible === false &&
        execution.reasonCode === null &&
        execution.profileDigest === profileDigest &&
        DIGEST.test(execution.predecessorExecutionRecordDigest) &&
        DIGEST.test(execution.processEvidenceDigest) &&
        result?.schemaVersion === "manual-r3-source-result.v1" &&
        result.promotionEligible === false &&
        result.phase === "source" &&
        ["fresh", "snapshot"].includes(result.chain) &&
        result.profileDigest === profileDigest &&
        result.ownerId === ownerId &&
        result.operationRef === execution.operationId &&
        result.sessionId === execution.sessionId &&
        result.sessionNonce === execution.sessionNonce &&
        result.requestDigest === execution.requestDigest &&
        result.candidateUseExecutionRecordDigest === execution.predecessorExecutionRecordDigest &&
        result.readbackDigest === execution.processEvidenceDigest &&
        sha256Canonical(result) === execution.resultDigest
    );
    need(
      acknowledgementTime(result.completedAt) <= acknowledgementTime(execution.finishedAt) &&
        acknowledgementTime(execution.finishedAt) <= acknowledgementTime(execution.recordedAt) &&
        acknowledgementTime(execution.recordedAt) <= acknowledgementTime(observedAt) &&
        acknowledgementTime(observedAt) <= acknowledgementTime(recordedAt)
    );
    const subjectDigest = sha256Canonical(execution);
    const acknowledgement = {
      schemaVersion: "manual-operation-record.v3",
      profileDigest,
      recordedAt,
      promotionEligible: false,
      kind: "custody",
      ownerId,
      subjectDigest,
      subjectType: "record",
      purpose: "owner-acknowledgement",
      outcome: "MATCH",
      observedDigest: subjectDigest,
      observedAt,
      storageRole: "archive",
      retentionDays: 90,
      reasonCode: null
    };
    validateContract("manual-operation-record.v3", acknowledgement);
    encodeManualJson(acknowledgement);
    return Object.freeze(acknowledgement);
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

// Compare a retained acknowledgement with the one exact record this terminal
// can authorize for an owner who has already taken the explicit action.
export function assertR3SourceAcknowledgement({
  acknowledgement,
  profileDigest,
  ownerId,
  execution,
  result,
  now
}) {
  try {
    need(acknowledgementTime(acknowledgement?.recordedAt) <= acknowledgementTime(now));
    const expected = buildR3SourceAcknowledgement({
      profileDigest,
      ownerId,
      execution,
      result,
      observedAt: acknowledgement.observedAt,
      recordedAt: acknowledgement.recordedAt
    });
    need(same(acknowledgement, expected));
    return expected;
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}
