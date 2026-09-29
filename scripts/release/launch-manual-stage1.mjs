#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import http from "node:http";
import net from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  computeRepositoryContract,
  computeMigrationCatalog,
  computeManualClusterFingerprint,
  assertManualDecision,
  assessManualRunnerEvidence,
  verifyManualAuthorization,
  verifyManualHandoff,
  encodeManualRunnerFrame,
  validateManualRunnerProtocol,
  deterministicPlanDigest,
  validateContract,
  validateManualRunnerRequest,
  parseManualRunnerFrames,
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  classifyDatabaseTests,
  discoverDatabaseTestCandidates,
  scanDatabaseFrameworkBypasses,
  runDatabaseManifest
} from "../../packages/release-foundation/src/index.mjs";
import { encodePrivateObservationJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import {
  loadFixedManualProfile,
  readFixedManualOperation,
  verifyManualBuild,
  openTrustedManualSession,
  readFixedR3JobAdmission,
  prepareR3HostedEvidenceImport,
  importR3HostedEvidence,
  importR3HostedCleanupEvidence,
  openTrustedR3CreationSession
} from "./manual-stage1-trust.mjs";
import { openR3H1ForwardLease } from "./r3-h1-forward-lease.mjs";
import {
  assessR3PostgresObservation,
  assessR3FinalPostgresObservation
} from "./r3-postgres-observation.mjs";
import {
  assessR3PostgresReadback,
  assessR3FinalPostgresReadback,
  buildR3Destination
} from "./r3-destination.mjs";
import {
  executeR3FinalMigrationContainer,
  executeR3FinalRuntimeContainer
} from "./r3-final-migration-container.mjs";
import { createR3FinalMigrationAssessment } from "./r3-final-migration-result.mjs";
import { assessFinalRuntimePreparation } from "../../apps/release-runner/src/final-runtime-preparation.mjs";
import { observeFinalRuntimeBoundary } from "../../apps/release-runner/src/final-database-runtime.mjs";
import { validateFinalDatabaseTestAssignments } from "../../apps/release-runner/src/database-test-envelope.mjs";
import { readR3SnapshotInput } from "./r3-snapshot-input-admission.mjs";
import { fetchR3SnapshotCiphertext } from "./r3-snapshot-payload.mjs";
import { decryptR3SnapshotCiphertext } from "./r3-h1-snapshot-decrypt.mjs";
import { exchangeR3Engine } from "./r3-engine-exchange.mjs";
import { copyR3SnapshotToPostgres } from "./r3-remote-snapshot-copy.mjs";
import { restoreR3SnapshotDatabase } from "./r3-remote-snapshot-restore.mjs";
import { createR3LifecycleAdapter } from "./r3-lifecycle-adapter.mjs";
import {
  executeR3LifecycleSuite,
  assertR3FinalLifecycleOriginals
} from "./r3-lifecycle-test-runner.mjs";
import {
  executeR3SourceSuite,
  runR3SourceProcess,
  r3RuntimeBoundary,
  r3RuntimeBoundarySql
} from "./r3-source-suite.mjs";
import { buildR3SourceResult, assertR3SourceAcknowledgement } from "./r3-source-result.mjs";
import { buildDatabaseSuiteReport } from "../../packages/release-foundation/src/database-test-launcher.mjs";
import { databaseTestCounts, summarizeDatabaseTestLog } from "./database-test-launcher-runtime.mjs";
import {
  bindR3SourceManifest,
  bindR3FinalManifest,
  planR3DatabaseTargets,
  provisionR3DatabaseTargets,
  recheckR3DatabaseTargets
} from "./r3-database-targets.mjs";
import {
  sameIdentity,
  samePublicDirectory,
  observedPath,
  readPinned,
  nativeText,
  ownerOnly,
  checkedPrivatePath,
  h3Same,
  h3Require,
  canonicalH3,
  pinPrivateInput,
  readCanonicalPrivateInput,
  openManualH3AInputs,
  openManualH3BInputs,
  expectedLimit,
  expectedRequire,
  expectedText,
  expectedJson,
  expectedEqual,
  expectedOrder,
  expectedGhArgv,
  expectedGhResult,
  openManualExpectedSchemaInputs
} from "./manual-runner-source-inputs.mjs";
import { createPostgresConnector } from "../../apps/release-runner/src/postgres-connector.mjs";
import { observeManualTarget } from "../../apps/release-runner/src/manual-target-observer.mjs";
import { buildManualBaseline } from "../../apps/release-runner/src/manual-command-adapter.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}

export async function prepareManualOperation(input) {
  if (!exact(input, ["proofBytes", "materialBytes", "targetIntent", "scenario"]))
    fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
  const proofBytes =
    Buffer.isBuffer(input.proofBytes) && input.proofBytes.length <= 1048576
      ? Buffer.from(input.proofBytes)
      : input.proofBytes;
  const materialBytes =
    Buffer.isBuffer(input.materialBytes) && input.materialBytes.length <= 1048576
      ? Buffer.from(input.materialBytes)
      : input.materialBytes;
  const targetIntent = exact(input.targetIntent, ["endpointPolicyId", "databaseName"])
    ? { ...input.targetIntent }
    : null;
  const scenario = input.scenario;
  // Holding these fixed public inputs establishes no trust. R1 alone validates
  // their shape/H1/build; the handles only prevent changing that validated window.
  const ownerInputs = await pinOwnerInputs();
  try {
    const build = await verifyManualBuild({ repoRoot, proofBytes, materialBytes });
    const profile = await loadFixedManualProfile({ repoRoot });
    await ownerInputs.recheck();
    if (!encodeManualJson(profile).equals(encodeManualJson(JSON.parse(ownerInputs.profileBytes))))
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const principal = Object.freeze({ ...JSON.parse(ownerInputs.bindingBytes).principal });
    if (
      !targetIntent ||
      !["normal", "apply-interrupted"].includes(scenario) ||
      !profile.allowedTargets.some(
        (target) =>
          target.endpointPolicyId === targetIntent.endpointPolicyId &&
          target.databaseName === targetIntent.databaseName &&
          target.purposes.includes("synthetic-fresh")
      )
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const verifiedProof = JSON.parse(proofBytes);
    const recheckSource = async () => {
      await ownerInputs.recheck();
      const sourceSha = (
        await nativeText(
          "git",
          [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-C",
            repoRoot,
            "rev-parse",
            "--verify",
            "HEAD"
          ],
          {
            PATH: process.env.PATH,
            ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows" } : {}),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
          }
        )
      ).trim();
      if (
        sourceSha !== verifiedProof.identity.sourceSha ||
        (await computeRepositoryContract(repoRoot)).digest !==
          verifiedProof.identity.repositoryContractDigest ||
        (await computeMigrationCatalog(repoRoot)).digest !==
          verifiedProof.identity.migrationCatalogDigest
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    };
    const archiveRoot = profile.storage.archiveRoot;
    const operationsRoot = path.join(archiveRoot, "inputs", "operations");
    // Inspect every existing private segment before creating even an intermediate directory.
    for (const file of [archiveRoot, path.join(archiveRoot, "inputs"), operationsRoot]) {
      try {
        await checkedPrivatePath(file, { principal, privateRoot: archiveRoot, directory: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await recheckSource();
    await ensureDirectory(path.join(archiveRoot, "inputs"), {
      principal,
      privateRoot: archiveRoot,
      recheckSource
    });
    await ensureDirectory(operationsRoot, { principal, privateRoot: archiveRoot, recheckSource });
    const operationRef = randomUUID();
    const index = {
      schemaVersion: "manual-operation-input.v1",
      operationRef,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      profileDigest: sha256Canonical(profile),
      buildProofDigest: build.buildProofDigest,
      proofRawDigest: build.proofRawDigest,
      materialRawDigest: build.materialRawDigest,
      custodyReceiptRawDigest: build.custodyReceiptRawDigest,
      targetIntent,
      purpose: "synthetic-fresh",
      scenario,
      operations: Object.fromEntries(
        ["observe", "migrate", "verify"].map((phase) => [
          phase,
          {
            operationId: randomUUID(),
            idempotencyKey: `manual-stage1:${operationRef}:${phase}`
          }
        ])
      ),
      promotionEligible: false
    };
    const bytes = encodeManualJson(index),
      indexDigest = sha256Canonical(index);
    const operationDirectory = path.join(operationsRoot, operationRef);
    const indexPath = path.join(operationDirectory, "index.json");
    try {
      await recheckSource();
      await checkedPrivatePath(operationsRoot, {
        principal,
        privateRoot: archiveRoot,
        directory: true
      });
      // The directory reserves this exact ref. EEXIST is never an invitation to retry.
      await fs.mkdir(operationDirectory, { mode: 0o700 });
      await fs.mkdir(path.join(operationDirectory, "runner-launch"), { mode: 0o700 });
      await checkedPrivatePath(operationDirectory, {
        principal,
        privateRoot: archiveRoot,
        directory: true
      });
      await recheckSource();
      const handle = await fs.open(indexPath, "wx", 0o600);
      try {
        await recheckSource();
        await checkedPrivatePath(operationDirectory, {
          principal,
          privateRoot: archiveRoot,
          directory: true
        });
        const chain = await checkedPrivatePath(indexPath, { principal, privateRoot: archiveRoot });
        if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        await handle.writeFile(bytes);
        await handle.sync();
        const after = await checkedPrivatePath(indexPath, { principal, privateRoot: archiveRoot });
        if (!sameIdentity(after.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        await recheckSource();
      } finally {
        await handle.close();
      }
      const fixed = await readFixedManualOperation({ repoRoot, operationRef });
      if (
        fixed.indexDigest !== indexDigest ||
        !encodeManualJson(fixed.operation).equals(bytes) ||
        !fixed.proofBytes.equals(proofBytes) ||
        !fixed.materialBytes.equals(materialBytes)
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      await recheckSource();
      return Object.freeze({ operationRef, indexDigest, promotionEligible: false });
    } catch (cause) {
      // Partial/colliding metadata stays reserved. No execution record or new identity is invented.
      throw Object.assign(new Error("MANUAL_OPERATION_PREPARATION_UNKNOWN", { cause }), {
        code: "MANUAL_OPERATION_PREPARATION_UNKNOWN",
        operationRef
      });
    }
  } finally {
    await ownerInputs.close();
  }
}

async function pinOwnerInputs() {
  const held = [];
  try {
    for (const relative of [
      "release/contracts/manual-stage1-profile.v2.json",
      "release/contracts/manual-stage1-owner-binding.v1.json"
    ]) {
      const file = path.join(repoRoot, ...relative.split("/"));
      const chain = await observedPath(file),
        handle = await fs.open(file, "r");
      const item = { file, chain, handle };
      held.push(item);
      Object.assign(item, await readPinned(handle, chain.at(-1).stat));
    }
    const recheck = async () => {
      for (const item of held) {
        const after = await observedPath(item.file);
        if (
          after.length !== item.chain.length ||
          !after.every(
            (entry, index) =>
              entry.path === item.chain[index].path &&
              (index === after.length - 1 ||
              entry.path === repoRoot ||
              entry.path.startsWith(repoRoot + path.sep)
                ? sameIdentity(entry.stat, item.chain[index].stat)
                : samePublicDirectory(entry.stat, item.chain[index].stat))
          )
        )
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        if (!(await readPinned(item.handle, item.stat)).bytes.equals(item.bytes))
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        const independent = await fs.open(item.file, "r");
        try {
          if (!(await readPinned(independent, item.stat)).bytes.equals(item.bytes))
            fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        } finally {
          await independent.close();
        }
      }
    };
    return {
      profileBytes: held[0].bytes,
      bindingBytes: held[1].bytes,
      recheck,
      close: async () => {
        for (const item of held) {
          item.bytes.fill(0);
          await item.handle.close();
        }
      }
    };
  } catch (cause) {
    for (const item of held) {
      item.bytes?.fill(0);
      await item.handle.close();
    }
    throw Object.assign(new Error("TRUSTED_BUILD_UNAVAILABLE", { cause }), {
      code: "TRUSTED_BUILD_UNAVAILABLE"
    });
  }
}
async function ensureDirectory(file, { principal, privateRoot, recheckSource }) {
  await recheckSource();
  await checkedPrivatePath(path.dirname(file), { principal, privateRoot, directory: true });
  try {
    await fs.mkdir(file, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await checkedPrivatePath(file, { principal, privateRoot, directory: true });
  await recheckSource();
}

export async function launchManualStage1(input) {
  if (
    !(exact(input, ["operationRef"]) || exact(input, ["operationRef", "allowedStage"])) ||
    ("allowedStage" in input && !["migration", "verification"].includes(input.allowedStage)) ||
    typeof input.operationRef !== "string" ||
    !uuid.test(input.operationRef)
  )
    fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
  return withManualTarget(input.operationRef, async (facts) => {
    const session = await openTrustedManualSession({
      repoRoot,
      operationRef: input.operationRef,
      proofBytes: facts.fixed.proofBytes,
      materialBytes: facts.fixed.materialBytes
    });
    try {
      const migration = await readConsumedMigration(facts);
      if (input.allowedStage && input.allowedStage !== (migration ? "verification" : "migration"))
        fail("MANUAL_LAUNCH_STAGE_MISMATCH");
      if (migration) {
        return await requireFixedH3B(facts, migration, async (secondFacts) => {
          const observed = { observation: migration.observation };
          if (migration.branch === "apply-unknown-recovery") {
            const reconcile = await launchZeroCredentialRunner(
              session,
              secondFacts,
              observed,
              null,
              { phase: "reconcile", migration }
            );
            return Object.freeze({
              operationRef: input.operationRef,
              reconcile: reconcile.reference,
              promotionEligible: false
            });
          }
          const verify = await launchZeroCredentialRunner(session, secondFacts, observed, null, {
            phase: "verify",
            migration
          });
          const replay = await launchZeroCredentialRunner(session, secondFacts, observed, null, {
            phase: "replay",
            migration
          });
          return Object.freeze({
            operationRef: input.operationRef,
            verify: verify.reference,
            replay: replay.reference,
            promotionEligible: false
          });
        });
      }
      const observed = await performTargetObservation(session, facts);
      const dry = await launchZeroCredentialRunner(session, facts, observed);
      const apply = await launchZeroCredentialRunner(session, facts, observed, dry);
      return Object.freeze({
        operationRef: input.operationRef,
        dryRun: dry.reference,
        apply: apply.reference,
        promotionEligible: false
      });
    } finally {
      await session.close();
    }
  });
}

async function readConsumedMigration(facts) {
  const operation = facts.fixed.operation,
    migrate = operation.operations.migrate,
    graph = await targetArchive(facts).graph(),
    requests = new Map(),
    consumptions = new Map();
  for (const [digest, { value }] of graph) {
    if (
      value.stage !== "runner-command" ||
      !(
        value.operationId === migrate.operationId ||
        value.idempotencyKey === migrate.idempotencyKey ||
        value.runId === operation.runId
      )
    )
      continue;
    if (value.schemaVersion !== "manual-runner-request.v1") continue;
    validateManualRunnerRequest(value);
    if (
      value.profileDigest !== operation.profileDigest ||
      value.operationId !== migrate.operationId ||
      value.idempotencyKey !== migrate.idempotencyKey ||
      value.runId !== operation.runId ||
      sha256Canonical(value.targetIntent) !== sha256Canonical(operation.targetIntent)
    )
      fail("MANUAL_SESSION_UNVERIFIED");
    requests.set(digest, value);
  }
  for (const { value } of graph.values()) {
    if (
      value.kind !== "consumption" ||
      !(
        value.operationId === migrate.operationId ||
        value.idempotencyKey === migrate.idempotencyKey ||
        requests.has(value.requestDigest)
      )
    )
      continue;
    validateContract("manual-operation-record.v2", value);
    const request = graph.get(value.requestDigest)?.value;
    if (
      !requests.has(value.requestDigest) ||
      value.status !== "CONSUMED" ||
      ![
        "profileDigest",
        "sessionId",
        "sessionNonce",
        "operationId",
        "idempotencyKey",
        "stage"
      ].every((key) => value[key] === request[key])
    )
      fail("MANUAL_SESSION_UNVERIFIED");
    if (consumptions.has(value.requestDigest)) fail("MANUAL_SESSION_UNVERIFIED");
    consumptions.set(value.requestDigest, value);
  }
  if (!consumptions.size) return null;
  const applied = [...requests.entries()].filter(
    ([digest, value]) => consumptions.has(digest) && value.phase === "apply"
  );
  if (
    applied.length !== 1 ||
    [...consumptions.keys()].some(
      (digest) => !["dry-run", "apply"].includes(requests.get(digest).phase)
    )
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const [requestDigest, request] = applied[0],
    original = (digest, schema, kind = null) => {
      const item = graph.get(digest);
      if (!item || sha256Bytes(item.bytes) !== digest) fail("MANUAL_SESSION_UNVERIFIED");
      validateContract(schema, item.value);
      if (kind && item.value.kind !== kind) fail("MANUAL_SESSION_UNVERIFIED");
      return item.value;
    },
    executions = [...graph.entries()].filter(
      ([, { value }]) => value.kind === "execution" && value.requestDigest === requestDigest
    );
  if (executions.length !== 1) fail("MANUAL_SESSION_UNVERIFIED");
  const [executionRecordDigest] = executions[0],
    execution = original(executionRecordDigest, "manual-operation-record.v2", "execution"),
    consumption = consumptions.get(requestDigest),
    allocation = original(
      request.attemptAllocationDigest,
      "manual-runner-evidence.v1",
      "attempt-allocation"
    ),
    dryExecution = original(request.dryRunRecordDigest, "manual-operation-record.v2", "execution"),
    dryRequest = original(dryExecution.requestDigest, "manual-runner-request.v1"),
    dryResult = original(
      dryExecution.resultDigest,
      "manual-runner-evidence.v1",
      "manual-command-result"
    ),
    baseline = original(request.baselineManifestDigest, "manual-baseline-manifest.v1"),
    observation = original(
      request.targetObservationDigest,
      "manual-runner-evidence.v1",
      "observation"
    );
  if (
    observationFields.some((key) => allocation[key] !== request[key]) ||
    observationFields
      .filter((key) => key !== "runId")
      .some((key) => execution[key] !== request[key]) ||
    allocation.phaseKey !== "apply" ||
    execution.consumptionRecordDigest !== sha256Canonical(consumption) ||
    execution.authorizationDigest !== consumption.authorizationDigest ||
    execution.predecessorExecutionRecordDigest !== request.dryRunRecordDigest ||
    dryRequest.phase !== "dry-run" ||
    !consumptions.has(dryExecution.requestDigest) ||
    dryExecution.status !== "SUCCEEDED" ||
    requests.size !== 2 ||
    consumptions.size !== 2 ||
    [
      "profileDigest",
      "operationId",
      "idempotencyKey",
      "runId",
      "buildProofDigest",
      "baselineManifestDigest",
      "targetObservationDigest"
    ].some((key) => dryRequest[key] !== request[key]) ||
    request.buildProofDigest !== facts.build.buildProofDigest ||
    request.approvedPlanDigest !== deterministicPlanDigest(dryResult.plan) ||
    request.physicalIdentity.clusterFingerprint !==
      computeManualClusterFingerprint(facts.targetContext.cluster) ||
    request.physicalIdentity.databaseOid !== facts.targetContext.databaseOid ||
    sha256Canonical(request.physicalIdentity) !==
      sha256Canonical(baseline.identity.physicalIdentity) ||
    baseline.identity.targetObservationDigest !== request.targetObservationDigest ||
    sha256Canonical(observation.physicalIdentity) !== sha256Canonical(request.physicalIdentity)
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const authorization = original(consumption.authorizationDigest, "manual-launch-authorization.v1"),
    slot = await targetArchive(facts).read(
      path.join(
        facts.profile.storage.journalRoot,
        "consumptions",
        `${request.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
      ),
      facts.profile.storage.journalRoot
    );
  if (!slot.bytes.equals(encodeManualJson(consumption))) fail("MANUAL_SESSION_UNVERIFIED");
  const rawBlobs = [],
    candidates = stdoutPrefixCandidates(graph),
    rawDirectory = path.join(facts.profile.storage.archiveRoot, "raw");
  await checkedPrivatePath(rawDirectory, {
    principal: facts.principal,
    privateRoot: facts.profile.storage.archiveRoot,
    directory: true
  });
  for (const name of await fs.readdir(rawDirectory)) {
    if (!/^[0-9a-f]{64}\.bin$/u.test(name)) fail("MANUAL_STORAGE_UNVERIFIED");
    const raw = await pinPrivateInput(
      path.join(rawDirectory, name),
      { principal: facts.principal, privateRoot: facts.profile.storage.archiveRoot },
      candidates.has(`sha256:${name.slice(0, -4)}`) ? 2097152 : 1048576
    );
    try {
      if (sha256Bytes(raw.bytes) !== `sha256:${name.slice(0, -4)}`)
        fail("MANUAL_STORAGE_UNVERIFIED");
      await raw.recheck();
      rawBlobs.push(Buffer.from(raw.bytes));
    } finally {
      await raw.close();
    }
  }
  const assess = (value) =>
      assessManualRunnerEvidence({
        profileBytes: encodeManualJson(facts.profile),
        requestBytes: graph.get(sha256Canonical(value)).bytes,
        artifactBytes: [...graph.values()].map((item) => item.bytes),
        rawBlobs
      }),
    dryAssessment = assess(dryRequest),
    assessment = assess(request);
  if (
    dryAssessment.executionStatus !== "SUCCEEDED" ||
    dryAssessment.proofDigest !== dryExecution.resultDigest
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const committedAssessment =
      assessment.executionStatus === "SUCCEEDED" &&
      assessment.originalDatabaseOutcome === "committed",
    normal =
      operation.scenario === "normal" &&
      execution.status === "SUCCEEDED" &&
      committedAssessment &&
      execution.resultDigest === assessment.proofDigest,
    unknown =
      operation.scenario === "apply-interrupted" &&
      execution.status === "INTERRUPTED_UNKNOWN" &&
      (assessment.executionStatus === "INTERRUPTED_UNKNOWN" || committedAssessment);
  if (!normal && !unknown) fail("MANUAL_SESSION_UNVERIFIED");
  const processes = [...graph.entries()]
    .filter(([, { value }]) => value.kind === "process" && value.requestDigest === requestDigest)
    .sort((a, b) => b[1].value.events.length - a[1].value.events.length);
  if (!processes.length) fail("MANUAL_SESSION_UNVERIFIED");
  const [processEvidenceDigest] = processes[0],
    process = original(processEvidenceDigest, "manual-runner-evidence.v1", "process");
  if (execution.processEvidenceDigest !== processEvidenceDigest || process.closedAt === null)
    fail("MANUAL_SESSION_UNVERIFIED");
  const actualResultDigest = assessment.proofDigest ?? execution.resultDigest;
  if (execution.resultDigest && execution.resultDigest !== actualResultDigest)
    fail("MANUAL_SESSION_UNVERIFIED");
  const result = actualResultDigest
    ? original(actualResultDigest, "manual-runner-evidence.v1", "manual-command-result")
    : null;
  if (
    result &&
    (result.requestDigest !== requestDigest ||
      observationFields.some((key) => result[key] !== request[key]))
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  if (unknown && committedAssessment) {
    const post = original(
      execution.postStateRecordDigest,
      "manual-operation-record.v2",
      "post-state"
    );
    if (
      !result ||
      execution.resultDigest !== assessment.proofDigest ||
      execution.startedAt !== result.startedAt ||
      execution.finishedAt !== process.closedAt ||
      post.requestDigest !== requestDigest ||
      post.consumptionRecordDigest !== execution.consumptionRecordDigest ||
      post.outcome !== "OBSERVED" ||
      post.observationDigest !== result.observationDigest
    )
      fail("MANUAL_SESSION_UNVERIFIED");
  }
  await facts.recheck();
  return Object.freeze({
    branch: normal ? "normal-success" : "apply-unknown-recovery",
    request,
    execution,
    process,
    baseline,
    observation,
    result,
    postObservation: result?.observationDigest
      ? original(result.observationDigest, "manual-runner-evidence.v1", "observation")
      : null,
    migration: {
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      attemptId: request.attemptId,
      allocationDigest: request.attemptAllocationDigest,
      requestDigest,
      approvedPlanDigest: request.approvedPlanDigest,
      processEvidenceDigest,
      resultDigest: actualResultDigest,
      executionRecordDigest
    }
  });
}

async function requireFixedH3B(facts, migration, work) {
  const inputs = await openManualH3BInputs({
    fixed: facts.fixed,
    profile: facts.profile,
    principal: facts.principal,
    h3InputBytes: facts.h3InputBytes,
    targetContext: facts.targetContext,
    migration: Object.fromEntries(
      ["branch", "request", "execution", "process", "postObservation", "migration"].map((key) => [
        key,
        migration[key]
      ])
    )
  });
  try {
    const status = inputs.context.credentialState;
    const credentialState = async () => {
      const directory = path.join(
          facts.profile.storage.credentialRoot,
          "operations",
          facts.fixed.operation.operationRef
        ),
        file = path.join(directory, "provision.json");
      await checkedPrivatePath(directory, {
        principal: facts.principal,
        privateRoot: facts.profile.storage.credentialRoot,
        directory: true
      });
      let stat;
      try {
        stat = (
          await checkedPrivatePath(file, {
            principal: facts.principal,
            privateRoot: facts.profile.storage.credentialRoot
          })
        ).at(-1).stat;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      if (status.state === "REMOVED") h3Require(!stat && status.stat === null);
      else
        h3Require(
          stat &&
            stat.isFile() &&
            stat.nlink === 1n &&
            h3Same(
              status.stat,
              Object.fromEntries(
                ["uid", "gid", "mode", "nlink", "dev", "ino"].map((key) => [key, String(stat[key])])
              )
            )
        );
    };
    const recheck = async () => {
      await inputs.recheck();
      await credentialState();
      await facts.recheck();
    };
    await recheck();
    const archive = targetArchive(facts);
    for (const [index, ref] of [inputs.refs.approval, inputs.refs.readback].entries())
      h3Require(h3Same(await archive.raw(inputs.bytes[index]), ref));
    await inputs.recheckArchived();
    await recheck();
    return await work({ ...facts, recheck });
  } finally {
    await inputs.close();
  }
}

export async function connectAndObserveManualTarget(input) {
  if (
    !exact(input, ["session", "operationRef"]) ||
    typeof input.operationRef !== "string" ||
    !uuid.test(input.operationRef) ||
    !input.session ||
    !["sign", "consume", "record", "close"].every((key) => typeof input.session[key] === "function")
  )
    fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
  try {
    return await withManualTarget(input.operationRef, (facts) =>
      performTargetObservation(input.session, facts)
    );
  } finally {
    await input.session.close();
  }
}

async function withManualTarget(operationRef, work) {
  const fixed = await readFixedManualOperation({ repoRoot, operationRef });
  const ownerInputs = await pinOwnerInputs();
  try {
    const build = await verifyManualBuild({
      repoRoot,
      proofBytes: fixed.proofBytes,
      materialBytes: fixed.materialBytes
    });
    const profile = await loadFixedManualProfile({ repoRoot });
    await ownerInputs.recheck();
    if (
      !encodeManualJson(profile).equals(ownerInputs.profileBytes) ||
      ["buildProofDigest", "proofRawDigest", "materialRawDigest", "custodyReceiptRawDigest"].some(
        (key) => build[key] !== fixed.operation[key]
      )
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    const principal = Object.freeze({ ...JSON.parse(ownerInputs.bindingBytes).principal });
    return await readH3Inputs(fixed, profile, principal, ownerInputs.recheck, (facts) =>
      work({ ...facts, fixed, profile, principal, build })
    );
  } finally {
    await ownerInputs.close();
  }
}

const observationFields = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
const fieldsFrom = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const objectFile = (root, digest) => {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail("MANUAL_STORAGE_UNVERIFIED");
  return path.join(root, "objects", `${digest.slice(7)}.json`);
};

// These graph references only select a bounded candidate read. The shared
// assessor still validates MS2 protocol, binding and every individual raw usage.
function stdoutPrefixCandidates(graph) {
  const digests = new Set();
  for (const { value } of graph.values()) {
    if (value.kind !== "process") continue;
    validateContract("manual-runner-evidence.v1", value);
    const request = graph.get(value.requestDigest)?.value;
    if (!request || request.schemaVersion !== "manual-runner-request.v1") continue;
    validateManualRunnerRequest(request);
    if (
      [
        "profileDigest",
        "sessionId",
        "sessionNonce",
        "operationId",
        "idempotencyKey",
        "attemptId",
        "runId"
      ].every((key) => value[key] === request[key]) &&
      value.attemptAllocationDigest === request.attemptAllocationDigest
    )
      digests.add(value.protocol.stdoutPrefix.digest);
  }
  return digests;
}

function targetArchive({ profile, principal, recheck }) {
  const read = (file, root) => readCanonicalPrivateInput(file, { principal, privateRoot: root });
  const get = async (digest, role = "archive") => {
    const item = await read(
      objectFile(profile.storage[`${role}Root`], digest),
      profile.storage[`${role}Root`]
    );
    if (sha256Bytes(item.bytes) !== digest) fail("MANUAL_STORAGE_UNVERIFIED");
    return item;
  };
  const raw = async (bytes, stdoutContext = null) => {
    let limit = 1048576;
    if (!Buffer.isBuffer(bytes)) fail("MANUAL_OUTPUT_LIMIT");
    if (bytes.length > limit) {
      if (!stdoutContext || bytes.length > 2097152) fail("MANUAL_OUTPUT_LIMIT");
      const { requestBytes, authorization, authorizeBytes } = stdoutContext;
      if (!Buffer.isBuffer(requestBytes) || !Buffer.isBuffer(authorizeBytes) || !authorization)
        fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
      const request = JSON.parse(requestBytes),
        authorize = parseManualRunnerFrames({
          direction: "parent-to-child",
          bytes: authorizeBytes,
          ended: true
        }).frames[0],
        parsed = parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: false });
      if (
        authorize?.type !== "AUTHORIZE" ||
        !authorizeBytes.subarray(0, 4).equals(Buffer.from("MS2 ")) ||
        !bytes.subarray(0, 4).equals(Buffer.from("MS2 ")) ||
        !encodeManualJson(authorize.payload.request).equals(requestBytes) ||
        sha256Canonical(authorize.payload.authorization) !== sha256Canonical(authorization) ||
        parsed.frames[0]?.payload.childChallenge !== request.childChallenge
      )
        fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
      const binding = {
        ...fieldsFrom(request, [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId",
          "runId",
          "attemptAllocationDigest",
          "containerId",
          "runnerImageDigest",
          "childChallenge"
        ]),
        requestDigest: sha256Bytes(requestBytes),
        authorizationDigest: sha256Canonical(authorization)
      };
      for (const frame of parsed.frames.slice(1)) {
        if (frame.type === "RESULT") {
          if (
            !Object.keys(binding)
              .filter(
                (key) =>
                  ![
                    "containerId",
                    "runnerImageDigest",
                    "childChallenge",
                    "authorizationDigest"
                  ].includes(key)
              )
              .every((key) => frame.payload[key] === binding[key])
          )
            fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
        } else if (sha256Canonical(frame.payload.binding) !== sha256Canonical(binding))
          fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
      }
      limit = 2097152;
    }
    const digest = sha256Bytes(bytes),
      file = path.join(profile.storage.archiveRoot, "raw", `${digest.slice(7)}.bin`);
    await recheck();
    await checkedPrivatePath(path.dirname(file), {
      principal,
      privateRoot: profile.storage.archiveRoot,
      directory: true
    });
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        const chain = await checkedPrivatePath(file, {
          principal,
          privateRoot: profile.storage.archiveRoot
        });
        if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
          fail("MANUAL_STORAGE_UNVERIFIED");
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const input = await pinPrivateInput(
      file,
      {
        principal,
        privateRoot: profile.storage.archiveRoot
      },
      limit
    );
    try {
      if (!input.bytes.equals(bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await input.recheck();
    } finally {
      await input.close();
    }
    await recheck();
    return { digest, bytes: bytes.length };
  };
  return {
    raw,
    read,
    get,
    async put(value, schema, role = "archive") {
      if (schema) validateContract(schema, value);
      const bytes = encodeManualJson(value),
        digest = sha256Bytes(bytes),
        file = objectFile(profile.storage[role + "Root"], digest);
      await recheck();
      await checkedPrivatePath(path.dirname(file), {
        principal,
        privateRoot: profile.storage[role + "Root"],
        directory: true
      });
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
          const chain = await checkedPrivatePath(file, {
            principal,
            privateRoot: profile.storage[role + "Root"]
          });
          if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
            fail("MANUAL_STORAGE_UNVERIFIED");
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (!(await get(digest, role)).bytes.equals(bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await recheck();
      return digest;
    },
    async graph() {
      const graph = new Map();
      for (const role of ["journal", "archive"]) {
        const root = profile.storage[`${role}Root`],
          directory = path.join(root, "objects");
        await checkedPrivatePath(directory, { principal, privateRoot: root, directory: true });
        const names = await fs.readdir(directory);
        if (!names.every((name) => /^[0-9a-f]{64}\.json$/u.test(name)))
          fail("MANUAL_STORAGE_UNVERIFIED");
        for (let offset = 0; offset < names.length; offset += 8) {
          const batch = names.slice(offset, offset + 8),
            settled = await Promise.allSettled(
              batch.map((name) => get(`sha256:${name.slice(0, -5)}`, role))
            ),
            failed = settled.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
          for (const [index, name] of batch.entries())
            graph.set(`sha256:${name.slice(0, -5)}`, settled[index].value);
        }
      }
      return graph;
    }
  };
}

// H1 owns the session and durable consume. The hosted control socket receives
// only this fixed request; its 202 is delivery acknowledgement, never success.
// No CLI/workflow calls this entry until the destination/cleanup graph is wired.
export async function launchR3TargetCreate(input) {
  const code = "R3_TARGET_CREATE_UNAVAILABLE";
  let fixed,
    session,
    lease,
    socket,
    archive,
    consumption,
    postgresTarget,
    postgresReadback,
    postgresAttempted = false,
    postgresPending,
    postgresSecret,
    postgresArchive,
    databaseTargetSet,
    targetLockLease,
    hostedEvidence,
    hostedEvidenceReady = false,
    hostedImportAttempted = false,
    hostedImportPending,
    destinationAttempted = false,
    destinationReady = false,
    destinationStage = "NOT_STARTED",
    destinationPending,
    destinationRecord,
    completionAttempted = false,
    completionReady = false,
    completionPending,
    completionRecord,
    consumerAttempted = false,
    consumerReady = false,
    consumerPending,
    consumerInput,
    consumerSlot,
    consumerRecord,
    consumerExecutionDigest,
    consumerMatchingSourceDigest = null,
    fetchAttempted = false,
    fetchReady = false,
    fetchPending,
    snapshotPayload,
    snapshotReadback,
    decryptAttempted = false,
    decryptReady = false,
    decryptPending,
    snapshotPlaintext,
    decryptionReadback,
    copyAttempted = false,
    copyReady = false,
    copyPending,
    snapshotCopy,
    copyReadback,
    restoreAttempted = false,
    restoreReady = false,
    restorePending,
    cleanupAttempted = false,
    cleanupReady = false,
    cleanupPending,
    cleanupReadback,
    cleanupStage = "NOT_STARTED",
    snapshotCompletionAttempted = false,
    snapshotCompletionReady = false,
    snapshotCompletionPending,
    snapshotCompletionRecord,
    candidateUseRecord,
    lifecycleAttempted = false,
    lifecycleReady = false,
    lifecyclePending,
    lifecycleResult,
    sourceAttempted = false,
    sourceReady = false,
    sourcePending,
    finalAttempted = false,
    finalReady = false,
    finalPending,
    finalResources,
    finalCompletionRecord,
    sourceCompletionRecord,
    sourceAcknowledgementAttempted = false,
    sourceAcknowledgementReady = false,
    sourceAcknowledgementPending,
    targetCleanupImportAttempted = false,
    targetCleanupImportReady = false,
    targetCleanupImportPending,
    targetCleanupEvidence,
    targetCleanupAttempted = false,
    targetCleanupReady = false,
    targetCleanupPending,
    forwardLeaseClosed = false,
    databaseStage = "NOT_STARTED",
    databasesAttempted = false,
    databasesPending,
    boundEngineId,
    stopping = false,
    closed = false,
    closing;
  const diagnostics = [];
  const databaseSecrets = [];
  const databaseSecretByName = new Map();
  const restoreStates = new Map();
  const restoreReadbacks = [];
  const lifecycleReadbacks = [];
  const sourceReadbacks = [];
  const sourceContexts = [];
  const sourceValues = new Map();
  const finalReadbacks = [];
  const finalMigrations = new Map();
  const lifecycleRegisteredRecords = [];
  const fetchAbort = new AbortController();
  const lifecycleAbort = new AbortController();
  const sourceAbort = new AbortController();
  const close = () => {
    if (closing) return closing;
    stopping = true;
    lifecycleAbort.abort();
    sourceAbort.abort();
    const abort = () => {
      closed = true;
      fetchAbort.abort();
      socket?.destroy();
    };
    if (
      !restorePending &&
      !cleanupPending &&
      !snapshotCompletionPending &&
      !lifecyclePending &&
      !sourcePending &&
      !finalPending &&
      !sourceAcknowledgementPending &&
      !targetCleanupPending
    )
      abort();
    closing = (async () => {
      // Revoking the key prevents new connections; it does not kill sshd or
      // imply the hosted Engine stopped. Consumed session locks stay UNKNOWN.
      const errors = [];
      // Keep the existing, still-checked lease and transport available for the
      // current target's bounded restore/revoke/credential cleanup. A stop
      // cannot start another target or publish a completed restore set.
      await restorePending?.catch(() => {});
      await cleanupPending?.catch(() => {});
      await snapshotCompletionPending?.catch(() => {});
      await lifecyclePending?.catch(() => {});
      await sourcePending?.catch(() => {});
      await finalPending?.catch(() => {});
      await sourceAcknowledgementPending?.catch(() => {});
      await targetCleanupPending?.catch(() => {});
      abort();
      await copyPending?.catch(() => {});
      await decryptPending?.catch(() => {});
      await fetchPending?.catch(() => {});
      await consumerPending?.catch(() => {});
      await completionPending?.catch(() => {});
      await destinationPending?.catch(() => {});
      await databasesPending?.catch(() => {});
      await postgresPending?.catch(() => {});
      await hostedImportPending?.catch(() => {});
      await targetCleanupImportPending?.catch(() => {});
      for (const held of databaseSecrets) {
        held.bytes.fill(0);
        try {
          await held.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (postgresSecret) {
        postgresSecret.bytes.fill(0);
        try {
          await postgresSecret.close();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const handle of [
        ...lifecycleReadbacks,
        ...sourceReadbacks,
        ...sourceContexts,
        ...finalReadbacks,
        cleanupReadback,
        ...restoreReadbacks,
        copyReadback,
        snapshotCopy,
        decryptionReadback,
        snapshotPlaintext,
        snapshotReadback,
        snapshotPayload,
        consumerInput,
        consumerSlot,
        targetCleanupEvidence,
        hostedEvidence,
        lease,
        session,
        fixed
      ]) {
        try {
          if (handle === session && session && (errors.length || !targetCleanupReady))
            await session.closeIncomplete();
          else await handle?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, code);
    })();
    return closing;
  };
  const check = async () => {
    if (closed) fail(code);
    await fixed.recheck();
    if (!forwardLeaseClosed) await lease?.recheck();
    await targetCleanupEvidence?.recheck();
    await targetLockLease?.recheck();
    await hostedEvidence?.recheck();
    if (destinationRecord) await recheckDestination();
    if (completionRecord) await recheckCompletion();
    if (snapshotCompletionRecord) await recheckSnapshotCompletion();
    if (sourceCompletionRecord || finalCompletionRecord) {
      const completed = sourceCompletionRecord ?? finalCompletionRecord;
      const verified = sourceCompletionRecord
        ? await session.verifySourceOriginals()
        : await session.verifyFinalOriginals();
      if (sha256Canonical(verified) !== completed.verifiedDigest) fail(code);
      for (const { digest, bytes, roles } of completed.originals)
        for (const role of roles)
          if (!(await archive.get(digest, role)).bytes.equals(bytes)) fail(code);
    } else if (candidateUseRecord) {
      const admission = await session.assertCandidateUse();
      if (admission.executionRecordDigest !== candidateUseRecord.executionRecordDigest) fail(code);
      if (
        candidateUseRecord.admission &&
        sha256Canonical(admission) !== sha256Canonical(candidateUseRecord.admission)
      )
        fail(code);
    }
    await consumerInput?.recheck();
    await consumerSlot?.recheck();
    await snapshotPayload?.recheck();
    await snapshotReadback?.recheck();
    await snapshotPlaintext?.recheck();
    await decryptionReadback?.recheck();
    await copyReadback?.recheck();
    for (const held of restoreReadbacks) await held.recheck();
    await cleanupReadback?.recheck();
    for (const held of lifecycleReadbacks) await held.recheck();
    for (const held of [...sourceReadbacks, ...sourceContexts]) await held.recheck();
    for (const held of finalReadbacks) await held.recheck();
    if (consumerRecord)
      for (const { digest, bytes, role } of consumerRecord)
        if (!(await archive.get(digest, role)).bytes.equals(bytes)) fail(code);
  };
  const recheckDestination = async () => {
    for (const [digest, bytes] of destinationRecord.originals) {
      for (const role of ["archive", "backup"]) {
        const original = await archive.get(digest, role);
        if (!original.bytes.equals(bytes)) fail(code);
      }
    }
  };
  const recheckCompletion = async () => {
    for (const { digest, bytes, roles } of completionRecord.originals)
      for (const role of roles)
        if (!(await archive.get(digest, role)).bytes.equals(bytes)) fail(code);
  };
  const recheckSnapshotCompletion = async () => {
    for (const { digest, bytes, roles } of snapshotCompletionRecord.originals)
      for (const role of roles)
        if (!(await archive.get(digest, role)).bytes.equals(bytes)) fail(code);
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  const exchange = (method, pathname, body = null, connected = null, options = {}) =>
    exchangeR3Engine(method, pathname, body, connected, {
      ...options,
      signal: fetchAbort.signal
    });
  const saveExchange = async (name, response) => {
    diagnostics.push({
      name,
      response: await archive.raw(
        encodeManualJson({ status: response.status, headers: response.headers })
      ),
      body: await archive.raw(response.body)
    });
  };
  const engineReadback = async (empty = !postgresAttempted, save = saveExchange) => {
    const ping = await exchange("GET", "/_ping");
    await save("engine-ping", ping);
    if (ping.status === 409 && ping.body.length === 0) fail("R3_HANDOFF_PENDING");
    if (ping.status !== 200 || ping.body.toString() !== "OK") fail(code);
    const info = await exchange("GET", "/v1.45/info"),
      version = await exchange("GET", "/v1.45/version");
    await save("engine-info", info);
    await save("engine-version", version);
    if (info.status !== 200 || version.status !== 200) fail(code);
    const engine = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(info.body));
    const runtime = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(version.body));
    if (
      typeof engine.ID !== "string" ||
      engine.ID.length < 8 ||
      engine.ID.length > 128 ||
      engine.DockerRootDir !== path.posix.join(fixed.spec.workspace.mountPath, "docker") ||
      engine.Driver !== "overlay2" ||
      engine.LoggingDriver !== "json-file" ||
      (empty && (engine.Containers !== 0 || engine.Images !== 0)) ||
      !Array.isArray(engine.DriverStatus) ||
      engine.DriverStatus.some(
        (pair) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some((v) => typeof v !== "string") ||
          /containerd|snapshotter/iu.test(pair.join(" "))
      ) ||
      typeof runtime.Version !== "string" ||
      !/^1\.\d+$/u.test(runtime.ApiVersion) ||
      Number(runtime.ApiVersion.split(".")[1]) < 45
    )
      fail(code);
    return { engine, runtime };
  };
  const pgIdentitySql = `SELECT json_build_object(
    'systemIdentifier',(pg_control_system()).system_identifier::text,
    'serverVersionNum',current_setting('server_version_num')::int,
    'serverAddress',host(inet_server_addr()),'serverPort',inet_server_port(),
    'databaseName',current_database(),
    'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
    'role',current_user,'tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),
    'clusterMarker',current_setting('cluster_name')) AS identity`;
  const savePgExchange = async (name, response) => {
    // Once input originals are pinned, keep their shared raw directory fixed.
    // Live resource checks still execute; creation evidence is already retained.
    if (consumerAttempted) return;
    diagnostics.push({
      name,
      response: await postgresArchive.raw(
        encodeManualJson({ status: response.status, headers: response.headers })
      ),
      body: await postgresArchive.raw(response.body)
    });
  };
  const engineCall = async (method, url, value, status, options = {}) => {
    await check();
    if (
      method !== "GET" &&
      (await engineReadback(false, savePgExchange)).engine.ID !== boundEngineId
    )
      fail(code);
    const body =
      value === undefined ? null : Buffer.isBuffer(value) ? value : encodeManualJson(value);
    const response = await exchange(method, `/v1.45${url}`, body, null, options);
    // Never archive a credential-bearing request, including the password tar.
    await savePgExchange(`postgres:${method}:${url}`, response);
    await check();
    if (response.status !== status) fail(code);
    return response.body;
  };
  const engineJson = async (...args) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await engineCall(...args)));
  const pgNames = () => {
    const id = fixed.spec.operationRef.replaceAll("-", "");
    return { container: `s1r3pg_${id}`, network: `s1r3net_${id}`, volume: `s1r3data_${id}` };
  };
  const readPgIdentity = async () => {
    await check();
    await postgresSecret.recheck();
    const connection = await createPostgresConnector()({
      credential: {
        username: "release_provisioner",
        password: postgresSecret.bytes.toString("ascii"),
        capabilityProfile: "provision"
      },
      target: { hostname: "127.0.0.1", port: 55441, databaseName: "postgres", tlsMode: "require" },
      custody: {
        operationRef: fixed.spec.operationRef,
        executionRecordDigest: consumption.executionRecordDigest
      }
    });
    let timer;
    try {
      const rows = await Promise.race([
        connection.withReadOnlyTransaction(async (transaction) => {
          await transaction.execute("SET LOCAL statement_timeout = '5s'");
          return transaction.query(pgIdentitySql);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), 15000);
        })
      ]);
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.identity) fail(code);
      await check();
      return rows[0].identity;
    } finally {
      clearTimeout(timer);
      await connection.close();
    }
  };
  const inspectPg = async (expectedEngineId, suppliedIdentity) => {
    const names = pgNames(),
      imageDigest = fixed.databaseTargetPolicy.requiredImageDigest;
    const { engine } = await engineReadback(false, savePgExchange);
    if (
      engine.ID !== expectedEngineId ||
      (!finalResources && (engine.Containers !== 1 || engine.Images !== 1))
    )
      fail(code);
    const container = await engineJson(
      "GET",
      `/containers/${names.container}/json`,
      undefined,
      200
    );
    const image = await engineJson(
      "GET",
      `/images/${encodeURIComponent(`postgres:17-bookworm@${imageDigest}`)}/json`,
      undefined,
      200
    );
    const network = await engineJson("GET", `/networks/${names.network}`, undefined, 200);
    const volume = await engineJson("GET", `/volumes/${names.volume}`, undefined, 200);
    const postgres = suppliedIdentity ?? (await readPgIdentity());
    const resources = {
      operationRef: fixed.spec.operationRef,
      workspaceMountPath: fixed.spec.workspace.mountPath,
      engineId: expectedEngineId,
      imageDigest,
      engine,
      image,
      container,
      network,
      volume,
      postgres
    };
    if (finalResources) {
      resources.finalResources = {
        ...finalResources,
        image: await engineJson(
          "GET",
          `/images/${encodeURIComponent(finalResources.imageReference)}/json`,
          undefined,
          200
        ),
        containers: await Promise.all(
          [
            finalResources.runnerContainerId,
            ...(finalResources.migrationContainerId ? [finalResources.migrationContainerId] : [])
          ].map((id) => engineJson("GET", `/containers/${id}/json`, undefined, 200))
        )
      };
      resources.containerInventory = await engineJson(
        "GET",
        "/containers/json?all=1",
        undefined,
        200
      );
      resources.imageInventory = await engineJson("GET", "/images/json", undefined, 200);
    }
    const facts = finalResources
      ? assessR3FinalPostgresObservation(resources)
      : assessR3PostgresObservation(resources);
    // Independent read through the owned CID must identify the very same PG
    // reached over the other SSH forward. A published-port claim alone is insufficient.
    const execution = await engineJson(
      "POST",
      `/containers/${facts.containerId}/exec`,
      {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "postgres",
        Cmd: [
          "/bin/bash",
          "-ec",
          'export PGPASSWORD="$(cat /run/stage1-postgres-password)" PGSSLMODE=require PGCONNECT_TIMEOUT=5; exec psql -X -A -t -v ON_ERROR_STOP=1 -U release_provisioner -d postgres -h "$1" -c "$2"',
          "--",
          facts.containerAddress,
          pgIdentitySql
        ]
      },
      201
    );
    if (!/^[0-9a-f]{64}$/u.test(execution.Id)) fail(code);
    const stream = await engineCall(
      "POST",
      `/exec/${execution.Id}/start`,
      { Detach: false, Tty: false },
      200,
      { timeout: 15000 }
    );
    const completed = await engineJson("GET", `/exec/${execution.Id}/json`, undefined, 200);
    const readback = { resources, execution, streamBase64: stream.toString("base64"), completed };
    let checked;
    try {
      checked = finalResources
        ? assessR3FinalPostgresReadback(readback)
        : assessR3PostgresReadback(readback);
    } catch {
      fail(code);
    }
    if (sha256Canonical(checked) !== sha256Canonical(facts)) fail(code);
    if (!consumerAttempted)
      diagnostics.push({
        name: "postgres-two-end-identity",
        body: await postgresArchive.raw(encodeManualJson(readback))
      });
    await check();
    if (!candidateUseRecord) postgresReadback = JSON.parse(JSON.stringify(readback));
    return facts;
  };
  const provisionPg = async (expectedEngineId) => {
    await check();
    // Raw diagnostic writes preserve the same private-file checks, but do not
    // repeat remote job/H2 verification for every response fragment. Native
    // operations check current trust before and after each complete exchange.
    postgresArchive = targetArchive({
      profile: lease.profile,
      principal: { platform: "posix", uid: process.getuid() },
      recheck: async () => {
        if (closed || !consumption) fail(code);
      }
    });
    const before = await engineReadback(true, savePgExchange);
    if (before.engine.ID !== expectedEngineId) fail(code);
    const policy = fixed.databaseTargetPolicy;
    if (
      policy?.policyId !== "s1-release-compose-ephemeral" ||
      policy.requiredServerVersionMajor !== 17 ||
      policy.requiredClusterMarker !== "subscription-s1-controlled/v1" ||
      !/^sha256:[0-9a-f]{64}$/u.test(policy.requiredImageDigest)
    )
      fail(code);
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(privateRoot, "r3", fixed.spec.operationRef);
    await ensureDirectory(path.dirname(directory), {
      principal,
      privateRoot,
      recheckSource: check
    });
    await check();
    await fs.mkdir(directory, { mode: 0o700 });
    await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
    // Reserve the sibling directory before pinning the provisioner password:
    // private pins also bind directory metadata, which must remain unchanged.
    await fs.mkdir(path.join(directory, "database-credentials"), { mode: 0o700 });
    const contextRoot = path.join(directory, "database-test-contexts");
    await fs.mkdir(contextRoot, { mode: 0o700 });
    for (const { suiteId } of fixed.databaseTestManifest.suites) {
      if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(suiteId)) fail(code);
      await fs.mkdir(path.join(contextRoot, suiteId), { mode: 0o700 });
    }
    const consumerDirectory = path.join(directory, "consumer");
    await fs.mkdir(consumerDirectory, { mode: 0o700 });
    for (const name of ["ciphertext", "plaintext", "observations"])
      await fs.mkdir(path.join(consumerDirectory, name), { mode: 0o700 });
    await fs.mkdir(path.join(consumerDirectory, "observations", "decryption"), { mode: 0o700 });
    await fs.mkdir(path.join(consumerDirectory, "observations", "copy"), { mode: 0o700 });
    await fs.mkdir(path.join(consumerDirectory, "observations", "cleanup"), { mode: 0o700 });
    const restoreDirectory = path.join(consumerDirectory, "observations", "restore");
    await fs.mkdir(restoreDirectory, { mode: 0o700 });
    for (const target of planR3DatabaseTargets({
      operationRef: fixed.spec.operationRef,
      phase: fixed.spec.phase,
      chain: fixed.spec.chain,
      manifest: fixed.databaseTestManifest
    }).targets)
      await fs.mkdir(path.join(restoreDirectory, target.databaseName), { mode: 0o700 });
    const secretPath = path.join(directory, "postgres-password");
    const secretBytes = Buffer.from(randomBytes(32).toString("hex"));
    const secretFile = await fs.open(secretPath, "wx", 0o600);
    try {
      await secretFile.writeFile(secretBytes);
      await secretFile.sync();
    } finally {
      await secretFile.close();
      secretBytes.fill(0);
    }
    postgresSecret = await pinPrivateInput(secretPath, { principal, privateRoot }, 64);
    if (!/^[0-9a-f]{64}$/u.test(postgresSecret.bytes.toString("ascii"))) fail(code);
    const names = pgNames(),
      image = `postgres:17-bookworm@${policy.requiredImageDigest}`;
    const labels = { "com.subscription.release.operation-ref": fixed.spec.operationRef };
    const pull = await engineCall(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}&platform=linux%2Famd64`,
      undefined,
      200,
      { timeout: 300000 }
    );
    const progress = new TextDecoder("utf-8", { fatal: true })
      .decode(pull)
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!progress.length || progress.some((entry) => entry.error || entry.errorDetail)) fail(code);
    const imageReadback = await engineJson(
      "GET",
      `/images/${encodeURIComponent(image)}/json`,
      undefined,
      200
    );
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(imageReadback.Id) ||
      imageReadback.Os !== "linux" ||
      imageReadback.Architecture !== "amd64" ||
      !imageReadback.RepoDigests?.some((digest) =>
        [
          `postgres@${policy.requiredImageDigest}`,
          `docker.io/library/postgres@${policy.requiredImageDigest}`
        ].includes(digest)
      )
    )
      fail(code);
    const network = await engineJson(
      "POST",
      "/networks/create",
      {
        Name: names.network,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        CheckDuplicate: true,
        Labels: labels,
        Options: { "com.docker.network.bridge.enable_ip_masquerade": "false" }
      },
      201
    );
    if (!/^[0-9a-f]{64}$/u.test(network.Id)) fail(code);
    const volume = await engineJson(
      "POST",
      "/volumes/create",
      { Name: names.volume, Driver: "local", Labels: labels },
      201
    );
    if (
      volume.Name !== names.volume ||
      volume.Driver !== "local" ||
      volume.Mountpoint !==
        `${fixed.spec.workspace.mountPath}/docker/volumes/${names.volume}/_data` ||
      (volume.Options != null && Object.keys(volume.Options).length !== 0) ||
      volume.Labels?.["com.subscription.release.operation-ref"] !== fixed.spec.operationRef
    )
      fail(code);
    const entry =
      "set -e; chown postgres:postgres /run/stage1-postgres-password; chmod 0600 /run/stage1-postgres-password; mkdir -m 0700 /run/stage1-tls; openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=localhost -keyout /run/stage1-tls/server.key -out /run/stage1-tls/server.crt; chown -R postgres:postgres /run/stage1-tls; chmod 0600 /run/stage1-tls/server.key; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_cert_file=/run/stage1-tls/server.crt -c ssl_key_file=/run/stage1-tls/server.key -c cluster_name=subscription-s1-controlled/v1";
    const container = await engineJson(
      "POST",
      `/containers/create?name=${names.container}`,
      {
        Image: image,
        Labels: labels,
        Entrypoint: ["/bin/bash", "-ec"],
        Cmd: [entry],
        Env: [
          "POSTGRES_DB=postgres",
          "POSTGRES_USER=release_provisioner",
          "POSTGRES_PASSWORD_FILE=/run/stage1-postgres-password",
          "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256"
        ],
        ExposedPorts: { "5432/tcp": {} },
        HostConfig: {
          NetworkMode: names.network,
          Privileged: false,
          RestartPolicy: { Name: "no" },
          Memory: 1073741824,
          MemorySwap: 1073741824,
          PidsLimit: 256,
          SecurityOpt: ["no-new-privileges:true"],
          LogConfig: { Type: "json-file", Config: {} },
          Mounts: [{ Type: "volume", Source: names.volume, Target: "/var/lib/postgresql/data" }]
        }
      },
      201
    );
    if (!/^[0-9a-f]{64}$/u.test(container.Id)) fail(code);
    // One fixed ustar member, mode 0600, root owner; bytes never enter argv,
    // environment, inspect metadata or the public evidence archive.
    const tar = Buffer.alloc(2048),
      header = tar.subarray(0, 512);
    header.write("stage1-postgres-password");
    header.write("0000600\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${postgresSecret.bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148
    );
    postgresSecret.bytes.copy(tar, 512);
    try {
      await engineCall("PUT", `/containers/${container.Id}/archive?path=%2Frun`, tar, 200, {
        contentType: "application/x-tar"
      });
    } finally {
      tar.fill(0);
    }
    await engineCall("POST", `/containers/${container.Id}/start`, undefined, 204);
    const deadline = Date.now() + 120000;
    let identity;
    while (!identity) {
      try {
        identity = await readPgIdentity();
      } catch (error) {
        // Only connection/startup failures are retryable; trust or identity
        // failures retain UNKNOWN and never trigger a second create.
        if (!["ECONNREFUSED", "ECONNRESET", "57P03"].includes(error.code) || Date.now() >= deadline)
          throw error;
        await pause();
      }
    }
    const facts = await inspectPg(expectedEngineId, identity);
    postgresTarget = Object.freeze({
      ...facts,
      credentialRef: `r3/${fixed.spec.operationRef}/postgres-password`,
      status: "POSTGRES_OBSERVED"
    });
    return postgresTarget;
  };
  const databaseAdmin = async (plan, work, observations = null, lifecycle = false) => {
    if (lifecycle && (!lifecycleAttempted || lifecycleReady || !completionReady)) fail(code);
    const allowed = new Set([
      "postgres",
      ...plan.targets.map((target) => target.databaseName),
      ...(lifecycle ? plan.reservations.map((target) => target.databaseName) : [])
    ]);
    let connection, connectedDatabase;
    const closeConnection = async () => {
      const previous = connection;
      connection = null;
      connectedDatabase = null;
      await previous?.close();
    };
    const connect = async (databaseName) => {
      if (closed || !allowed.has(databaseName)) fail(code);
      if (connectedDatabase !== databaseName) {
        await closeConnection();
        await postgresSecret.recheck();
        connection = await createPostgresConnector()({
          credential: {
            username: "release_provisioner",
            password: postgresSecret.bytes.toString("ascii"),
            capabilityProfile: "provision"
          },
          target: { hostname: "127.0.0.1", port: 55441, databaseName, tlsMode: "require" },
          custody: {
            operationRef: fixed.spec.operationRef,
            executionRecordDigest: consumption.executionRecordDigest
          }
        });
        await connection.execute("SET statement_timeout = '30s'");
        await connection.execute("SET lock_timeout = '5s'");
        await connection.execute("SET search_path = pg_catalog");
        const rows = await connection.query(pgIdentitySql);
        const observed = rows?.[0]?.identity;
        if (
          !Array.isArray(rows) ||
          rows.length !== 1 ||
          observed?.databaseName !== databaseName ||
          !/^[1-9][0-9]*$/u.test(observed.databaseOid ?? "") ||
          [
            "systemIdentifier",
            "serverVersionNum",
            "serverAddress",
            "serverPort",
            "role",
            "tls",
            "clusterMarker"
          ].some((key) => observed[key] !== postgresTarget.postgres[key])
        )
          fail(code);
        connectedDatabase = databaseName;
      }
      return connection;
    };
    const executeAdmin = async ({ databaseName, sql }) => {
      if (closed || typeof sql !== "string" || sql.length > 262144) fail(code);
      const client = await connect(databaseName);
      const result = await client.query(sql);
      const rows = JSON.parse(JSON.stringify([...result]));
      // Only the fixed helper's nonsecret SELECT responses are archived. Never
      // retain role-password SQL, driver errors or a connector statement log.
      if (/^SELECT\b/u.test(sql.trimStart())) {
        observations?.push({ databaseName, sql, rows: JSON.parse(JSON.stringify(rows)) });
        if (!consumerAttempted)
          diagnostics.push({
            name: `database:${databaseName}:observation`,
            body: await postgresArchive.raw(encodeManualJson(rows))
          });
      }
      return { rows };
    };
    try {
      return await work(executeAdmin);
    } finally {
      await closeConnection();
    }
  };
  const provisionDatabases = async () => {
    databaseStage = "CLUSTER_IDENTITY";
    await check();
    await inspectPg(boundEngineId);
    databaseStage = "PLAN";
    const plan = planR3DatabaseTargets({
      operationRef: fixed.spec.operationRef,
      phase: fixed.spec.phase,
      chain: fixed.spec.chain,
      manifest: fixed.databaseTestManifest
    });
    const createdAt = new Date().toISOString();
    databaseStage = "ATTEMPT_ARCHIVE";
    diagnostics.push({
      name: "database-target-attempt",
      body: await postgresArchive.raw(
        encodeManualJson({
          status: "INTERRUPTED_UNKNOWN",
          operationRef: fixed.spec.operationRef,
          plan,
          manifestRawDigest: fixed.databaseTestManifestRawDigest,
          createdAt
        })
      )
    });
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(privateRoot, "r3", fixed.spec.operationRef, "database-credentials");
    databaseStage = "CREDENTIAL_DIRECTORY";
    await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
    if ((await fs.readdir(directory)).length !== 0) fail(code);
    // Finish this fixed directory before pinning any of its files. Adding a
    // sibling after a pin would correctly invalidate its held parent identity.
    const preparedSecrets = new Map();
    for (const target of [...plan.targets, ...plan.reservations]) {
      for (const [profile, username] of Object.entries(target.roles)) {
        const filename = `${target.databaseName}-${profile}.json`;
        const filepath = path.join(directory, filename);
        const bytes = encodeManualJson({
          username,
          password: randomBytes(32).toString("hex"),
          host: "127.0.0.1",
          port: 55441,
          database: target.databaseName,
          tlsMode: "require"
        });
        const file = await fs.open(filepath, "wx", 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          bytes.fill(0);
          await file.close();
        }
        preparedSecrets.set(filename, { filepath });
      }
    }
    for (const [filename, prepared] of preparedSecrets) {
      prepared.held = await pinPrivateInput(prepared.filepath, { principal, privateRoot }, 4096);
      databaseSecrets.push(prepared.held);
      databaseSecretByName.set(filename, prepared.held);
    }
    await check();
    databaseStage = "PROVISION";
    const created = await databaseAdmin(plan, (executeAdmin) =>
      provisionR3DatabaseTargets({
        plan,
        policy: fixed.databaseTargetPolicy,
        createdAt,
        executeAdmin,
        recheck: check,
        createSecret: async ({ databaseName, profile, username }) => {
          const target = plan.targets.find((item) => item.databaseName === databaseName);
          if (!target || target.roles[profile] !== username || closed) fail(code);
          const filename = `${databaseName}-${profile}.json`;
          const held = preparedSecrets.get(filename)?.held;
          if (!held) fail(code);
          await held.recheck();
          const secret = JSON.parse(held.bytes);
          return {
            username,
            password: secret.password,
            reference: `r3/${fixed.spec.operationRef}/database-credentials/${filename}`
          };
        }
      })
    );
    databaseStage = "FINAL_CLUSTER_IDENTITY";
    await check();
    await inspectPg(boundEngineId);
    if (
      sha256Canonical(created.plan) !== sha256Canonical(plan) ||
      !Array.isArray(created.records) ||
      created.records.length !== plan.targets.length
    )
      fail(code);
    databaseStage = "TARGET_LOCKS";
    targetLockLease = await session.holdTargets({
      engineId: postgresTarget.engineId,
      systemIdentifier: postgresTarget.postgres.systemIdentifier,
      targets: created.records.map(({ databaseName, databaseOid, marker }) => ({
        databaseName,
        databaseOid,
        marker
      }))
    });
    await databaseAdmin(plan, (executeAdmin) =>
      recheckR3DatabaseTargets({
        plan,
        records: created.records,
        executeAdmin
      })
    );
    await check();
    const result = Object.freeze({
      ...created,
      targetLocks: targetLockLease.locks,
      status: "DATABASES_OBSERVED",
      manifestRawDigest: fixed.databaseTestManifestRawDigest,
      engineId: postgresTarget.engineId,
      systemIdentifier: postgresTarget.postgres.systemIdentifier,
      promotionEligible: false,
      targetSetComplete: false
    });
    databaseStage = "RESULT_ARCHIVE";
    diagnostics.push({
      name: "database-target-set",
      body: await postgresArchive.raw(encodeManualJson(result))
    });
    databaseTargetSet = result;
    databaseStage = "OBSERVED";
    return databaseTargetSet;
  };
  const recordDestination = async () => {
    destinationStage = "LIVE_READBACK";
    await check();
    for (const held of databaseSecrets) await held.recheck();
    const observed = await inspectPg(boundEngineId);
    if (
      Object.keys(observed).some(
        (key) => sha256Canonical(observed[key]) !== sha256Canonical(postgresTarget[key])
      )
    )
      fail(code);
    const databaseReadback = [];
    await databaseAdmin(
      databaseTargetSet.plan,
      (executeAdmin) =>
        recheckR3DatabaseTargets({
          plan: databaseTargetSet.plan,
          records: databaseTargetSet.records,
          executeAdmin
        }),
      databaseReadback
    );
    await check();
    const initialExecution = (await archive.get(consumption.executionRecordDigest, "journal"))
      .value;
    destinationStage = "BUILD";
    const result = await buildR3Destination({
      spec: fixed.spec,
      jobAdmissionDigest: fixed.jobAdmissionDigest,
      hostedEvidence: fieldsFrom(hostedEvidence, [
        "bundleDigest",
        "engine",
        "workspaceObservation",
        "jobAdmissionDigest",
        "spec"
      ]),
      session: fieldsFrom(session, ["profileDigest", "sessionId", "sessionNonce", "scope"]),
      initialExecution,
      manifest: fixed.databaseTestManifest,
      manifestRawDigest: fixed.databaseTestManifestRawDigest,
      policy: fixed.databaseTargetPolicy,
      postgresReadback,
      databaseTargetSet,
      databaseReadback,
      observedAt: new Date().toISOString()
    });
    const destinationBytes = encodeManualJson(result.destination),
      observationBytes = encodeManualJson(result.observations),
      destinationDigest = sha256Bytes(destinationBytes),
      observationsDigest = sha256Bytes(observationBytes);
    if (
      result.destination.observationEvidenceDigest !== observationsDigest ||
      result.destination.initialExecutionRecordDigest !== consumption.executionRecordDigest ||
      destinationBytes.length > 1048576 ||
      observationBytes.length > 1048576
    )
      fail(code);
    // Reuse the profile's independent encrypted backup and immutable object
    // names. A partially saved destination does not resolve the original UNKNOWN.
    destinationStage = "CUSTODY";
    for (const value of [result.observations, result.destination]) {
      const expected = sha256Canonical(value);
      for (const role of ["backup", "archive"])
        if ((await archive.put(value, null, role)) !== expected) fail(code);
    }
    await check();
    destinationRecord = {
      originals: [
        [observationsDigest, observationBytes],
        [destinationDigest, destinationBytes]
      ],
      destination: JSON.parse(destinationBytes),
      destinationDigest
    };
    await recheckDestination();
    destinationReady = true;
    destinationStage = "OBSERVED";
    return Object.freeze({
      status: "DESTINATION_OBSERVED",
      destinationDigest,
      observationEvidenceDigest: observationsDigest,
      initialExecutionRecordDigest: consumption.executionRecordDigest,
      promotionEligible: false
    });
  };
  const recheckResources = async () => {
    if (targetCleanupImportAttempted) fail(code);
    await check();
    if (destinationAttempted && !destinationReady) fail(code);
    if (postgresAttempted && !postgresTarget) fail(code);
    if (databasesAttempted && !databaseTargetSet) fail(code);
    for (const held of databaseSecrets) await held.recheck();
    const current = await engineReadback(
      !postgresAttempted,
      postgresAttempted ? savePgExchange : saveExchange
    );
    if (current.engine.ID !== boundEngineId) fail(code);
    if (postgresAttempted) {
      const observed = await inspectPg(boundEngineId);
      if (
        Object.keys(postgresTarget)
          .filter((key) => !["credentialRef", "status"].includes(key))
          .some((key) => sha256Canonical(observed[key]) !== sha256Canonical(postgresTarget[key]))
      )
        fail(code);
    }
    if (databaseTargetSet)
      await databaseAdmin(databaseTargetSet.plan, (executeAdmin) =>
        recheckR3DatabaseTargets({
          plan: databaseTargetSet.plan,
          records: databaseTargetSet.records,
          restoreStates: [...restoreStates].map(([databaseName, phase]) => ({
            databaseName,
            phase
          })),
          executeAdmin
        })
      );
    await snapshotCopy?.recheck();
    await check();
  };
  const completeCreation = async () => {
    await recheckResources();
    const result = await session.completeCreation({
      destinationDigest: destinationRecord.destinationDigest
    });
    const execution = await archive.get(result.executionRecordDigest, "journal");
    validateContract("manual-operation-record.v3", execution.value);
    if (
      execution.value.status !== "SUCCEEDED" ||
      execution.value.stage !== "target-create" ||
      execution.value.sessionId !== session.sessionId ||
      execution.value.sessionNonce !== session.sessionNonce ||
      execution.value.predecessorExecutionRecordDigest !== consumption.executionRecordDigest ||
      execution.value.resultDigest !== destinationRecord.destinationDigest ||
      execution.value.processEvidenceDigest !==
        destinationRecord.destination.observationEvidenceDigest ||
      !Array.isArray(result.custodyRecordDigests) ||
      result.custodyRecordDigests.length !== 4 ||
      new Set(result.custodyRecordDigests).size !== 4
    )
      fail(code);
    const originals = [
      {
        digest: result.executionRecordDigest,
        bytes: execution.bytes,
        roles: ["journal", "archive", "backup"]
      }
    ];
    for (const digest of result.custodyRecordDigests) {
      const custody = await archive.get(digest);
      validateContract("manual-operation-record.v3", custody.value);
      if (custody.value.kind !== "custody" || custody.value.outcome !== "MATCH") fail(code);
      originals.push({ digest, bytes: custody.bytes, roles: ["archive"] });
    }
    completionRecord = { originals, executionRecordDigest: result.executionRecordDigest };
    await recheckResources();
    completionReady = true;
    return Object.freeze({
      status: "TARGET_CREATED",
      executionRecordDigest: result.executionRecordDigest,
      custodyRecordDigests: Object.freeze([...result.custodyRecordDigests]),
      destinationDigest: destinationRecord.destinationDigest,
      promotionEligible: false
    });
  };
  const consumeSnapshot = async (inputReference, matchingSourceEvidenceDigest) => {
    await recheckResources();
    consumerInput = await readR3SnapshotInput({
      repoRoot: input.repoRoot,
      inputReference,
      now: new Date()
    });
    const opened = [...(await archive.graph()).entries()].filter(
      ([, item]) =>
        item.value.schemaVersion === "manual-operation-record.v3" &&
        item.value.kind === "session" &&
        item.value.sessionId === session.sessionId &&
        item.value.status === "OPEN"
    );
    if (opened.length !== 1) fail(code);
    const now = new Date().toISOString();
    const request = {
      schemaVersion: "manual-runner-request.v3",
      profileDigest: session.profileDigest,
      ownerId: lease.profile.ownerId,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      operationId: input.operationRef,
      idempotencyKey: `r3-snapshot:${input.operationRef}`,
      attemptId: randomUUID(),
      runId: randomUUID(),
      stage: "snapshot-consumer",
      capability: "read-decrypt-use",
      purpose: "sanitized-snapshot-test-input",
      phase: session.scope.phase,
      sourceSha: session.scope.sourceSha,
      scopeAuthorizationDigest: consumerInput.permissionDigest,
      destinationAdmissionDigest: destinationRecord.destinationDigest,
      input: { inputReference, inputIndexDigest: consumerInput.inputIndexDigest },
      ...(session.scope.phase === "final" ? { matchingSourceEvidenceDigest } : {}),
      candidate: { buildProofDigest: session.scope.buildProofDigest }
    };
    request.attemptAllocationDigest = await archive.put(
      {
        schemaVersion: "manual-runner-evidence.v2",
        kind: "attempt-allocation",
        recordedAt: now,
        promotionEligible: false,
        ...fieldsFrom(request, [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId",
          "runId",
          "stage",
          "phase",
          "sourceSha",
          "destinationAdmissionDigest",
          "scopeAuthorizationDigest",
          "input"
        ]),
        ...fieldsFrom(session.scope, [
          "chain",
          "targetPolicyDigest",
          "creationSpecDigest",
          "jobAdmissionDigest"
        ]),
        sessionRecordDigest: opened[0][0],
        allocatedAt: now,
        buildProofDigest: session.scope.buildProofDigest,
        predecessorExecutionRecordDigest: completionRecord.executionRecordDigest,
        ...(session.scope.phase === "final" ? { matchingSourceEvidenceDigest } : {})
      },
      "manual-runner-evidence.v2"
    );
    await consumerInput.assertConsumerBinding({ request, scope: session.scope });
    const requestDigest = await archive.put(request, "manual-runner-request.v3");
    const binding = fieldsFrom(request, [
      "profileDigest",
      "ownerId",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "stage",
      "capability",
      "purpose",
      "phase",
      "scopeAuthorizationDigest"
    ]);
    const requestInput = { binding, canonicalBytes: encodeManualJson(request) };
    const authorization = await session.sign(requestInput);
    await recheckResources();
    const receipt = await session.consume({ authorization, request: requestInput });
    const execution = await archive.get(receipt.executionRecordDigest, "journal");
    validateContract("manual-operation-record.v3", execution.value);
    if (
      receipt.stage !== "snapshot-consumer" ||
      execution.value.stage !== "snapshot-consumer" ||
      execution.value.status !== "INTERRUPTED_UNKNOWN" ||
      execution.value.predecessorExecutionRecordDigest !== completionRecord.executionRecordDigest ||
      execution.value.requestDigest !== requestDigest ||
      execution.value.authorizationDigest !== sha256Canonical(authorization) ||
      execution.value.sessionId !== session.sessionId ||
      execution.value.sessionNonce !== session.sessionNonce
    )
      fail(code);
    const consumed = await archive.get(execution.value.consumptionRecordDigest, "journal");
    const readback = await archive.get(receipt.consumptionReadbackDigest);
    for (const value of [consumed.value, readback.value])
      validateContract("manual-operation-record.v3", value);
    if (
      consumed.value.kind !== "consumption" ||
      consumed.value.status !== "CONSUMED" ||
      consumed.value.stage !== "snapshot-consumer" ||
      consumed.value.requestDigest !== requestDigest ||
      readback.value.purpose !== "consumption-readback" ||
      readback.value.outcome !== "MATCH" ||
      readback.value.subjectDigest !== execution.value.consumptionRecordDigest ||
      readback.value.observedDigest !== execution.value.consumptionRecordDigest
    )
      fail(code);
    consumerSlot = await pinPrivateInput(
      path.join(
        lease.profile.storage.journalRoot,
        "consumptions",
        `${session.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
      ),
      {
        principal: { platform: "posix", uid: process.getuid() },
        privateRoot: lease.profile.storage.journalRoot
      }
    );
    if (!consumerSlot.bytes.equals(consumed.bytes)) fail(code);
    consumerRecord = [];
    for (const [digest, role] of [
      [request.attemptAllocationDigest, "archive"],
      [requestDigest, "archive"],
      [sha256Canonical(authorization), "archive"],
      [receipt.executionRecordDigest, "journal"],
      [execution.value.consumptionRecordDigest, "journal"],
      [receipt.consumptionReadbackDigest, "archive"]
    ])
      consumerRecord.push({ digest, role, bytes: (await archive.get(digest, role)).bytes });
    await recheckResources();
    consumerExecutionDigest = receipt.executionRecordDigest;
    consumerMatchingSourceDigest = matchingSourceEvidenceDigest;
    consumerReady = true;
    await assertSnapshotConsumption();
    return Object.freeze({
      status: "SNAPSHOT_INPUT_CONSUMED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: receipt.executionRecordDigest,
      consumptionRecordDigest: execution.value.consumptionRecordDigest,
      consumptionReadbackDigest: receipt.consumptionReadbackDigest,
      requestDigest,
      destinationDigest: destinationRecord.destinationDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      promotionEligible: false
    });
  };
  // A source terminal digest is a selector only. The held core independently
  // reconstructs its complete history and authenticates prior job inputs.
  // Check explicit stages, not every low-level Engine read in a restore.
  const assertSnapshotConsumption = async () => {
    if (session.scope.phase !== "final" || !consumerReady) return;
    try {
      const receipt = await session.assertSnapshotConsumption();
      if (
        !exact(receipt, ["executionRecordDigest", "matchingSourceEvidenceDigest"]) ||
        receipt.executionRecordDigest !== consumerExecutionDigest ||
        receipt.matchingSourceEvidenceDigest !== consumerMatchingSourceDigest
      )
        fail(code);
    } catch (error) {
      await session.closeIncomplete().catch(() => {});
      throw error;
    }
  };
  const snapshotPhase = async (work) => {
    await assertSnapshotConsumption();
    const result = await work();
    await assertSnapshotConsumption();
    return result;
  };
  const fetchSnapshot = async () => {
    snapshotPayload = await fetchR3SnapshotCiphertext({
      profile: lease.profile,
      operationRef: fixed.spec.operationRef,
      subject: consumerInput.storageSubject,
      signal: fetchAbort.signal,
      recheck: recheckResources
    });
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(privateRoot, "r3", fixed.spec.operationRef, "consumer");
    const facts = snapshotPayload.facts;
    if (
      facts.path !== path.join(directory, "ciphertext", "snapshot.enc") ||
      facts.ciphertextDigest !== consumerInput.storageSubject.ciphertextDigest ||
      facts.ciphertextSizeBytes !== consumerInput.storageSubject.ciphertextSizeBytes ||
      typeof facts.readerPrincipal !== "string" ||
      facts.readerPrincipal === consumerInput.storageSubject.writerPrincipal
    )
      fail(code);
    // This separate precreated directory does not change the ciphertext's
    // pinned parents. The original consumer UNKNOWN and global raw store remain.
    const observedDirectory = path.join(directory, "observations");
    await checkedPrivatePath(observedDirectory, { principal, privateRoot, directory: true });
    const bytes = encodeManualJson({
      status: "CIPHERTEXT_OBSERVED",
      operationRef: fixed.spec.operationRef,
      sessionId: session.sessionId,
      inputIndexDigest: consumerInput.inputIndexDigest,
      consumerExecutionRecordDigest: consumerExecutionDigest,
      storageSubject: consumerInput.storageSubject,
      observations: snapshotPayload.observations
    });
    if (bytes.length > 1048576) fail(code);
    const filename = path.join(observedDirectory, "readback.json");
    const file = await fs.open(filename, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await fs.open(observedDirectory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    snapshotReadback = await pinPrivateInput(filename, { principal, privateRoot });
    if (!snapshotReadback.bytes.equals(bytes)) fail(code);
    await check();
    fetchReady = true;
    return Object.freeze({
      status: "CIPHERTEXT_OBSERVED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: consumerExecutionDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      ciphertextDigest: facts.ciphertextDigest,
      ciphertextSizeBytes: facts.ciphertextSizeBytes,
      readbackDigest: sha256Bytes(bytes),
      promotionEligible: false
    });
  };
  const decryptSnapshot = async () => {
    snapshotPlaintext = await decryptR3SnapshotCiphertext({
      repoRoot: input.repoRoot,
      profile: lease.profile,
      operationRef: fixed.spec.operationRef,
      cryptoInputs: consumerInput.cryptoInputs,
      source: snapshotPayload.source,
      signal: fetchAbort.signal,
      recheck: recheckResources
    });
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(privateRoot, "r3", fixed.spec.operationRef, "consumer");
    const facts = snapshotPlaintext.facts;
    const envelope = consumerInput.cryptoInputs.envelope;
    if (
      facts.path !== path.join(directory, "plaintext", "snapshot.dump") ||
      facts.snapshotDigest !== envelope.snapshotDigest ||
      facts.keyFingerprint !== envelope.localKeyReadback.keyFingerprint ||
      facts.plaintextSizeBytes !== envelope.ciphertextSizeBytes
    )
      fail(code);
    const observedDirectory = path.join(directory, "observations", "decryption");
    await checkedPrivatePath(observedDirectory, { principal, privateRoot, directory: true });
    const bytes = encodeManualJson({
      status: "PLAINTEXT_AUTHENTICATED",
      operationRef: fixed.spec.operationRef,
      sessionId: session.sessionId,
      inputIndexDigest: consumerInput.inputIndexDigest,
      consumerExecutionRecordDigest: consumerExecutionDigest,
      ciphertextReadbackDigest: sha256Bytes(snapshotReadback.bytes),
      snapshotDigest: facts.snapshotDigest,
      plaintextSizeBytes: facts.plaintextSizeBytes,
      keyFingerprint: facts.keyFingerprint,
      observations: snapshotPlaintext.observations
    });
    if (bytes.length > 1048576) fail(code);
    const filename = path.join(observedDirectory, "readback.json");
    const file = await fs.open(filename, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await fs.open(observedDirectory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    decryptionReadback = await pinPrivateInput(filename, { principal, privateRoot });
    if (!decryptionReadback.bytes.equals(bytes)) fail(code);
    await check();
    decryptReady = true;
    return Object.freeze({
      status: "PLAINTEXT_AUTHENTICATED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: consumerExecutionDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      snapshotDigest: facts.snapshotDigest,
      plaintextSizeBytes: facts.plaintextSizeBytes,
      readbackDigest: sha256Bytes(bytes),
      promotionEligible: false
    });
  };
  const copySnapshot = async () => {
    snapshotCopy = await copyR3SnapshotToPostgres({
      operationRef: fixed.spec.operationRef,
      containerId: postgresTarget.containerId,
      plaintext: snapshotPlaintext,
      engineCall,
      recheck: recheckResources,
      signal: fetchAbort.signal
    });
    const facts = snapshotCopy.facts;
    const targetDirectory = `/tmp/stage1-r3-${fixed.spec.operationRef.replaceAll("-", "")}`;
    if (
      facts.containerId !== postgresTarget.containerId ||
      facts.directory !== targetDirectory ||
      facts.path !== `${targetDirectory}/snapshot.dump` ||
      facts.snapshotDigest !== snapshotPlaintext.facts.snapshotDigest ||
      facts.plaintextSizeBytes !== snapshotPlaintext.facts.plaintextSizeBytes
    )
      fail(code);
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(
      privateRoot,
      "r3",
      fixed.spec.operationRef,
      "consumer",
      "observations",
      "copy"
    );
    await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
    const bytes = encodeManualJson({
      status: "PLAINTEXT_COPIED",
      operationRef: fixed.spec.operationRef,
      sessionId: session.sessionId,
      inputIndexDigest: consumerInput.inputIndexDigest,
      consumerExecutionRecordDigest: consumerExecutionDigest,
      decryptionReadbackDigest: sha256Bytes(decryptionReadback.bytes),
      engineId: boundEngineId,
      facts,
      observations: snapshotCopy.observations
    });
    if (bytes.length > 1048576) fail(code);
    const filename = path.join(directory, "readback.json");
    const file = await fs.open(filename, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await fs.open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    copyReadback = await pinPrivateInput(filename, { principal, privateRoot });
    if (!copyReadback.bytes.equals(bytes)) fail(code);
    await recheckResources();
    copyReady = true;
    return Object.freeze({
      status: "PLAINTEXT_COPIED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: consumerExecutionDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      snapshotDigest: facts.snapshotDigest,
      plaintextSizeBytes: facts.plaintextSizeBytes,
      readbackDigest: sha256Bytes(bytes),
      promotionEligible: false
    });
  };
  const restoreSnapshot = async () => {
    await recheckResources();
    const { metadata, ownershipMap } = consumerInput.restoreInputs;
    if (
      metadata.dumpDigest !== snapshotCopy.facts.snapshotDigest ||
      metadata.ownershipMapDigest !== sha256Canonical(ownershipMap) ||
      databaseTargetSet.plan.chain !== "snapshot" ||
      databaseTargetSet.plan.phase !== session.scope.phase
    )
      fail(code);
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const readbacks = [];
    for (const target of databaseTargetSet.records) {
      if (stopping) fail(code);
      const identity = {
        kind: "r3-database-target",
        engineId: boundEngineId,
        systemIdentifier: postgresTarget.postgres.systemIdentifier,
        databaseOid: target.databaseOid,
        marker: target.marker
      };
      const databaseIdentityDigest = sha256Canonical(identity);
      const locks = targetLockLease.locks.filter(
        (lock) =>
          lock.databaseName === target.databaseName && lock.lockDigest === databaseIdentityDigest
      );
      if (locks.length !== 1 || sha256Canonical(locks[0].identity) !== databaseIdentityDigest)
        fail(code);
      const credentials = {};
      const heldCredentials = [];
      for (const profile of ["restore", "migrate"]) {
        const filename = `${target.databaseName}-${profile}.json`;
        if (
          target.secretReferences[profile] !==
          `r3/${fixed.spec.operationRef}/database-credentials/${filename}`
        )
          fail(code);
        const held = databaseSecretByName.get(filename);
        if (!held) fail(code);
        await held.recheck();
        heldCredentials.push(held);
        credentials[profile] = JSON.parse(held.bytes);
      }
      const result = await restoreR3SnapshotDatabase({
        operationRef: fixed.spec.operationRef,
        postgres: postgresTarget,
        target: { ...target, databaseIdentityDigest },
        copied: snapshotCopy,
        ownershipMap,
        restoreCredential: credentials.restore,
        migrationCredential: credentials.migrate,
        engineCall,
        // The helper observes this exact PG target, role transition and copied
        // file. Recheck the complete set before/after the loop, and keep current
        // trust plus the held credential originals checked within each target.
        recheck: async () => {
          await check();
          for (const held of heldCredentials) await held.recheck();
        },
        transition: (phase) => {
          const previous = restoreStates.get(target.databaseName);
          const allowed = {
            GRANTING: [undefined],
            GRANTED: ["GRANTING"],
            REVOKING: ["GRANTING", "GRANTED"],
            REVOKED: ["REVOKING"]
          };
          if (!allowed[phase]?.includes(previous)) fail(code);
          restoreStates.set(target.databaseName, phase);
        },
        signal: fetchAbort.signal
      });
      if (
        restoreStates.get(target.databaseName) !== "REVOKED" ||
        result.facts.containerId !== postgresTarget.containerId ||
        result.facts.databaseName !== target.databaseName ||
        result.facts.databaseOid !== target.databaseOid ||
        result.facts.snapshotDigest !== metadata.dumpDigest ||
        result.facts.ownershipObservationDigest !==
          sha256Canonical(result.observations.ownershipObservation) ||
        result.facts.restoreRoleDisabled !== true ||
        result.facts.credentialFilesRemoved !== true
      )
        fail(code);
      const directory = path.join(
        privateRoot,
        "r3",
        fixed.spec.operationRef,
        "consumer",
        "observations",
        "restore",
        target.databaseName
      );
      await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
      const bytes = encodeManualJson({
        status: "SNAPSHOT_DATABASE_RESTORED",
        operationRef: fixed.spec.operationRef,
        sessionId: session.sessionId,
        inputIndexDigest: consumerInput.inputIndexDigest,
        consumerExecutionRecordDigest: consumerExecutionDigest,
        copyReadbackDigest: sha256Bytes(copyReadback.bytes),
        databaseIdentityDigest,
        facts: result.facts,
        observations: result.observations
      });
      if (bytes.length > 1048576) fail(code);
      const filename = path.join(directory, "readback.json");
      const file = await fs.open(filename, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await fs.open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const held = await pinPrivateInput(filename, { principal, privateRoot });
      restoreReadbacks.push(held);
      if (!held.bytes.equals(bytes)) fail(code);
      readbacks.push(
        Object.freeze({ databaseName: target.databaseName, digest: sha256Bytes(bytes) })
      );
    }
    await recheckResources();
    if (stopping) fail(code);
    restoreReady = true;
    return Object.freeze({
      status: "SNAPSHOT_DATABASES_RESTORED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: consumerExecutionDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      snapshotDigest: metadata.dumpDigest,
      readbacks: Object.freeze(readbacks),
      promotionEligible: false
    });
  };
  const sourceCheck = async () => {
    if (stopping || closed || sourceAbort.signal.aborted) fail(code);
    if (!candidateUseRecord) fail(code);
    await check();
  };
  const consumeCandidateUse = async (matchingSourceEvidenceDigest) => {
    await recheckResources();
    const final = session.scope.phase === "final";
    if (
      final
        ? !/^sha256:[0-9a-f]{64}$/u.test(matchingSourceEvidenceDigest ?? "")
        : matchingSourceEvidenceDigest !== undefined
    )
      fail(code);
    if (
      final &&
      session.scope.chain === "snapshot" &&
      consumerMatchingSourceDigest !== matchingSourceEvidenceDigest
    )
      fail(code);
    const opened = [...(await archive.graph()).entries()].filter(
      ([, item]) =>
        item.value.schemaVersion === "manual-operation-record.v3" &&
        item.value.kind === "session" &&
        item.value.sessionId === session.sessionId &&
        item.value.status === "OPEN"
    );
    if (opened.length !== 1 || candidateUseRecord) fail(code);
    const preparationExecutionRecordDigest =
      session.scope.chain === "snapshot"
        ? snapshotCompletionRecord?.executionRecordDigest
        : completionRecord.executionRecordDigest;
    const now = new Date().toISOString();
    const request = {
      schemaVersion: "manual-runner-request.v5",
      profileDigest: session.profileDigest,
      ownerId: lease.profile.ownerId,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      operationId: input.operationRef,
      idempotencyKey: `r3-candidate-use:${input.operationRef}`,
      attemptId: randomUUID(),
      runId: randomUUID(),
      stage: "candidate-use",
      capability: final ? "execute-final-database-tests" : "execute-source-database-tests",
      purpose: "stage1-isolated-database-tests",
      ...fieldsFrom(session.scope, [
        "phase",
        "chain",
        "sourceSha",
        "targetPolicyDigest",
        "creationSpecDigest",
        "jobAdmissionDigest"
      ]),
      candidate: { buildProofDigest: session.scope.buildProofDigest },
      destinationAdmissionDigest: destinationRecord.destinationDigest,
      preparationExecutionRecordDigest,
      databaseTestManifestDigest: sha256Canonical(fixed.databaseTestManifest),
      ...(final ? { matchingSourceEvidenceDigest } : {})
    };
    request.attemptAllocationDigest = await archive.put(
      {
        schemaVersion: "manual-runner-evidence.v2",
        kind: "attempt-allocation",
        recordedAt: now,
        promotionEligible: false,
        ...fieldsFrom(request, [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId",
          "runId",
          "stage",
          "phase",
          "chain",
          "sourceSha",
          "targetPolicyDigest",
          "creationSpecDigest",
          "jobAdmissionDigest",
          "destinationAdmissionDigest",
          "preparationExecutionRecordDigest",
          "databaseTestManifestDigest"
        ]),
        sessionRecordDigest: opened[0][0],
        allocatedAt: now,
        buildProofDigest: session.scope.buildProofDigest,
        predecessorExecutionRecordDigest: preparationExecutionRecordDigest,
        ...(final ? { matchingSourceEvidenceDigest } : {})
      },
      "manual-runner-evidence.v2"
    );
    const requestDigest = await archive.put(request, "manual-runner-request.v5");
    const {
      schemaVersion,
      attemptId,
      runId,
      attemptAllocationDigest,
      sourceSha,
      candidate,
      ...binding
    } = request;
    const requestInput = { binding, canonicalBytes: encodeManualJson(request) };
    const authorization = await session.sign(requestInput);
    await recheckResources();
    const receipt = await session.consume({ authorization, request: requestInput });
    const execution = await archive.get(receipt.executionRecordDigest, "journal");
    validateContract("manual-operation-record.v3", execution.value);
    if (
      receipt.stage !== "candidate-use" ||
      execution.value.stage !== "candidate-use" ||
      execution.value.status !== "INTERRUPTED_UNKNOWN" ||
      execution.value.predecessorExecutionRecordDigest !== preparationExecutionRecordDigest ||
      execution.value.requestDigest !== requestDigest ||
      execution.value.authorizationDigest !== sha256Canonical(authorization) ||
      execution.value.sessionId !== session.sessionId ||
      execution.value.sessionNonce !== session.sessionNonce
    )
      fail(code);
    const admission = await session.assertCandidateUse();
    if (
      admission.executionRecordDigest !== receipt.executionRecordDigest ||
      (final && admission.matchingSourceEvidenceDigest !== matchingSourceEvidenceDigest)
    )
      fail(code);
    candidateUseRecord = {
      executionRecordDigest: receipt.executionRecordDigest,
      ...(final ? { admission, request } : {})
    };
    await sourceCheck();
  };
  const sourceSecret = async (record, profile) => {
    const planned = [
      ...databaseTargetSet.plan.targets,
      ...databaseTargetSet.plan.reservations
    ].find((item) => item.databaseName === record.databaseName);
    const filename = `${record.databaseName}-${profile}.json`;
    const held = databaseSecretByName.get(filename);
    if (
      !planned ||
      !["migrate", "runtime-test"].includes(profile) ||
      !held ||
      record.roles[profile] !== planned.roles[profile] ||
      record.secretReferences[profile] !==
        `r3/${fixed.spec.operationRef}/database-credentials/${filename}`
    )
      fail(code);
    await held.recheck();
    const secret = JSON.parse(held.bytes);
    if (
      secret.username !== planned.roles[profile] ||
      secret.database !== record.databaseName ||
      secret.host !== "127.0.0.1" ||
      secret.port !== 55441 ||
      secret.tlsMode !== "require"
    )
      fail(code);
    return secret;
  };
  const sourceCredential = async (record, profile, sql) => {
    await sourceCheck();
    const secret = await sourceSecret(record, profile);
    const connection = await createPostgresConnector()({
      credential: {
        username: secret.username,
        password: secret.password,
        capabilityProfile: profile
      },
      target: {
        hostname: secret.host,
        port: secret.port,
        databaseName: secret.database,
        tlsMode: secret.tlsMode
      },
      custody: {
        operationRef: fixed.spec.operationRef,
        executionRecordDigest: consumption.executionRecordDigest
      }
    });
    try {
      const identity = await connection.observeIdentity();
      if (
        identity.databaseName !== record.databaseName ||
        identity.databaseOid !== record.databaseOid ||
        identity.role !== secret.username ||
        identity.tls !== true
      )
        fail(code);
      await connection.execute("SET statement_timeout = '30s'");
      await connection.execute("SET lock_timeout = '5s'");
      const rows = JSON.parse(JSON.stringify([...(await connection.query(sql))]));
      await sourceCheck();
      return { rows };
    } finally {
      await connection.close();
    }
  };
  const sourceProcess = (executable, args, timeoutMs, environment = {}) =>
    runR3SourceProcess({
      executable,
      args,
      timeoutMs,
      environment,
      repoRoot,
      signal: sourceAbort.signal,
      recheck: sourceCheck
    });
  const sourcePrisma = async (record, args, timeoutMs) => {
    const secret = await sourceSecret(record, "migrate");
    return sourceProcess(
      "pnpm",
      ["--filter", "@subscription-saas/api", "exec", "prisma", ...args],
      timeoutMs,
      {
        DATABASE_URL: `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@127.0.0.1:55441/${record.databaseName}?sslmode=require`,
        STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
      }
    );
  };
  const sourceFile = async (filename, value, privateRoot, handles) => {
    const principal = { platform: "posix", uid: process.getuid() };
    const bytes = encodePrivateObservationJson(value);
    if (bytes.length > 33554432) fail(code);
    const directory = path.dirname(filename);
    await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
    const handle = await fs.open(filename, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = await fs.open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const held = await pinPrivateInput(filename, { principal, privateRoot }, 33554432);
    handles.push(held);
    if (!held.bytes.equals(bytes)) fail(code);
    return sha256Bytes(bytes);
  };
  const sourceStore = async (name, value) => {
    if (
      !["attempt", "manifest"].includes(name) &&
      !fixed.databaseTestManifest.suites.some(({ suiteId }) => suiteId === name)
    )
      fail(code);
    let digest;
    for (const role of ["archive", "backup"]) {
      const privateRoot = lease.profile.storage[`${role}Root`];
      const actual = await sourceFile(
        path.join(
          privateRoot,
          "inputs",
          "r3",
          fixed.spec.operationRef,
          "observations",
          "source",
          name,
          "readback.json"
        ),
        value,
        privateRoot,
        sourceReadbacks
      );
      if (digest && actual !== digest) fail(code);
      digest = actual;
    }
    // Derive later results from the actual last pinned copy, only after both
    // stores agreed. The copies remain held and are checked by sourceCheck.
    sourceValues.set(name, JSON.parse(sourceReadbacks.at(-1).bytes));
    return digest;
  };
  const finalStore = async (name, value) => {
    const allowed = [
      "attempt",
      "manifest",
      "runtime",
      ...fixed.databaseTestManifest.suites.map(({ suiteId }) => suiteId),
      ...databaseTargetSet.plan.targets.map(({ databaseName }) => databaseName),
      ...databaseTargetSet.plan.reservations.map(({ databaseName }) => databaseName)
    ];
    if (!allowed.includes(name)) fail(code);
    let digest;
    for (const role of ["archive", "backup"]) {
      const privateRoot = lease.profile.storage[`${role}Root`];
      const actual = await sourceFile(
        path.join(
          privateRoot,
          "inputs",
          "r3",
          fixed.spec.operationRef,
          "observations",
          "final",
          name,
          "readback.json"
        ),
        value,
        privateRoot,
        finalReadbacks
      );
      if (digest && actual !== digest) fail(code);
      digest = actual;
    }
    return digest;
  };
  const runFinalManifest = async (matchingSourceEvidenceDigest) => {
    const observations = [],
      physicalLocks = new Map(),
      migrationAttempts = new Set();
    let runtime,
      runtimeWritten = false,
      manifestWritten = false,
      envelope,
      lifecycleReport;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const equal = (a, b) => sha256Canonical(plain(a)) === sha256Canonical(plain(b));
    try {
      if ((await fs.realpath(repoRoot)) !== (await fs.realpath(input.repoRoot))) fail(code);
      await consumeCandidateUse(matchingSourceEvidenceDigest);
      const request = candidateUseRecord.request;
      const matchedSource = candidateUseRecord.admission.matchedSource;
      await finalStore("attempt", {
        status: "FINAL_MANIFEST_INTERRUPTED_UNKNOWN",
        operationRef: fixed.spec.operationRef,
        sessionId: session.sessionId,
        sessionNonce: session.sessionNonce,
        candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
        matchingSourceEvidenceDigest,
        promotionEligible: false
      });
      const load = async (name) =>
        JSON.parse(await fs.readFile(path.join(repoRoot, "release/contracts", name), "utf8"));
      const manifest = fixed.databaseTestManifest;
      const discovery = await load("database-test-discovery.v1.json");
      const exceptions = await load("database-test-exceptions.v1.json");
      const external = await load("external-validation-applicability.v1.json");
      const globalObjectPolicy = await load("migration-global-object-policy.v1.json");
      const migrationCatalog = await computeMigrationCatalog(repoRoot);
      const buildProof = (await archive.get(session.scope.buildProofDigest)).value;
      validateContract("build-proof.v1", buildProof);
      if (
        sha256Canonical(buildProof) !== session.scope.buildProofDigest ||
        buildProof.identity.sourceSha !== fixed.spec.sourceSha ||
        buildProof.identity.repositoryContractDigest !==
          (await computeRepositoryContract(repoRoot)).digest ||
        buildProof.identity.migrationCatalogDigest !== migrationCatalog.digest ||
        matchedSource.terminalDigest !== matchingSourceEvidenceDigest
      )
        fail(code);
      const classification = classifyDatabaseTests(
        await discoverDatabaseTestCandidates(repoRoot, discovery),
        manifest.suites,
        exceptions.exceptions,
        external.records
      );
      if ((await scanDatabaseFrameworkBypasses(repoRoot, manifest)).length) fail(code);
      const plan = databaseTargetSet.plan;
      let selections = bindR3FinalManifest({
        operationRef: fixed.spec.operationRef,
        chain: fixed.spec.chain,
        manifest,
        plan,
        discoveryDigest: sha256Canonical(discovery),
        discoveryUnclassifiedCount: classification.unclassified.length
      }).map((selection) => plain({ ...selection, runId: request.runId }));
      const postgres = {
        engineId: postgresTarget.engineId,
        containerId: postgresTarget.containerId,
        systemIdentifier: postgresTarget.postgres.systemIdentifier,
        imageDigest: postgresTarget.imageDigest,
        hostname: "postgres",
        port: 5432,
        tlsMode: "require"
      };
      const parent = {
        ...fieldsFrom(request, [
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
        candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
        matchingSourceEvidenceDigest,
        destinationAdmissionDigest: destinationRecord.destinationDigest,
        creationEvidenceDigest: hostedEvidence.bundleDigest,
        databaseTargetPlanDigest: sha256Canonical(plan),
        databaseTestManifestDigest: sha256Canonical(manifest),
        databaseTestDiscoveryDigest: sha256Canonical(discovery),
        buildProof,
        buildProofDigest: session.scope.buildProofDigest,
        actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
        postgres
      };
      const imageReference = `ghcr.io/keqi119/subscription-runner@${parent.actualRunnerDigest}`;
      if (buildProof.identity.images.runner.registry !== "ghcr.io/keqi119/subscription-runner")
        fail(code);
      const identity = {
        operationRef: fixed.spec.operationRef,
        sourceSha: parent.sourceSha,
        imageDigest: parent.actualRunnerDigest,
        imageReference,
        postgresAddress: postgresTarget.containerAddress
      };
      const target = Object.freeze({
        policyId: fixed.databaseTargetPolicy.policyId,
        environment: `ci-${plan.chain}`,
        host: "127.0.0.1",
        clusterMarker: postgresTarget.postgres.clusterMarker,
        clusterFingerprint: sha256Canonical({
          engineId: postgres.engineId,
          systemIdentifier: postgres.systemIdentifier,
          containerId: postgres.containerId,
          imageDigest: postgres.imageDigest
        }),
        imageDigest: postgres.imageDigest,
        serverVersionNum: postgresTarget.postgres.serverVersionNum
      });
      const reservations = plan.reservations.map(({ shard, databaseName, roles }) => ({
        shard,
        databaseName,
        roles,
        targetLockDigest: targetLockLease.locks.find((entry) => entry.databaseName === databaseName)
          ?.lockDigest
      }));
      const runtimeBoundary = async (record, database) =>
        observeFinalRuntimeBoundary(
          {
            $queryRawUnsafe: async (sql) =>
              (await sourceCredential(record, "runtime-test", sql)).rows
          },
          database
        );
      const migrate = async (record) => {
        if (
          !finalResources ||
          finalResources.migrationContainerId ||
          migrationAttempts.has(record.databaseName)
        )
          fail(code);
        migrationAttempts.add(record.databaseName);
        const planned = [...plan.targets, ...plan.reservations].find(
          (item) => item.databaseName === record.databaseName
        );
        if (!planned || planned.kind === "application" || !equal(record.roles, planned.roles))
          fail(code);
        const migrationSecret = await sourceSecret(record, "migrate");
        const runtimeSecret = await sourceSecret(record, "runtime-test");
        const lock =
          planned.kind === "suite"
            ? targetLockLease.locks.find((entry) => entry.databaseName === record.databaseName)
            : physicalLocks.get(record.databaseName);
        if (!lock) fail(code);
        const database = {
          databaseName: record.databaseName,
          databaseOid: record.databaseOid,
          marker: record.marker,
          migrationRole: record.roles.migrate,
          migrationCredentialFingerprint: sha256Bytes(
            Buffer.from(migrationSecret.password, "utf8")
          ),
          runtimeCredentialFingerprint: sha256Bytes(Buffer.from(runtimeSecret.password, "utf8")),
          databaseIdentityFingerprint: sha256Canonical({
            databaseName: record.databaseName,
            databaseOid: record.databaseOid,
            role: record.roles.migrate,
            tls: true
          }),
          targetLockDigest: lock.lockDigest
        };
        const assignment =
          planned.kind === "suite"
            ? { kind: "suite", suiteId: planned.suiteId, name: planned.name }
            : { kind: "lifecycle-owned", suiteId: planned.suiteId, lifecycleShard: planned.shard };
        let migrationInput, assessor, schema, preparation, boundary, owned;
        const physical = [];
        const observeTarget = async () => {
          const facts = await inspectPg(boundEngineId);
          const value = await sourceCredential(
            record,
            "migrate",
            `SELECT current_database()::text AS "databaseName", d.oid::text AS "databaseOid", COALESCE(shobj_description(d.oid,'pg_database'),'') AS "marker", pg_get_userbyid(d.datdba) AS "databaseOwner", (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname='public') AS "schemaOwner" FROM pg_database d WHERE d.datname=current_database()`
          );
          if (value.rows.length !== 1) fail(code);
          const observed = {
            ...value.rows[0],
            engineId: facts.engineId,
            postgresContainerId: facts.containerId,
            systemIdentifier: facts.postgres.systemIdentifier
          };
          physical.push(observed);
          return observed;
        };
        try {
          owned = await executeR3FinalMigrationContainer({
            identity: { ...identity, runnerContainerId: finalResources.runnerContainerId },
            signal: sourceAbort.signal,
            engineCall,
            recheck: () => inspectPg(boundEngineId),
            register: async (id) => {
              if (finalResources.migrationContainerId) fail(code);
              finalResources.migrationContainerId = id;
            },
            unregister: async (id) => {
              if (finalResources.migrationContainerId !== id) fail(code);
              delete finalResources.migrationContainerId;
            },
            prepare: async (id) => {
              migrationInput = {
                schemaVersion: "r3-final-migration-input.v1",
                ...parent,
                runnerContainerId: finalResources.runnerContainerId,
                migrationContainerId: id,
                matchingSourceResultDigest: matchedSource.resultDigest,
                assignment,
                database,
                expectedSchemaDigest: matchedSource.postSchemaDigest,
                migrationCatalogDigest: migrationCatalog.digest
              };
              assessor = createR3FinalMigrationAssessment({
                input: migrationInput,
                manifest,
                migrationCatalog,
                globalObjectPolicy,
                observeTarget
              });
              return {
                input: migrationInput,
                credential: {
                  username: migrationSecret.username,
                  password: migrationSecret.password,
                  capabilityProfile: "migrate"
                }
              };
            },
            assess: async ({ stage, result }) => {
              if (stage !== "prepare") {
                await assessor.assess({ stage, result });
                if (stage === "verify") schema = assessor.finish();
              } else {
                if (!schema) fail(code);
                preparation = await assessFinalRuntimePreparation({
                  input: migrationInput,
                  manifest,
                  migrationCatalog,
                  globalObjectPolicy,
                  preparation: result.preparation,
                  repoRoot
                });
                await observeTarget();
                boundary = await runtimeBoundary(record, {
                  ...database,
                  runtimeRole: runtimeSecret.username,
                  databaseIdentityFingerprint: sha256Canonical({
                    databaseName: record.databaseName,
                    databaseOid: record.databaseOid,
                    role: runtimeSecret.username,
                    tls: true
                  })
                });
              }
            }
          });
          if (!schema || !preparation || !boundary || owned.deleted !== true) fail(code);
        } catch (error) {
          await finalStore(record.databaseName, {
            status: "FINAL_MIGRATION_INTERRUPTED_UNKNOWN",
            input: migrationInput ?? null,
            physical,
            originals: error.originals ?? null,
            promotionEligible: false
          });
          throw error;
        }
        const migrationEvidenceDigest = await finalStore(record.databaseName, {
          status: "FINAL_MIGRATION_OBSERVED",
          input: migrationInput,
          physical,
          schema,
          preparation,
          boundary,
          originals: owned.originals,
          promotionEligible: false
        });
        const runtimeDatabase = {
          ...database,
          runtimeRole: runtimeSecret.username,
          databaseIdentityFingerprint: sha256Canonical({
            databaseName: record.databaseName,
            databaseOid: record.databaseOid,
            role: runtimeSecret.username,
            tls: true
          }),
          migrationEvidenceDigest,
          runtimeSecretReference: `secret-file:///run/secrets/${record.databaseName}-runtime-test.json`
        };
        finalMigrations.set(record.databaseName, {
          database: runtimeDatabase,
          preparation,
          boundary
        });
        await sourceCheck();
        return { exitCode: 0, signal: null };
      };
      lifecycleAttempted = true;
      const adapter = createR3LifecycleAdapter({
        plan,
        target,
        policy: fixed.databaseTargetPolicy,
        executeAdmin: (command) =>
          databaseAdmin(plan, (execute) => execute(command), observations, true),
        executeCredential: ({ record, profile, sql }) => sourceCredential(record, profile, sql),
        secretStore: {
          create: async ({ databaseName, profile, username }) => {
            const reservation = plan.reservations.find(
              (item) => item.databaseName === databaseName
            );
            if (!reservation || reservation.roles[profile] !== username) fail(code);
            const reference = `r3/${plan.operationRef}/database-credentials/${databaseName}-${profile}.json`;
            const secret = await sourceSecret(
              { ...reservation, secretReferences: { [profile]: reference } },
              profile
            );
            return { username, password: secret.password, reference };
          }
        },
        migrate,
        prepareRuntimeAccess: async (record) => {
          const prepared = finalMigrations.get(record.databaseName);
          if (!prepared) fail(code);
          const boundary = await runtimeBoundary(record, prepared.database);
          observations.push({
            stage: "final-runtime-boundary",
            databaseName: record.databaseName,
            value: boundary
          });
        },
        registerTarget: async (record) => {
          const registered = await session.registerLifecycleTarget({ record });
          if (physicalLocks.has(record.databaseName)) fail(code);
          physicalLocks.set(record.databaseName, registered.lock);
          lifecycleRegisteredRecords.push(plain(record));
          return registered;
        },
        recheck: sourceCheck,
        observations
      });
      const lifecycleAdapter = { ...adapter, reservations };
      await recheckResources();
      const pull = await engineCall(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(imageReference)}&platform=linux%2Famd64`,
        undefined,
        200,
        { timeout: 300000 }
      );
      const progress = pull
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      if (!progress.length || progress.some((item) => item.error || item.errorDetail)) fail(code);
      observations.push({ stage: "final-image-pull", value: progress });
      runtime = await executeR3FinalRuntimeContainer({
        identity,
        signal: sourceAbort.signal,
        engineCall,
        recheck: async () => {
          await sourceCheck();
          if (finalResources) await inspectPg(boundEngineId);
        },
        register: async (id) => {
          if (finalResources) fail(code);
          finalResources = {
            runnerContainerId: id,
            runtimeState: "created",
            imageDigest: parent.actualRunnerDigest,
            imageReference,
            sourceSha: parent.sourceSha
          };
        },
        started: async (id) => {
          if (finalResources.runnerContainerId !== id || finalResources.runtimeState !== "created")
            fail(code);
          finalResources.runtimeState = "running";
        },
        unregister: async (id) => {
          if (finalResources.runnerContainerId !== id || finalResources.migrationContainerId)
            fail(code);
          // Only this held candidate image is removed, after the owned CID's
          // independent absence readback; never prune an Engine or another job.
          const removed = await engineJson(
            "DELETE",
            `/images/${encodeURIComponent(imageReference)}?force=0&noprune=1`,
            undefined,
            200
          );
          await engineCall(
            "GET",
            `/images/${encodeURIComponent(imageReference)}/json`,
            undefined,
            404
          );
          observations.push({ stage: "final-image-removed", value: removed });
          finalResources = undefined;
        },
        prepare: async (runnerContainerId) => {
          await inspectPg(boundEngineId);
          for (const planned of plan.targets.filter((item) => item.kind === "suite")) {
            const record = databaseTargetSet.records.find(
              (item) => item.databaseName === planned.databaseName
            );
            if (!record) fail(code);
            await migrate(record);
          }
          const credentials = {},
            runtimePreparations = {};
          const suiteAssignments = {};
          for (const selection of selections) {
            if (selection.r3ExecutionMode === "lifecycle-owned") {
              suiteAssignments[selection.suiteId] = { kind: "lifecycle-owned", reservations };
              continue;
            }
            const databases = {};
            for (const planned of plan.targets.filter(
              (item) => item.suiteId === selection.suiteId
            )) {
              const prepared = finalMigrations.get(planned.databaseName);
              if (!prepared) fail(code);
              databases[planned.name] = prepared.database;
              const record = databaseTargetSet.records.find(
                (item) => item.databaseName === planned.databaseName
              );
              const secret = await sourceSecret(record, "runtime-test");
              credentials[planned.databaseName] = {
                username: secret.username,
                password: secret.password,
                capabilityProfile: "runtime-test"
              };
              runtimePreparations[planned.databaseName] = {
                migrationEvidenceDigest: prepared.database.migrationEvidenceDigest,
                schemaFixture: prepared.preparation.schemaFixture
              };
            }
            suiteAssignments[selection.suiteId] = { kind: "suite", databases };
          }
          envelope = {
            schemaVersion: "database-test-launch-envelope.v2",
            executionMode: "database-test",
            ...parent,
            runnerContainerId,
            databaseTestManifestReference: "launch-file:///run/launch/database-test-manifest.json",
            suiteAssignments
          };
          const admitted = validateFinalDatabaseTestAssignments({
            envelope,
            manifest,
            discoveryDigest: sha256Canonical(discovery)
          });
          selections = admitted.selections.map((selection) =>
            plain({ ...selection, runId: request.runId })
          );
          return {
            input: {
              envelope,
              credentials,
              runtimePreparations,
              lifecycleContext: {
                runId: plan.operationRef,
                target,
                policy: fixed.databaseTargetPolicy,
                reservations
              }
            }
          };
        },
        lifecycleAdapter,
        assessLifecycle: async ({ selection, originals }) => {
          if (
            lifecycleReady ||
            !equal(
              selection,
              selections.find((item) => item.r3ExecutionMode === "lifecycle-owned")
            )
          )
            fail(code);
          assertR3FinalLifecycleOriginals(originals);
          const physical = observations
            .filter((entry) => entry.stage === "provision")
            .map((entry) => entry.record);
          const boundaries = observations.filter(
            (entry) => entry.stage === "final-runtime-boundary"
          );
          if (
            physical.length !== 2 ||
            boundaries.length !== 2 ||
            observations.filter((entry) => entry.stage === "cleanup").length !== 2 ||
            observations.filter((entry) => entry.stage === "owned-absence").at(-1)?.value?.rows?.[0]
              ?.count !== "0"
          )
            fail(code);
          const logSummary = summarizeDatabaseTestLog({ stdout: originals.tap, stderr: "" });
          lifecycleReport = buildDatabaseSuiteReport({
            execution: selection,
            operationId: fixed.spec.operationRef,
            provisioned: {
              ...physical[0],
              additionalDatabases: [{ ...physical[1], name: "sibling" }]
            },
            result: {
              counts: databaseTestCounts(originals.tap),
              sanitizedLogDigest: sha256Canonical(logSummary),
              roleBoundaries: boundaries.map((entry, index) => ({
                database: index === 0 ? "target" : "sibling",
                ...entry.value.roleBoundary
              }))
            }
          });
          if (lifecycleReport.terminalStatus !== "PASSED") fail(code);
          lifecycleReady = true;
          return { report: lifecycleReport, originals };
        },
        assess: async (result) => {
          if (
            !lifecycleReady ||
            !exact(result, ["manifestReport", "suiteReadbacks"]) ||
            !Array.isArray(result.suiteReadbacks) ||
            result.suiteReadbacks.length !== selections.length
          )
            fail(code);
          const reports = new Map();
          for (const readback of result.suiteReadbacks) {
            if (
              !exact(readback, ["suiteId", "report", "originals"]) ||
              reports.has(readback.suiteId) ||
              !selections.some((item) => item.suiteId === readback.suiteId)
            )
              fail(code);
            reports.set(readback.suiteId, readback.report);
            if (
              readback.suiteId === "node.release-database-lifecycle.postgres" &&
              !equal(readback.report, lifecycleReport)
            )
              fail(code);
          }
          const reconstructed = await runDatabaseManifest({
            selections,
            concurrency: 1,
            executeSuite: async (selection) => reports.get(selection.suiteId)
          });
          if (
            reconstructed.terminalStatus !== "PASSED" ||
            !equal(reconstructed, result.manifestReport)
          )
            fail(code);
          // This records the observed execution only. A successful release
          // terminal still requires independent original reconstruction/custody.
          for (const readback of result.suiteReadbacks)
            await finalStore(readback.suiteId, readback);
        }
      });
      const { channel, ...containerOriginals } = runtime.originals;
      runtimeWritten = true;
      await finalStore("runtime", {
        envelope,
        ...containerOriginals,
        transcript: channel.transcript,
        resultDigest: sha256Canonical(runtime.result),
        promotionEligible: false
      });
      await recheckResources();
      manifestWritten = true;
      const readbackDigest = await finalStore("manifest", {
        status: "FINAL_MANIFEST_OBSERVED",
        envelope,
        manifestReport: runtime.result.manifestReport,
        observations,
        promotionEligible: false
      });
      await sourceCheck();
      const verified = await session.custodyFinalOriginals();
      if (verified.readbackDigest !== readbackDigest) fail(code);
      await sourceCheck();
      const completed = await session.completeFinal();
      const digestPattern = /^sha256:[0-9a-f]{64}$/u;
      if (
        !digestPattern.test(completed?.executionRecordDigest) ||
        !digestPattern.test(completed?.resultDigest) ||
        completed?.processEvidenceDigest !== readbackDigest ||
        !Array.isArray(completed?.custodyRecordDigests) ||
        completed.custodyRecordDigests.length !== 2 ||
        new Set(completed.custodyRecordDigests).size !== 2 ||
        completed.custodyRecordDigests.some((digest) => !digestPattern.test(digest))
      )
        fail(code);
      const initial = await archive.get(candidateUseRecord.executionRecordDigest, "journal");
      const execution = await archive.get(completed.executionRecordDigest, "journal");
      validateContract("manual-operation-record.v3", initial.value);
      validateContract("manual-operation-record.v3", execution.value);
      if (
        initial.value.stage !== "candidate-use" ||
        initial.value.status !== "INTERRUPTED_UNKNOWN" ||
        execution.value.stage !== "candidate-use" ||
        execution.value.status !== "SUCCEEDED" ||
        execution.value.promotionEligible !== false ||
        execution.value.reasonCode !== null ||
        execution.value.sessionId !== session.sessionId ||
        execution.value.sessionNonce !== session.sessionNonce ||
        execution.value.operationId !== fixed.spec.operationRef ||
        execution.value.predecessorExecutionRecordDigest !==
          candidateUseRecord.executionRecordDigest ||
        execution.value.resultDigest !== completed.resultDigest ||
        execution.value.processEvidenceDigest !== readbackDigest ||
        [
          "profileDigest",
          "requestDigest",
          "authorizationDigest",
          "consumptionRecordDigest",
          "idempotencyKey",
          "attemptId"
        ].some((field) => execution.value[field] !== initial.value[field])
      )
        fail(code);
      const originalRequest = await archive.get(initial.value.requestDigest);
      if (!equal(originalRequest.value, request)) fail(code);
      const result = await archive.get(completed.resultDigest);
      const { buildR3FinalCompletion } = await import("./r3-final-result.mjs");
      const custodyRecords = [];
      for (const digest of verified.custodyRecordDigests)
        custodyRecords.push((await archive.get(digest)).value);
      const rebuilt = buildR3FinalCompletion({
        request,
        initialExecution: initial.value,
        manifest,
        verified,
        custodyRecords,
        completedAt: result.value.completedAt
      });
      if (
        sha256Canonical(rebuilt) !== completed.resultDigest ||
        !result.bytes.equals(encodeManualJson(rebuilt))
      )
        fail(code);
      const originals = [
        {
          digest: completed.executionRecordDigest,
          bytes: execution.bytes,
          roles: ["journal", "archive", "backup"]
        },
        { digest: completed.resultDigest, bytes: result.bytes, roles: ["archive", "backup"] }
      ];
      const roles = new Set(["archive", "backup"]);
      for (const digest of completed.custodyRecordDigests) {
        const custody = await archive.get(digest);
        validateContract("manual-operation-record.v3", custody.value);
        const value = custody.value;
        if (
          value.kind !== "custody" ||
          value.promotionEligible !== false ||
          value.profileDigest !== session.profileDigest ||
          value.ownerId !== lease.profile.ownerId ||
          value.subjectType !== "record" ||
          !roles.delete(value.storageRole) ||
          value.purpose !== `${value.storageRole}-readback` ||
          value.outcome !== "MATCH" ||
          value.subjectDigest !== completed.resultDigest ||
          value.observedDigest !== completed.resultDigest ||
          value.retentionDays !== 90 ||
          value.reasonCode !== null
        )
          fail(code);
        originals.push({ digest, bytes: custody.bytes, roles: ["archive", "backup"] });
      }
      if (roles.size !== 0) fail(code);
      const { custodyRecordDigests: originalCustody, ...finalVerified } = verified;
      finalCompletionRecord = {
        originals,
        verifiedDigest: sha256Canonical(finalVerified),
        execution: execution.value,
        result: result.value
      };
      await sourceCheck();
      finalReady = true;
      return Object.freeze({
        status: "FINAL_MANIFEST_OBSERVED",
        readbackDigest,
        candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
        executionStatus: "SUCCEEDED",
        executionRecordDigest: completed.executionRecordDigest,
        resultDigest: completed.resultDigest,
        custodyRecordDigests: verified.custodyRecordDigests,
        resultCustodyRecordDigests: completed.custodyRecordDigests,
        counts: Object.freeze({ ...runtime.result.manifestReport.counts }),
        promotionEligible: false
      });
    } catch (error) {
      if (candidateUseRecord && !runtimeWritten && error.originals) {
        runtimeWritten = true;
        await finalStore("runtime", {
          status: "FINAL_RUNTIME_INTERRUPTED_UNKNOWN",
          originals: error.originals,
          promotionEligible: false
        }).catch(() => {});
      }
      if (candidateUseRecord && !manifestWritten) {
        manifestWritten = true;
        await finalStore("manifest", {
          status: "FINAL_MANIFEST_INTERRUPTED_UNKNOWN",
          observations,
          promotionEligible: false
        }).catch(() => {});
      }
      throw Object.assign(new Error(code), {
        code,
        failureCode: /^[A-Z0-9_]{1,64}$/u.test(error?.code ?? "") ? error.code : code
      });
    }
  };
  const runSourceManifest = async () => {
    const observations = [];
    let generation,
      attemptDigest,
      manifestWriteAttempted = false;
    try {
      if ((await fs.realpath(repoRoot)) !== (await fs.realpath(input.repoRoot))) fail(code);
      await consumeCandidateUse();
      await recheckResources();
      attemptDigest = await sourceStore("attempt", {
        status: "SOURCE_MANIFEST_INTERRUPTED_UNKNOWN",
        operationRef: fixed.spec.operationRef,
        sessionId: session.sessionId,
        sessionNonce: session.sessionNonce,
        sourceSha: fixed.spec.sourceSha,
        destinationDigest: destinationRecord.destinationDigest,
        manifestDigest: sha256Canonical(fixed.databaseTestManifest),
        candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
        promotionEligible: false
      });
      const load = async (name) =>
        JSON.parse(await fs.readFile(path.join(repoRoot, "release/contracts", name), "utf8"));
      const discovery = await load("database-test-discovery.v1.json");
      const exceptions = await load("database-test-exceptions.v1.json");
      const external = await load("external-validation-applicability.v1.json");
      const candidates = await discoverDatabaseTestCandidates(repoRoot, discovery);
      const classification = classifyDatabaseTests(
        candidates,
        fixed.databaseTestManifest.suites,
        exceptions.exceptions,
        external.records
      );
      if ((await scanDatabaseFrameworkBypasses(repoRoot, fixed.databaseTestManifest)).length)
        fail(code);
      await sourceCheck();
      const selections = bindR3SourceManifest({
        operationRef: fixed.spec.operationRef,
        chain: fixed.spec.chain,
        manifest: fixed.databaseTestManifest,
        plan: databaseTargetSet.plan,
        discoveryDigest: sha256Canonical(discovery),
        discoveryUnclassifiedCount: classification.unclassified.length
      });
      const clusterFingerprint = sha256Canonical({
        engineId: postgresTarget.engineId,
        systemIdentifier: postgresTarget.postgres.systemIdentifier,
        containerId: postgresTarget.containerId,
        imageDigest: postgresTarget.imageDigest
      });
      generation = await sourceProcess(
        "pnpm",
        [
          "--filter",
          "@subscription-saas/api",
          "exec",
          "prisma",
          "generate",
          "--schema",
          "prisma/schema.prisma"
        ],
        300000,
        { STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1" }
      );
      if (
        generation.code !== 0 ||
        generation.signal !== null ||
        generation.truncated ||
        generation.processError ||
        generation.timedOut
      )
        fail(code);
      let failed = false;
      const manifestReport = await runDatabaseManifest({
        selections,
        concurrency: 1,
        executeSuite: async (execution) => {
          if (failed) fail(code);
          await sourceCheck();
          let result;
          try {
            if (execution.r3ExecutionMode === "lifecycle-owned") {
              lifecycleAttempted = true;
              lifecyclePending = runLifecycle();
              await lifecyclePending;
              const physical = lifecycleResult.observations
                .filter((entry) => entry.stage === "provision")
                .map((entry) => entry.record);
              const roles = lifecycleResult.observations.filter(
                (entry) => entry.stage === "source-runtime-boundary"
              );
              const migrations = lifecycleResult.observations.filter(
                (entry) => entry.stage === "source-migration"
              );
              if (physical.length !== 2 || roles.length !== 2 || migrations.length !== 2)
                fail(code);
              const resultLog = { stdout: lifecycleResult.originals.tap, stderr: "" };
              const logSummary = summarizeDatabaseTestLog(resultLog);
              result = {
                originals: lifecycleResult,
                migrationObservations: migrations.map((entry) => entry.value),
                logSummary,
                report: buildDatabaseSuiteReport({
                  execution,
                  operationId: fixed.spec.operationRef,
                  provisioned: {
                    ...physical[0],
                    additionalDatabases: [{ ...physical[1], name: "sibling" }]
                  },
                  result: {
                    counts: databaseTestCounts(resultLog.stdout),
                    sanitizedLogDigest: sha256Canonical(logSummary),
                    roleBoundaries: roles.map((entry, index) =>
                      r3RuntimeBoundary(index === 0 ? "target" : "sibling", entry.value)
                    )
                  }
                })
              };
            } else {
              const assignments = [execution.assignment, ...execution.additionalAssignments];
              const records = assignments.map(({ databaseName }) =>
                databaseTargetSet.records.find((record) => record.databaseName === databaseName)
              );
              result = await executeR3SourceSuite({
                execution,
                records,
                clusterFingerprint,
                containerId: postgresTarget.containerId,
                profileDigest: session.profileDigest,
                repoRoot,
                readSecret: sourceSecret,
                executeCredential: sourceCredential,
                runPrisma: sourcePrisma,
                recheck: sourceCheck,
                writeContext: async (selection, context) => {
                  const reference = `r3/${fixed.spec.operationRef}/database-test-contexts/${selection.suiteId}/context.json`;
                  const privateRoot = lease.profile.storage.credentialRoot;
                  await sourceFile(
                    path.join(privateRoot, reference),
                    context,
                    privateRoot,
                    sourceContexts
                  );
                  return reference;
                },
                runTest: (selection, reference) =>
                  sourceProcess(
                    selection.command.executable,
                    selection.command.arguments,
                    selection.timeoutMs,
                    { S1_RELEASE_DATABASE_TEST: "1", S1_RELEASE_DATABASE_CONTEXT: reference }
                  )
              });
            }
            const digest = await sourceStore(execution.suiteId, {
              status: "SOURCE_SUITE_OBSERVED",
              attemptDigest,
              operationRef: fixed.spec.operationRef,
              sessionId: session.sessionId,
              destinationDigest: destinationRecord.destinationDigest,
              ...result,
              promotionEligible: false
            });
            observations.push({
              suiteId: execution.suiteId,
              readbackDigest: digest,
              migrationObservations: result.migrationObservations
            });
            if (result.report.terminalStatus !== "PASSED") {
              failed = true;
              fail(code);
            }
            await sourceCheck();
            return result.report;
          } catch (cause) {
            failed = true;
            if (!result)
              await sourceStore(execution.suiteId, {
                status: "SOURCE_SUITE_INTERRUPTED_UNKNOWN",
                attemptDigest,
                operationRef: fixed.spec.operationRef,
                originals: cause.originals ?? null,
                lifecycleReadbackDigest: /^sha256:[0-9a-f]{64}$/u.test(cause.readbackDigest ?? "")
                  ? cause.readbackDigest
                  : null,
                promotionEligible: false
              });
            throw Object.assign(new Error(code), { code });
          }
        }
      });
      await recheckResources();
      const reconstructed = await buildR3SourceResult({
        manifest: fixed.databaseTestManifest,
        plan: databaseTargetSet.plan,
        discoveryDigest: sha256Canonical(discovery),
        binding: {
          operationRef: fixed.spec.operationRef,
          chain: fixed.spec.chain,
          profileDigest: session.profileDigest,
          sessionId: session.sessionId,
          sessionNonce: session.sessionNonce,
          sourceSha: fixed.spec.sourceSha,
          destinationDigest: destinationRecord.destinationDigest,
          clusterFingerprint,
          containerId: postgresTarget.containerId,
          creationExecutionRecordDigest: completionRecord.executionRecordDigest,
          candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
          snapshotExecutionRecordDigest: snapshotCompletionRecord?.executionRecordDigest ?? null
        },
        records: databaseTargetSet.records,
        lifecycleRecords: lifecycleRegisteredRecords,
        attempt: sourceValues.get("attempt"),
        suiteReadbacks: selections.map(({ suiteId }) => sourceValues.get(suiteId)),
        manifestReport
      });
      await sourceCheck();
      const value = {
        status: "SOURCE_MANIFEST_OBSERVED",
        attemptDigest,
        operationRef: fixed.spec.operationRef,
        sessionId: session.sessionId,
        sessionNonce: session.sessionNonce,
        sourceSha: fixed.spec.sourceSha,
        destinationDigest: destinationRecord.destinationDigest,
        manifestReport,
        reconstructed,
        observations,
        generation,
        discovery: { candidates, classification, discoveryDigest: sha256Canonical(discovery) },
        promotionEligible: false
      };
      manifestWriteAttempted = true;
      const readbackDigest = await sourceStore("manifest", value);
      await sourceCheck();
      const verified = await session.custodySourceOriginals();
      if (
        verified.readbackDigest !== readbackDigest ||
        verified.reconstructedDigest !== sha256Canonical(reconstructed) ||
        sha256Canonical(verified.suiteReadbacks) !== sha256Canonical(reconstructed.suiteReadbacks)
      )
        fail(code);
      await sourceCheck();
      const completed = await session.completeSource();
      const digestPattern = /^sha256:[0-9a-f]{64}$/u;
      if (
        !digestPattern.test(completed?.executionRecordDigest) ||
        !digestPattern.test(completed?.resultDigest) ||
        completed?.processEvidenceDigest !== readbackDigest ||
        !Array.isArray(completed?.custodyRecordDigests) ||
        completed.custodyRecordDigests.length !== 2 ||
        new Set(completed.custodyRecordDigests).size !== 2 ||
        completed.custodyRecordDigests.some((digest) => !digestPattern.test(digest))
      )
        fail(code);
      const initial = await archive.get(candidateUseRecord.executionRecordDigest, "journal");
      const execution = await archive.get(completed.executionRecordDigest, "journal");
      validateContract("manual-operation-record.v3", initial.value);
      validateContract("manual-operation-record.v3", execution.value);
      if (
        initial.value.stage !== "candidate-use" ||
        initial.value.status !== "INTERRUPTED_UNKNOWN" ||
        execution.value.stage !== "candidate-use" ||
        execution.value.status !== "SUCCEEDED" ||
        execution.value.sessionId !== session.sessionId ||
        execution.value.sessionNonce !== session.sessionNonce ||
        execution.value.operationId !== fixed.spec.operationRef ||
        execution.value.predecessorExecutionRecordDigest !==
          candidateUseRecord.executionRecordDigest ||
        execution.value.resultDigest !== completed.resultDigest ||
        execution.value.processEvidenceDigest !== readbackDigest ||
        [
          "profileDigest",
          "requestDigest",
          "authorizationDigest",
          "consumptionRecordDigest",
          "idempotencyKey",
          "attemptId"
        ].some((field) => execution.value[field] !== initial.value[field])
      )
        fail(code);
      const request = await archive.get(initial.value.requestDigest);
      validateContract("manual-runner-request.v5", request.value);
      const result = await archive.get(completed.resultDigest);
      const { buildR3SourceCompletion } = await import("./r3-source-result.mjs");
      const custodyRecords = [];
      for (const digest of verified.custodyRecordDigests)
        custodyRecords.push((await archive.get(digest)).value);
      const rebuilt = buildR3SourceCompletion({
        request: request.value,
        initialExecution: initial.value,
        manifest: fixed.databaseTestManifest,
        verified,
        custodyRecords,
        completedAt: result.value.completedAt
      });
      if (
        sha256Canonical(rebuilt) !== completed.resultDigest ||
        !result.bytes.equals(encodeManualJson(rebuilt))
      )
        fail(code);
      const originals = [
        {
          digest: completed.executionRecordDigest,
          bytes: execution.bytes,
          roles: ["journal", "archive", "backup"]
        },
        { digest: completed.resultDigest, bytes: result.bytes, roles: ["archive", "backup"] }
      ];
      const roles = new Set(["archive", "backup"]);
      for (const digest of completed.custodyRecordDigests) {
        const custody = await archive.get(digest);
        validateContract("manual-operation-record.v3", custody.value);
        const value = custody.value;
        if (
          value.kind !== "custody" ||
          value.profileDigest !== session.profileDigest ||
          value.ownerId !== lease.profile.ownerId ||
          value.subjectType !== "record" ||
          !roles.delete(value.storageRole) ||
          value.purpose !== `${value.storageRole}-readback` ||
          value.outcome !== "MATCH" ||
          value.subjectDigest !== completed.resultDigest ||
          value.observedDigest !== completed.resultDigest ||
          value.retentionDays !== 90 ||
          value.reasonCode !== null
        )
          fail(code);
        originals.push({ digest, bytes: custody.bytes, roles: ["archive", "backup"] });
      }
      if (roles.size !== 0) fail(code);
      const { custodyRecordDigests: originalCustody, ...sourceVerified } = verified;
      sourceCompletionRecord = {
        originals,
        verifiedDigest: sha256Canonical(sourceVerified),
        execution: execution.value,
        result: result.value
      };
      await sourceCheck();
      sourceReady = true;
      return Object.freeze({
        status: value.status,
        attemptDigest,
        readbackDigest,
        custodyRecordDigests: verified.custodyRecordDigests,
        executionStatus: "SUCCEEDED",
        executionRecordDigest: completed.executionRecordDigest,
        resultDigest: completed.resultDigest,
        resultCustodyRecordDigests: completed.custodyRecordDigests,
        counts: Object.freeze({ ...manifestReport.counts }),
        promotionEligible: false
      });
    } catch (cause) {
      // The initial dual-store UNKNOWN remains authoritative on partial writes.
      // Never overwrite an existing original or treat one OBSERVED copy as a
      // complete result. sourceReady is set only after both copies and recheck.
      if (attemptDigest && !manifestWriteAttempted)
        await sourceStore("manifest", {
          status: "SOURCE_MANIFEST_INTERRUPTED_UNKNOWN",
          operationRef: fixed.spec.operationRef,
          attemptDigest,
          observations,
          generation: generation ?? null,
          promotionEligible: false
        });
      throw Object.assign(new Error(code), { code });
    }
  };
  const runLifecycle = async () => {
    if ((await fs.realpath(repoRoot)) !== (await fs.realpath(input.repoRoot))) fail(code);
    await recheckResources();
    const plan = databaseTargetSet.plan;
    const target = Object.freeze({
      policyId: fixed.databaseTargetPolicy.policyId,
      environment: `ci-${plan.chain}`,
      host: "127.0.0.1",
      clusterMarker: postgresTarget.postgres.clusterMarker,
      clusterFingerprint: sha256Canonical({
        engineId: postgresTarget.engineId,
        systemIdentifier: postgresTarget.postgres.systemIdentifier,
        containerId: postgresTarget.containerId,
        imageDigest: postgresTarget.imageDigest
      }),
      imageDigest: postgresTarget.imageDigest,
      serverVersionNum: postgresTarget.postgres.serverVersionNum
    });
    const observations = [];
    const sourceRuntimeChecked = new Set();
    const lifecycleCheck = async () => {
      if (stopping || lifecycleAbort.signal.aborted || !candidateUseRecord) fail(code);
      await check();
    };
    const secretFor = async (databaseName, profile, username) => {
      const reservation = plan.reservations.find((entry) => entry.databaseName === databaseName);
      if (!reservation || reservation.roles[profile] !== username) fail(code);
      const filename = `${databaseName}-${profile}.json`;
      const held = databaseSecretByName.get(filename);
      if (!held) fail(code);
      await held.recheck();
      const secret = JSON.parse(held.bytes);
      if (
        secret.username !== username ||
        secret.database !== databaseName ||
        secret.host !== "127.0.0.1" ||
        secret.port !== 55441 ||
        secret.tlsMode !== "require"
      )
        fail(code);
      return {
        ...secret,
        reference: `r3/${fixed.spec.operationRef}/database-credentials/${filename}`
      };
    };
    const executeCredential = async ({ record, profile, sql }) => {
      const secret = await secretFor(record.databaseName, profile, record.roles[profile]);
      await lifecycleCheck();
      const connection = await createPostgresConnector()({
        credential: {
          username: secret.username,
          password: secret.password,
          capabilityProfile: profile
        },
        target: {
          hostname: secret.host,
          port: secret.port,
          databaseName: secret.database,
          tlsMode: secret.tlsMode
        },
        custody: {
          operationRef: fixed.spec.operationRef,
          executionRecordDigest: consumption.executionRecordDigest
        }
      });
      try {
        const identity = await connection.observeIdentity();
        if (
          identity.databaseName !== record.databaseName ||
          identity.databaseOid !== record.databaseOid ||
          identity.role !== secret.username ||
          identity.tls !== true
        )
          fail(code);
        await connection.execute("SET statement_timeout = '30s'");
        await connection.execute("SET lock_timeout = '5s'");
        if (
          sourceAttempted &&
          profile === "runtime-test" &&
          !sourceRuntimeChecked.has(record.databaseName)
        ) {
          const value = {
            rows: JSON.parse(JSON.stringify([...(await connection.query(r3RuntimeBoundarySql))]))
          };
          r3RuntimeBoundary("target", value);
          observations.push({
            stage: "source-runtime-boundary",
            databaseName: record.databaseName,
            value
          });
          sourceRuntimeChecked.add(record.databaseName);
        }
        return { rows: JSON.parse(JSON.stringify([...(await connection.query(sql))])) };
      } finally {
        await connection.close();
      }
    };
    const migrate = async (record) => {
      if (sourceAttempted) {
        const results = [];
        const commands = [
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
          ["migrate", "diff", "--from-empty", "--to-config-datasource", "--script"]
        ];
        for (const args of commands) {
          const result = await sourcePrisma(record, args, 300000);
          observations.push({
            stage: "source-migration-process",
            databaseName: record.databaseName,
            arguments: args,
            result
          });
          if (
            result.code !== 0 ||
            result.signal !== null ||
            result.truncated ||
            result.processError ||
            result.timedOut
          )
            fail(code);
          results.push(result);
        }
        const name =
          record.databaseName === plan.reservations[0].databaseName ? "target" : "sibling";
        observations.push({
          stage: "source-migration",
          databaseName: record.databaseName,
          value: {
            name,
            migrationStatusDigest: sha256Canonical(results[1]),
            schemaDiffDigest: sha256Canonical(results[2]),
            postSchemaDigest: sha256Bytes(Buffer.from(results[3].stdout, "utf8"))
          }
        });
        await sourceCheck();
        return { exitCode: 0, signal: null };
      }
      const secret = await secretFor(record.databaseName, "migrate", record.roles.migrate);
      await lifecycleCheck();
      const args = [
        "--filter",
        "@subscription-saas/api",
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--schema",
        "prisma/schema.prisma"
      ];
      const exit = await new Promise((resolve, reject) => {
        let processFailed = false;
        const child = childProcess.spawn("pnpm", args, {
          cwd: repoRoot,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DATABASE_URL: `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@127.0.0.1:55441/${record.databaseName}?sslmode=require`,
            STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
          signal: lifecycleAbort.signal,
          timeout: 300000,
          killSignal: "SIGKILL"
        });
        const stopGroup = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") processFailed = true;
            }
          }
        };
        lifecycleAbort.signal.addEventListener("abort", stopGroup, { once: true });
        const timer = setTimeout(stopGroup, 300000);
        child.stdout.resume();
        child.stderr.resume();
        child.once("error", () => {
          processFailed = true;
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          lifecycleAbort.signal.removeEventListener("abort", stopGroup);
          stopGroup();
          if (processFailed) reject(Object.assign(new Error(code), { code }));
          else resolve({ exitCode, signal });
        });
      });
      observations.push({
        stage: "migration-process",
        databaseName: record.databaseName,
        command: ["pnpm", ...args],
        ...exit
      });
      if (exit.exitCode !== 0 || exit.signal !== null) fail(code);
      await lifecycleCheck();
      return exit;
    };
    const adapter = createR3LifecycleAdapter({
      plan,
      target,
      policy: fixed.databaseTargetPolicy,
      executeAdmin: (command) =>
        databaseAdmin(plan, (execute) => execute(command), observations, true),
      executeCredential,
      secretStore: {
        create: ({ databaseName, profile, username }) => secretFor(databaseName, profile, username)
      },
      migrate,
      registerTarget: async (record) => {
        const registered = await session.registerLifecycleTarget({ record });
        lifecycleRegisteredRecords.push(JSON.parse(JSON.stringify(record)));
        return registered;
      },
      recheck: lifecycleCheck,
      observations
    });
    let originals, failure;
    try {
      originals = await executeR3LifecycleSuite({
        adapter,
        signal: lifecycleAbort.signal,
        recheck: lifecycleCheck
      });
      await recheckResources();
    } catch (error) {
      originals = error.originals ?? null;
      failure = error;
    }
    const value = {
      status: failure ? "LIFECYCLE_INTERRUPTED_UNKNOWN" : "LIFECYCLE_OBSERVED",
      operationRef: fixed.spec.operationRef,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      destinationDigest: destinationRecord.destinationDigest,
      creationExecutionRecordDigest: completionRecord.executionRecordDigest,
      candidateUseExecutionRecordDigest: candidateUseRecord.executionRecordDigest,
      snapshotExecutionRecordDigest: snapshotCompletionRecord?.executionRecordDigest ?? null,
      manifestRawDigest: fixed.databaseTestManifestRawDigest,
      target,
      originals,
      observations,
      promotionEligible: false
    };
    const bytes = sourceAttempted ? encodePrivateObservationJson(value) : encodeManualJson(value);
    const readbackLimit = sourceAttempted ? 33554432 : 1048576;
    if (bytes.length > readbackLimit) fail(code);
    const principal = { platform: "posix", uid: process.getuid() };
    for (const role of ["archive", "backup"]) {
      const privateRoot = lease.profile.storage[`${role}Root`];
      const directory = path.join(
        privateRoot,
        "inputs",
        "r3",
        fixed.spec.operationRef,
        "observations",
        "lifecycle"
      );
      await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
      const filename = path.join(directory, "readback.json");
      const handle = await fs.open(filename, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const parent = await fs.open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const held = await pinPrivateInput(filename, { principal, privateRoot }, readbackLimit);
      lifecycleReadbacks.push(held);
      if (!held.bytes.equals(bytes)) fail(code);
    }
    // On authority loss the private originals remain; no success or custody is
    // synthesized from a test event. Existing consumed locks remain retained.
    if (failure) throw Object.assign(new Error(code), { code, readbackDigest: sha256Bytes(bytes) });
    await lifecycleCheck();
    lifecycleResult = value;
    lifecycleReady = true;
    return Object.freeze({
      status: value.status,
      readbackDigest: sha256Bytes(bytes),
      counts: originals.counts,
      promotionEligible: false
    });
  };
  const cleanupSnapshot = async () => {
    cleanupStage = "INITIAL_RESOURCE_RECHECK";
    await recheckResources();
    if (stopping || restoreReadbacks.length !== databaseTargetSet.records.length) fail(code);
    const readbacks = databaseTargetSet.records.map((target, index) =>
      Object.freeze({
        databaseName: target.databaseName,
        digest: sha256Bytes(restoreReadbacks[index].bytes)
      })
    );
    if (new Set(readbacks.map((entry) => entry.databaseName)).size !== readbacks.length) fail(code);
    cleanupStage = "REMOTE_COPY_CLEANUP";
    const proof = await snapshotCopy.cleanup();
    if (
      stopping ||
      !proof ||
      sha256Canonical(proof.facts) !== sha256Canonical(snapshotCopy.facts) ||
      !proof.observations
    )
      fail(code);
    cleanupStage = "CLEANED_RESOURCE_RECHECK";
    await recheckResources();
    if (stopping) fail(code);
    cleanupStage = "PRIVATE_READBACK";
    const privateRoot = lease.profile.storage.credentialRoot;
    const principal = { platform: "posix", uid: process.getuid() };
    const directory = path.join(
      privateRoot,
      "r3",
      fixed.spec.operationRef,
      "consumer",
      "observations",
      "cleanup"
    );
    await checkedPrivatePath(directory, { principal, privateRoot, directory: true });
    const bytes = encodeManualJson({
      status: "SNAPSHOT_REMOTE_DUMP_CLEANED",
      operationRef: fixed.spec.operationRef,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      inputIndexDigest: consumerInput.inputIndexDigest,
      consumerExecutionRecordDigest: consumerExecutionDigest,
      copyReadbackDigest: sha256Bytes(copyReadback.bytes),
      restoreReadbacks: readbacks,
      facts: proof.facts,
      observations: proof.observations
    });
    if (bytes.length > 1048576) fail(code);
    const filename = path.join(directory, "readback.json");
    const file = await fs.open(filename, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const parent = await fs.open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    cleanupReadback = await pinPrivateInput(filename, { principal, privateRoot });
    if (!cleanupReadback.bytes.equals(bytes)) fail(code);
    cleanupStage = "FINAL_RESOURCE_RECHECK";
    await recheckResources();
    if (stopping) fail(code);
    cleanupReady = true;
    cleanupStage = "OBSERVED";
    return Object.freeze({
      status: "SNAPSHOT_REMOTE_DUMP_CLEANED",
      executionStatus: "INTERRUPTED_UNKNOWN",
      executionRecordDigest: consumerExecutionDigest,
      inputIndexDigest: consumerInput.inputIndexDigest,
      snapshotDigest: snapshotCopy.facts.snapshotDigest,
      readbackDigest: sha256Bytes(bytes),
      promotionEligible: false
    });
  };
  const completeSnapshot = async () => {
    await recheckResources();
    if (stopping) fail(code);
    const result = await session.completeSnapshot();
    const digest = /^sha256:[0-9a-f]{64}$/u;
    if (
      !digest.test(result?.executionRecordDigest) ||
      !digest.test(result?.resultDigest) ||
      !digest.test(result?.processEvidenceDigest) ||
      !Array.isArray(result?.custodyRecordDigests) ||
      result.custodyRecordDigests.length !== 4 ||
      new Set(result.custodyRecordDigests).size !== 4 ||
      result.custodyRecordDigests.some((value) => !digest.test(value)) ||
      !Array.isArray(result?.originalDigests) ||
      result.originalDigests.length === 0 ||
      result.originalDigests.some((value) => !digest.test(value))
    )
      fail(code);
    const predecessor = await archive.get(consumerExecutionDigest, "journal");
    const execution = await archive.get(result.executionRecordDigest, "journal");
    validateContract("manual-operation-record.v3", predecessor.value);
    validateContract("manual-operation-record.v3", execution.value);
    if (
      predecessor.value.stage !== "snapshot-consumer" ||
      predecessor.value.status !== "INTERRUPTED_UNKNOWN" ||
      execution.value.stage !== "snapshot-consumer" ||
      execution.value.status !== "SUCCEEDED" ||
      execution.value.sessionId !== session.sessionId ||
      execution.value.sessionNonce !== session.sessionNonce ||
      execution.value.operationId !== fixed.spec.operationRef ||
      execution.value.predecessorExecutionRecordDigest !== consumerExecutionDigest ||
      execution.value.resultDigest !== result.resultDigest ||
      execution.value.processEvidenceDigest !== result.processEvidenceDigest ||
      [
        "requestDigest",
        "authorizationDigest",
        "consumptionRecordDigest",
        "idempotencyKey",
        "attemptId"
      ].some((field) => execution.value[field] !== predecessor.value[field])
    )
      fail(code);
    const originals = [
      {
        digest: result.executionRecordDigest,
        bytes: execution.bytes,
        roles: ["journal", "archive", "backup"]
      }
    ];
    const custodyPairs = new Set();
    for (const custodyDigest of result.custodyRecordDigests) {
      const custody = await archive.get(custodyDigest, "archive");
      validateContract("manual-operation-record.v3", custody.value);
      if (
        custody.value.kind !== "custody" ||
        custody.value.outcome !== "MATCH" ||
        ![result.resultDigest, result.processEvidenceDigest].includes(
          custody.value.subjectDigest
        ) ||
        custody.value.observedDigest !== custody.value.subjectDigest ||
        !["archive", "backup"].includes(custody.value.storageRole)
      )
        fail(code);
      custodyPairs.add(`${custody.value.subjectDigest}:${custody.value.storageRole}`);
      originals.push({ digest: custodyDigest, bytes: custody.bytes, roles: ["archive"] });
    }
    if (custodyPairs.size !== 4) fail(code);
    for (const originalDigest of new Set([
      ...result.originalDigests,
      result.resultDigest,
      result.processEvidenceDigest
    ])) {
      const original = await archive.get(originalDigest, "archive");
      if (sha256Bytes(original.bytes) !== originalDigest) fail(code);
      originals.push({
        digest: originalDigest,
        bytes: original.bytes,
        roles: ["archive", "backup"]
      });
    }
    snapshotCompletionRecord = { originals, executionRecordDigest: result.executionRecordDigest };
    await recheckResources();
    if (stopping) fail(code);
    snapshotCompletionReady = true;
    return Object.freeze({
      status: "SNAPSHOT_CONSUMED",
      executionStatus: "SUCCEEDED",
      executionRecordDigest: result.executionRecordDigest,
      resultDigest: result.resultDigest,
      processEvidenceDigest: result.processEvidenceDigest,
      custodyRecordDigests: Object.freeze([...result.custodyRecordDigests]),
      originalDigests: Object.freeze([...result.originalDigests]),
      promotionEligible: false
    });
  };
  try {
    if (
      !exact(input, ["repoRoot", "operationRef"]) ||
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      typeof input.repoRoot !== "string" ||
      !path.isAbsolute(input.repoRoot) ||
      path.normalize(input.repoRoot) !== input.repoRoot ||
      typeof input.operationRef !== "string" ||
      !uuid.test(input.operationRef)
    )
      fail(code);
    input = Object.freeze({ repoRoot: input.repoRoot, operationRef: input.operationRef });
    await prepareR3HostedEvidenceImport(input);
    fixed = await readFixedR3JobAdmission(input);
    session = await openTrustedR3CreationSession(input);
    lease = await openR3H1ForwardLease(input);
    if (
      sha256Canonical(lease.scope) !== sha256Canonical(session.scope) ||
      sha256Canonical(lease.admission) !== fixed.jobAdmissionDigest
    )
      fail(code);
    archive = targetArchive({
      profile: lease.profile,
      principal: { platform: "posix", uid: process.getuid() },
      recheck: check
    });
    // Install the sole job key before waiting for its SSH reverse-forward.
    // Connect once before consuming, then send on that very connection only.
    const deadline = Date.now() + 60000;
    while (!socket) {
      await check();
      try {
        socket = await new Promise((resolve, reject) => {
          const pending = net.createConnection({ host: "127.0.0.1", port: 55440 });
          const timer = setTimeout(
            () => pending.destroy(Object.assign(new Error(code), { code })),
            3000
          );
          pending.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          pending.once("connect", () => {
            clearTimeout(timer);
            resolve(pending);
          });
        });
      } catch (error) {
        if (!["ECONNREFUSED", "ECONNRESET"].includes(error.code) || Date.now() >= deadline)
          throw error;
        await pause();
      }
    }
    await check();
    const current = [...(await archive.graph()).entries()].filter(
      ([, item]) =>
        item.value.schemaVersion === "manual-operation-record.v3" &&
        item.value.kind === "session" &&
        item.value.sessionId === session.sessionId &&
        item.value.status === "OPEN"
    );
    if (current.length !== 1 || socket.destroyed) fail(code);
    const now = new Date().toISOString();
    const request = {
      schemaVersion: "manual-runner-request.v4",
      profileDigest: session.profileDigest,
      ownerId: lease.profile.ownerId,
      sessionId: session.sessionId,
      sessionNonce: session.sessionNonce,
      operationId: input.operationRef,
      idempotencyKey: `r3:${input.operationRef}`,
      attemptId: randomUUID(),
      runId: randomUUID(),
      stage: "target-create",
      capability: "create-isolated-target",
      purpose: "stage1-isolated-database-tests",
      ...fieldsFrom(session.scope, [
        "phase",
        "chain",
        "sourceSha",
        "targetPolicyDigest",
        "creationSpecDigest",
        "jobAdmissionDigest"
      ]),
      candidate: { buildProofDigest: session.scope.buildProofDigest }
    };
    request.attemptAllocationDigest = await archive.put(
      {
        schemaVersion: "manual-runner-evidence.v2",
        kind: "attempt-allocation",
        recordedAt: now,
        promotionEligible: false,
        ...fieldsFrom(request, [
          "profileDigest",
          "sessionId",
          "sessionNonce",
          "operationId",
          "idempotencyKey",
          "attemptId",
          "runId",
          "stage",
          "phase",
          "chain",
          "sourceSha",
          "targetPolicyDigest",
          "creationSpecDigest",
          "jobAdmissionDigest"
        ]),
        sessionRecordDigest: current[0][0],
        allocatedAt: now,
        buildProofDigest: session.scope.buildProofDigest,
        predecessorExecutionRecordDigest: null
      },
      "manual-runner-evidence.v2"
    );
    await archive.put(request, "manual-runner-request.v4");
    const {
      schemaVersion,
      attemptId,
      runId,
      attemptAllocationDigest,
      sourceSha,
      candidate,
      ...binding
    } = request;
    const requestInput = { binding, canonicalBytes: encodeManualJson(request) };
    const authorization = await session.sign(requestInput);
    const body = encodeManualJson({ request, authorization });
    if (body.length > 1048576) fail(code);
    diagnostics.push({ name: "creation-request", body: await archive.raw(body) });
    await check();
    if (socket.destroyed) fail(code);
    // This call writes consumption + its readback + pending UNKNOWN before it
    // returns. No request bytes may reach the network above this boundary.
    consumption = await session.consume({ authorization, request: requestInput });
    const delivered = await exchange("POST", "/stage1-r3/target-create", body, socket);
    await saveExchange("creation-ack", delivered);
    if (delivered.status !== 202 || delivered.body.length !== 0) fail(code);
    const readyDeadline = Date.now() + 120000;
    let readback;
    while (!readback) {
      await check();
      try {
        readback = await engineReadback();
      } catch (error) {
        if (
          !["ECONNREFUSED", "ECONNRESET", "EPIPE", "R3_HANDOFF_PENDING"].includes(error.code) ||
          Date.now() >= readyDeadline
        )
          throw error;
        await pause();
      }
    }
    await check();
    const engine = Object.freeze(JSON.parse(JSON.stringify(readback.engine)));
    boundEngineId = engine.ID;
    return Object.freeze({
      get status() {
        return completionReady ? "TARGET_CREATED" : "INTERRUPTED_UNKNOWN";
      },
      session: Object.freeze(
        fieldsFrom(session, ["profileDigest", "sessionId", "sessionNonce", "scope"])
      ),
      consumption,
      engine,
      version: Object.freeze(readback.runtime),
      get diagnostics() {
        return Object.freeze(diagnostics.slice());
      },
      async importHostedEvidence(bundleBytes) {
        if (
          stopping ||
          closed ||
          hostedImportAttempted ||
          !Buffer.isBuffer(bundleBytes) ||
          bundleBytes.length === 0 ||
          bundleBytes.length > 1048576
        )
          fail(code);
        hostedImportAttempted = true;
        const bytes = Buffer.from(bundleBytes);
        hostedImportPending = (async () => {
          await check();
          hostedEvidence = await importR3HostedEvidence({ ...input, bundleBytes: bytes });
          const observed = await engineReadback(!postgresAttempted);
          if (
            hostedEvidence.engine.id !== boundEngineId ||
            observed.engine.ID !== boundEngineId ||
            sha256Canonical(hostedEvidence.engine.version) !== sha256Canonical(observed.runtime)
          )
            fail(code);
          await check();
          diagnostics.push({ name: "hosted-evidence", body: await archive.raw(bytes) });
          hostedEvidenceReady = true;
          return Object.freeze({
            status: "HOSTED_EVIDENCE_OBSERVED",
            bundleDigest: hostedEvidence.bundleDigest,
            engineId: boundEngineId,
            promotionEligible: false
          });
        })();
        try {
          return await hostedImportPending;
        } catch {
          throw Object.assign(new Error(code), { code, consumption });
        }
      },
      async provisionPostgres(...args) {
        if (args.length !== 0 || stopping || closed || postgresAttempted) fail(code);
        postgresAttempted = true;
        postgresPending = provisionPg(engine.ID);
        try {
          return await postgresPending;
        } catch (cause) {
          throw Object.assign(new Error(code, { cause }), {
            code,
            consumption,
            diagnostics: Object.freeze(diagnostics.slice())
          });
        }
      },
      async provisionDatabases(...args) {
        if (args.length !== 0 || stopping || closed || !postgresTarget || databasesAttempted)
          fail(code);
        databasesAttempted = true;
        databasesPending = provisionDatabases();
        try {
          return await databasesPending;
        } catch (cause) {
          // SQL driver errors can contain statements with role passwords. Keep
          // only the helper's already-sanitized partial records and a fixed code.
          const partial = { status: "INTERRUPTED_UNKNOWN", records: cause?.records ?? [] };
          try {
            diagnostics.push({
              name: "database-target-set-incomplete",
              body: await postgresArchive.raw(encodeManualJson(partial))
            });
          } catch {
            /* The operation remains UNKNOWN even if archival is unavailable. */
          }
          throw Object.assign(new Error(code), {
            code,
            failedAt: databaseStage,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code,
            consumption,
            diagnostics: Object.freeze(diagnostics.slice())
          });
        }
      },
      async recordDestination(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          destinationAttempted ||
          !hostedEvidenceReady ||
          !postgresTarget ||
          !databaseTargetSet ||
          !targetLockLease
        )
          fail(code);
        destinationAttempted = true;
        destinationPending = recordDestination();
        try {
          return await destinationPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failedAt: destinationStage,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async completeCreation(...args) {
        if (args.length !== 0 || stopping || closed || completionAttempted || !destinationReady)
          fail(code);
        completionAttempted = true;
        completionPending = completeCreation();
        try {
          return await completionPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async recheck() {
        if (stopping) fail(code);
        if (completionAttempted && !completionReady) fail(code);
        if (consumerAttempted && !consumerReady) fail(code);
        if (fetchAttempted && !fetchReady) fail(code);
        if (decryptAttempted && !decryptReady) fail(code);
        if (copyAttempted && !copyReady) fail(code);
        if (restoreAttempted && !restoreReady) fail(code);
        if (cleanupAttempted && !cleanupReady) fail(code);
        if (snapshotCompletionAttempted && !snapshotCompletionReady) fail(code);
        if (lifecycleAttempted && !lifecycleReady) fail(code);
        if (sourceAttempted && !sourceReady) fail(code);
        if (finalAttempted && !finalReady) fail(code);
        if (sourceAcknowledgementAttempted && !sourceAcknowledgementReady) fail(code);
        if (targetCleanupAttempted && !targetCleanupReady) fail(code);
        if (targetCleanupReady) return check();
        await recheckResources();
        await assertSnapshotConsumption();
      },
      async importHostedCleanupEvidence(...args) {
        if (
          args.length !== 1 ||
          stopping ||
          closed ||
          targetCleanupImportAttempted ||
          !sourceAcknowledgementReady ||
          !Buffer.isBuffer(args[0]) ||
          args[0].length === 0 ||
          args[0].length > 1048576
        )
          fail(code);
        targetCleanupImportAttempted = true;
        const bundleBytes = Buffer.from(args[0]);
        targetCleanupImportPending = (async () => {
          // The Engine is already gone; retain trust/original checks without
          // attempting another request against the removed target.
          await check();
          const held = await importR3HostedCleanupEvidence({ ...input, bundleBytes });
          targetCleanupEvidence = held;
          if (
            held.creationEvidenceDigest !== hostedEvidence.bundleDigest ||
            held.cleanup.engine.id !== boundEngineId
          )
            fail(code);
          await check();
          if (stopping || closed) fail(code);
          targetCleanupImportReady = true;
          return Object.freeze({
            status: "HOSTED_CLEANUP_OBSERVED",
            bundleDigest: held.bundleDigest,
            promotionEligible: false
          });
        })();
        try {
          return await targetCleanupImportPending;
        } catch {
          throw Object.assign(new Error(code), { code });
        }
      },
      async completeCleanup(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          targetCleanupAttempted ||
          !sourceAcknowledgementReady ||
          !targetCleanupImportReady
        )
          fail(code);
        targetCleanupAttempted = true;
        targetCleanupPending = (async () => {
          await check();
          if (stopping || closed) fail(code);
          // The hosted owner must have closed its established forwards first.
          // Revoking this key prevents reconnects; the core independently
          // observes both ports and the dedicated uid before recording success.
          await lease.close();
          forwardLeaseClosed = true;
          socket?.destroy();
          const receipt = await session.completeCleanup();
          if (
            !exact(receipt, [
              "cleanupObservationRecordDigest",
              "cleanupBundleDigest",
              "creationEvidenceDigest",
              "forwardEvidenceDigest",
              "forwardObservationDigest",
              "sourceExecutionRecordDigest",
              "sourceAcknowledgementRecordDigest",
              "custodyRecordDigests",
              "promotionEligible"
            ]) ||
            receipt.cleanupBundleDigest !== targetCleanupEvidence.bundleDigest ||
            receipt.creationEvidenceDigest !== hostedEvidence.bundleDigest ||
            receipt.sourceExecutionRecordDigest !==
              sha256Canonical(sourceCompletionRecord.execution) ||
            receipt.promotionEligible !== false
          )
            fail(code);
          await check();
          if (stopping || closed) fail(code);
          targetCleanupReady = true;
          return Object.freeze({ status: "CLEANUP_OBSERVED", ...receipt });
        })();
        try {
          return await targetCleanupPending;
        } catch {
          await session.closeIncomplete().catch(() => {});
          throw Object.assign(new Error(code), { code });
        }
      },
      async acknowledgeSource(...args) {
        if (
          args.length !== 1 ||
          stopping ||
          closed ||
          sourceAcknowledgementAttempted ||
          !sourceReady ||
          !sourceCompletionRecord ||
          !exact(args[0], ["executionRecordDigest"]) ||
          args[0].executionRecordDigest !== sha256Canonical(sourceCompletionRecord.execution)
        )
          fail(code);
        // Only the owner's separate action reaches this entry. Running the
        // manifest never acknowledges its result on the owner's behalf.
        const executionRecordDigest = args[0].executionRecordDigest;
        sourceAcknowledgementAttempted = true;
        sourceAcknowledgementPending = (async () => {
          await recheckResources();
          if (stopping || closed) fail(code);
          const receipt = await session.acknowledgeSource({ executionRecordDigest });
          if (
            !exact(receipt, [
              "executionRecordDigest",
              "resultDigest",
              "acknowledgementRecordDigest",
              "promotionEligible"
            ]) ||
            receipt.executionRecordDigest !== executionRecordDigest ||
            receipt.resultDigest !== sourceCompletionRecord.execution.resultDigest ||
            receipt.promotionEligible !== false
          )
            fail(code);
          const retained = await archive.get(receipt.acknowledgementRecordDigest);
          assertR3SourceAcknowledgement({
            acknowledgement: retained.value,
            profileDigest: session.profileDigest,
            ownerId: lease.profile.ownerId,
            execution: sourceCompletionRecord.execution,
            result: sourceCompletionRecord.result,
            now: new Date().toISOString()
          });
          sourceCompletionRecord.originals.push({
            digest: receipt.acknowledgementRecordDigest,
            bytes: retained.bytes,
            roles: ["archive", "backup"]
          });
          await check();
          if (stopping || closed) fail(code);
          sourceAcknowledgementReady = true;
          return Object.freeze({ status: "SOURCE_ACKNOWLEDGED", ...receipt });
        })();
        try {
          return await sourceAcknowledgementPending;
        } catch {
          throw Object.assign(new Error(code), { code });
        }
      },
      async runFinalManifest(...args) {
        if (
          args.length !== 1 ||
          !exact(args[0], ["matchingSourceEvidenceDigest"]) ||
          !/^sha256:[0-9a-f]{64}$/u.test(args[0].matchingSourceEvidenceDigest ?? "") ||
          stopping ||
          closed ||
          finalAttempted ||
          sourceAttempted ||
          lifecycleAttempted ||
          !completionReady ||
          session.scope.phase !== "final" ||
          (session.scope.chain === "snapshot" ? !snapshotCompletionReady : consumerAttempted)
        )
          fail(code);
        finalAttempted = true;
        finalPending = runFinalManifest(args[0].matchingSourceEvidenceDigest);
        return finalPending;
      },
      async runSourceManifest(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          sourceAttempted ||
          lifecycleAttempted ||
          !completionReady ||
          session.scope.phase !== "source" ||
          (session.scope.chain === "snapshot" ? !snapshotCompletionReady : consumerAttempted)
        )
          fail(code);
        sourceAttempted = true;
        sourcePending = runSourceManifest();
        return sourcePending;
      },
      async runLifecycle(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          lifecycleAttempted ||
          sourceAttempted ||
          !completionReady ||
          session.scope.phase !== "source" ||
          (session.scope.chain === "snapshot" ? !snapshotCompletionReady : consumerAttempted)
        )
          fail(code);
        lifecycleAttempted = true;
        lifecyclePending = consumeCandidateUse().then(() => runLifecycle());
        return lifecyclePending;
      },
      async completeSnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          snapshotCompletionAttempted ||
          !cleanupReady ||
          !restoreReady ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        snapshotCompletionAttempted = true;
        snapshotCompletionPending = snapshotPhase(completeSnapshot);
        try {
          return await snapshotCompletionPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async cleanupSnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          cleanupAttempted ||
          !restoreReady ||
          !copyReady ||
          !decryptReady ||
          !fetchReady ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        cleanupAttempted = true;
        cleanupPending = snapshotPhase(cleanupSnapshot);
        try {
          return await cleanupPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureStage: cleanupStage,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async restoreSnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          restoreAttempted ||
          !copyReady ||
          !decryptReady ||
          !fetchReady ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        restoreAttempted = true;
        restorePending = snapshotPhase(restoreSnapshot);
        try {
          return await restorePending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async copySnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          copyAttempted ||
          !decryptReady ||
          !fetchReady ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        copyAttempted = true;
        copyPending = snapshotPhase(copySnapshot);
        try {
          return await copyPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async decryptSnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          decryptAttempted ||
          !fetchReady ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        decryptAttempted = true;
        decryptPending = snapshotPhase(decryptSnapshot);
        try {
          return await decryptPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async fetchSnapshot(...args) {
        if (
          args.length !== 0 ||
          stopping ||
          closed ||
          fetchAttempted ||
          !consumerReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        fetchAttempted = true;
        fetchPending = snapshotPhase(fetchSnapshot);
        try {
          return await fetchPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      async consumeSnapshot(...args) {
        const [selector] = args;
        const final = session.scope.phase === "final";
        if (
          args.length !== 1 ||
          !exact(selector, [
            "inputReference",
            ...(final ? ["matchingSourceEvidenceDigest"] : [])
          ]) ||
          typeof selector.inputReference !== "string" ||
          !uuid.test(selector.inputReference) ||
          (final &&
            (typeof selector.matchingSourceEvidenceDigest !== "string" ||
              !/^sha256:[0-9a-f]{64}$/u.test(selector.matchingSourceEvidenceDigest))) ||
          stopping ||
          closed ||
          consumerAttempted ||
          !completionReady ||
          session.scope.chain !== "snapshot"
        )
          fail(code);
        consumerAttempted = true;
        consumerPending = consumeSnapshot(
          selector.inputReference,
          final ? selector.matchingSourceEvidenceDigest : null
        );
        try {
          return await consumerPending;
        } catch (cause) {
          throw Object.assign(new Error(code), {
            code,
            consumption,
            failureCode: /^[A-Z0-9_]{1,64}$/u.test(cause?.code ?? "") ? cause.code : code
          });
        }
      },
      close
    });
  } catch (cause) {
    let cleanupError;
    try {
      await close();
    } catch (error) {
      cleanupError = error;
    }
    throw Object.assign(new Error(code, { cause }), {
      code,
      consumption,
      diagnostics,
      cleanupError
    });
  }
}

const runnerEntrypoint = '["node","/app/apps/release-runner/src/cli.mjs"]';
const runnerFormats = Object.freeze({
  image:
    '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"platform":{{json (printf "%s/%s" .Os .Architecture)}},"defaultEntrypoint":{{eq (json .Config.Entrypoint) "' +
    runnerEntrypoint.replaceAll('"', '\\"') +
    '"}},"defaultCommand":{{not .Config.Cmd}}}',
  container:
    '{"id":{{json .Id}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"networkMode":{{json .HostConfig.NetworkMode}},"networkId":{{$sep := ""}}{{range .NetworkSettings.Networks}}{{$sep}}{{json .NetworkID}}{{$sep = ","}}{{end}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"portBindings":{{json .HostConfig.PortBindings}},"defaultEntrypoint":{{eq (json .Config.Entrypoint) "' +
    runnerEntrypoint.replaceAll('"', '\\"') +
    '"}},"defaultCommand":{{not .Config.Cmd}},"manualMode":[{{$sep := ""}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "RUNNER_EXECUTION_MODE"}}{{$sep}}{{eq . "RUNNER_EXECUTION_MODE=manual-stage1"}}{{$sep = ","}}{{end}}{{end}}]}'
});

// These are private source locations, never caller-selected evidence or admission.
async function runnerSources(facts, attemptId) {
  const { profile, principal, fixed, recheck } = facts,
    privateRoot = profile.storage.archiveRoot,
    base = path.join(
      privateRoot,
      "inputs",
      "operations",
      fixed.operation.operationRef,
      "runner-launch"
    );
  await recheck();
  const initial = await checkedPrivatePath(base, { principal, privateRoot, directory: true });
  const directory = path.join(base, attemptId);
  await fs.mkdir(directory, { mode: 0o700 });
  const config = path.join(directory, "docker-config");
  await fs.mkdir(config, { mode: 0o700 });
  const pinned = await checkedPrivatePath(config, { principal, privateRoot, directory: true });
  const immutable = [];
  const checkSourceBytes = async () => {
    const after = await checkedPrivatePath(config, { principal, privateRoot, directory: true });
    if (
      after.length !== pinned.length ||
      !after.every(
        (entry, index) =>
          entry.path === pinned[index].path &&
          (entry.path !== privateRoot && !entry.path.startsWith(privateRoot + path.sep)
            ? samePublicDirectory(entry.stat, pinned[index].stat)
            : sameIdentity(entry.stat, pinned[index].stat, entry.path !== directory))
      )
    )
      fail("MANUAL_STORAGE_UNVERIFIED");
    const baseEntry = after.find((entry) => entry.path === base);
    if (
      !sameIdentity(
        baseEntry.stat,
        { ...initial.at(-1).stat, nlink: initial.at(-1).stat.nlink + 1n },
        false
      )
    )
      fail("MANUAL_STORAGE_UNVERIFIED");
    for (const item of immutable) {
      const current = await checkedPrivatePath(item.file, { principal, privateRoot });
      if (!sameIdentity(current.at(-1).stat, item.stat)) fail("MANUAL_STORAGE_UNVERIFIED");
      const handle = await fs.open(item.file, "r");
      try {
        if (!(await readPinned(handle, item.stat)).bytes.equals(item.bytes))
          fail("MANUAL_STORAGE_UNVERIFIED");
      } finally {
        await handle.close();
      }
    }
  };
  const guard = async () => {
    await recheck();
    await checkSourceBytes();
  };
  const put = async (name, bytes) => {
    await guard();
    if (!Buffer.isBuffer(bytes) || bytes.length > 1048576) fail("MANUAL_OUTPUT_LIMIT");
    const file = path.join(directory, name),
      handle = await fs.open(file, "wx", 0o600);
    try {
      const chain = await checkedPrivatePath(file, { principal, privateRoot });
      if (!sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })))
        fail("MANUAL_STORAGE_UNVERIFIED");
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const item = await pinPrivateInput(file, { principal, privateRoot });
    try {
      if (!item.bytes.equals(bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await item.recheck();
      immutable.push({
        file,
        bytes: Buffer.from(bytes),
        stat: (await checkedPrivatePath(file, { principal, privateRoot })).at(-1).stat
      });
    } finally {
      await item.close();
    }
    await guard();
  };
  await guard();
  return { put, guard, checkSourceBytes, config };
}

// Fixed Task 10 source admission. These local contracts are private source
// projections; R1 remains the sole verifier of build/proof/receipt/session trust.
async function expectedGhCall(file, subject, p, archive, recheck, assertLive, sources, prefix) {
  const argv = expectedGhArgv(file, p);
  await recheck();
  assertLive();
  const argvRaw = await archive.raw(encodeManualJson(argv));
  let startedAt;
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["GH_HOST", "GH_REPO"].includes(name.toUpperCase())
      )
    ),
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
  // Match R1's fixed github.com policy and preserve its legitimate gh auth/config
  // environment. No caller GH_HOST/GH_REPO selects the verification target.
  const processResult = await new Promise((resolve) => {
    let child,
      pid,
      problem,
      spawned = false,
      stdoutSize = 0,
      stderrSize = 0,
      stdoutEnded = false,
      stderrEnded = false,
      stdoutError = false,
      stderrError = false;
    const stdout = [],
      stderr = [];
    let timer;
    const rejectProcess = (code) => {
      problem ??= code;
      child?.kill("SIGKILL");
    };
    const collect = (parts, stream, chunk) => {
      chunk = Buffer.from(chunk);
      const size = stream === "stdout" ? stdoutSize : stderrSize;
      parts.push(chunk.subarray(0, Math.max(0, expectedLimit - size)));
      if (stream === "stdout") stdoutSize += chunk.length;
      else stderrSize += chunk.length;
      if (size + chunk.length > expectedLimit) rejectProcess("MANUAL_OUTPUT_LIMIT");
    };
    try {
      child = childProcess.spawn("gh", argv, {
        shell: false,
        cwd: repoRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      pid = child.pid;
      child.stdout.on("data", (chunk) => collect(stdout, "stdout", chunk));
      child.stderr.on("data", (chunk) => collect(stderr, "stderr", chunk));
      child.stdout.on("end", () => {
        stdoutEnded = true;
      });
      child.stderr.on("end", () => {
        stderrEnded = true;
      });
      child.stdout.on("error", () => {
        stdoutError = true;
        rejectProcess("MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED");
      });
      child.stderr.on("error", () => {
        stderrError = true;
        rejectProcess("MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED");
      });
      child.once("spawn", () => {
        spawned = true;
        startedAt = new Date().toISOString();
      });
      child.once("error", () => rejectProcess("MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED"));
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          pid,
          spawned,
          exitCode,
          signal,
          problem,
          closedAt: new Date().toISOString(),
          stdoutComplete: stdoutEnded && !stdoutError && stdoutSize <= expectedLimit,
          stderrComplete: stderrEnded && !stderrError && stderrSize <= expectedLimit
        });
      });
      timer = setTimeout(() => rejectProcess("MANUAL_PROCESS_TIMEOUT"), 30000);
    } catch {
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        problem: "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED",
        closedAt: null,
        stdoutComplete: false,
        stderrComplete: false
      });
    }
  });
  // Preserve actual bytes and process facts before every refusal. Binary and
  // truncated failures stay in the known private allocation source directory;
  // the shared evidence graph has an existing fatal-UTF8 text-raw contract.
  const rawRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length }),
    capturedStdout = rawRef(processResult.stdout),
    capturedStderr = rawRef(processResult.stderr);
  await sources.put(`${prefix}.stdout`, processResult.stdout);
  await sources.put(`${prefix}.stderr`, processResult.stderr);
  await sources.put(
    `${prefix}.capture.json`,
    encodeManualJson({
      recordVersion: "manual-expected-gh-capture.v1",
      subject,
      argv: argvRaw,
      stdout: { raw: capturedStdout, complete: processResult.stdoutComplete },
      stderr: { raw: capturedStderr, complete: processResult.stderrComplete },
      pid:
        Number.isSafeInteger(processResult.pid) && processResult.pid > 0 ? processResult.pid : null,
      startedAt: startedAt ?? null,
      closedAt: processResult.closedAt,
      exitCode: processResult.exitCode ?? null,
      signal: processResult.signal ?? null,
      processProblem: processResult.problem ?? null,
      recordedAt: new Date().toISOString(),
      promotionEligible: false
    })
  );
  let decodeFailure = null;
  try {
    expectedText(processResult.stdout);
    expectedText(processResult.stderr);
  } catch (cause) {
    decodeFailure = cause;
  }
  const stdout = decodeFailure ? capturedStdout : await archive.raw(processResult.stdout),
    stderr = decodeFailure ? capturedStderr : await archive.raw(processResult.stderr);
  await recheck();
  assertLive();
  return expectedGhResult({ subject, p, processResult, startedAt, argvRaw, stdout, stderr });
}
async function withExpectedAdmission(
  facts,
  allocation,
  attemptAllocationDigest,
  archive,
  assertLive,
  sources,
  work
) {
  const { fixed, build, profile, principal } = facts,
    opened = [];
  let inputs,
    createdSidecar,
    admissionAccepted = false;
  const root = path.join(
      profile.storage.archiveRoot,
      "inputs",
      "expected-schema",
      build.proofRawDigest.slice(7)
    ),
    options = { principal, privateRoot: profile.storage.archiveRoot };
  // Reserve only our own metadata before pinning source ancestors. Their exact
  // directory identities, including nlink, remain unchanged during validation.
  const admissions = path.join(root, "admissions"),
    admissionRoot = path.join(admissions, fixed.operation.operationRef);
  try {
    await facts.recheck();
    await checkedPrivatePath(root, { ...options, directory: true });
    for (const directory of [admissions, admissionRoot]) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await checkedPrivatePath(directory, { ...options, directory: true });
    }
    const reserved = await checkedPrivatePath(admissionRoot, { ...options, directory: true });
    const pin = async (file) => {
      const item = await pinPrivateInput(file, options);
      opened.push(item);
      return item;
    };
    inputs = await openManualExpectedSchemaInputs({
      fixed,
      build,
      profile,
      principal,
      targetContext: facts.targetContext,
      allocation,
      attemptAllocationDigest
    });
    const p = inputs.context.provenance,
      expectation = inputs.context.expectation;
    const recheckOwnInputs = async () => {
      await inputs.recheck();
      for (const item of opened) await item.recheck();
      expectedRequire(
        (await archive.get(attemptAllocationDigest)).bytes.equals(encodeManualJson(allocation)),
        "MANUAL_STORAGE_UNVERIFIED"
      );
      const chain = await checkedPrivatePath(admissionRoot, { ...options, directory: true });
      expectedRequire(
        chain.length === reserved.length &&
          chain.every(
            (v, i) =>
              v.path === reserved[i].path &&
              (v.path === admissionRoot
                ? sameIdentity(v.stat, reserved[i].stat, false)
                : v.path !== options.privateRoot &&
                    !v.path.startsWith(options.privateRoot + path.sep)
                  ? samePublicDirectory(v.stat, reserved[i].stat)
                  : sameIdentity(v.stat, reserved[i].stat))
          ),
        "MANUAL_OPERATION_INPUT_UNAVAILABLE"
      );
      assertLive();
    };
    const recheck = async () => {
      assertLive();
      await sources.guard();
      await recheckOwnInputs();
    };
    const recheckForDelivery = async () => {
      assertLive();
      await sources.checkSourceBytes();
      await recheckOwnInputs();
    };
    await recheck();
    const provenance = inputs.refs.files["provenance.json"],
      calls = [];
    for (const [name, subject, prefix] of [
      ["provenance.json", provenance, "expected-provenance.gh"],
      ["expected.sql", p.expectedScript, "expected-script.gh"]
    ])
      calls.push(
        await expectedGhCall(
          path.join(root, name),
          subject,
          p,
          archive,
          recheck,
          assertLive,
          sources,
          prefix
        )
      );
    expectedRequire(
      provenance.digest !== p.expectedScript.digest &&
        expectedOrder([
          calls[0].startedAt,
          calls[0].closedAt,
          calls[1].startedAt,
          calls[1].closedAt
        ])
    );
    await recheck();
    for (const bytes of [
      ...inputs.bytes.raws,
      inputs.bytes.files["provenance.json"],
      inputs.bytes.files["import-readback.json"]
    ])
      await archive.raw(bytes);
    const expectationDigest = await archive.put(expectation, "manual-runner-evidence.v1"),
      expectationBytes = encodeManualJson(expectation);
    await archive.raw(expectationBytes);
    expectedRequire(
      (await archive.get(expectationDigest)).bytes.equals(expectationBytes),
      "MANUAL_STORAGE_UNVERIFIED"
    );
    const recordedAt = new Date().toISOString(),
      admission = {
        recordVersion: "manual-expected-schema-readback.v1",
        operationRef: fixed.operation.operationRef,
        indexDigest: fixed.indexDigest,
        runId: fixed.operation.runId,
        profileDigest: fixed.operation.profileDigest,
        attemptId: allocation.attemptId,
        attemptAllocationDigest,
        buildProofDigest: build.buildProofDigest,
        proofRawDigest: build.proofRawDigest,
        provenance,
        sourceSchema: p.sourceSchema.raw,
        prismaVersion: p.toolchain.prismaVersionRaw,
        script: p.expectedScript,
        schemaExpectation: { digest: expectationDigest, bytes: expectationBytes.length },
        calls,
        recordedAt,
        promotionEligible: false
      };
    expectedRequire(expectedOrder([calls[1].closedAt, recordedAt]));
    await recheck();
    const file = path.join(admissionRoot, `${allocation.attemptId}.json`),
      bytes = encodeManualJson(admission),
      handle = await fs.open(file, "wx", 0o600);
    try {
      const chain = await checkedPrivatePath(file, options);
      expectedRequire(
        sameIdentity(chain.at(-1).stat, await handle.stat({ bigint: true })),
        "MANUAL_STORAGE_UNVERIFIED"
      );
      createdSidecar = {
        file,
        stat: await handle.stat({ bigint: true }),
        directory: await checkedPrivatePath(admissionRoot, { ...options, directory: true })
      };
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const reopened = await pin(file);
    expectedRequire(
      reopened.bytes.equals(bytes) && expectedEqual(expectedJson(reopened.bytes, true), admission),
      "MANUAL_STORAGE_UNVERIFIED"
    );
    await reopened.recheck();
    const recorded = await inputs.readRecordedAdmission();
    expectedRequire(
      expectedEqual(recorded.context.admission, admission),
      "MANUAL_STORAGE_UNVERIFIED"
    );
    await recheck();
    admissionAccepted = true;
    return await work({ expectation, admission, recheck, recheckForDelivery });
  } catch (cause) {
    if (createdSidecar && !admissionAccepted) {
      try {
        const chain = await checkedPrivatePath(createdSidecar.file, options),
          directories = chain.slice(0, -1);
        expectedRequire(
          directories.length === createdSidecar.directory.length &&
            directories.every(
              (v, i) =>
                v.path === createdSidecar.directory[i].path &&
                (v.path === admissionRoot
                  ? sameIdentity(v.stat, createdSidecar.directory[i].stat, false)
                  : v.path !== options.privateRoot &&
                      !v.path.startsWith(options.privateRoot + path.sep)
                    ? samePublicDirectory(v.stat, createdSidecar.directory[i].stat)
                    : sameIdentity(v.stat, createdSidecar.directory[i].stat))
            ) &&
            chain.at(-1).stat.dev === createdSidecar.stat.dev &&
            chain.at(-1).stat.ino === createdSidecar.stat.ino,
          "MANUAL_STORAGE_UNVERIFIED"
        );
        await fs.unlink(createdSidecar.file);
      } catch (cleanup) {
        throw Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_ADMISSION_UNKNOWN", { cause }), {
          code: "MANUAL_EXPECTED_SCHEMA_ADMISSION_UNKNOWN",
          cleanupCause: cleanup
        });
      }
    }
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      fail("MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED");
    throw cause;
  } finally {
    const settled = await Promise.allSettled([
      ...(inputs ? [inputs.close()] : []),
      ...opened.map((item) => item.close())
    ]);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

async function launchZeroCredentialRunner(session, facts, observed, dry = null, second = null) {
  const { fixed, principal } = facts,
    operation = fixed.operation,
    archive = targetArchive(facts);
  // Reopen the genuine original baseline, rather than inventing one for this attempt.
  const graph = await archive.graph();
  const baselines = [...graph.entries()].filter(
    ([, item]) =>
      item.value.schemaVersion === "manual-baseline-manifest.v1" &&
      item.value.identity.targetObservationDigest === sha256Canonical(observed.observation)
  );
  if (baselines.length !== 1) fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
  const baseline = await archive.get(baselines[0][0]);
  if (!baseline.bytes.equals(baselines[0][1].bytes)) fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
  if (process.platform !== "linux") fail("MANUAL_RUNNER_INPUT_REQUIRED");
  const resources = await facts.recheckResources();
  if (resources.network.internal !== true) fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
  const attemptId = randomUUID(),
    allocatedAt = new Date().toISOString(),
    identity = {
      profileDigest: operation.profileDigest,
      ...fieldsFrom(session, ["sessionId", "sessionNonce"]),
      ...operation.operations[second?.phase === "verify" ? "verify" : "migrate"],
      attemptId,
      runId: operation.runId
    };
  const allocation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "attempt-allocation",
    recordedAt: allocatedAt,
    promotionEligible: false,
    ...identity,
    stage: "runner-command",
    phaseKey: second?.phase ?? (dry ? "apply" : "dry-run"),
    allocatedAt,
    targetIntent: operation.targetIntent,
    predecessorExecutionRecordDigest:
      second?.migration.migration.executionRecordDigest ??
      dry?.reference.executionRecordDigest ??
      null
  };
  const attemptAllocationDigest = await archive.put(allocation, "manual-runner-evidence.v1");
  if (!(await archive.get(attemptAllocationDigest)).bytes.equals(encodeManualJson(allocation)))
    fail("MANUAL_STORAGE_UNVERIFIED");
  const sources = await runnerSources(facts, attemptId),
    cidRoot = `/tmp/manual-stage1-${attemptId}`,
    cidFile = `${cidRoot}/runner.cid`;
  await fs.mkdir(cidRoot, { mode: 0o700 });
  const cleanupConfig = path.join(cidRoot, "cleanup-config");
  await fs.mkdir(cleanupConfig, { mode: 0o700 });
  await checkedPrivatePath(cleanupConfig, { principal, privateRoot: cidRoot, directory: true });
  const cidDirectory = (
    await checkedPrivatePath(cidRoot, { principal, privateRoot: cidRoot, directory: true })
  ).at(-1).stat;
  try {
    await fs.lstat(cidFile);
    fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const proof = JSON.parse(fixed.proofBytes),
    image = proof.identity.images.runner,
    imageReference = `${image.registry}@${image.imageDigest}`,
    args = [
      "run",
      "--interactive",
      "--read-only",
      "--network",
      resources.network.id,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=1m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--env",
      "RUNNER_EXECUTION_MODE=manual-stage1",
      "--cidfile",
      cidFile,
      imageReference
    ],
    argvBytes = encodeManualJson({ command: "docker", args }),
    argv = await archive.raw(argvBytes);
  await sources.put("runner.argv.json", argvBytes);
  const environment = { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: sources.config };
  if (typeof process.env.PATH === "string") environment.PATH = process.env.PATH;
  let cleanupCause = null,
    cleanupEnvironment;
  const docker = async (callArgs, prefix, cleanup = false) => {
    if (!cleanup) await sources.guard();
    const result = await new Promise((resolve) => {
      try {
        childProcess.execFile(
          "docker",
          callArgs,
          {
            shell: false,
            windowsHide: true,
            encoding: "buffer",
            timeout: 10000,
            maxBuffer: 1048576,
            env: cleanup ? cleanupEnvironment : environment
          },
          (error, stdout, stderr) => resolve({ error, stdout, stderr })
        );
      } catch (error) {
        resolve({ error });
      }
    });
    for (const stream of ["stdout", "stderr"])
      if (Buffer.isBuffer(result[stream])) {
        const bytes = result[stream];
        try {
          if (bytes.length > 1048576) fail("MANUAL_OUTPUT_LIMIT");
          await sources.put(`${prefix}.${stream}`, bytes);
          await archive.raw(bytes);
        } catch (cause) {
          if (!cleanup) throw cause;
          cleanupCause ??= cause;
        }
      }
    return result;
  };
  const decode = (result) => {
    if (
      result.error ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stdout.length > 1048576 ||
      result.stderr.length
    )
      fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    } catch {
      fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
    }
  };
  const imageFacts = decode(
    await docker(
      ["image", "inspect", "--format", runnerFormats.image, "--", imageReference],
      "image-inspect"
    )
  );
  if (
    !exact(imageFacts, [
      "id",
      "repoDigests",
      "sourceRevision",
      "platform",
      "defaultEntrypoint",
      "defaultCommand"
    ]) ||
    !/^sha256:[0-9a-f]{64}$/u.test(imageFacts.id) ||
    !Array.isArray(imageFacts.repoDigests) ||
    !imageFacts.repoDigests.includes(imageReference) ||
    imageFacts.sourceRevision !== proof.identity.sourceSha ||
    imageFacts.platform !== image.platform ||
    imageFacts.defaultEntrypoint !== true ||
    imageFacts.defaultCommand !== true
  )
    fail("MANUAL_RUNNER_RESOURCE_MISMATCH");
  await archive.raw(Buffer.alloc(0));
  const events = [];
  let previousProcessEvidenceDigest = null,
    stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    closedAt = null,
    requestDigest = null,
    input = null,
    authorization = null,
    consumed = null,
    commandResult = null,
    resultDigest = null,
    observationDigest = null;
  const parentFrames = [];
  const stdoutRaw = (bytes) =>
    archive.raw(bytes, {
      requestBytes: input?.canonicalBytes,
      authorization,
      authorizeBytes: parentFrames[0]
    });
  const profileBytes = encodeManualJson(facts.profile);
  const snapshot = async (prefix = stdout) => {
    const value = {
      schemaVersion: "manual-runner-evidence.v1",
      kind: "process",
      recordedAt: new Date().toISOString(),
      promotionEligible: false,
      ...identity,
      attemptAllocationDigest,
      requestDigest,
      previousProcessEvidenceDigest,
      events: [...events],
      closedAt,
      protocol: {
        stdoutPrefix: await stdoutRaw(prefix),
        parentFrames: await (async () => {
          const refs = [];
          // Each new ACK can create a raw-directory entry. Keep these writes
          // separate from the other frames' private-directory readbacks.
          for (const bytes of parentFrames) refs.push(await archive.raw(bytes));
          return refs;
        })()
      }
    };
    previousProcessEvidenceDigest = await archive.put(value, "manual-runner-evidence.v1");
    if (!(await archive.get(previousProcessEvidenceDigest)).bytes.equals(encodeManualJson(value)))
      fail("MANUAL_STORAGE_UNVERIFIED");
  };
  const event = (status, fields = {}) => ({
    sequence: events.length,
    processSequence: 0,
    source: "parent",
    tool: "runner",
    event: status,
    at: new Date().toISOString(),
    containerId: null,
    pid: null,
    argvDigest: argv.digest,
    exitCode: null,
    signal: null,
    reasonCode: null,
    stdout: null,
    stderr: null,
    ...fields
  });
  events.push(event("PREPARED"));
  await snapshot();
  await sources.guard();
  let child,
    containerId = null,
    close = null,
    failure = null,
    spawned = false,
    challenge,
    spawnedEvent = null,
    spawnError = null,
    refusalAt = null,
    launchCustodyComplete = false;
  const incompleteRaw = new Set();
  let closedResolve, challengeResolve, challengeReject;
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });
  const challenged = new Promise((resolve, reject) => {
    challengeResolve = resolve;
    challengeReject = reject;
  });
  challenged.catch(() => {});
  const rejectStream = (cause) => {
    if (!failure || failure.code === "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED") {
      failure = cause;
      refusalAt = new Date().toISOString();
    }
    challengeReject(cause);
    wake?.();
    wake = null;
  };
  let activeFrames = false,
    parsedCount = 0,
    wake = null;
  const frames = [];
  const collect = (stream) => (chunk) => {
    if (!Buffer.isBuffer(chunk)) {
      rejectStream(
        Object.assign(new Error("MANUAL_FRAME_INVALID"), { code: "MANUAL_FRAME_INVALID" })
      );
      return;
    }
    const current = stream === "stdout" ? stdout : stderr;
    const limit = stream === "stdout" ? 2097152 : 1048576;
    const overflow = current.length + chunk.length > limit;
    if (overflow) incompleteRaw.add(stream);
    const next = Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
    if (stream === "stdout") stdout = next;
    else stderr = next;
    try {
      if (overflow) fail("MANUAL_OUTPUT_LIMIT");
      if (stream === "stdout") {
        if (
          !stdout
            .subarray(0, Math.min(4, stdout.length))
            .equals(Buffer.from("MS2 ").subarray(0, Math.min(4, stdout.length)))
        )
          fail("MANUAL_FRAME_INVALID");
        const parsed = parseManualRunnerFrames({
          direction: "child-to-parent",
          bytes: stdout,
          ended: false
        });
        if (
          !activeFrames &&
          (parsed.frames.length > 1 || (parsed.frames.length === 1 && parsed.pendingBytes.length))
        )
          fail("MANUAL_FRAME_ORDER_INVALID");
        if (!challenge && parsed.frames.length) {
          challenge = parsed.frames[0];
          challengeResolve(challenge);
        }
        for (const frame of parsed.frames.slice(parsedCount)) {
          if (frame.type !== "CHALLENGE") frames.push(frame);
        }
        parsedCount = parsed.frames.length;
        wake?.();
        wake = null;
      }
    } catch (cause) {
      rejectStream(cause);
    }
  };
  const bounded = async (promise, milliseconds, code) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), milliseconds);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const readCid = async () => {
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        // Docker's one permitted CID creation changes directory times. Its
        // stable identity stays pinned; the complete file is separately pinned.
        const chain = await observedPath(cidRoot),
          current = chain.at(-1).stat;
        await ownerOnly(cidRoot, principal, current);
        if (!sameIdentity(current, cidDirectory, false))
          fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
        const pending = await fs.lstat(cidFile, { bigint: true });
        if (!pending.isFile() || pending.nlink !== 1n || (await fs.realpath(cidFile)) !== cidFile)
          fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
        await ownerOnly(cidFile, principal, pending);
        // os.Create exposes a zero-byte file while the Engine call is in flight.
        // Reopen each bounded poll; only the later complete bytes can supply ID.
        if (pending.size === 0n) {
          const handle = await fs.open(cidFile, "r");
          try {
            if (!sameIdentity(pending, await handle.stat({ bigint: true }), false))
              fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
          } finally {
            await handle.close();
          }
          if (Date.now() >= deadline || close) fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        const input = await pinPrivateInput(cidFile, { principal, privateRoot: cidRoot });
        try {
          if (
            !/^[0-9a-f]{64}\n?$/u.test(
              new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)
            )
          )
            fail("MANUAL_RUNNER_RESOURCE_INPUT_REQUIRED");
          await input.recheck();
          containerId = input.bytes.toString("ascii").trim();
          await sources.put("runner.cid", input.bytes);
          await archive.raw(input.bytes);
          return containerId;
        } finally {
          await input.close();
        }
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline || close) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  const inspect = async (prefix, cleanup = false) =>
    decode(
      await docker(
        ["container", "inspect", "--format", runnerFormats.container, "--", containerId],
        prefix,
        cleanup
      )
    );
  const checkContainer = (value, running) => {
    if (
      !exact(value, [
        "id",
        "imageId",
        "imageReference",
        "running",
        "paused",
        "restarting",
        "dead",
        "readonlyRootfs",
        "privileged",
        "networkMode",
        "networkId",
        "capDrop",
        "securityOpt",
        "tmpfs",
        "mounts",
        "ports",
        "portBindings",
        "defaultEntrypoint",
        "defaultCommand",
        "manualMode"
      ]) ||
      value.id !== containerId ||
      value.imageId !== imageFacts.id ||
      value.imageReference !== imageReference ||
      value.running !== running ||
      value.paused !== false ||
      value.restarting !== false ||
      value.dead !== false ||
      value.readonlyRootfs !== true ||
      value.privileged !== false ||
      value.networkMode !== resources.network.id ||
      value.networkId !== resources.network.id ||
      sha256Canonical(value.capDrop) !== sha256Canonical(["ALL"]) ||
      sha256Canonical(value.securityOpt) !== sha256Canonical(["no-new-privileges"]) ||
      sha256Canonical(value.tmpfs) !==
        sha256Canonical({
          "/tmp": "rw,noexec,nosuid,size=64m",
          "/var/lib/postgresql/data": "rw,noexec,nosuid,size=1m"
        }) ||
      !Array.isArray(value.mounts) ||
      value.mounts.some(
        (mount) =>
          mount.Type !== "tmpfs" ||
          !["/tmp", "/var/lib/postgresql/data"].includes(mount.Destination)
      ) ||
      !(
        value.ports === null ||
        exact(value.ports, []) ||
        (exact(value.ports, ["5432/tcp"]) && value.ports["5432/tcp"] === null)
      ) ||
      !(value.portBindings === null || exact(value.portBindings, [])) ||
      value.defaultEntrypoint !== true ||
      value.defaultCommand !== true ||
      sha256Canonical(value.manualMode) !== sha256Canonical([true])
    )
      fail("MANUAL_RUNNER_RESOURCE_MISMATCH");
  };
  try {
    const oldMask = process.umask(0o077);
    try {
      child = childProcess.spawn("docker", args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: environment
      });
    } finally {
      process.umask(oldMask);
    }
    child.once("close", (exitCode, signal) => {
      close = { exitCode, signal, at: new Date().toISOString() };
      closedResolve(close);
      wake?.();
      wake = null;
      if (!challenge)
        rejectStream(
          Object.assign(new Error("MANUAL_FRAME_INCOMPLETE"), { code: "MANUAL_FRAME_INCOMPLETE" })
        );
    });
    child.once("error", () => {
      spawnError = event("SPAWN_FAILED", { reasonCode: "MANUAL_PROCESS_SPAWN_FAILED" });
      rejectStream(
        Object.assign(new Error("MANUAL_PROCESS_SPAWN_FAILED"), {
          code: "MANUAL_PROCESS_SPAWN_FAILED"
        })
      );
    });
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", () =>
        rejectStream(
          Object.assign(new Error("MANUAL_FRAME_INCOMPLETE"), { code: "MANUAL_FRAME_INCOMPLETE" })
        )
      );
    await bounded(
      new Promise((resolve, reject) => {
        child.once("spawn", () => {
          spawned = true;
          spawnedEvent = event("SPAWNED", { pid: child.pid });
          resolve();
        });
        child.once("error", reject);
      }),
      5000,
      "MANUAL_PROCESS_TIMEOUT"
    );
    containerId = await readCid();
    spawnedEvent.containerId = containerId;
    events.push(spawnedEvent);
    await snapshot();
    checkContainer(await inspect("container-inspect"), true);
    launchCustodyComplete = true;
    await bounded(challenged, 5000, "MANUAL_PROCESS_TIMEOUT");
    if (failure) throw failure;
    await withExpectedAdmission(
      facts,
      allocation,
      attemptAllocationDigest,
      archive,
      () => {
        if (failure) throw failure;
        // CHALLENGE proves only an earlier live response. Actual closure or
        // exit during admission prevents publishing a successful readback.
        if (close || child.exitCode !== null || child.signalCode !== null)
          fail("MANUAL_FRAME_INCOMPLETE");
      },
      sources,
      async (admitted) => {
        const { profile, targetContext } = facts;
        const target = profile.allowedTargets.find(
          (value) =>
            value.endpointPolicyId === operation.targetIntent.endpointPolicyId &&
            value.databaseName === operation.targetIntent.databaseName
        );
        const physicalIdentity = observed.observation.physicalIdentity;
        const roleObservation = {
          role: target.roles[second?.phase === "verify" ? "verify" : "migrate"],
          tls: true,
          schemaObservationDigest: sha256Canonical(observed.observation.catalog)
        };
        const domainInput = {
          databaseIdentityFingerprint: sha256Canonical({
            databaseName: physicalIdentity.databaseName,
            databaseOid: physicalIdentity.databaseOid,
            role: roleObservation.role,
            tls: true
          }),
          baselineManifestIdentityDigest: sha256Canonical(baseline.value.identity),
          baselineManifestDigest: baselines[0][0],
          expectedSchemaDigest: admitted.expectation.script.digest,
          expectedOwner: observed.observation.catalog.schemaOwner,
          allowedExtensions: [...observed.observation.catalog.extensions]
        };
        if (dry && !encodeManualJson(domainInput).equals(encodeManualJson(dry.domainInput)))
          fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
        const request = {
          schemaVersion: "manual-runner-request.v1",
          ...identity,
          ownerId: profile.ownerId,
          purpose: operation.purpose,
          targetIntent: operation.targetIntent,
          stage: "runner-command",
          capability: second?.phase === "verify" ? "verify" : "migrate",
          phase: allocation.phaseKey,
          commandId: second?.phase === "verify" ? "db.schema.verify" : "db.migrate.deploy",
          commandVersion: "1",
          buildProofDigest: facts.build.buildProofDigest,
          baselineManifestDigest: baselines[0][0],
          targetObservationDigest: sha256Canonical(observed.observation),
          physicalIdentity,
          roleObservation,
          containerId,
          runnerImageDigest: image.imageDigest,
          childChallenge: challenge.payload.childChallenge,
          attemptAllocationDigest,
          domainInput,
          expectedSchemaEvidenceDigest: admitted.admission.schemaExpectation.digest,
          ...(second
            ? {
                predecessorExecutionRecordDigest: second.migration.migration.executionRecordDigest,
                ...(["replay", "reconcile"].includes(second.phase)
                  ? { originalIdempotencyKey: second.migration.request.idempotencyKey }
                  : {})
              }
            : dry
              ? {
                  dryRunRecordDigest: dry.reference.executionRecordDigest,
                  approvedPlanDigest: deterministicPlanDigest(dry.result.plan)
                }
              : {})
        };
        validateManualRunnerRequest(request);
        const catalog = await computeMigrationCatalog(repoRoot);
        if (catalog.digest !== proof.identity.migrationCatalogDigest)
          fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
        for (const entry of catalog.entries) {
          const bytes = await fs.readFile(path.join(repoRoot, ...entry.path.split("/")));
          if (sha256Bytes(bytes) !== entry.sha256) fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
          await archive.raw(bytes);
        }
        await archive.put(catalog, null);
        for (const [index, bytes] of facts.h3InputBytes.entries()) {
          const ref = await archive.raw(bytes);
          const expected = index === 0 ? targetContext.h3Approval : targetContext.h3Readback;
          if (sha256Canonical(ref) !== sha256Canonical(expected)) fail("MANUAL_STORAGE_UNVERIFIED");
        }
        await admitted.recheck();
        requestDigest = await archive.put(request, "manual-runner-request.v1");
        input = {
          binding: Object.fromEntries(
            Object.entries(request).filter(
              ([key]) =>
                ![
                  "schemaVersion",
                  "attemptId",
                  "runId",
                  "attemptAllocationDigest",
                  "domainInput",
                  "expectedSchemaEvidenceDigest"
                ].includes(key)
            )
          ),
          canonicalBytes: (await archive.get(requestDigest)).bytes
        };
        // Append a bound successor; the original null-request bytes stay intact.
        await snapshot();
        await admitted.recheck();
        const custody = async (digest, subjectType = "r2-artifact", role = "archive") => {
          await archive.get(digest, role);
          const observedAt = new Date().toISOString();
          return session.record("custody", {
            schemaVersion: "manual-operation-record.v2",
            kind: "custody",
            profileDigest: request.profileDigest,
            recordedAt: new Date().toISOString(),
            promotionEligible: false,
            ownerId: profile.ownerId,
            subjectDigest: digest,
            subjectType,
            purpose: role === "backup" ? "backup-readback" : "archive-readback",
            outcome: "MATCH",
            observedDigest: digest,
            observedAt,
            storageRole: role,
            retentionDays: profile.storage.retentionDays,
            reasonCode: null
          });
        };
        // Finish receipt-independent custody before starting the short handoff window.
        const processReadbackRef = await custody(previousProcessEvidenceDigest);
        const processReadback = (await archive.get(processReadbackRef.recordDigest)).value;
        const bound = (await archive.get(previousProcessEvidenceDigest)).value;
        // Finish receipt-independent delivery preparation before starting its short window.
        await admitted.recheckForDelivery();
        await facts.recheckResources();
        await sources.checkSourceBytes();
        authorization = await session.sign(input);
        consumed = await session.consume({
          authorization,
          request: input,
          childObservation: fieldsFrom(request, [
            "containerId",
            "runnerImageDigest",
            "childChallenge"
          ])
        });
        const authorize = encodeManualRunnerFrame({
          protocol: "MS2",
          type: "AUTHORIZE",
          sequence: 0,
          payload: {
            launchContext: { containerId, runnerImageDigest: image.imageDigest },
            allocation,
            request,
            authorization,
            receipt: consumed.handoffReceipt,
            baseline: baseline.value,
            process: bound,
            processReadback,
            targetContext
          }
        });
        const binding = {
          ...fieldsFrom(request, [
            ...observationFields,
            "attemptAllocationDigest",
            "containerId",
            "runnerImageDigest",
            "childChallenge"
          ]),
          requestDigest,
          authorizationDigest: sha256Canonical(authorization)
        };
        let stdinBytes = 0;
        const send = async (bytes) => {
          if (stdinBytes + bytes.length > 1048576) fail("MANUAL_OUTPUT_LIMIT");
          stdinBytes += bytes.length;
          try {
            await new Promise((resolve, reject) =>
              child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()))
            );
          } catch {
            fail("MANUAL_FRAME_INCOMPLETE");
          }
        };
        const next = () =>
          bounded(
            (async () => {
              while (true) {
                if (failure) throw failure;
                if (frames.length) return frames.shift();
                if (close) fail("MANUAL_FRAME_INCOMPLETE");
                await new Promise((resolve) => {
                  wake = resolve;
                });
              }
            })(),
            1810000,
            "MANUAL_PROCESS_TIMEOUT"
          );
        const control = (frame, type) => {
          if (
            frame.type !== type ||
            sha256Canonical(frame.payload.binding) !== sha256Canonical(binding) ||
            sha256Canonical(frame.payload.authorizeFrame) !==
              sha256Canonical({ digest: sha256Bytes(authorize), bytes: authorize.length })
          )
            fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
        };
        if (close || child.exitCode !== null || child.signalCode !== null)
          fail("MANUAL_FRAME_INCOMPLETE");
        await checkConsumedObservation(session, input, authorization, consumed, facts, archive);
        activeFrames = true;
        await send(authorize);
        parentFrames.push(authorize);
        control(await next(), "READY");
        // Keep the resource observation and full fact/source guard after READY, before the pin.
        await admitted.recheckForDelivery();
        await facts.recheckResources();
        await sources.guard();
        if (close || child.exitCode !== null || child.signalCode !== null)
          fail("MANUAL_FRAME_INCOMPLETE");
        const secret = await pinPrivateInput(
          path.join(
            profile.storage.credentialRoot,
            "operations",
            operation.operationRef,
            second?.phase === "verify" ? "verify.json" : "migrate.json"
          ),
          { principal, privateRoot: profile.storage.credentialRoot }
        );
        let credentialBytes;
        try {
          const credential = observerCredential(
            secret.bytes,
            target.roles[second?.phase === "verify" ? "verify" : "migrate"]
          );
          credential.password = "";
          credential.username = "";
          await secret.recheck();
          // Pin awaits may race source changes; reopen all inputs before the final fresh check.
          await admitted.recheckForDelivery();
          await checkConsumedObservation(session, input, authorization, consumed, facts, archive);
          credentialBytes = encodeManualRunnerFrame({
            protocol: "MS2",
            type: "CREDENTIAL",
            sequence: 1,
            payload: { binding, credential: secret.bytes.toString("utf8") }
          });
          await send(credentialBytes);
        } finally {
          credentialBytes?.fill(0);
          secret.bytes.fill(0);
          await secret.close();
        }
        control(await next(), "CREDENTIAL_RECEIVED");
        while (true) {
          const frame = await next();
          await archive.raw(frame.frameBytes);
          await archive.raw(frame.payloadBytes);
          if (frame.type === "RESULT") {
            commandResult = frame.payload;
            resultDigest = await archive.put(commandResult, "manual-runner-evidence.v1");
            if (!(await archive.get(resultDigest)).bytes.equals(frame.payloadBytes))
              fail("MANUAL_STORAGE_UNVERIFIED");
            await custody(resultDigest);
            break;
          }
          if (frame.type === "ACK_RECEIVED") continue;
          if (!["PREPARED", "EVENT", "OBSERVATION"].includes(frame.type))
            fail("MANUAL_FRAME_ORDER_INVALID");
          const prior = await archive.get(previousProcessEvidenceDigest);
          const prefixLength = parseManualRunnerFrames({
            direction: "child-to-parent",
            bytes: stdout,
            ended: false
          })
            .frames.slice(0, frame.sequence + 1)
            .reduce((total, value) => total + value.frameBytes.length, 0);
          const prefix = Buffer.from(stdout.subarray(0, prefixLength));
          let subject, subjectDigest;
          if (frame.type === "OBSERVATION") {
            subjectDigest = await archive.put(
              frame.payload.observation,
              "manual-runner-evidence.v1"
            );
            observationDigest = subjectDigest;
            subject = {
              kind: "observation",
              observation: (await archive.get(subjectDigest)).value
            };
          } else {
            const value = frame.payload.event;
            if (value.event === "PREPARED") {
              const prisma = "/app/apps/release-runner/node_modules/.bin/prisma";
              const schema = "/app/apps/api/prisma/schema.prisma",
                config = "/app/apps/api/prisma.config.ts";
              const argsByTool = {
                "prisma-version": ["--version"],
                "psql-version": ["--version"],
                "prisma-deploy": ["migrate", "deploy", "--schema", schema, "--config", config],
                "prisma-diff": [
                  "migrate",
                  "diff",
                  "--from-config-datasource",
                  "--to-schema",
                  schema,
                  "--exit-code",
                  "--config",
                  config
                ],
                "prisma-script": [
                  "migrate",
                  "diff",
                  "--from-empty",
                  "--to-config-datasource",
                  "--script",
                  "--config",
                  config
                ]
              };
              const args = argsByTool[value.tool];
              if (!args) fail("MANUAL_FRAME_INVALID");
              const argv = await archive.raw(
                encodeManualJson({ command: value.tool === "psql-version" ? "psql" : prisma, args })
              );
              if (argv.digest !== value.argvDigest) fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
            }
            if (value.event === "CLOSED") {
              for (const key of ["stdout", "stderr"]) {
                const bytes = Buffer.from(frame.payload[key + "Base64"], "base64");
                new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                const raw = await archive.raw(bytes);
                if (sha256Canonical(raw) !== sha256Canonical(value[key]))
                  fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
              }
            }
            events.push(value);
            await snapshot(prefix);
            subjectDigest = previousProcessEvidenceDigest;
            subject = { kind: "process", process: (await archive.get(subjectDigest)).value };
          }
          const readbackRef = await custody(subjectDigest);
          const ack = encodeManualRunnerFrame({
            protocol: "MS2",
            type: "ACK",
            sequence: parentFrames.length + 1,
            payload: {
              binding,
              acknowledgedFrame: {
                digest: sha256Bytes(frame.frameBytes),
                bytes: frame.frameBytes.length
              },
              subject,
              readback: (await archive.get(readbackRef.recordDigest)).value
            }
          });
          validateManualRunnerProtocol({
            mode: "live-ack",
            profileBytes,
            requestBytes: input.canonicalBytes,
            authorizationBytes: encodeManualJson(authorization),
            previousProcessBytes: prior.bytes,
            childFrameBytes: frame.frameBytes,
            ackFrameBytes: ack,
            stdoutPrefixBytes: prefix,
            parentFrameBytes: [...parentFrames]
          });
          await send(ack);
          parentFrames.push(ack);
        }
        await bounded(closed, 5000, "MANUAL_FRAME_INCOMPLETE");
        if (failure) throw failure;
      }
    );
  } catch (cause) {
    if (!child) spawnError = event("SPAWN_FAILED", { reasonCode: "MANUAL_PROCESS_SPAWN_FAILED" });
    failure ??= cause;
    refusalAt ??= new Date().toISOString();
  } finally {
    const retain = async (work) => {
      try {
        await work();
      } catch (cause) {
        cleanupCause ??= cause;
      }
    };
    try {
      if (spawned && !events.some((value) => value.event === "SPAWNED")) {
        events.push({ ...spawnedEvent, sequence: events.length, containerId });
        await retain(snapshot);
      } else if (!spawned && spawnError) {
        events.push({ ...spawnError, sequence: events.length });
        await retain(snapshot);
      }
      let stopped = false;
      if (containerId) {
        try {
          await checkedPrivatePath(cleanupConfig, {
            principal,
            privateRoot: cidRoot,
            directory: true
          });
          cleanupEnvironment = { ...environment, DOCKER_CONFIG: cleanupConfig };
          if (!commandResult || failure || !close)
            await docker(["stop", "--time", "2", "--", containerId], "stop", true);
          checkContainer(await inspect("final-inspect", true), false);
          stopped = true;
        } catch (cause) {
          cleanupCause ??= cause;
        }
      } else if (spawned) {
        cleanupCause ??= failure;
      }
      child?.stdin.end();
      if (child && !close) {
        try {
          await bounded(closed, 1000, "MANUAL_FRAME_INCOMPLETE");
        } catch {
          child.kill("SIGTERM");
          try {
            await bounded(closed, 1000, "MANUAL_FRAME_INCOMPLETE");
          } catch {
            child.kill("SIGKILL");
            try {
              await bounded(closed, 1000, "MANUAL_FRAME_INCOMPLETE");
            } catch (cause) {
              cleanupCause ??= cause;
            }
          }
        }
      }
      await retain(async () => {
        await stdoutRaw(stdout);
        await archive.raw(stderr);
      });
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(stdout);
        new TextDecoder("utf-8", { fatal: true }).decode(stderr);
        parseManualRunnerFrames({ direction: "child-to-parent", bytes: stdout, ended: true });
      } catch (cause) {
        const code = cause.code?.startsWith("MANUAL_") ? cause.code : "MANUAL_FRAME_INVALID";
        rejectStream(Object.assign(new Error(code), { code }));
      }
      // Actual pipe closure and exact stopped inspect are independent facts.
      // A killed Docker CLI alone never establishes container completion.
      if (close && spawned) {
        const complete =
          launchCustodyComplete &&
          stopped &&
          !cleanupCause &&
          incompleteRaw.size === 0 &&
          (commandResult && !failure ? true : refusalAt <= close.at);
        if (complete && !commandResult) {
          events.push(
            event("DISPATCH_CLOSED", {
              at: refusalAt,
              containerId,
              argvDigest: null,
              reasonCode: failure?.code ?? "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"
            })
          );
          await retain(snapshot);
        }
        const stdoutRef = incompleteRaw.has("stdout") ? null : await stdoutRaw(stdout),
          stderrRef = incompleteRaw.has("stderr") ? null : await archive.raw(stderr);
        events.push(
          event("CLOSED", {
            at: close.at,
            containerId,
            pid: child.pid,
            exitCode: close.exitCode,
            signal: close.signal,
            reasonCode: failure?.code ?? null,
            stdout: stdoutRef,
            stderr: stderrRef
          })
        );
        const calls = new Map();
        for (const value of events)
          if (value.event !== "DISPATCH_CLOSED") calls.set(value.processSequence, value.event);
        const dispatchClosed = events.some(
          (value) => value.tool === "runner" && value.event === "DISPATCH_CLOSED"
        );
        if (
          complete &&
          !cleanupCause &&
          dispatchClosed &&
          [...calls.values()].every((value) => ["CLOSED", "SPAWN_FAILED"].includes(value))
        )
          closedAt = close.at;
        await retain(snapshot);
      }
      await retain(sources.guard);
    } catch (cause) {
      failure = Object.assign(new Error("MANUAL_RUNNER_CLEANUP_UNKNOWN", { cause }), {
        code: "MANUAL_RUNNER_CLEANUP_UNKNOWN"
      });
    } finally {
      if (child && !close) child.kill("SIGKILL");
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
    }
  }
  if (cleanupCause)
    throw Object.assign(new Error("MANUAL_RUNNER_CLEANUP_UNKNOWN", { cause: cleanupCause }), {
      code: "MANUAL_RUNNER_CLEANUP_UNKNOWN"
    });
  if (!failure && commandResult && closedAt && !cleanupCause) {
    const request = JSON.parse(input.canonicalBytes);
    const checked = (await archive.get(consumed.handoffReceipt.consumptionRecordDigest, "journal"))
      .value;
    const scoped = fieldsFrom(request, [
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey"
    ]);
    const record = (kind, fields) => ({
      schemaVersion: "manual-operation-record.v2",
      kind,
      profileDigest: request.profileDigest,
      recordedAt: new Date().toISOString(),
      promotionEligible: false,
      ...fields
    });
    const post = await session.record(
      "post-state",
      record("post-state", {
        ...scoped,
        requestDigest,
        consumptionRecordDigest: sha256Canonical(checked),
        outcome: observationDigest ? "OBSERVED" : "UNAVAILABLE",
        observationDigest,
        observedAt: observationDigest
          ? (await archive.get(observationDigest)).value.observedAt
          : null,
        reasonCode: observationDigest ? null : "MANUAL_EVIDENCE_INCOMPLETE"
      })
    );
    const artifactGraph = await archive.graph(),
      prefixCandidates = stdoutPrefixCandidates(artifactGraph),
      rawBlobs = [];
    for (const name of await fs.readdir(path.join(facts.profile.storage.archiveRoot, "raw"))) {
      if (!/^[0-9a-f]{64}\.bin$/u.test(name)) fail("MANUAL_STORAGE_UNVERIFIED");
      const raw = await pinPrivateInput(
        path.join(facts.profile.storage.archiveRoot, "raw", name),
        { principal, privateRoot: facts.profile.storage.archiveRoot },
        prefixCandidates.has(`sha256:${name.slice(0, -4)}`) ? 2097152 : 1048576
      );
      try {
        if (sha256Bytes(raw.bytes) !== "sha256:" + name.slice(0, -4))
          fail("MANUAL_STORAGE_UNVERIFIED");
        await raw.recheck();
        rawBlobs.push(Buffer.from(raw.bytes));
      } finally {
        await raw.close();
      }
    }
    const assessment = assessManualRunnerEvidence({
      profileBytes,
      requestBytes: input.canonicalBytes,
      artifactBytes: [...artifactGraph.values()].map((item) => item.bytes),
      rawBlobs
    });
    const handoffDigest = sha256Canonical(consumed.handoffReceipt);
    const handoffReadback = [...artifactGraph.entries()].filter(
      ([, item]) =>
        item.value.kind === "custody" &&
        item.value.subjectDigest === handoffDigest &&
        item.value.purpose === "handoff-readback" &&
        item.value.outcome === "MATCH"
    );
    if (handoffReadback.length !== 1) fail("MANUAL_SESSION_UNVERIFIED");
    // The frozen interrupted scenario stops after the real committed result,
    // post-state and closed process have been independently reopened. Preserve
    // those original facts without first writing a successful execution.
    const interrupted =
      facts.fixed.operation.scenario === "apply-interrupted" &&
      request.phase === "apply" &&
      assessment.executionStatus === "SUCCEEDED" &&
      assessment.originalDatabaseOutcome === "committed";
    const execution = record("execution", {
      ...scoped,
      attemptId,
      requestDigest,
      authorizationDigest: sha256Canonical(authorization),
      consumptionRecordDigest: sha256Canonical(checked),
      handoffRecordDigest: handoffDigest,
      handoffReadbackDigest: handoffReadback[0][0],
      postStateRecordDigest: post.recordDigest,
      predecessorExecutionRecordDigest:
        request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null,
      startedAt: commandResult.startedAt,
      finishedAt: closedAt,
      status: interrupted ? "INTERRUPTED_UNKNOWN" : assessment.executionStatus,
      reasonCode: interrupted ? "MANUAL_EVIDENCE_INCOMPLETE" : assessment.reasonCode,
      resultDigest,
      processEvidenceDigest: previousProcessEvidenceDigest
    });
    const executionRef = await session.record("execution", execution);
    await archive.put(execution, "manual-operation-record.v2", "backup");
    for (const role of ["archive", "backup"]) {
      await archive.get(executionRef.recordDigest, role);
      const observedAt = new Date().toISOString();
      await session.record(
        "custody",
        record("custody", {
          ownerId: facts.profile.ownerId,
          subjectDigest: executionRef.recordDigest,
          subjectType: "record",
          purpose: role === "backup" ? "backup-readback" : "archive-readback",
          outcome: "MATCH",
          observedDigest: executionRef.recordDigest,
          observedAt,
          storageRole: role,
          retentionDays: facts.profile.storage.retentionDays,
          reasonCode: null
        })
      );
    }
    if (interrupted) fail("MANUAL_EVIDENCE_INCOMPLETE");
    if (assessment.executionStatus !== "SUCCEEDED")
      fail(assessment.reasonCode ?? "MANUAL_EVIDENCE_INCOMPLETE");
    return {
      reference: Object.freeze({
        requestDigest,
        resultDigest,
        processEvidenceDigest: previousProcessEvidenceDigest,
        executionRecordDigest: executionRef.recordDigest
      }),
      result: commandResult,
      domainInput: request.domainInput
    };
  }
  throw (
    failure ??
    Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"), {
      code: "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"
    })
  );
}

async function checkConsumedObservation(session, input, authorization, consumed, facts, archive) {
  assertManualDecision(consumed?.parentDecision);
  const { profile, targetContext } = facts,
    request = JSON.parse(input.canonicalBytes),
    authorizationDigest = sha256Canonical(authorization),
    requestDigest = sha256Bytes(input.canonicalBytes);
  if (
    consumed.stage !== request.stage ||
    consumed.parentDecision.authorizationDigest !== authorizationDigest ||
    consumed.parentDecision.requestDigest !== requestDigest
  )
    fail("MANUAL_BINDING_MISMATCH");
  const receipt = request.stage === "runner-command" ? consumed.handoffReceipt : null;
  if (
    receipt &&
    !(await archive.get(sha256Canonical(receipt))).bytes.equals(encodeManualJson(receipt))
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const custody = (
    await archive.get(receipt?.consumptionReadbackDigest ?? consumed.consumptionReadbackDigest)
  ).value;
  validateContract("manual-operation-record.v2", custody);
  const consumption = (await archive.get(custody.subjectDigest, "journal")).value;
  validateContract("manual-operation-record.v2", consumption);
  const slot = await archive.read(
    path.join(
      profile.storage.journalRoot,
      "consumptions",
      `${request.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
    ),
    profile.storage.journalRoot
  );
  if (
    custody.kind !== "custody" ||
    custody.purpose !== "consumption-readback" ||
    custody.outcome !== "MATCH" ||
    custody.observedDigest !== custody.subjectDigest ||
    custody.storageRole !== "journal" ||
    consumption.kind !== "consumption" ||
    consumption.status !== "CONSUMED" ||
    consumption.authorizationDigest !== authorizationDigest ||
    consumption.requestDigest !== requestDigest ||
    !slot.bytes.equals(encodeManualJson(consumption))
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  await facts.recheck();
  const graph = await archive.graph(),
    opened = graph.get(consumption.sessionRecordDigest)?.value;
  if (
    !opened ||
    [...graph.values()].some(
      ({ value }) =>
        value.kind === "session" && value.sessionId === session.sessionId && value.status !== "OPEN"
    )
  )
    fail("MANUAL_SESSION_UNVERIFIED");
  const revocationDirectory = path.join(profile.storage.journalRoot, "revocations"),
    records = [];
  for (const name of await fs.readdir(revocationDirectory)) {
    if (!name.startsWith(`${sha256Canonical(profile).slice(7)}-`)) continue;
    records.push(
      (await archive.read(path.join(revocationDirectory, name), profile.storage.journalRoot)).value
    );
  }
  records.sort((left, right) => left.sequence - right.sequence);
  const head = records.at(-1);
  if (!head) fail("MANUAL_REVOCATION_UNVERIFIED");
  const checkpoints = path.join(profile.storage.journalRoot, "checkpoints");
  for (const name of await fs.readdir(checkpoints)) {
    if (!name.startsWith(`${sha256Canonical(profile).slice(7)}-`)) continue;
    const saved = (await archive.read(path.join(checkpoints, name), profile.storage.journalRoot))
      .value;
    if (
      !records[saved.sequence] ||
      sha256Canonical(records[saved.sequence]) !== sha256Canonical(saved)
    )
      fail("MANUAL_REVOCATION_UNVERIFIED");
  }
  const checkpoint = (
    await archive.read(
      path.join(
        profile.storage.journalRoot,
        "checkpoints",
        `${sha256Canonical(profile).slice(7)}-${head.sequence}.json`
      ),
      profile.storage.journalRoot
    )
  ).value;
  const predecessor =
    request.dryRunRecordDigest || request.predecessorExecutionRecordDigest
      ? (await archive.get(request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest))
          .value
      : null;
  const readAt = new Date().toISOString();
  const decision = verifyManualAuthorization({
    authorization,
    profile,
    request: input,
    session: {
      record: opened,
      recordDigest: consumption.sessionRecordDigest,
      readAt,
      predecessor
    },
    revocation: {
      records,
      headDigest: sha256Canonical(head),
      checkpoint: { sequence: checkpoint.sequence, digest: sha256Canonical(checkpoint) },
      readAt
    },
    now: readAt
  });
  assertManualDecision(decision);
  if (
    decision.sessionId !== session.sessionId ||
    decision.profileDigest !== targetContext.profileDigest
  )
    fail("MANUAL_BINDING_MISMATCH");
  if (receipt) {
    const handoffReadbacks = [...graph.values()].filter(
      ({ value }) =>
        value.kind === "custody" &&
        value.subjectDigest === sha256Canonical(receipt) &&
        value.purpose === "handoff-readback"
    );
    if (
      handoffReadbacks.length !== 1 ||
      handoffReadbacks[0].value.outcome !== "MATCH" ||
      handoffReadbacks[0].value.observedDigest !== sha256Canonical(receipt) ||
      handoffReadbacks[0].value.storageRole !== "archive" ||
      receipt.consumptionRecordDigest !== sha256Canonical(consumption)
    )
      fail("MANUAL_SESSION_UNVERIFIED");
    verifyManualHandoff({
      authorization,
      receipt,
      profile,
      request: input,
      childObservation: fieldsFrom(request, ["containerId", "runnerImageDigest", "childChallenge"]),
      now: readAt
    });
  }
  return consumption;
}

function observerCredential(bytes, expectedRole) {
  try {
    const supplied = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !exact(supplied, ["username", "password"]) ||
      !encodeManualJson(supplied).equals(bytes) ||
      supplied.username !== expectedRole ||
      typeof supplied.password !== "string" ||
      !supplied.password.length ||
      supplied.password.includes("\0")
    )
      fail("MANUAL_CREDENTIAL_INVALID");
    const credential = {
      username: supplied.username,
      password: supplied.password,
      capabilityProfile: "verify"
    };
    supplied.password = "";
    return credential;
  } catch {
    // Native JSON diagnostics can include secret input. Only a fixed code escapes.
    fail("MANUAL_CREDENTIAL_INVALID");
  }
}

async function performTargetObservation(session, facts) {
  const { fixed, profile, principal, targetContext, recheck, recheckResources } = facts,
    archive = targetArchive(facts),
    operation = fixed.operation;
  if (
    session.profileDigest !== operation.profileDigest ||
    sha256Canonical(session.targetIntent) !== sha256Canonical(operation.targetIntent)
  )
    fail("MANUAL_BINDING_MISMATCH");
  // Original identities survive session closure. Reuse reads their archived
  // graph; it neither consumes the old authorization nor reserves another attempt.
  const graph = await archive.graph();
  const values = [...graph.values()].map(({ value }) => value);
  if (
    values.some(
      (value) =>
        value.operationId === operation.operations.observe.operationId ||
        value.idempotencyKey === operation.operations.observe.idempotencyKey ||
        (value.runId === operation.runId &&
          (value.stage === "target-observe" || value.phaseKey === "target-observe"))
    )
  ) {
    try {
      const unique = (matches) => {
        if (matches.length !== 1) fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
        return matches[0];
      };
      const request = unique(
        values.filter(
          (value) =>
            value.schemaVersion === "manual-runner-request.v1" &&
            value.stage === "target-observe" &&
            (value.operationId === operation.operations.observe.operationId ||
              value.idempotencyKey === operation.operations.observe.idempotencyKey ||
              value.runId === operation.runId)
        )
      );
      validateManualRunnerRequest(request);
      if (
        request.profileDigest !== operation.profileDigest ||
        request.runId !== operation.runId ||
        request.operationId !== operation.operations.observe.operationId ||
        request.idempotencyKey !== operation.operations.observe.idempotencyKey ||
        request.ownerId !== profile.ownerId ||
        request.purpose !== operation.purpose ||
        sha256Canonical(request.targetIntent) !== sha256Canonical(operation.targetIntent)
      )
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      const requestDigest = sha256Canonical(request);
      const baseline = unique(
        values.filter(
          (value) =>
            value.schemaVersion === "manual-baseline-manifest.v1" &&
            (graph.get(value.identity?.targetObservationDigest)?.value.requestDigest ===
              requestDigest ||
              graph.get(value.identity?.authorizationDigest)?.value.payload?.requestDigest ===
                requestDigest)
        )
      );
      validateContract("manual-baseline-manifest.v1", baseline);
      if (
        baseline.identity.buildProofDigest !== facts.build.buildProofDigest ||
        baseline.identity.purpose !== operation.purpose ||
        baseline.identity.physicalIdentity.endpointPolicyId !==
          operation.targetIntent.endpointPolicyId ||
        baseline.identity.physicalIdentity.databaseName !== operation.targetIntent.databaseName ||
        baseline.identity.physicalIdentity.databaseOid !== targetContext.databaseOid ||
        baseline.identity.physicalIdentity.clusterFingerprint !==
          computeManualClusterFingerprint(targetContext.cluster)
      )
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      const consumption = unique(
          values.filter((v) => v.kind === "consumption" && v.requestDigest === requestDigest)
        ),
        execution = unique(
          values.filter((v) => v.kind === "execution" && v.requestDigest === requestDigest)
        );
      const original = async (digest, schema, role = "archive") => {
        const item = await archive.get(digest, role);
        validateContract(schema, item.value);
        if (!item.bytes.equals(graph.get(digest)?.bytes))
          fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
        return item;
      };
      const custody = async (
        subjectDigest,
        subjectType,
        purpose = "archive-readback",
        storageRole = "archive"
      ) => {
        const saved = unique(
          values.filter(
            (v) =>
              v.kind === "custody" && v.subjectDigest === subjectDigest && v.purpose === purpose
          )
        );
        const digest = sha256Canonical(saved);
        await original(digest, "manual-operation-record.v2");
        if (
          saved.profileDigest !== operation.profileDigest ||
          saved.ownerId !== profile.ownerId ||
          saved.subjectType !== subjectType ||
          saved.outcome !== "MATCH" ||
          saved.observedDigest !== subjectDigest ||
          saved.storageRole !== storageRole
        )
          fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
        return digest;
      };
      const requestItem = await original(requestDigest, "manual-runner-request.v1");
      await original(request.attemptAllocationDigest, "manual-runner-evidence.v1");
      await original(sha256Canonical(baseline), "manual-baseline-manifest.v1");
      const observation = (
          await original(baseline.identity.targetObservationDigest, "manual-runner-evidence.v1")
        ).value,
        authorization = (
          await original(baseline.identity.authorizationDigest, "manual-launch-authorization.v1")
        ).value,
        proof = await original(facts.build.buildProofDigest, "build-proof.v1");
      if (
        !proof.bytes.equals(encodeManualJson(JSON.parse(fixed.proofBytes))) ||
        observation.kind !== "observation" ||
        observation.requestDigest !== requestDigest ||
        consumption.authorizationDigest !== baseline.identity.authorizationDigest ||
        execution.authorizationDigest !== baseline.identity.authorizationDigest ||
        execution.consumptionRecordDigest !== sha256Canonical(consumption)
      )
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      await original(sha256Canonical(consumption), "manual-operation-record.v2", "journal");
      const slot = await archive.read(
        path.join(
          profile.storage.journalRoot,
          "consumptions",
          `${request.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
        ),
        profile.storage.journalRoot
      );
      if (!slot.bytes.equals(encodeManualJson(consumption)))
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      await custody(sha256Canonical(consumption), "record", "consumption-readback", "journal");
      await original(sha256Canonical(execution), "manual-operation-record.v2");
      const result = (await original(execution.resultDigest, "manual-runner-evidence.v1")).value,
        postState = (await original(execution.postStateRecordDigest, "manual-operation-record.v2"))
          .value;
      if (
        baseline.identity.targetObservationDigest !== result.observationDigest ||
        baseline.identity.targetObservationDigest !== postState.observationDigest
      )
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      const readbackDigest = await custody(
        baseline.identity.targetObservationDigest,
        "r2-artifact"
      );
      await custody(sha256Canonical(execution), "record");
      await custody(sha256Canonical(baseline), "r2-artifact");
      // The same complete canonical archive input as R1 supplies the only
      // success classification; raw reads retain the existing private-store protections.
      const rawDirectory = path.join(profile.storage.archiveRoot, "raw"),
        prefixCandidates = stdoutPrefixCandidates(graph),
        rawBlobs = [];
      await checkedPrivatePath(rawDirectory, {
        principal,
        privateRoot: profile.storage.archiveRoot,
        directory: true
      });
      for (const name of await fs.readdir(rawDirectory)) {
        if (!/^[0-9a-f]{64}\.bin$/u.test(name)) fail("MANUAL_STORAGE_UNVERIFIED");
        const raw = await pinPrivateInput(
          path.join(rawDirectory, name),
          { principal, privateRoot: profile.storage.archiveRoot },
          prefixCandidates.has(`sha256:${name.slice(0, -4)}`) ? 2097152 : 1048576
        );
        try {
          if (sha256Bytes(raw.bytes) !== `sha256:${name.slice(0, -4)}`)
            fail("MANUAL_STORAGE_UNVERIFIED");
          await raw.recheck();
          rawBlobs.push(Buffer.from(raw.bytes));
        } finally {
          await raw.close();
        }
      }
      const assessment = assessManualRunnerEvidence({
        profileBytes: encodeManualJson(profile),
        requestBytes: requestItem.bytes,
        artifactBytes: [...graph.values()].map((item) => item.bytes),
        rawBlobs
      });
      if (
        assessment.executionStatus !== "SUCCEEDED" ||
        execution.status !== assessment.executionStatus
      )
        fail("MANUAL_BASELINE_REUSE_INPUT_REQUIRED");
      await recheckResources();
      const current = await readFixedManualOperation({
        repoRoot,
        operationRef: operation.operationRef
      });
      if (
        current.indexDigest !== fixed.indexDigest ||
        !current.proofBytes.equals(fixed.proofBytes) ||
        !current.materialBytes.equals(fixed.materialBytes)
      )
        fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
      await recheck();
      return Object.freeze({ observation, readbackDigest });
    } catch (cause) {
      throw Object.assign(new Error("MANUAL_BASELINE_REUSE_INPUT_REQUIRED", { cause }), {
        code: "MANUAL_BASELINE_REUSE_INPUT_REQUIRED"
      });
    }
  }
  const binding = {
    profileDigest: session.profileDigest,
    ownerId: profile.ownerId,
    ...fieldsFrom(session, ["sessionId", "sessionNonce"]),
    ...operation.operations.observe,
    purpose: operation.purpose,
    targetIntent: operation.targetIntent,
    stage: "target-observe",
    capability: "verify"
  };
  const request = {
    schemaVersion: "manual-runner-request.v1",
    ...binding,
    attemptId: randomUUID(),
    runId: operation.runId
  };
  const allocatedAt = new Date().toISOString();
  const allocation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "attempt-allocation",
    recordedAt: allocatedAt,
    promotionEligible: false,
    ...fieldsFrom(request, observationFields),
    stage: "target-observe",
    phaseKey: "target-observe",
    allocatedAt,
    targetIntent: operation.targetIntent,
    predecessorExecutionRecordDigest: null
  };
  request.attemptAllocationDigest = await archive.put(allocation, "manual-runner-evidence.v1");
  validateManualRunnerRequest(request);
  const requestDigest = await archive.put(request, "manual-runner-request.v1"),
    input = { binding, canonicalBytes: (await archive.get(requestDigest)).bytes };
  const authorization = await session.sign(input),
    consumed = await session.consume({ authorization, request: input });
  let database, credential;
  try {
    let consumption = await checkConsumedObservation(
      session,
      input,
      authorization,
      consumed,
      facts,
      archive
    );
    await recheckResources();
    await checkConsumedObservation(session, input, authorization, consumed, facts, archive);
    const secret = await pinPrivateInput(
      path.join(
        profile.storage.credentialRoot,
        "operations",
        operation.operationRef,
        "observer.json"
      ),
      { principal, privateRoot: profile.storage.credentialRoot }
    );
    try {
      const endpointPolicy = profile.allowedTargets.find(
        (target) =>
          target.endpointPolicyId === operation.targetIntent.endpointPolicyId &&
          target.databaseName === operation.targetIntent.databaseName
      );
      credential = observerCredential(secret.bytes, endpointPolicy.roles.observer);
      await secret.recheck();
      await recheckResources();
      consumption = await checkConsumedObservation(
        session,
        input,
        authorization,
        consumed,
        facts,
        archive
      );
      const endpoint = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(endpointPolicy.endpoint);
      if (!endpoint) fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
      database = await createPostgresConnector()({
        credential,
        target: {
          hostname: endpoint[1] === "[::1]" ? "::1" : endpoint[1],
          port: Number(endpoint[2]),
          databaseName: endpointPolicy.databaseName,
          tlsMode: "require"
        }
      });
      const startedAt = new Date().toISOString();
      const observation = await observeManualTarget({
        request,
        database,
        endpointPolicy,
        approvedClusterObservation: targetContext
      });
      await recheck();
      const observationDigest = await archive.put(observation, "manual-runner-evidence.v1");
      const record = (kind, fields) => ({
        schemaVersion: "manual-operation-record.v2",
        kind,
        profileDigest: request.profileDigest,
        recordedAt: new Date().toISOString(),
        promotionEligible: false,
        ...fields
      });
      const custody = async (subjectDigest, subjectType) => {
        const observedAt = new Date().toISOString();
        return session.record(
          "custody",
          record("custody", {
            ownerId: profile.ownerId,
            subjectDigest,
            subjectType,
            purpose: "archive-readback",
            outcome: "MATCH",
            observedDigest: subjectDigest,
            observedAt,
            storageRole: "archive",
            retentionDays: 90,
            reasonCode: null
          })
        );
      };
      const readback = await custody(observationDigest, "r2-artifact");
      const reopened = (await archive.get(observationDigest)).value;
      const finishedAt = new Date().toISOString();
      const result = {
        schemaVersion: "manual-runner-evidence.v1",
        kind: "manual-command-result",
        recordedAt: finishedAt,
        promotionEligible: false,
        ...fieldsFrom(request, observationFields),
        requestDigest,
        phaseKey: "target-observe",
        attemptAllocationDigest: request.attemptAllocationDigest,
        startedAt,
        finishedAt,
        outcome: "RETURNED",
        reasonCode: null,
        plan: null,
        postState: null,
        observationDigest,
        processEvidenceDigest: null,
        statements: [...database.statementLog],
        originalExecutionRecordDigest: null
      };
      const resultDigest = await archive.put(result, "manual-runner-evidence.v1");
      const scoped = fieldsFrom(request, [
        "sessionId",
        "sessionNonce",
        "operationId",
        "idempotencyKey"
      ]);
      const post = await session.record(
        "post-state",
        record("post-state", {
          ...scoped,
          requestDigest,
          consumptionRecordDigest: sha256Canonical(consumption),
          outcome: "OBSERVED",
          observationDigest,
          observedAt: reopened.observedAt,
          reasonCode: null
        })
      );
      const execution = await session.record(
        "execution",
        record("execution", {
          ...scoped,
          attemptId: request.attemptId,
          requestDigest,
          authorizationDigest: sha256Canonical(authorization),
          consumptionRecordDigest: sha256Canonical(consumption),
          handoffRecordDigest: null,
          handoffReadbackDigest: null,
          postStateRecordDigest: post.recordDigest,
          predecessorExecutionRecordDigest: null,
          startedAt,
          finishedAt,
          status: "SUCCEEDED",
          reasonCode: null,
          resultDigest,
          processEvidenceDigest: null
        })
      );
      await custody(execution.recordDigest, "record");
      await recheckResources();
      // Baseline E references the verified build's canonical archive object,
      // not its differently formatted fixed input bytes.
      const verifiedProof = JSON.parse(fixed.proofBytes);
      if (sha256Canonical(verifiedProof) !== facts.build.buildProofDigest)
        fail("MANUAL_EVIDENCE_BINDING_MISMATCH");
      try {
        if (
          !(await archive.get(facts.build.buildProofDigest)).bytes.equals(
            encodeManualJson(verifiedProof)
          )
        )
          fail("MANUAL_STORAGE_UNVERIFIED");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await archive.put(verifiedProof, "build-proof.v1");
      }
      const baseline = buildManualBaseline({
        request,
        trustedBuildDecision: facts.build,
        targetObservation: reopened,
        roleObservation: reopened.roleObservation,
        preState: reopened.catalog,
        authorizationDigest: sha256Canonical(authorization)
      });
      const baselineDigest = await archive.put(baseline, "manual-baseline-manifest.v1");
      await custody(baselineDigest, "r2-artifact");
      await recheck();
      return Object.freeze({ observation: reopened, readbackDigest: readback.recordDigest });
    } finally {
      secret.bytes.fill(0);
      await secret.close();
    }
  } finally {
    try {
      await database?.close();
    } finally {
      if (credential) {
        credential.password = "";
        credential.username = "";
      }
      credential = null;
    }
  }
}

// Fixed private SQL is compared with captured bytes; never executed by this reader.
async function readH3Inputs(fixed, profile, principal, recheckOwner, work) {
  let inputs,
    verified = false;
  try {
    inputs = await openManualH3AInputs({ fixed, profile, principal });
    const { approval, readback, targetContext } = inputs.context;
    await recheckOwner();
    const recheckInputs = async () => {
      await inputs.recheck();
      await recheckOwner();
    };
    await observeH3Resources(approval, readback, recheckInputs);
    const current = await readFixedManualOperation({
      repoRoot,
      operationRef: fixed.operation.operationRef
    });
    if (
      current.indexDigest !== fixed.indexDigest ||
      !current.proofBytes.equals(fixed.proofBytes) ||
      !current.materialBytes.equals(fixed.materialBytes)
    )
      fail("MANUAL_OPERATION_INPUT_UNAVAILABLE");
    await recheckInputs();
    verified = true;
    return await work({
      targetContext,
      h3InputBytes: inputs.bytes.map((bytes) => Buffer.from(bytes)),
      recheck: recheckInputs,
      recheckResources: () => observeH3Resources(approval, readback, recheckInputs)
    });
  } catch (cause) {
    if (verified) throw cause;
    throw Object.assign(new Error("H3_INPUT_UNAVAILABLE", { cause }), {
      code: "H3_INPUT_UNAVAILABLE"
    });
  } finally {
    await inputs?.close();
  }
}

// Fixed, nonsecret projections. Never collect Docker's whole Config/Env or commands
// (which can contain credentials), nor execute the human operation-sheet text.
const h3MarkerLabel = "subscription-stage1-manual-marker";
const h3DockerFormats = Object.freeze({
  container:
    '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"privileged":{{json .HostConfig.Privileged}},"marker":{{json (index .Config.Labels "' +
    h3MarkerLabel +
    '")}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"networks":{ {{$sep := ""}}{{range $name, $network := .NetworkSettings.Networks}}{{$sep}}{{json $name}}:{"NetworkID":{{json $network.NetworkID}},"IPAddress":{{json $network.IPAddress}},"GlobalIPv6Address":{{json $network.GlobalIPv6Address}}}{{$sep = ","}}{{end}} },"ports":{{json .NetworkSettings.Ports}},"portBindings":{{json .HostConfig.PortBindings}},"pgdata":[{{$sep := ""}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "PGDATA"}}{{$sep}}{{eq . "PGDATA=/var/lib/postgresql/data"}}{{$sep = ","}}{{end}}{{end}}],"defaultEntrypoint":{{eq (json .Config.Entrypoint) "[\\"docker-entrypoint.sh\\"]"}},"defaultCommand":{{eq (json .Config.Cmd) "[\\"postgres\\"]"}}}',
  volume:
    '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"mountpoint":{{json .Mountpoint}},"optionsEmpty":{{not .Options}},"marker":{{json (index .Labels "' +
    h3MarkerLabel +
    '")}}}',
  image: '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}}}'
});

async function dockerObservation(kind, reference, recheck) {
  const daemon =
    process.platform === "win32"
      ? "npipe:////./pipe/docker_engine"
      : process.platform === "linux"
        ? "unix:///var/run/docker.sock"
        : null;
  if (!daemon) fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  const args =
    kind === "users"
      ? [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `volume=${reference}`,
          "--format",
          "{{.ID}}"
        ]
      : [kind, "inspect", "--format", h3DockerFormats[kind], "--", reference];
  // Ignore DOCKER_HOST/CONTEXT/TLS, HOME, PostgreSQL and arbitrary inherited env.
  // Host/principal trust is established by H1, not selected by this invocation.
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR"])
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  const result = await new Promise((resolve) => {
    try {
      childProcess.execFile(
        "docker",
        ["--host", daemon, ...args],
        {
          shell: false,
          windowsHide: true,
          encoding: "buffer",
          timeout: 10000,
          maxBuffer: 1048576,
          env
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })
      );
    } catch {
      resolve({ error: true });
    }
  });
  await recheck();
  if (
    result.error ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length > 1048576 ||
    result.stderr.length > 1048576 ||
    result.stderr.length
  )
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    return kind === "users" ? text : JSON.parse(text);
  } catch {
    // Do not retain raw daemon errors, which may contain private host information.
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  }
}

async function observeH3Resources(approval, readback, recheck) {
  const spec = approval.creationSpec,
    cluster = readback.cluster;
  // DNS/proxy/wildcard paths require a separately proven mapping. This initial
  // implementation admits only an exact loopback publication on the H1 host.
  const endpoint = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/u.exec(spec.endpoint);
  if (
    !endpoint ||
    Number(endpoint[2]) > 65535 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(spec.dataVolumeName)
  )
    fail("MANUAL_H3_RESOURCE_INPUT_REQUIRED");
  const host = endpoint[1] === "[::1]" ? "::1" : endpoint[1];
  const mismatch = () => fail("MANUAL_H3_RESOURCE_MISMATCH");
  const snapshot = async () => {
    const container = await dockerObservation("container", cluster.databaseContainerId, recheck);
    if (
      !container ||
      container.id !== cluster.databaseContainerId ||
      container.name !== "/" + spec.databaseContainerName ||
      container.running !== true ||
      container.paused !== false ||
      container.restarting !== false ||
      container.dead !== false ||
      container.privileged !== false ||
      container.marker !== spec.marker ||
      !/^sha256:[0-9a-f]{64}$/u.test(container.imageId) ||
      typeof container.imageReference !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*@sha256:[0-9a-f]{64}$/u.test(container.imageReference) ||
      !container.imageReference.endsWith("@" + spec.postgresImageDigest) ||
      container.defaultEntrypoint !== true ||
      container.defaultCommand !== true ||
      !Array.isArray(container.pgdata) ||
      container.pgdata.length !== 1 ||
      container.pgdata[0] !== true ||
      !Array.isArray(container.mounts) ||
      !container.networks ||
      typeof container.networks !== "object" ||
      Array.isArray(container.networks)
    )
      mismatch();
    const mounts = container.mounts.filter(
      (item) => item?.Destination === "/var/lib/postgresql/data"
    );
    if (
      mounts.length !== 1 ||
      mounts[0].Type !== "volume" ||
      mounts[0].Name !== spec.dataVolumeName ||
      mounts[0].RW !== true ||
      typeof mounts[0].Source !== "string"
    )
      mismatch();
    for (const mount of container.mounts) {
      if (mount === mounts[0]) continue;
      const dest = mount?.Destination;
      if (
        typeof dest !== "string" ||
        !dest.startsWith("/") ||
        dest === "/" ||
        "/var/lib/postgresql/data".startsWith(dest + "/") ||
        dest.startsWith("/var/lib/postgresql/data/") ||
        mount.RW !== false
      )
        mismatch();
    }
    const expectedPorts = { [`${spec.serverPort}/tcp`]: [{ HostIp: host, HostPort: endpoint[2] }] };
    if (
      sha256Canonical(container.ports) !== sha256Canonical(expectedPorts) ||
      sha256Canonical(container.portBindings) !== sha256Canonical(expectedPorts)
    )
      mismatch();
    const networks = Object.entries(container.networks);
    if (networks.length !== 1) mismatch();
    const [networkName, link] = networks[0];
    if (
      !link ||
      !/^[0-9a-f]{64}$/u.test(link.NetworkID) ||
      ![networkName, link.NetworkID].includes(container.networkMode) ||
      ["host", "none", "default", "bridge"].includes(networkName) ||
      ![link.IPAddress, link.GlobalIPv6Address].includes(cluster.serverAddress)
    )
      mismatch();
    const volume = await dockerObservation("volume", spec.dataVolumeName, recheck);
    if (
      !volume ||
      volume.name !== spec.dataVolumeName ||
      volume.driver !== "local" ||
      volume.scope !== "local" ||
      volume.mountpoint !== mounts[0].Source ||
      volume.optionsEmpty !== true ||
      volume.marker !== spec.marker
    )
      mismatch();
    const image = await dockerObservation("image", container.imageId, recheck);
    if (
      !image ||
      image.id !== container.imageId ||
      !Array.isArray(image.repoDigests) ||
      !image.repoDigests.includes(container.imageReference)
    )
      mismatch();
    const network = await dockerObservation("network", link.NetworkID, recheck);
    if (
      !network ||
      network.id !== link.NetworkID ||
      network.name !== networkName ||
      network.driver !== "bridge" ||
      network.scope !== "local"
    )
      mismatch();
    const users = await dockerObservation("users", spec.dataVolumeName, recheck);
    if (
      users !== cluster.databaseContainerId + "\n" &&
      users !== cluster.databaseContainerId + "\r\n"
    )
      mismatch();
    return { container, volume, image, network, users };
  };
  const first = await snapshot(),
    second = await snapshot();
  if (sha256Canonical(first) !== sha256Canonical(second)) mismatch();
  return second;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  Promise.resolve()
    .then(() => {
      const argv = process.argv.slice(2);
      if (
        argv.length !== 2 ||
        argv[0] !== "--operation-ref" ||
        !uuid.test(argv[1] ?? "") ||
        process.env.RUNNER_LAUNCH_ENVELOPE_FILE !== undefined ||
        process.env.RUNNER_EXECUTION_MODE !== undefined
      )
        fail("MANUAL_LAUNCH_INVOCATION_REJECTED");
      return launchManualStage1({ operationRef: argv[1] });
    })
    .catch((error) => {
      process.stderr.write(`${error?.code ?? "MANUAL_LAUNCH_FAILED"}\n`);
      process.exitCode = 1;
    });
}
