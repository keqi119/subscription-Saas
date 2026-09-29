// Reconstruct a source result from retained originals. Callers must separately
// establish the fixed candidate, private readbacks, live authority and custody.
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { encodePrivateObservationJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import {
  buildDatabaseSuiteReport,
  runDatabaseManifest
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
          binding.creationExecutionRecordDigest
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
    const held = [];
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
      suiteReadbacks: reconstructed.suiteReadbacks
    });
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}
