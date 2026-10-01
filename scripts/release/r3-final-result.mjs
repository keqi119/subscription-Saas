// Internal reconstruction from fixed, independently read H1 originals. This
// does not authenticate source history, confer execution authority or custody.
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  encodeManualJson,
  encodePrivateObservationJson
} from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { planR3DatabaseTargets } from "./r3-database-targets.mjs";
import { validateFinalDatabaseTestAssignments } from "../../apps/release-runner/src/database-test-envelope.mjs";
import { createR3FinalMigrationAssessment } from "./r3-final-migration-result.mjs";
import { assessFinalRuntimePreparation } from "../../apps/release-runner/src/final-runtime-preparation.mjs";
import { observeFinalRuntimeBoundary } from "../../apps/release-runner/src/final-database-runtime.mjs";

const CODE = "R3_FINAL_RESULT_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LIMIT = 33554432;
const need = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const LIFECYCLE = "node.release-database-lifecycle.postgres";

export function r3FinalObservationNames({ manifest, plan }) {
  const expected = planR3DatabaseTargets({
    operationRef: plan.operationRef,
    phase: "final",
    chain: plan.chain,
    manifest
  });
  need(same(plan, expected));
  const names = [
    "attempt",
    "source",
    ...plan.targets.map(({ databaseName }) => databaseName),
    ...plan.reservations.map(({ databaseName }) => databaseName),
    "runtime",
    ...manifest.suites.map(({ suiteId }) => suiteId),
    "application",
    "manifest"
  ];
  need(
    new Set(names).size === names.length &&
      names.every((name) => /^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(name))
  );
  return Object.freeze(names);
}

// A data projection only. The reader calls this after independently checking
// the retained originals; calling it alone does not authenticate those inputs.
export function projectR3FinalPublicFacts({
  request,
  buildProof,
  migrationCatalog,
  discovery,
  destination,
  targetPlan,
  sourceGateEvidence,
  applicationObservation,
  applicationAssessment
}) {
  try {
    const images = buildProof.identity.images;
    const applicationPlan = applicationObservation.plan;
    const postgres = destination.postgres;
    const facts = {
      releaseImages: Object.fromEntries(
        ["api", "web", "runner"].map((role) => [
          role,
          `${images[role].registry}@${images[role].imageDigest}`
        ])
      ),
      contracts: {
        migrationCatalogDigest: migrationCatalog.digest,
        repositoryContractDigest: buildProof.identity.repositoryContractDigest,
        databaseTestManifestDigest: request.databaseTestManifestDigest,
        databaseTestDiscoveryDigest: discovery.discoveryDigest,
        postgresImageDigest: postgres.imageDigest,
        snapshotMetadataDigest: sourceGateEvidence.snapshot?.snapshotMetadataDigest ?? null
      },
      sourceGateEvidence,
      destination: {
        admissionDigest: request.destinationAdmissionDigest,
        creationEvidenceDigest: destination.hostedEvidenceDigest,
        targetPlanDigest: sha256Canonical(targetPlan),
        engineId: postgres.engineId,
        containerId: postgres.containerId,
        systemIdentifier: postgres.postgres.systemIdentifier,
        imageDigest: postgres.imageDigest,
        serverVersionNum: String(postgres.postgres.serverVersionNum)
      },
      application: {
        manifestDigest: sha256Canonical(applicationPlan.manifest),
        manifestIdentityDigest: sha256Canonical(applicationPlan.manifest.identity),
        databaseIdentityFingerprint: applicationPlan.manifest.identity.databaseIdentityFingerprint,
        apiSessionNonceDigest: sha256Bytes(Buffer.from(applicationPlan.identity.apiSessionNonce)),
        apiReadiness: applicationObservation.observations.verifyApi.apiReadiness,
        webClient: applicationObservation.observations.verifyWebClient,
        assessment: applicationAssessment
      }
    };
    need(encodeManualJson(facts).length <= 1048576);
    return freeze(globalThis.structuredClone(facts));
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}

function candidate(request, initialExecution, manifest) {
  validateContract("manual-runner-request.v5", request);
  validateContract("manual-operation-record.v3", initialExecution);
  need(
    request.phase === "final" &&
      request.stage === "candidate-use" &&
      request.capability === "execute-final-database-tests" &&
      request.purpose === "stage1-isolated-database-tests" &&
      request.databaseTestManifestDigest === sha256Canonical(manifest) &&
      initialExecution.kind === "execution" &&
      initialExecution.stage === "candidate-use" &&
      initialExecution.status === "INTERRUPTED_UNKNOWN" &&
      initialExecution.promotionEligible === false &&
      initialExecution.reasonCode === "MANUAL_EVIDENCE_INCOMPLETE" &&
      ["startedAt", "finishedAt", "resultDigest", "processEvidenceDigest"].every(
        (key) => initialExecution[key] === null
      ) &&
      initialExecution.requestDigest === sha256Canonical(request) &&
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
}

export async function readR3FinalOriginals({
  manifest,
  plan,
  discovery,
  request,
  initialExecution,
  destination,
  buildProof,
  migrationCatalog,
  globalObjectPolicy,
  lifecycleRecords,
  readObservation,
  recheck,
  repoRoot
}) {
  try {
    candidate(request, initialExecution, manifest);
    need(
      typeof readObservation === "function" &&
        typeof recheck === "function" &&
        discovery?.classification?.unclassified?.length === 0 &&
        DIGEST.test(discovery.discoveryDigest) &&
        destination.schemaVersion === "manual-r3-destination.v1" &&
        sha256Canonical(destination) === request.destinationAdmissionDigest &&
        same(plan, destination.databaseTargetSet.plan) &&
        plan.operationRef === request.operationId &&
        plan.chain === request.chain &&
        sha256Canonical(buildProof) === request.candidate.buildProofDigest &&
        buildProof.identity.sourceSha === request.sourceSha &&
        buildProof.identity.migrationCatalogDigest === migrationCatalog.digest
    );
    const names = r3FinalObservationNames({ manifest, plan }),
      held = [],
      originals = [],
      values = new Map();
    await recheck();
    for (const name of names) {
      let first;
      for (const storageRole of ["archive", "backup"]) {
        const value = await readObservation({ storageRole, name });
        need(value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= LIMIT);
        const bytes = Buffer.from(value);
        if (first) need(first.equals(bytes));
        else first = bytes;
        held.push({ storageRole, name, bytes });
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(first));
      need(encodePrivateObservationJson(value).equals(first));
      values.set(name, value);
      originals.push({ name, digest: sha256Bytes(first), bytes: first.length });
    }
    const attempt = values.get("attempt"),
      source = values.get("source"),
      runtime = values.get("runtime"),
      observed = values.get("manifest");
    need(
      same(attempt, {
        status: "FINAL_MANIFEST_INTERRUPTED_UNKNOWN",
        operationRef: request.operationId,
        sessionId: request.sessionId,
        sessionNonce: request.sessionNonce,
        candidateUseExecutionRecordDigest: sha256Canonical(initialExecution),
        matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
        promotionEligible: false
      })
    );
    // This retained public gate is a claim until the core compares its digest
    // with the independently authenticated source-history projection.
    validateContract("source-gate-evidence.v1", source?.sourceGateEvidence);
    need(
      exact(source, [
        "status",
        "matchingSourceEvidenceDigest",
        "sourceGateEvidenceDigest",
        "sourceGateEvidence",
        "promotionEligible"
      ]) &&
        source.status === "FINAL_SOURCE_GATE_OBSERVED" &&
        source.promotionEligible === false &&
        source.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest &&
        DIGEST.test(source.sourceGateEvidenceDigest) &&
        encodeManualJson(source.sourceGateEvidence).length <= 1048576 &&
        source.sourceGateEvidenceDigest === sha256Canonical(source.sourceGateEvidence) &&
        source.sourceGateEvidence.sourceSha === request.sourceSha &&
        source.sourceGateEvidence.chain === request.chain &&
        source.sourceGateEvidence.terminalStatus === "PASSED" &&
        source.sourceGateEvidence.migrationCatalogDigest === migrationCatalog.digest &&
        source.sourceGateEvidence.repositoryContractDigest ===
          buildProof.identity.repositoryContractDigest &&
        source.sourceGateEvidence.databaseTestManifestDigest ===
          request.databaseTestManifestDigest &&
        source.sourceGateEvidence.databaseTestDiscoveryDigest === discovery.discoveryDigest &&
        source.sourceGateEvidence.postgres.imageDigest === destination.postgres.imageDigest &&
        source.sourceGateEvidence.postgres.serverVersionNum ===
          String(destination.postgres.postgres.serverVersionNum)
    );
    need(
      exact(observed, [
        "status",
        "envelope",
        "manifestReport",
        "applicationEvidenceDigest",
        "sourceGateEvidenceDigest",
        "observations",
        "promotionEligible"
      ]) &&
        observed.status === "FINAL_MANIFEST_OBSERVED" &&
        observed.sourceGateEvidenceDigest === source.sourceGateEvidenceDigest &&
        observed.promotionEligible === false &&
        runtime.promotionEligible === false &&
        same(runtime.envelope, observed.envelope)
    );
    const envelope = runtime.envelope;
    const admitted = validateFinalDatabaseTestAssignments({
      envelope,
      manifest,
      discoveryDigest: discovery.discoveryDigest
    });
    const postgres = destination.postgres;
    const parent = {
      ...pick(request, [
        "phase",
        "chain",
        "profileDigest",
        "sessionId",
        "sessionNonce",
        "operationId",
        "runId",
        "attemptId",
        "sourceSha"
      ]),
      candidateUseExecutionRecordDigest: sha256Canonical(initialExecution),
      matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
      destinationAdmissionDigest: request.destinationAdmissionDigest,
      creationEvidenceDigest: destination.hostedEvidenceDigest,
      databaseTargetPlanDigest: sha256Canonical(plan),
      databaseTestManifestDigest: request.databaseTestManifestDigest,
      databaseTestDiscoveryDigest: discovery.discoveryDigest,
      buildProof,
      buildProofDigest: request.candidate.buildProofDigest,
      actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
      runnerContainerId: envelope.runnerContainerId,
      postgres: {
        engineId: postgres.engineId,
        containerId: postgres.containerId,
        systemIdentifier: postgres.postgres.systemIdentifier,
        imageDigest: postgres.imageDigest,
        hostname: "postgres",
        port: 5432,
        tlsMode: "require"
      }
    };
    need(
      Object.entries(parent).every(([key, value]) => same(envelope[key], value)) &&
        envelope.databaseTestManifestReference ===
          "launch-file:///run/launch/database-test-manifest.json" &&
        same(admitted.plan, plan)
    );
    need(Array.isArray(lifecycleRecords) && lifecycleRecords.length === 2);
    const records = [
      ...destination.databaseTargetSet.records.filter((record) =>
        plan.targets.some((item) => item.databaseName === record.databaseName)
      ),
      ...lifecycleRecords
    ];
    const planned = [...plan.targets, ...plan.reservations];
    need(
      records.length === planned.length &&
        new Set(records.map((record) => record.databaseOid)).size === records.length
    );
    const { assessR3FinalContainerOriginals } = await import("./r3-final-migration-container.mjs");
    const identity = {
      operationRef: request.operationId,
      sourceSha: request.sourceSha,
      imageDigest: parent.actualRunnerDigest,
      imageReference: `ghcr.io/keqi119/subscription-runner@${parent.actualRunnerDigest}`,
      postgresAddress: postgres.containerAddress
    };
    const preparations = {},
      migrationDigests = [],
      fingerprints = new Set();
    let sourceClaims;
    for (const target of planned) {
      const record = records.find(({ databaseName }) => databaseName === target.databaseName);
      need(record && same(record.roles, target.roles) && record.shard === target.shard);
      const saved = values.get(target.databaseName);
      need(
        exact(saved, [
          "status",
          "input",
          "physical",
          "schema",
          "preparation",
          "boundary",
          "originals",
          "promotionEligible"
        ]) &&
          saved.status === "FINAL_MIGRATION_OBSERVED" &&
          saved.promotionEligible === false
      );
      const input = saved.input;
      need(
        Object.entries(parent).every(([key, value]) => same(input[key], value)) &&
          input.database.databaseName === record.databaseName &&
          input.database.databaseOid === record.databaseOid &&
          input.database.marker === record.marker &&
          input.database.migrationRole === record.roles.migrate &&
          input.migrationCatalogDigest === migrationCatalog.digest &&
          same(
            input.assignment,
            target.kind === "application"
              ? { kind: "application" }
              : target.kind === "suite"
                ? { kind: "suite", suiteId: target.suiteId, name: target.name }
                : { kind: "lifecycle-owned", suiteId: LIFECYCLE, lifecycleShard: target.shard }
          )
      );
      const claims = {
        matchingSourceEvidenceDigest: input.matchingSourceEvidenceDigest,
        matchingSourceResultDigest: input.matchingSourceResultDigest,
        expectedSchemaDigest: input.expectedSchemaDigest,
        sourceGateEvidenceDigest: source.sourceGateEvidenceDigest
      };
      need(Object.values(claims).every((value) => DIGEST.test(value)));
      if (sourceClaims) need(same(sourceClaims, claims));
      else sourceClaims = claims;
      for (const key of ["runtimeCredentialFingerprint", "migrationCredentialFingerprint"]) {
        const value = input.database[key];
        need(DIGEST.test(value) && !fingerprints.has(value));
        fingerprints.add(value);
      }
      assessR3FinalContainerOriginals({
        identity: { ...identity, runnerContainerId: envelope.runnerContainerId },
        role: "migration",
        originals: saved.originals
      });
      need(
        same(saved.originals.inputIdentity, input) &&
          saved.originals.containerId === input.migrationContainerId
      );
      const results = saved.originals.channel.results;
      need(
        Array.isArray(results) &&
          results.length === 4 &&
          Array.isArray(saved.physical) &&
          saved.physical.length === 4
      );
      let n = 0;
      const assessment = createR3FinalMigrationAssessment({
        input,
        manifest,
        migrationCatalog,
        globalObjectPolicy,
        observeTarget: async () => saved.physical[n++]
      });
      for (const [i, stage] of ["plan", "apply", "verify"].entries())
        await assessment.assess({ stage, result: results[i] });
      need(
        n === 3 &&
          same(saved.schema, assessment.finish()) &&
          same(saved.physical[3], saved.physical[2])
      );
      const preparation = await assessFinalRuntimePreparation({
        input,
        manifest,
        migrationCatalog,
        globalObjectPolicy,
        preparation: results[3].preparation,
        repoRoot
      });
      need(same(saved.preparation, preparation));
      const database = {
        ...input.database,
        runtimeRole: target.roles["runtime-test"],
        databaseIdentityFingerprint: sha256Canonical({
          databaseName: record.databaseName,
          databaseOid: record.databaseOid,
          role: target.roles["runtime-test"],
          tls: true
        }),
        migrationEvidenceDigest: sha256Canonical(saved),
        runtimeSecretReference: `secret-file:///run/secrets/${record.databaseName}-runtime-test.json`
      };
      const boundary = await observeFinalRuntimeBoundary(
        { $queryRawUnsafe: async () => [saved.boundary.identity] },
        database
      );
      need(same(saved.boundary, boundary));
      if (target.kind === "suite") {
        need(same(envelope.suiteAssignments[target.suiteId].databases[target.name], database));
        preparations[target.databaseName] = {
          migrationEvidenceDigest: database.migrationEvidenceDigest,
          schemaFixture: preparation.schemaFixture
        };
      }
      migrationDigests.push({ databaseName: record.databaseName, digest: sha256Canonical(saved) });
    }
    need(source.sourceGateEvidence.postSchemaDigest === sourceClaims.expectedSchemaDigest);
    const suiteReadbacks = manifest.suites.map(({ suiteId }) => values.get(suiteId));
    const result = { manifestReport: observed.manifestReport, suiteReadbacks };
    need(runtime.resultDigest === sha256Canonical(result));
    const {
      envelope: ignoredEnvelope,
      transcript,
      resultDigest,
      promotionEligible,
      ...container
    } = runtime;
    assessR3FinalContainerOriginals({
      identity,
      role: "runtime",
      originals: { ...container, channel: { result, transcript } }
    });
    need(
      same(container.inputIdentity, envelope) &&
        container.containerId === envelope.runnerContainerId
    );
    const lifecycle = suiteReadbacks.find(({ suiteId }) => suiteId === LIFECYCLE);
    // The lifecycle result carried inside the final manifest must be the exact
    // original/result pair exchanged with H1, not another independently valid pair.
    const lifecycleOriginals = JSON.parse(transcript[44].raw).payload.originals;
    const lifecycleResult = JSON.parse(transcript[45].raw).payload;
    need(
      same(lifecycle.originals.lifecycle, lifecycleOriginals) &&
        same(lifecycleResult.originals, lifecycleOriginals) &&
        same(lifecycleResult.report, lifecycle.report)
    );
    const { assessR3FinalSuiteReadbacks } = await import("./r3-final-suite-result.mjs");
    const reconstructed = await assessR3FinalSuiteReadbacks({
      envelope,
      manifest,
      discoveryDigest: discovery.discoveryDigest,
      runtimePreparations: preparations,
      suiteReadbacks,
      lifecycle: {
        records: lifecycleRecords,
        observations: observed.observations,
        originals: lifecycle.originals.lifecycle
      },
      repoRoot
    });
    need(same(reconstructed.manifestReport, observed.manifestReport));
    const application = values.get("application");
    need(
      exact(application, [
        "status",
        "observedAt",
        "buildMaterialObservation",
        "observation",
        "inventoryReadbacks",
        "reconstructed",
        "promotionEligible"
      ]) &&
        application.status === "FINAL_APPLICATION_OBSERVED" &&
        application.promotionEligible === false &&
        observed.applicationEvidenceDigest === sha256Canonical(application)
    );
    const applicationTarget = plan.targets.find(({ kind }) => kind === "application");
    const applicationRecord = records.find(
      ({ databaseName }) => databaseName === applicationTarget?.databaseName
    );
    need(applicationTarget && applicationRecord);
    const { assessR3ApplicationOriginals } = await import("./r3-application-originals.mjs");
    const applicationReconstructed = await assessR3ApplicationOriginals({
      context: {
        request,
        buildProof,
        buildMaterialObservation: application.buildMaterialObservation,
        postgres: destination.postgres,
        record: applicationRecord,
        migration: values.get(applicationTarget.databaseName),
        creationEvidenceDigest: destination.hostedEvidenceDigest,
        targetPolicyRef: `release/contracts/manual-stage1-r3-target-policy.v1.json@${request.targetPolicyDigest}`,
        observedAt: application.observedAt
      },
      observation: application.observation,
      inventoryReadbacks: application.inventoryReadbacks,
      repoRoot
    });
    need(same(applicationReconstructed, application.reconstructed));
    await recheck();
    for (const { storageRole, name, bytes } of held) {
      const current = await readObservation({ storageRole, name });
      need(current instanceof Uint8Array && Buffer.from(current).equals(bytes));
    }
    const publicFacts = projectR3FinalPublicFacts({
      request,
      buildProof,
      migrationCatalog,
      discovery,
      destination,
      targetPlan: plan,
      sourceGateEvidence: source.sourceGateEvidence,
      applicationObservation: application.observation,
      applicationAssessment: applicationReconstructed
    });
    const finalReconstructed = freeze({
      manifestReport: reconstructed.manifestReport,
      migrationDigests,
      sourceClaims,
      sourceOriginalDigest: originals.find(({ name }) => name === "source").digest,
      applicationDigest: sha256Canonical(application),
      applicationReconstructedDigest: sha256Canonical(applicationReconstructed),
      runtimeDigest: sha256Canonical(runtime),
      publicFacts
    });
    return freeze({
      readbackDigest: sha256Canonical(observed),
      reconstructedDigest: sha256Canonical(finalReconstructed),
      reconstructed: finalReconstructed,
      sourceClaims,
      suiteReadbacks: suiteReadbacks.map((item) => ({
        suiteId: item.suiteId,
        readbackDigest: sha256Canonical(item),
        reportDigest: sha256Canonical(item.report)
      })),
      originals
    });
  } catch (cause) {
    const error = Object.assign(new Error(CODE), { code: CODE });
    Object.defineProperty(error, "cause", { value: cause });
    throw error;
  }
}

const time = (value) => {
  need(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
  return Date.parse(value);
};

export function buildR3FinalCompletion({
  request,
  initialExecution,
  manifest,
  verified,
  custodyRecords,
  completedAt
}) {
  candidate(request, initialExecution, manifest);
  const plan = planR3DatabaseTargets({
    operationRef: request.operationId,
    phase: "final",
    chain: request.chain,
    manifest
  });
  const names = r3FinalObservationNames({ manifest, plan });
  const initialAt = time(initialExecution.recordedAt),
    completed = time(completedAt);
  need(
    initialAt <= completed &&
      DIGEST.test(verified?.readbackDigest) &&
      DIGEST.test(verified.reconstructedDigest) &&
      exact(verified.sourceClaims, [
        "matchingSourceEvidenceDigest",
        "matchingSourceResultDigest",
        "expectedSchemaDigest",
        "sourceGateEvidenceDigest"
      ]) &&
      Object.values(verified.sourceClaims).every((value) => DIGEST.test(value)) &&
      verified.sourceClaims.matchingSourceEvidenceDigest === request.matchingSourceEvidenceDigest &&
      Array.isArray(verified.originals) &&
      verified.originals.length === names.length &&
      Array.isArray(verified.suiteReadbacks) &&
      verified.suiteReadbacks.length === manifest.suites.length
  );
  const digests = new Set();
  const originals = verified.originals.map((item, index) => {
    need(
      exact(item, ["name", "digest", "bytes"]) &&
        item.name === names[index] &&
        DIGEST.test(item.digest) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes > 0 &&
        item.bytes <= LIMIT &&
        !digests.has(item.digest)
    );
    digests.add(item.digest);
    return { ...item };
  });
  need(originals.at(-1).digest === verified.readbackDigest);
  for (const [i, suite] of manifest.suites.entries()) {
    const entry = verified.suiteReadbacks[i];
    need(
      entry.suiteId === suite.suiteId &&
        entry.readbackDigest === originals.find(({ name }) => name === suite.suiteId).digest &&
        DIGEST.test(entry.reportDigest)
    );
  }
  need(Array.isArray(custodyRecords) && custodyRecords.length === originals.length * 2);
  const pairs = new Map();
  for (const custody of custodyRecords) {
    validateContract("manual-operation-record.v3", custody);
    const role = custody.storageRole,
      pair = `${custody.subjectDigest}:${role}`;
    need(
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
        !pairs.has(pair) &&
        initialAt <= time(custody.observedAt) &&
        time(custody.observedAt) <= time(custody.recordedAt) &&
        time(custody.recordedAt) <= completed
    );
    pairs.set(pair, sha256Canonical(custody));
  }
  const custodyRecordDigests = originals.flatMap(({ digest }) =>
    ["archive", "backup"].map((role) => {
      const value = pairs.get(`${digest}:${role}`);
      need(DIGEST.test(value));
      return value;
    })
  );
  const result = {
    schemaVersion: "manual-r3-final-result.v1",
    operationRef: request.operationId,
    ...pick(request, [
      "profileDigest",
      "ownerId",
      "sessionId",
      "sessionNonce",
      "sourceSha",
      "targetPolicyDigest",
      "creationSpecDigest",
      "jobAdmissionDigest",
      "phase",
      "chain",
      "destinationAdmissionDigest",
      "preparationExecutionRecordDigest",
      "databaseTestManifestDigest",
      "matchingSourceEvidenceDigest"
    ]),
    buildProofDigest: request.candidate.buildProofDigest,
    candidateUseExecutionRecordDigest: sha256Canonical(initialExecution),
    requestDigest: sha256Canonical(request),
    readbackDigest: verified.readbackDigest,
    reconstructedDigest: verified.reconstructedDigest,
    sourceClaims: { ...verified.sourceClaims },
    originals,
    custodyRecordDigests,
    completedAt,
    promotionEligible: false
  };
  encodeManualJson(result);
  return freeze(result);
}

// A record shape only. The caller must authenticate the retained final and
// source originals and obtain the owner's explicit action before calling this.
export function buildR3FinalAcknowledgement({
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
        result?.schemaVersion === "manual-r3-final-result.v1" &&
        result.promotionEligible === false &&
        result.phase === "final" &&
        ["fresh", "snapshot"].includes(result.chain) &&
        result.profileDigest === profileDigest &&
        result.ownerId === ownerId &&
        result.operationRef === execution.operationId &&
        result.sessionId === execution.sessionId &&
        result.sessionNonce === execution.sessionNonce &&
        result.requestDigest === execution.requestDigest &&
        result.candidateUseExecutionRecordDigest === execution.predecessorExecutionRecordDigest &&
        result.readbackDigest === execution.processEvidenceDigest &&
        DIGEST.test(result.matchingSourceEvidenceDigest) &&
        exact(result.sourceClaims, [
          "matchingSourceEvidenceDigest",
          "matchingSourceResultDigest",
          "expectedSchemaDigest",
          "sourceGateEvidenceDigest"
        ]) &&
        Object.values(result.sourceClaims).every((value) => DIGEST.test(value)) &&
        result.sourceClaims.matchingSourceEvidenceDigest === result.matchingSourceEvidenceDigest &&
        sha256Canonical(result) === execution.resultDigest
    );
    need(
      time(result.completedAt) <= time(execution.finishedAt) &&
        time(execution.finishedAt) <= time(execution.recordedAt) &&
        time(execution.recordedAt) <= time(observedAt) &&
        time(observedAt) <= time(recordedAt)
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

// This comparison does not grant authority or authenticate the source claims.
export function assertR3FinalAcknowledgement({
  acknowledgement,
  profileDigest,
  ownerId,
  execution,
  result,
  now
}) {
  try {
    need(time(acknowledgement?.recordedAt) <= time(now));
    const expected = buildR3FinalAcknowledgement({
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
