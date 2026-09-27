#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import {
  loadFixedManualProfile,
  readFixedManualOperation,
  verifyManualBuild,
  openTrustedManualSession
} from "./manual-stage1-trust.mjs";
import {
  sameIdentity,
  samePublicDirectory,
  observedPath,
  readPinned,
  nativeText,
  ownerOnly,
  checkedPrivatePath,
  h3Oid,
  h3Text,
  h3Instant,
  h3Same,
  h3Require,
  h3Rows,
  h3RoleRows,
  h3Table,
  h3Sources,
  canonicalH3,
  pinPrivateInput,
  openManualH3AInputs
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
  const root = path.join(
      facts.profile.storage.archiveRoot,
      "inputs",
      "operations",
      facts.fixed.operation.operationRef
    ),
    opened = [],
    values = [];
  let sources;
  try {
    for (const name of ["h3-b-approval.json", "h3-b-readback.json"]) {
      let item;
      try {
        item = await pinPrivateInput(path.join(root, name), {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        });
      } catch (cause) {
        if (cause.code === "MANUAL_OPERATION_INPUT_UNAVAILABLE" || cause.code === "ENOENT")
          fail("MANUAL_H3_B_INPUT_REQUIRED");
        throw cause;
      }
      opened.push(item);
      const value = canonicalH3(item.bytes);
      values.push(value);
      if (
        value.operationRef !== facts.fixed.operation.operationRef ||
        value.indexDigest !== facts.fixed.indexDigest ||
        value.runId !== facts.fixed.operation.runId ||
        value.profileDigest !== facts.fixed.operation.profileDigest ||
        value.ownerId !== facts.profile.ownerId ||
        value.promotionEligible !== false ||
        sha256Canonical(value.targetIntent) !==
          sha256Canonical(facts.fixed.operation.targetIntent) ||
        sha256Canonical(value.migration) !== sha256Canonical(migration.migration)
      )
        fail("MANUAL_H3_BINDING_INVALID");
      await item.recheck();
    }
    const [approval, readback] = values,
      [h3AApproval, h3AReadback] = facts.h3InputBytes.map(canonicalH3);
    const common = [
      "operationRef",
      "indexDigest",
      "runId",
      "profileDigest",
      "targetIntent",
      "ownerId",
      "promotionEligible"
    ];
    h3Require(
      exact(approval, [
        "recordVersion",
        ...common,
        "h3AApproval",
        "h3AReadback",
        "approvedAt",
        "expiresAt",
        "branch",
        "migration",
        "preApprovalEvidence",
        "investigationApprovalRef",
        "target",
        "migrationTable",
        "roles",
        "grant",
        "operationSheet"
      ])
    );
    h3Require(
      exact(readback, [
        "recordVersion",
        ...common,
        "approval",
        "migration",
        "target",
        "migrationTable",
        "writerQuiescence",
        "before",
        "grantStartedAt",
        "grantCompletedAt",
        "grantEvidence",
        "after",
        "provisionExit",
        "readbackAt",
        "readbackReport"
      ])
    );
    h3Require(
      approval.recordVersion === "manual-h3-b-approval.v1" &&
        readback.recordVersion === "manual-h3-b-readback.v1" &&
        approval.branch === migration.branch
    );
    h3Require(
      typeof approval.operationSheet === "string" &&
        approval.operationSheet.length > 0 &&
        typeof readback.readbackReport === "string" &&
        readback.readbackReport.length > 0
    );
    h3Require(
      h3Same(approval.h3AApproval, facts.targetContext.h3Approval) &&
        h3Same(approval.h3AReadback, facts.targetContext.h3Readback)
    );
    h3Require(
      h3Same(readback.approval, {
        digest: sha256Bytes(opened[0].bytes),
        bytes: opened[0].bytes.length
      })
    );
    const target = {
      cluster: facts.targetContext.cluster,
      databaseName: facts.fixed.operation.targetIntent.databaseName,
      databaseOid: facts.targetContext.databaseOid
    };
    h3Require(
      h3Same(approval.target, target) &&
        h3Same(readback.target, target) &&
        h3Same(approval.roles, h3AReadback.roles)
    );
    h3Table(approval.migrationTable);
    h3Require(
      h3Same(approval.migrationTable.owner, approval.roles.migrate) &&
        h3Same(readback.migrationTable, approval.migrationTable)
    );
    h3Require(
      h3Same(approval.grant, {
        privileges: ["SELECT"],
        grantees: ["verify", "observer"],
        grantOption: false
      })
    );
    h3Require(
      migration.branch === "normal-success"
        ? approval.investigationApprovalRef === null
        : h3Text(approval.investigationApprovalRef)
    );
    const time = () =>
      h3Require(
        h3Instant(approval.approvedAt) < h3Instant(approval.expiresAt) &&
          h3Instant(approval.expiresAt) <= h3Instant(facts.profile.expiresAt) &&
          h3Instant(approval.approvedAt) <= Date.now() &&
          Date.now() <= h3Instant(approval.expiresAt) &&
          h3Instant(readback.readbackAt) <= Date.now() &&
          h3Instant(readback.readbackAt) <= h3Instant(approval.expiresAt)
      );
    time();
    const context = {
      approval: h3AApproval,
      readback: h3AReadback,
      fixed: facts.fixed,
      table: approval.migrationTable
    };
    sources = await h3Sources(facts.fixed, facts.profile, facts.principal, context);
    h3Require(
      (await sources.raw(approval.h3AApproval)).equals(facts.h3InputBytes[0]) &&
        (await sources.raw(approval.h3AReadback)).equals(facts.h3InputBytes[1]) &&
        (await sources.raw(readback.approval)).equals(opened[0].bytes)
    );
    const pre = await sources.json(approval.preApprovalEvidence);
    h3Require(exact(pre, ["roles", "table", "writerProcess", "writerSessions"]));
    const preRoles = await sources.capture(pre.roles, "roles", "observer"),
      preTable = await sources.capture(pre.table, "roles", "observer"),
      preSessions = await sources.capture(pre.writerSessions, "sessions", "observer");
    const knownRoles = h3RoleRows(preRoles.native.data, approval.roles);
    context.provisionMemberships = preRoles.native.data.memberships
      .filter((row) => row[1] === approval.roles.provision.oid)
      .map((row) => ({ oid: row[0], name: knownRoles.get(row[0])[1] }))
      .sort((left, right) => (BigInt(left.oid) < BigInt(right.oid) ? -1 : 1));
    h3Table(preRoles.native.data.migrationTable, approval.migrationTable);
    h3Table(preTable.native.data.migrationTable, approval.migrationTable);
    const processRef = {
      digest: migration.migration.processEvidenceDigest,
      bytes: encodeManualJson(migration.process).length
    };
    h3Require(
      h3Same(pre.writerProcess, processRef) &&
        (await sources.raw(pre.writerProcess)).equals(encodeManualJson(migration.process)) &&
        migration.process.closedAt !== null
    );
    for (const capture of [preRoles, preTable, preSessions])
      h3Require(
        h3Instant(migration.process.closedAt) <= h3Instant(capture.native.observedAt) &&
          h3Instant(capture.value.recordedAt) <= h3Instant(approval.approvedAt)
      );
    const writerCount = (capture) =>
      capture.native.data.sessions.filter(
        (row) => row[1] === target.databaseOid && row[2] === approval.roles.migrate.oid
      ).length;
    h3Require(writerCount(preSessions) === 0);
    const quiescence = readback.writerQuiescence;
    h3Require(
      exact(quiescence, [
        "observedAt",
        "containerId",
        "containerState",
        "processEvidence",
        "databaseSessions",
        "sessionReadback"
      ]) &&
        quiescence.containerId === migration.request.containerId &&
        quiescence.containerState === "exited" &&
        quiescence.databaseSessions === 0 &&
        h3Same(quiescence.processEvidence, processRef)
    );
    h3Require(
      (await sources.raw(quiescence.processEvidence)).equals(encodeManualJson(migration.process))
    );
    h3Require(
      migration.execution.processEvidenceDigest === migration.migration.processEvidenceDigest
    );
    const finalFile = path.join(
        root,
        "runner-launch",
        migration.request.attemptId,
        "final-inspect.stdout"
      ),
      final = await pinPrivateInput(finalFile, {
        principal: facts.principal,
        privateRoot: facts.profile.storage.archiveRoot
      });
    let finalSnapshot;
    try {
      let inspected;
      try {
        inspected = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(final.bytes));
      } catch {
        fail("MANUAL_H3_FORMAT_INVALID");
      }
      h3Require(
        inspected.id === migration.request.containerId &&
          inspected.running === false &&
          inspected.paused === false &&
          inspected.restarting === false &&
          inspected.dead === false
      );
      await sources.raw({ digest: sha256Bytes(final.bytes), bytes: final.bytes.length });
      await final.recheck();
      finalSnapshot = {
        bytes: Buffer.from(final.bytes),
        chain: await checkedPrivatePath(finalFile, {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        })
      };
    } finally {
      await final.close();
    }
    const runnerLaunchRoot = path.dirname(path.dirname(finalFile));
    const finalRecheck = async () => {
      const item = await pinPrivateInput(finalFile, {
        principal: facts.principal,
        privateRoot: facts.profile.storage.archiveRoot
      });
      try {
        await item.recheck();
        const chain = await checkedPrivatePath(finalFile, {
          principal: facts.principal,
          privateRoot: facts.profile.storage.archiveRoot
        });
        h3Require(
          item.bytes.equals(finalSnapshot.bytes) &&
            chain.length === finalSnapshot.chain.length &&
            chain.every(
              (entry, index) =>
                entry.path === finalSnapshot.chain[index].path &&
                (entry.path === runnerLaunchRoot
                  ? samePublicDirectory(entry.stat, finalSnapshot.chain[index].stat)
                  : entry.path === facts.profile.storage.archiveRoot ||
                      entry.path.startsWith(facts.profile.storage.archiveRoot + path.sep)
                    ? sameIdentity(
                        entry.stat,
                        finalSnapshot.chain[index].stat,
                        index === chain.length - 1
                      )
                    : samePublicDirectory(entry.stat, finalSnapshot.chain[index].stat))
            )
        );
      } finally {
        await item.close();
      }
    };
    const stoppedSessions = await sources.capture(
      quiescence.sessionReadback,
      "sessions",
      "observer"
    );
    h3Require(
      writerCount(stoppedSessions) === 0 &&
        quiescence.observedAt === stoppedSessions.native.observedAt &&
        h3Instant(migration.process.closedAt) <= h3Instant(stoppedSessions.native.observedAt)
    );
    const permissions = async (value, after) => {
      h3Require(
        exact(value, ["observedAt", "source", "roles"]) &&
          Array.isArray(value.roles) &&
          value.roles.length === 2
      );
      const refs = await sources.json(value.source);
      h3Require(exact(refs, ["verify", "observer"]));
      const captures = [];
      for (const [index, kind] of ["verify", "observer"].entries()) {
        const capture = await sources.capture(refs[kind], "privileges", kind),
          declared = value.roles[index];
        let selectReadback = null;
        if (after) {
          selectReadback = declared.selectReadback;
          const selected = await sources.capture(selectReadback, "migrations", kind);
          captures.push(selected);
          if (migration.branch === "normal-success") {
            h3Require(
              migration.postObservation?.catalog.migrationTableOid === approval.migrationTable.oid
            );
            const rows = migration.postObservation.catalog.migrationRows.map((row) => {
              h3Require(
                typeof row.checksum === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.checksum)
              );
              return [
                row.id,
                row.migrationName,
                row.checksum.slice(7),
                row.startedAt,
                row.finishedAt,
                row.rolledBackAt,
                row.appliedStepsCount
              ];
            });
            h3Require(h3Same(selected.native.data.rows, rows));
          }
        }
        h3Require(h3Same(declared, h3Permission(capture, kind, context, after, selectReadback)));
        captures.push(capture);
      }
      h3Require(
        h3Instant(value.observedAt) ===
          Math.max(...captures.map((capture) => h3Instant(capture.native.observedAt)))
      );
      return captures;
    };
    const before = await permissions(readback.before, false),
      after = await permissions(readback.after, true),
      grant = await sources.capture(readback.grantEvidence, "grant", "provision");
    const exit = readback.provisionExit;
    h3Require(
      exact(exit, [
        "identity",
        "revokedAt",
        "canLogin",
        "superuser",
        "createdb",
        "createrole",
        "replication",
        "bypassrls",
        "memberships",
        "process",
        "observedAt",
        "activeSessions",
        "credentialState",
        "roleReadback",
        "sessionReadback",
        "processReadback",
        "credentialStateReadback"
      ])
    );
    h3Require(
      h3Same(exit.identity, approval.roles.provision) &&
        ["canLogin", "superuser", "createdb", "createrole", "replication", "bypassrls"].every(
          (key) => exit[key] === false
        ) &&
        h3Same(exit.memberships, []) &&
        exit.activeSessions === 0
    );
    const host = await sources.json(exit.processReadback);
    h3Require(
      exact(host, ["process", "grant", "revoke"]) &&
        h3Same(host.process, exit.process) &&
        h3Same(host.grant, readback.grantEvidence)
    );
    const parent = host.process;
    h3Require(
      exact(parent, ["pid", "startedAt", "closedAt", "exitCode", "signal"]) &&
        Number.isSafeInteger(parent.pid) &&
        parent.pid > 0 &&
        parent.exitCode === 0 &&
        parent.signal === null
    );
    const revoke = await sources.capture(host.revoke, "revoke", "provision"),
      exitRoles = await sources.capture(exit.roleReadback, "roles", "observer"),
      exitSessions = await sources.capture(exit.sessionReadback, "sessions", "observer");
    const role = h3RoleRows(exitRoles.native.data, approval.roles).get(
      approval.roles.provision.oid
    );
    h3Require(
      role.slice(2, 8).every((value) => value === false) &&
        !exitRoles.native.data.memberships.some((row) => row[1] === role[0]) &&
        exitSessions.native.data.sessions.filter((row) => row[2] === role[0]).length === 0
    );
    const status = await sources.json(exit.credentialStateReadback);
    h3Require(
      exact(status, ["observedAt", "operationRef", "state", "stat"]) &&
        status.operationRef === facts.fixed.operation.operationRef &&
        status.state === exit.credentialState &&
        ["SEALED_RETAINED", "REMOVED"].includes(status.state)
    );
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
    await credentialState();
    const chain = [
      approval.approvedAt,
      readback.before.observedAt,
      readback.grantStartedAt,
      readback.grantCompletedAt,
      readback.after.observedAt,
      exit.revokedAt,
      parent.closedAt,
      exit.observedAt,
      readback.readbackAt
    ].map(h3Instant);
    h3Require(
      chain.every((at, index) => Number.isFinite(at) && (index === 0 || chain[index - 1] <= at)) &&
        h3Instant(approval.approvedAt) <= h3Instant(parent.startedAt) &&
        h3Instant(parent.startedAt) <= h3Instant(readback.grantStartedAt)
    );
    h3Require(
      readback.grantStartedAt === grant.value.spawnedAt &&
        readback.grantCompletedAt === grant.value.closedAt &&
        exit.revokedAt === revoke.value.closedAt
    );
    for (const capture of before)
      h3Require(
        h3Instant(approval.approvedAt) <= h3Instant(capture.value.preparedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(grant.value.spawnedAt)
      );
    for (const capture of after)
      h3Require(
        h3Instant(grant.value.closedAt) <= h3Instant(capture.value.spawnedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(revoke.value.spawnedAt)
      );
    for (const capture of [grant, revoke])
      h3Require(
        capture.value.parentPid === parent.pid &&
          h3Instant(parent.startedAt) <= h3Instant(capture.value.preparedAt) &&
          h3Instant(capture.value.closedAt) <= h3Instant(parent.closedAt)
      );
    for (const capture of [exitRoles, exitSessions])
      h3Require(
        h3Instant(parent.closedAt) <= h3Instant(capture.value.spawnedAt) &&
          h3Instant(capture.native.observedAt) <= h3Instant(exit.observedAt)
      );
    h3Require(
      h3Instant(parent.closedAt) <= h3Instant(status.observedAt) &&
        h3Instant(status.observedAt) <= h3Instant(exit.observedAt)
    );
    for (const capture of [
      preRoles,
      preTable,
      preSessions,
      stoppedSessions,
      ...before,
      ...after,
      grant,
      revoke,
      exitRoles,
      exitSessions
    ])
      h3Require(h3Instant(capture.value.recordedAt) <= h3Instant(readback.readbackAt));
    const recheck = async () => {
      time();
      for (const item of opened) await item.recheck();
      await finalRecheck();
      await sources.recheck();
      await credentialState();
      await facts.recheck();
    };
    await recheck();
    const archive = targetArchive(facts);
    for (const item of opened.slice(0, 2)) {
      const ref = await archive.raw(item.bytes);
      h3Require((await sources.raw(ref)).equals(item.bytes));
    }
    await recheck();
    return await work({ ...facts, recheck });
  } finally {
    await sources?.close();
    for (const item of opened) await item.close();
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
  const read = async (file, root) => {
    const item = await pinPrivateInput(file, { principal, privateRoot: root });
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(item.bytes));
      if (!encodeManualJson(value).equals(item.bytes)) fail("MANUAL_STORAGE_UNVERIFIED");
      await item.recheck();
      return { value, bytes: Buffer.from(item.bytes) };
    } finally {
      await item.close();
    }
  };
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
const expectedLimit = 1048576;
const expectedBucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const expectedAccount = "1457643390906675";
const expectedPgDigest = "sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const expectedSchemaPath = "apps/api/prisma/schema.prisma",
  expectedConfigPath = "apps/api/prisma.config.ts";
const expectedPrisma = "/app/apps/release-runner/node_modules/.bin/prisma";
const expectedRole = "expected_schema_owner",
  expectedDatabase = "expected_schema_reference";
const expectedProcessKeys = [
  "tool",
  "argv",
  "stdout",
  "stderr",
  "pid",
  "preparedAt",
  "spawnedAt",
  "closedAt",
  "exitCode",
  "signal"
];
const expectedCreationTools = [
  "container-create",
  "container-inspect",
  "image-inspect",
  "node-version",
  "psql-version",
  "initdb",
  "pg-start",
  "database-create",
  "identity-before"
];
const expectedReadbackTools = [
  "identity-after",
  "migration-readback",
  "pg-stop",
  "container-exit-inspect",
  "container-stop",
  "container-remove"
];
const expectedPrismaTools = ["prisma-version", "prisma-deploy", "prisma-diff", "prisma-script"];
const expectedBucketTools = [
  "GetBucketAcl",
  "GetBucketWorm",
  "GetBucketVersioning",
  "GetBucketEncryption",
  "GetBucketPolicyStatus",
  "GetBucketPublicAccessBlock"
];
const expectedHeaderKeys = [
  "date",
  "x-oss-request-id",
  "content-length",
  "last-modified",
  "etag",
  "x-oss-server-side-encryption",
  "content-type"
];
function expectedRequire(value, code = "MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID") {
  if (!value) fail(code);
}
function expectedDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
function expectedTime(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function expectedOrder(times) {
  return times.every(expectedTime) && times.every((v, i) => i === 0 || times[i - 1] <= v);
}
function expectedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= expectedLimit;
}
function expectedText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  }
}
function expectedJson(bytes, canonical = false) {
  expectedRequire(
    Buffer.isBuffer(bytes) && bytes.length <= expectedLimit,
    "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
  );
  let value;
  try {
    value = JSON.parse(expectedText(bytes));
  } catch {
    fail("MANUAL_EXPECTED_SCHEMA_JSON_INVALID");
  }
  // encodeManualJson rejects invalid Unicode, undefined values and unsafe data.
  const encoded = encodeManualJson(value);
  expectedRequire(
    encoded.length <= expectedLimit && (!canonical || encoded.equals(bytes)),
    "MANUAL_EXPECTED_SCHEMA_JSON_INVALID"
  );
  return value;
}
function expectedEqual(a, b) {
  return encodeManualJson(a).equals(encodeManualJson(b));
}
function expectedRawRef(ref) {
  expectedRequire(
    exact(ref, ["digest", "bytes"]) &&
      expectedDigest(ref.digest) &&
      Number.isSafeInteger(ref.bytes) &&
      ref.bytes >= 0 &&
      ref.bytes <= expectedLimit,
    "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
  );
  return ref;
}
function expectedPrismaArgv(tool) {
  const args = {
    "prisma-version": ["--version"],
    "prisma-deploy": [
      "migrate",
      "deploy",
      "--schema",
      "/app/" + expectedSchemaPath,
      "--config",
      "/app/" + expectedConfigPath
    ],
    "prisma-diff": [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "/app/" + expectedSchemaPath,
      "--exit-code",
      "--config",
      "/app/" + expectedConfigPath
    ],
    "prisma-script": [
      "migrate",
      "diff",
      "--from-empty",
      "--to-config-datasource",
      "--script",
      "--config",
      "/app/" + expectedConfigPath
    ]
  };
  return [expectedPrisma, ...args[tool]];
}
const expectedContainerFormat =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"user":{{json .Config.User}},"network":{{json .HostConfig.NetworkMode}},"binds":{{json .HostConfig.Binds}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"source":{{json $m.Source}},"destination":{{json $m.Destination}}}{{end}}],"tmpfs":{{json .HostConfig.Tmpfs}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"status":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}';
const expectedImageFormat =
  '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}';
const expectedIdentitySql = `SELECT json_build_object(
 'databaseName', current_database(),
 'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
 'serverVersion', current_setting('server_version'),
 'schemaOwner', (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public'),
 'ownerInventory', (SELECT coalesce(json_agg(i ORDER BY i."objectClass",i."objectName"),'[]'::json) FROM (
   SELECT 'schema'::text AS "objectClass", nspname::text AS "objectName", nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname='public'
   UNION ALL SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,c.relname::text,c.relowner::regrole::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
 ) i),
 'extensions', (SELECT coalesce(json_agg(extname ORDER BY extname),'[]'::json) FROM pg_extension),
 'listenAddresses', current_setting('listen_addresses'),
 'socketDirectory', current_setting('unix_socket_directories'),
 'dataDirectory', current_setting('data_directory'),
 'configuredPort', current_setting('port')::integer)::text`;
const expectedMigrationsSql = `SELECT coalesce(json_agg(m ORDER BY m.name),'[]'::json)::text FROM (
 SELECT migration_name::text AS name,checksum::text AS checksum,finished_at IS NOT NULL AS finished,
 rolled_back_at IS NOT NULL AS "rolledBack",applied_steps_count AS "appliedSteps" FROM public._prisma_migrations
) m`;

async function expectedCheckoutPin(relative) {
  const file = path.join(repoRoot, ...relative.split("/")),
    chain = await observedPath(file),
    handle = await fs.open(file, "r");
  try {
    const captured = await readPinned(handle, chain.at(-1).stat);
    const recheck = async () => {
      const current = await observedPath(file);
      expectedRequire(
        current.length === chain.length &&
          current.every(
            (v, i) =>
              v.path === chain[i].path &&
              (i === current.length - 1 ||
              v.path === repoRoot ||
              v.path.startsWith(repoRoot + path.sep)
                ? sameIdentity(v.stat, chain[i].stat)
                : samePublicDirectory(v.stat, chain[i].stat))
          ),
        "MANUAL_OPERATION_INPUT_UNAVAILABLE"
      );
      expectedRequire(
        (await readPinned(handle, captured.stat)).bytes.equals(captured.bytes),
        "MANUAL_OPERATION_INPUT_UNAVAILABLE"
      );
      const independent = await fs.open(file, "r");
      try {
        expectedRequire(
          (await readPinned(independent, captured.stat)).bytes.equals(captured.bytes),
          "MANUAL_OPERATION_INPUT_UNAVAILABLE"
        );
      } finally {
        await independent.close();
      }
    };
    await recheck();
    return { bytes: captured.bytes, recheck, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function expectedProvenanceShape(p, facts, proof) {
  expectedRequire(
    exact(p, [
      "recordVersion",
      "buildProofDigest",
      "proofRaw",
      "sourceSha",
      "ci",
      "sourceSchema",
      "config",
      "lockfile",
      "migrationCatalogDigest",
      "toolchain",
      "expectedScript",
      "references",
      "generatedAt",
      "promotionEligible"
    ])
  );
  const runMatch =
    /^https:\/\/github\.com\/keqi119\/subscription-Saas\/actions\/runs\/([1-9][0-9]*)$/u.exec(
      proof.provenance.ciRunRef
    );
  expectedRequire(runMatch && Number.isSafeInteger(Number(runMatch[1])));
  expectedRequire(
    p.recordVersion === "manual-expected-schema-provenance.v1" &&
      p.buildProofDigest === facts.build.buildProofDigest &&
      expectedEqual(expectedRawRef(p.proofRaw), {
        digest: facts.build.proofRawDigest,
        bytes: facts.fixed.proofBytes.length
      }) &&
      p.sourceSha === proof.identity.sourceSha &&
      /^[0-9a-f]{40}$/u.test(p.sourceSha) &&
      p.migrationCatalogDigest === proof.identity.migrationCatalogDigest &&
      expectedTime(p.generatedAt) &&
      Date.parse(p.generatedAt) <= Date.now() &&
      p.promotionEligible === false
  );
  expectedRequire(
    exact(p.ci, [
      "repository",
      "workflowPath",
      "sourceRef",
      "runId",
      "runAttempt",
      "runnerClass"
    ]) &&
      expectedEqual(p.ci, {
        repository: "keqi119/subscription-Saas",
        workflowPath: ".github/workflows/docker-images.yml",
        sourceRef: "refs/heads/main",
        runId: runMatch[1],
        runAttempt: 1,
        runnerClass: "github-hosted"
      })
  );
  for (const [key, location] of [
    ["sourceSchema", expectedSchemaPath],
    ["config", expectedConfigPath],
    ["lockfile", "pnpm-lock.yaml"]
  ]) {
    expectedRequire(exact(p[key], ["path", "raw"]) && p[key].path === location);
    expectedRawRef(p[key].raw);
  }
  expectedRequire(
    exact(p.toolchain, [
      "runnerImageDigest",
      "postgresImageDigest",
      "nodeVersion",
      "postgresqlVersion",
      "prismaVersion",
      "prismaVersionRaw"
    ]) &&
      p.toolchain.runnerImageDigest === proof.identity.images.runner.imageDigest &&
      p.toolchain.postgresImageDigest === expectedPgDigest &&
      proof.provenance.baseImages.some(
        (v) => v.name === "postgres:17.11-bookworm" && v.resolvedDigest === expectedPgDigest
      ) &&
      /^v22\.\d+\.\d+$/u.test(p.toolchain.nodeVersion) &&
      /^17\.11(?: \([^()]+\))?$/u.test(p.toolchain.postgresqlVersion) &&
      expectedString(p.toolchain.prismaVersion) &&
      /^prisma\s*:\s*7\.8\.0\s*$/mu.test(p.toolchain.prismaVersion) &&
      p.toolchain.prismaVersion.includes("\n")
  );
  expectedRawRef(p.toolchain.prismaVersionRaw);
  expectedRawRef(p.expectedScript);
  expectedRequire(
    p.expectedScript.bytes > 0 && Array.isArray(p.references) && p.references.length === 2
  );
  return runMatch[1];
}
async function expectedReference(reference, p, raw, proof, target, catalog, extensions) {
  expectedRequire(
    exact(reference, [
      "referenceRunId",
      "identity",
      "createdAt",
      "readbackAt",
      "creationEvidence",
      "readbackEvidence",
      "migrationCatalog",
      "migrationHead",
      "migrationOwner",
      "allowedExtensions",
      "calls"
    ]) && uuid.test(reference.referenceRunId)
  );
  const r = reference,
    c = r.identity?.cluster;
  expectedRequire(
    exact(r.identity, ["cluster", "databaseName", "databaseOid"]) &&
      exact(c, [
        "systemIdentifier",
        "databaseContainerId",
        "runnerImageDigest",
        "postgresImageDigest",
        "dataDirectory",
        "socketDirectory",
        "listenAddresses",
        "configuredPort"
      ])
  );
  expectedRequire(typeof c.dataDirectory === "string");
  const root = path.posix.dirname(c.dataDirectory);
  expectedRequire(
    /^[1-9][0-9]*$/u.test(c.systemIdentifier) &&
      BigInt(c.systemIdentifier) <= 18446744073709551615n &&
      /^[0-9a-f]{64}$/u.test(c.databaseContainerId) &&
      /^[1-9][0-9]*$/u.test(r.identity.databaseOid) &&
      r.identity.databaseName === expectedDatabase &&
      c.runnerImageDigest === p.toolchain.runnerImageDigest &&
      c.postgresImageDigest === p.toolchain.postgresImageDigest &&
      /^\/tmp\/manual-schema-reference-[a-zA-Z0-9_-]+$/u.test(root) &&
      c.dataDirectory === root + "/data" &&
      c.socketDirectory === root + "/socket" &&
      c.listenAddresses === "" &&
      c.configuredPort === 5432 &&
      !(
        c.systemIdentifier === target.cluster.systemIdentifier &&
        r.identity.databaseOid === target.databaseOid
      ) &&
      expectedOrder([r.createdAt, r.readbackAt, p.generatedAt])
  );
  const creation = expectedJson(await raw(r.creationEvidence), true),
    readback = expectedJson(await raw(r.readbackEvidence), true);
  for (const [v, version, tools] of [
    [creation, "manual-expected-reference-creation.v1", expectedCreationTools],
    [readback, "manual-expected-reference-readback.v1", expectedReadbackTools]
  ])
    expectedRequire(
      exact(v, ["recordVersion", "referenceRunId", "calls"]) &&
        v.recordVersion === version &&
        v.referenceRunId === r.referenceRunId &&
        Array.isArray(v.calls) &&
        v.calls.length === tools.length
    );
  expectedRequire(Array.isArray(r.calls) && r.calls.length === 4);
  const captured = new Map();
  for (const [calls, tools] of [
    [creation.calls, expectedCreationTools],
    [r.calls, expectedPrismaTools],
    [readback.calls, expectedReadbackTools]
  ]) {
    let previous;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      expectedRequire(
        exact(call, expectedProcessKeys) &&
          call.tool === tools[i] &&
          Number.isSafeInteger(call.pid) &&
          call.pid > 0 &&
          call.exitCode === 0 &&
          call.signal === null &&
          expectedOrder([
            ...(previous ? [previous] : []),
            call.preparedAt,
            call.spawnedAt,
            call.closedAt,
            p.generatedAt
          ]),
        "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
      );
      previous = call.closedAt;
      const argv = expectedJson(await raw(call.argv), true),
        stdout = await raw(call.stdout),
        stderr = await raw(call.stderr);
      expectedRequire(
        Array.isArray(argv) && argv.length > 0 && argv.every((v) => typeof v === "string"),
        "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
      );
      expectedText(stdout);
      expectedText(stderr);
      captured.set(call.tool, { call, argv, stdout });
      if (tools === expectedPrismaTools)
        expectedRequire(
          expectedEqual(argv, expectedPrismaArgv(call.tool)) &&
            expectedOrder([
              r.createdAt,
              call.preparedAt,
              call.spawnedAt,
              call.closedAt,
              r.readbackAt
            ]),
          "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
        );
    }
  }
  const get = (tool) => captured.get(tool),
    dockerPrefix = get("container-create").argv.slice(0, 5),
    dockerCommand =
      process.platform === "win32"
        ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"
        : "/usr/bin/docker";
  expectedRequire(
    dockerPrefix[0] === dockerCommand &&
      dockerPrefix[1] === "--host" &&
      dockerPrefix[2] ===
        (process.platform === "win32"
          ? "npipe:////./pipe/docker_engine"
          : "unix:///var/run/docker.sock") &&
      dockerPrefix[3] === "--config" &&
      /^\/tmp\/manual-schema-handoff-[a-zA-Z0-9_-]+\/docker-config$/u.test(dockerPrefix[4]),
    "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID"
  );
  const imageRef = `${proof.identity.images.runner.registry}@${c.runnerImageDigest}`,
    id = c.databaseContainerId;
  const checkArgv = (tool, argv) =>
    expectedRequire(expectedEqual(get(tool).argv, argv), "MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  checkArgv("container-create", [
    ...dockerPrefix,
    "create",
    "--pull=never",
    "--network=none",
    "--user=postgres",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=16m,mode=1777",
    "--interactive",
    "--entrypoint",
    "/usr/local/bin/node",
    imageRef,
    "/app/scripts/release/manual-expected-schema-producer.mjs",
    "--reference"
  ]);
  expectedRequire(expectedText(get("container-create").stdout).trim() === id);
  const container = expectedJson(get("container-inspect").stdout),
    exited = expectedJson(get("container-exit-inspect").stdout),
    image = expectedJson(get("image-inspect").stdout);
  const containerKeys = [
    "id",
    "imageId",
    "imageRef",
    "user",
    "network",
    "binds",
    "mounts",
    "tmpfs",
    "readonly",
    "status",
    "running",
    "exitCode"
  ];
  for (const [v, state] of [
    [container, "created"],
    [exited, "exited"]
  ])
    expectedRequire(
      exact(v, containerKeys) &&
        v.id === id &&
        expectedDigest(v.imageId) &&
        v.imageRef === imageRef &&
        v.user === "postgres" &&
        v.network === "none" &&
        v.readonly === true &&
        (v.binds === null || expectedEqual(v.binds, [])) &&
        Array.isArray(v.mounts) &&
        v.mounts.length <= 2 &&
        v.mounts.every(
          (m) =>
            exact(m, ["type", "source", "destination"]) &&
            m.type === "tmpfs" &&
            m.source === "" &&
            ["/tmp", "/var/lib/postgresql/data"].includes(m.destination)
        ) &&
        expectedEqual(v.tmpfs, {
          "/tmp": "rw,nosuid,nodev,size=512m,mode=1777",
          "/var/lib/postgresql/data": "rw,nosuid,nodev,size=16m,mode=1777"
        }) &&
        v.status === state &&
        v.running === false &&
        v.exitCode === 0
    );
  expectedRequire(
    container.imageId === exited.imageId &&
      exact(image, ["id", "repoDigests", "sourceRevision"]) &&
      image.id === container.imageId &&
      image.sourceRevision === p.sourceSha &&
      Array.isArray(image.repoDigests) &&
      image.repoDigests.every(expectedString) &&
      image.repoDigests.includes(imageRef)
  );
  checkArgv("container-inspect", [
    ...dockerPrefix,
    "container",
    "inspect",
    "--format",
    expectedContainerFormat,
    id
  ]);
  checkArgv("container-exit-inspect", [
    ...dockerPrefix,
    "container",
    "inspect",
    "--format",
    expectedContainerFormat,
    id
  ]);
  checkArgv("image-inspect", [
    ...dockerPrefix,
    "image",
    "inspect",
    "--format",
    expectedImageFormat,
    image.id
  ]);
  checkArgv("container-stop", [...dockerPrefix, "stop", "--time", "10", id]);
  checkArgv("container-remove", [...dockerPrefix, "rm", "--force", "--volumes", id]);
  expectedRequire(expectedText(get("container-remove").stdout).trim() === id);
  checkArgv("node-version", ["/usr/local/bin/node", "--version"]);
  const pg = "/usr/lib/postgresql/17/bin/",
    data = c.dataDirectory,
    socket = c.socketDirectory;
  checkArgv("psql-version", [pg + "psql", "--version"]);
  checkArgv("initdb", [
    pg + "initdb",
    "--pgdata",
    data,
    "--username",
    expectedRole,
    "--encoding=UTF8",
    "--locale=C.UTF-8",
    "--auth-local=trust",
    "--auth-host=reject"
  ]);
  checkArgv("pg-start", [
    pg + "pg_ctl",
    "--pgdata",
    data,
    "--log",
    root + "/server.log",
    "--wait",
    "--timeout=30",
    "--options",
    `-c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c port=5432`,
    "start"
  ]);
  checkArgv("pg-stop", [
    pg + "pg_ctl",
    "--pgdata",
    data,
    "--wait",
    "--timeout=30",
    "--mode=immediate",
    "stop"
  ]);
  const psql = [
    pg + "psql",
    "--no-psqlrc",
    "--no-password",
    "--host",
    socket,
    "--port",
    "5432",
    "--username",
    expectedRole,
    "--dbname",
    expectedDatabase,
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command"
  ];
  checkArgv("database-create", [
    ...psql.map((v) => (v === expectedDatabase ? "postgres" : v)),
    `CREATE DATABASE ${expectedDatabase} OWNER ${expectedRole}`
  ]);
  for (const tool of ["identity-before", "identity-after"])
    checkArgv(tool, [...psql, expectedIdentitySql]);
  checkArgv("migration-readback", [...psql, expectedMigrationsSql]);
  const before = expectedJson(get("identity-before").stdout),
    after = expectedJson(get("identity-after").stdout);
  for (const db of [before, after])
    expectedRequire(
      exact(db, [
        "databaseName",
        "databaseOid",
        "systemIdentifier",
        "serverVersion",
        "schemaOwner",
        "ownerInventory",
        "extensions",
        "listenAddresses",
        "socketDirectory",
        "dataDirectory",
        "configuredPort"
      ]) &&
        db.databaseName === r.identity.databaseName &&
        db.databaseOid === r.identity.databaseOid &&
        db.systemIdentifier === c.systemIdentifier &&
        db.serverVersion === p.toolchain.postgresqlVersion &&
        [expectedRole, "pg_database_owner"].includes(db.schemaOwner) &&
        db.listenAddresses === "" &&
        db.socketDirectory === socket &&
        db.dataDirectory === data &&
        db.configuredPort === 5432 &&
        Array.isArray(db.ownerInventory) &&
        db.ownerInventory.length > 0 &&
        db.ownerInventory.every(
          (v) =>
            exact(v, ["objectClass", "objectName", "owner"]) &&
            ["schema", "relation", "sequence"].includes(v.objectClass) &&
            expectedString(v.objectName) &&
            [expectedRole, "pg_database_owner"].includes(v.owner)
        ) &&
        Array.isArray(db.extensions) &&
        db.extensions.every(expectedString)
    );
  expectedRequire(
    r.migrationOwner === expectedRole &&
      after.ownerInventory.filter(
        (v) =>
          v.objectClass === "relation" &&
          v.objectName === "_prisma_migrations" &&
          v.owner === expectedRole
      ).length === 1 &&
      expectedEqual(after.extensions, extensions) &&
      expectedEqual(r.allowedExtensions, extensions)
  );
  const rows = expectedJson(get("migration-readback").stdout);
  expectedRequire(
    Array.isArray(rows) &&
      rows.length === catalog.entries.length &&
      rows.every(
        (v, i) =>
          exact(v, ["name", "checksum", "finished", "rolledBack", "appliedSteps"]) &&
          v.name === catalog.entries[i].path.split("/").at(-2) &&
          v.checksum === catalog.entries[i].sha256.slice(7) &&
          v.finished === true &&
          v.rolledBack === false &&
          Number.isSafeInteger(v.appliedSteps) &&
          v.appliedSteps >= 1
      )
  );
  const catalogIdentity = {
    catalogVersion: "migration-catalog.v1",
    entries: catalog.entries.map((v) => ({ order: v.order, path: v.path, sha256: v.sha256 }))
  };
  expectedRequire(
    (await raw(r.migrationCatalog)).equals(encodeManualJson(catalogIdentity)) &&
      r.migrationCatalog.digest === p.migrationCatalogDigest &&
      r.migrationHead === rows.at(-1)?.name
  );
  expectedRequire(
    expectedText(get("node-version").stdout).trim() === p.toolchain.nodeVersion &&
      /^psql \(PostgreSQL\) 17\.11(?: \([^()]+\))?$/u.test(
        expectedText(get("psql-version").stdout).trim()
      ) &&
      expectedEqual(get("prisma-version").call.stdout, p.toolchain.prismaVersionRaw) &&
      expectedText(get("prisma-version").stdout).trim() === p.toolchain.prismaVersion &&
      expectedEqual(get("prisma-script").call.stdout, p.expectedScript) &&
      expectedText(get("prisma-diff").stdout).trim() === ""
  );
  expectedRequire(
    r.createdAt === get("database-create").call.closedAt &&
      r.readbackAt === get("migration-readback").call.closedAt &&
      expectedOrder([get("image-inspect").call.closedAt, get("node-version").call.preparedAt]) &&
      expectedOrder([
        get("identity-before").call.closedAt,
        get("prisma-version").call.preparedAt
      ]) &&
      expectedOrder([get("prisma-script").call.closedAt, get("identity-after").call.preparedAt]) &&
      expectedOrder([get("pg-stop").call.closedAt, get("container-exit-inspect").call.preparedAt])
  );
  return {
    ownerInventory: after.ownerInventory,
    stable: {
      migrationCatalog: r.migrationCatalog,
      migrationHead: r.migrationHead,
      migrationOwner: r.migrationOwner,
      allowedExtensions: r.allowedExtensions
    }
  };
}

async function expectedOssImport(imported, p, facts, subjects, raw) {
  expectedRequire(
    exact(imported, [
      "recordVersion",
      "buildProofDigest",
      "proofRawDigest",
      "profileDigest",
      "ownerId",
      "importApprovalRef",
      "importedAt",
      "readbackAt",
      "objects",
      "promotionEligible"
    ]) &&
      imported.recordVersion === "manual-expected-schema-import.v1" &&
      imported.buildProofDigest === facts.build.buildProofDigest &&
      imported.proofRawDigest === facts.build.proofRawDigest &&
      imported.profileDigest === facts.fixed.operation.profileDigest &&
      imported.ownerId === facts.profile.ownerId &&
      expectedString(imported.importApprovalRef) &&
      expectedOrder([imported.importedAt, imported.readbackAt]) &&
      Date.parse(imported.readbackAt) <= Date.now() &&
      imported.promotionEligible === false &&
      Array.isArray(imported.objects) &&
      imported.objects.length === subjects.size
  );
  const reader = `acs:ram::${expectedAccount}:role/subscription-saas-stage1-evidence-audit-reader/stage1-reader-${p.ci.runId}-attempt-1`,
    writer = `acs:ram::${expectedAccount}:role/subscription-saas-stage1-evidence-writer/stage1-writer-${p.ci.runId}-attempt-1`;
  // Resolve the installed strict XML parser only. This does not instantiate an
  // OSS client, load credentials, or contact a storage service.
  const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url)),
    ossRequire = createRequire(apiRequire.resolve("ali-oss")),
    xml = ossRequire("xml2js");
  const httpTime = (v) =>
    typeof v === "string" &&
    Number.isFinite(Date.parse(v)) &&
    new Date(Date.parse(v)).toUTCString() === v;
  const xmlBody = async (body, root) => {
    const source = expectedText(body);
    expectedRequire(!/<!DOCTYPE|<!ENTITY/iu.test(source));
    let parsed;
    try {
      parsed = await xml.parseStringPromise(source, {
        explicitRoot: true,
        explicitArray: false,
        strict: true
      });
    } catch {
      fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
    }
    expectedRequire(exact(parsed, [root]));
    let value = parsed[root];
    if (value && typeof value === "object" && value.$ !== undefined) {
      expectedRequire(
        exact(value.$, ["xmlns"]) && value.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com"
      );
      value = { ...value };
      delete value.$;
    }
    return value;
  };
  const aclBody = async (body) => {
    const v = await xmlBody(body, "AccessControlPolicy");
    expectedRequire(
      exact(v, ["Owner", "AccessControlList"]) &&
        exact(v.Owner, ["ID", "DisplayName"]) &&
        v.Owner.ID === expectedAccount &&
        typeof v.Owner.DisplayName === "string" &&
        exact(v.AccessControlList, ["Grant"]) &&
        v.AccessControlList.Grant === "private"
    );
  };
  let previousDigest = "";
  for (const object of imported.objects) {
    expectedRequire(
      exact(object, [
        "subject",
        "storeRef",
        "writerIdentity",
        "auditReaderIdentity",
        "storedAt",
        "retainUntil",
        "readbackAt",
        "getEvidence",
        "headEvidence",
        "aclEvidence"
      ])
    );
    const subject = expectedRawRef(object.subject),
      bytes = subjects.get(subject.digest);
    expectedRequire(
      bytes &&
        bytes.length === subject.bytes &&
        subject.digest > previousDigest &&
        object.writerIdentity === writer &&
        object.auditReaderIdentity === "audit-reader" &&
        expectedOrder([
          object.storedAt,
          object.readbackAt,
          imported.importedAt,
          imported.readbackAt
        ]) &&
        expectedTime(object.retainUntil)
    );
    previousDigest = subject.digest;
    const key = `evidence/github-${p.ci.runId}-attempt-1/${subject.digest.slice(7)}.json`;
    expectedRequire(object.storeRef === `oss://${expectedBucket}/${key}`);
    const head = expectedJson(await raw(object.headEvidence), true),
      acl = expectedJson(await raw(object.aclEvidence), true),
      get = expectedJson(await raw(object.getEvidence), true);
    expectedRequire(Array.isArray(head?.bucketChecks) && head.bucketChecks.length === 6);
    const bucketRecords = [];
    for (const ref of head.bucketChecks) bucketRecords.push(expectedJson(await raw(ref), true));
    const records = [...bucketRecords, head, acl, get],
      operations = [...expectedBucketTools, "HeadObject", "GetObjectAcl", "GetObject"];
    let previousAt;
    const bodies = new Map();
    for (let i = 0; i < records.length; i++) {
      const v = records[i],
        operation = operations[i],
        isObject = i >= 6;
      expectedRequire(
        exact(v, [
          "recordVersion",
          "operation",
          "bucket",
          "objectKey",
          "readerPrincipal",
          "observedAt",
          "response",
          "bucketChecks"
        ]) &&
          v.recordVersion === "manual-expected-oss-readback.v1" &&
          v.operation === operation &&
          v.bucket === expectedBucket &&
          v.objectKey === (isObject ? key : null) &&
          v.readerPrincipal === reader &&
          expectedOrder([...(previousAt ? [previousAt] : []), v.observedAt, object.readbackAt]) &&
          exact(v.response, ["status", "headers", "body"]) &&
          v.response.status === 200 &&
          exact(v.response.headers, expectedHeaderKeys) &&
          Array.isArray(v.bucketChecks) &&
          (operation === "HeadObject" || v.bucketChecks.length === 0)
      );
      previousAt = v.observedAt;
      const h = v.response.headers,
        body = await raw(v.response.body);
      expectedRequire(
        expectedHeaderKeys.every(
          (name) =>
            h[name] === null ||
            (typeof h[name] === "string" &&
              h[name].length <= 1024 &&
              [...h[name]].every(
                (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
              ))
        ) &&
          httpTime(h.date) &&
          typeof h["x-oss-request-id"] === "string" &&
          /^[A-Za-z0-9-]+$/u.test(h["x-oss-request-id"]) &&
          (h["content-length"] === null ||
            (/^(?:0|[1-9][0-9]*)$/u.test(h["content-length"]) &&
              Number.isSafeInteger(Number(h["content-length"])) &&
              (operation === "HeadObject" || Number(h["content-length"]) === body.length)))
      );
      bodies.set(operation, body);
      if (["GetObject", "HeadObject"].includes(operation))
        expectedRequire(
          h["content-length"] !== null &&
            Number(h["content-length"]) === subject.bytes &&
            httpTime(h["last-modified"]) &&
            typeof h.etag === "string" &&
            h.etag.length > 0 &&
            h["x-oss-server-side-encryption"] === "AES256" &&
            typeof h["content-type"] === "string" &&
            h["content-type"].length > 0 &&
            (operation === "HeadObject" ? body.length === 0 : body.equals(bytes))
        );
    }
    await aclBody(bodies.get("GetBucketAcl"));
    await aclBody(bodies.get("GetObjectAcl"));
    const worm = await xmlBody(bodies.get("GetBucketWorm"), "WormConfiguration");
    expectedRequire(
      exact(worm, ["WormId", "State", "RetentionPeriodInDays", "CreationDate"]) &&
        expectedString(worm.WormId) &&
        worm.State === "Locked" &&
        worm.RetentionPeriodInDays === "210" &&
        typeof worm.CreationDate === "string" &&
        Number.isFinite(Date.parse(worm.CreationDate)) &&
        Date.parse(worm.CreationDate) <= Date.parse(object.storedAt)
    );
    const version = await xmlBody(bodies.get("GetBucketVersioning"), "VersioningConfiguration");
    expectedRequire(
      (typeof version === "string" && version.trim() === "") ||
        ((exact(version, []) || exact(version, ["Status"])) &&
          (version.Status === undefined || version.Status === ""))
    );
    const encryption = await xmlBody(bodies.get("GetBucketEncryption"), "ServerSideEncryptionRule"),
      rule = encryption?.ApplyServerSideEncryptionByDefault;
    expectedRequire(
      exact(encryption, ["ApplyServerSideEncryptionByDefault"]) &&
        rule &&
        typeof rule === "object" &&
        !Array.isArray(rule) &&
        Object.keys(rule).every((k) =>
          ["SSEAlgorithm", "KMSMasterKeyID", "KMSDataEncryption"].includes(k)
        ) &&
        Object.values(rule).every((v) => typeof v === "string") &&
        rule.SSEAlgorithm === "AES256"
    );
    const policy = await xmlBody(bodies.get("GetBucketPolicyStatus"), "PolicyStatus"),
      bpa = await xmlBody(
        bodies.get("GetBucketPublicAccessBlock"),
        "PublicAccessBlockConfiguration"
      );
    expectedRequire(
      exact(policy, ["IsPublic"]) &&
        policy.IsPublic === "false" &&
        exact(bpa, ["BlockPublicAccess"]) &&
        bpa.BlockPublicAccess === "true"
    );
    const headers = head.response.headers;
    expectedRequire(
      [
        "content-length",
        "last-modified",
        "etag",
        "x-oss-server-side-encryption",
        "content-type"
      ].every((k) => headers[k] === get.response.headers[k]) &&
        object.storedAt === new Date(Date.parse(headers["last-modified"])).toISOString() &&
        object.retainUntil ===
          new Date(Date.parse(object.storedAt) + 210 * 86400000).toISOString() &&
        Date.parse(object.retainUntil) >= Date.parse(object.storedAt) + 90 * 86400000
    );
  }
}
async function expectedGhCall(file, subject, p, archive, recheck, assertLive, sources, prefix) {
  const argv = [
    "attestation",
    "verify",
    file,
    "--repo",
    "keqi119/subscription-Saas",
    "--signer-workflow",
    "keqi119/subscription-Saas/.github/workflows/docker-images.yml",
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    p.sourceSha,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
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
  expectedRequire(
    !processResult.problem &&
      processResult.spawned &&
      Number.isSafeInteger(processResult.pid) &&
      processResult.pid > 0 &&
      processResult.exitCode === 0 &&
      processResult.signal === null,
    processResult.problem ?? "MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED"
  );
  expectedText(processResult.stderr);
  const output = expectedJson(processResult.stdout);
  expectedRequire(
    Array.isArray(output) && output.length === 1,
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const item = output[0],
    result = item?.verificationResult,
    cert = result?.signature?.certificate,
    statement = result?.statement,
    signer =
      "https://github.com/keqi119/subscription-Saas/.github/workflows/docker-images.yml@refs/heads/main";
  expectedRequire(
    cert?.issuer === "https://token.actions.githubusercontent.com" &&
      cert.subjectAlternativeName?.type === "URI" &&
      cert.subjectAlternativeName.value === signer &&
      cert.buildSignerURI === signer &&
      cert.buildSignerDigest === p.sourceSha &&
      cert.runnerEnvironment === "github-hosted" &&
      cert.sourceRepositoryURI === "https://github.com/keqi119/subscription-Saas" &&
      cert.sourceRepositoryDigest === p.sourceSha &&
      cert.sourceRepositoryRef === "refs/heads/main" &&
      cert.buildConfigURI === signer &&
      cert.buildConfigDigest === p.sourceSha &&
      cert.runInvocationURI ===
        `https://github.com/keqi119/subscription-Saas/actions/runs/${p.ci.runId}/attempts/1` &&
      statement?._type === "https://in-toto.io/Statement/v1" &&
      Array.isArray(statement.subject) &&
      statement.subject.length === 1 &&
      exact(statement.subject[0]?.digest, ["sha256"]) &&
      statement.subject[0].digest.sha256 === subject.digest.slice(7) &&
      Array.isArray(result.verifiedTimestamps) &&
      result.verifiedTimestamps.length > 0 &&
      result.verifiedTimestamps.every(
        (v) =>
          typeof v?.timestamp === "string" &&
          Number.isFinite(Date.parse(v.timestamp)) &&
          Date.parse(p.generatedAt) <= Date.parse(v.timestamp) &&
          Date.parse(v.timestamp) <= Date.parse(processResult.closedAt)
      ),
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const bundle = item.attestation?.bundle,
    payload = bundle?.dsseEnvelope?.payload;
  expectedRequire(
    bundle &&
      typeof bundle === "object" &&
      !Array.isArray(bundle) &&
      bundle.dsseEnvelope?.payloadType === "application/vnd.in-toto+json" &&
      typeof payload === "string",
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  const payloadBytes = Buffer.from(payload, "base64");
  expectedRequire(
    payloadBytes.toString("base64") === payload &&
      encodeManualJson(expectedJson(payloadBytes)).equals(encodeManualJson(statement)),
    "MANUAL_EXPECTED_SCHEMA_ATTESTATION_INVALID"
  );
  return {
    subject,
    argv: argvRaw,
    stdout,
    stderr,
    pid: processResult.pid,
    startedAt,
    closedAt: processResult.closedAt,
    exitCode: 0,
    signal: null,
    bundleDigest: sha256Canonical(bundle)
  };
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
    opened = [],
    sourcePins = [],
    raws = new Map(),
    subjects = new Map();
  let createdSidecar,
    admissionAccepted = false;
  const proof = expectedJson(fixed.proofBytes),
    root = path.join(
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
    // Hold the exact already-verified originals; this is identity/byte custody,
    // never another proof/material/receipt/CI verifier.
    for (const [digest, suffix, bytes] of [
      [build.proofRawDigest, "proof.json", fixed.proofBytes],
      [build.materialRawDigest, "material.json", fixed.materialBytes]
    ]) {
      const original = await pin(
        path.join(profile.storage.archiveRoot, "inputs", "build", `${digest.slice(7)}.${suffix}`)
      );
      expectedRequire(original.bytes.equals(bytes), "MANUAL_OPERATION_INPUT_UNAVAILABLE");
    }
    const files = new Map();
    for (const name of [
      "provenance.json",
      "expected.sql",
      "schema.prisma",
      "prisma-version.stdout",
      "import-readback.json"
    ])
      files.set(name, await pin(path.join(root, name)));
    const p = expectedJson(files.get("provenance.json").bytes, true),
      imported = expectedJson(files.get("import-readback.json").bytes, true);
    expectedProvenanceShape(p, facts, proof);
    const raw = async (ref) => {
      expectedRawRef(ref);
      if (!raws.has(ref.digest))
        raws.set(
          ref.digest,
          Buffer.from((await pin(path.join(root, "raw", `${ref.digest.slice(7)}.bin`))).bytes)
        );
      const bytes = raws.get(ref.digest);
      expectedRequire(
        bytes.length === ref.bytes && sha256Bytes(bytes) === ref.digest,
        "MANUAL_EXPECTED_SCHEMA_RAW_INVALID"
      );
      return bytes;
    };
    const sourceRaw = async (ref) => {
      const bytes = await raw(ref);
      subjects.set(ref.digest, bytes);
      return bytes;
    };
    const provenanceRaw = files.get("provenance.json").bytes;
    subjects.set(sha256Bytes(provenanceRaw), provenanceRaw);
    expectedRequire((await sourceRaw(p.proofRaw)).equals(fixed.proofBytes));
    for (const [key, name] of [
      ["sourceSchema", "schema.prisma"],
      ["config", null],
      ["lockfile", null]
    ]) {
      const item = await expectedCheckoutPin(p[key].path);
      sourcePins.push(item);
      const bytes = await sourceRaw(p[key].raw);
      expectedRequire(bytes.equals(item.bytes) && (!name || bytes.equals(files.get(name).bytes)));
      expectedText(bytes);
    }
    expectedRequire(
      (await sourceRaw(p.expectedScript)).equals(files.get("expected.sql").bytes) &&
        (await sourceRaw(p.toolchain.prismaVersionRaw)).equals(
          files.get("prisma-version.stdout").bytes
        ) &&
        expectedText(files.get("prisma-version.stdout").bytes).trim() === p.toolchain.prismaVersion
    );
    expectedText(files.get("expected.sql").bytes);
    const catalog = await computeMigrationCatalog(repoRoot),
      extensionSet = new Set(["plpgsql"]);
    expectedRequire(catalog.digest === p.migrationCatalogDigest && catalog.entries.length > 0);
    for (const entry of catalog.entries) {
      const item = await expectedCheckoutPin(entry.path);
      sourcePins.push(item);
      expectedRequire(sha256Bytes(item.bytes) === entry.sha256);
      for (const match of expectedText(item.bytes).matchAll(
        /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/giu
      ))
        extensionSet.add(match[1].toLowerCase());
    }
    const references = [];
    for (const r of p.references)
      references.push(
        await expectedReference(
          r,
          p,
          sourceRaw,
          proof,
          facts.targetContext,
          catalog,
          [...extensionSet].sort()
        )
      );
    const [a, b] = p.references;
    expectedRequire(
      a.referenceRunId !== b.referenceRunId &&
        a.identity.cluster.databaseContainerId !== b.identity.cluster.databaseContainerId &&
        !(
          a.identity.cluster.systemIdentifier === b.identity.cluster.systemIdentifier &&
          a.identity.databaseOid === b.identity.databaseOid
        ) &&
        expectedEqual(references[0], references[1]),
      "MANUAL_EXPECTED_SCHEMA_REPRODUCTION_FAILED"
    );
    await expectedOssImport(imported, p, facts, subjects, raw);
    const recheckOwnInputs = async () => {
      for (const items of [opened, sourcePins]) {
        for (let offset = 0; offset < items.length; offset += 8) {
          const settled = await Promise.allSettled(
            items.slice(offset, offset + 8).map((item) => item.recheck())
          );
          const failed = settled.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
        }
      }
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
      const head = (
        await nativeText("git", [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          repoRoot,
          "rev-parse",
          "--verify",
          "HEAD"
        ])
      ).trim();
      const status = await nativeText("git", [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        repoRoot,
        "status",
        "--porcelain",
        "--untracked-files=all"
      ]);
      expectedRequire(
        head === p.sourceSha &&
          status === "" &&
          (await computeRepositoryContract(repoRoot)).digest ===
            proof.identity.repositoryContractDigest &&
          (await computeMigrationCatalog(repoRoot)).digest === p.migrationCatalogDigest
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
    const provenance = { digest: sha256Bytes(provenanceRaw), bytes: provenanceRaw.length },
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
    for (const bytes of [...raws.values(), provenanceRaw, files.get("import-readback.json").bytes])
      await archive.raw(bytes);
    const expectation = {
      schemaVersion: "manual-runner-evidence.v1",
      recordedAt: p.generatedAt,
      promotionEligible: false,
      kind: "schema-expectation",
      buildProofDigest: build.buildProofDigest,
      sourceSchemaDigest: p.sourceSchema.raw.digest,
      prismaVersion: p.toolchain.prismaVersion,
      script: p.expectedScript,
      sourceSchemaPath: expectedSchemaPath
    };
    validateContract("manual-runner-evidence.v1", expectation);
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
    for (const item of [...opened, ...sourcePins]) await item.close();
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
        // Complete source/admission reads before the fresh capability-release check below.
        await admitted.recheckForDelivery();
        await facts.recheckResources();
        await sources.checkSourceBytes();
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
function h3Acl(value) {
  if (value === null) return true;
  const oid0 = (x) => x === "0" || h3Oid(x);
  h3Rows(value, [h3Oid, oid0, h3Text, (x) => typeof x === "boolean"], (row) => [
    BigInt(row[0]),
    BigInt(row[1]),
    row[2]
  ]);
  return true;
}
function h3Privileges(value, order) {
  return (
    Array.isArray(value) &&
    value.every(
      (item, index) =>
        order.includes(item) &&
        (index === 0 || order.indexOf(value[index - 1]) < order.indexOf(item))
    )
  );
}
function h3Permission(capture, kind, context, after, selectReadback) {
  const data = capture.native.data,
    identity = context.readback.roles[kind],
    known = h3RoleRows(data, context.readback.roles),
    role = known.get(identity.oid);
  h3Require(
    role[2] === true &&
      role.slice(3, 8).every((value) => value === false) &&
      !data.memberships.some((row) => row[1] === identity.oid)
  );
  const oid0 = (x) => x === "0" || h3Oid(x),
    bool = (x) => typeof x === "boolean";
  const perms = (order) => (value) => h3Privileges(value, order);
  const dbPerms = ["CONNECT", "CREATE", "TEMPORARY"],
    schemaPerms = ["USAGE", "CREATE"],
    tablePerms = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN"
    ],
    seqPerms = ["USAGE", "SELECT", "UPDATE"],
    colPerms = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
  h3Rows([data.database], [h3Oid, h3Text, h3Oid, h3Acl, perms(dbPerms), perms(dbPerms)], (row) => [
    BigInt(row[0])
  ]);
  h3Require(
    data.database[0] === context.readback.databaseOid &&
      data.database[1] === context.fixed.operation.targetIntent.databaseName &&
      data.database[2] !== identity.oid &&
      h3Same(data.database[4], ["CONNECT"]) &&
      data.database[5].length === 0
  );
  h3Rows(
    data.schemas,
    [h3Oid, h3Text, h3Oid, h3Acl, perms(schemaPerms), perms(schemaPerms)],
    (row) => [BigInt(row[0])]
  );
  h3Require(
    new Set(data.schemas.map((row) => row[1])).size === data.schemas.length &&
      data.schemas.every(
        (row) =>
          !row[1].startsWith("pg_") &&
          row[1] !== "information_schema" &&
          row[2] !== identity.oid &&
          row[5].length === 0 &&
          h3Same(row[4], row[1] === "public" ? ["USAGE"] : [])
      )
  );
  const publicSchema = data.schemas.find((row) => row[1] === "public");
  h3Require(publicSchema);
  const schemas = new Map(data.schemas.map((row) => [row[0], row]));
  h3Rows(
    data.relations,
    [
      h3Oid,
      h3Oid,
      h3Text,
      (x) => ["r", "p", "v", "m", "f", "S", "i", "I", "t", "c"].includes(x),
      h3Oid,
      h3Acl,
      Array.isArray,
      Array.isArray
    ],
    (row) => [BigInt(row[0])]
  );
  const relations = new Map(data.relations.map((row) => [row[0], row]));
  h3Require(
    new Set(data.relations.map((row) => row[1] + "/" + row[2])).size === data.relations.length
  );
  for (const row of data.relations) {
    const order =
      row[3] === "S" ? seqPerms : ["r", "p", "v", "m", "f"].includes(row[3]) ? tablePerms : [];
    h3Require(
      schemas.has(row[1]) &&
        row[4] !== identity.oid &&
        h3Privileges(row[6], order) &&
        h3Privileges(row[7], order) &&
        row[7].length === 0
    );
    const migration = row[0] === context.table.oid;
    if (migration) {
      h3Require(
        row[1] === publicSchema[0] &&
          row[2] === "_prisma_migrations" &&
          row[3] === "r" &&
          row[4] === context.table.owner.oid &&
          h3Same(row[6], after ? ["SELECT"] : [])
      );
      h3Require(
        row[5] === null ||
          row[5].every(
            (acl) =>
              acl[1] === context.table.owner.oid ||
              (after &&
                [context.readback.roles.verify.oid, context.readback.roles.observer.oid].includes(
                  acl[1]
                ) &&
                acl[2] === "SELECT" &&
                acl[3] === false)
          )
      );
    } else h3Require(row[2] !== "_prisma_migrations" && row[6].length === 0);
  }
  h3Require(relations.has(context.table.oid));
  h3Rows(
    data.columns,
    [
      h3Oid,
      (x) => Number.isSafeInteger(x) && x > 0,
      h3Text,
      h3Acl,
      perms(colPerms),
      perms(colPerms)
    ],
    (row) => [BigInt(row[0]), row[1]]
  );
  for (const row of data.columns) {
    const relation = relations.get(row[0]);
    h3Require(relation && row[5].length === 0);
    if (row[0] === context.table.oid)
      h3Require(
        (row[3] === null || row[3].length === 0) && h3Same(row[4], after ? ["SELECT"] : [])
      );
    else h3Require(row[4].length === 0);
  }
  h3Require(data.columns.some((row) => row[0] === context.table.oid));
  h3Rows(
    [data.controlFunction],
    [h3Oid, (x) => x === "pg_catalog.pg_control_system()", h3Oid, h3Acl, bool, bool],
    (row) => [BigInt(row[0])]
  );
  h3Require(
    data.controlFunction[2] !== identity.oid &&
      data.controlFunction[4] === true &&
      data.controlFunction[5] === false
  );
  h3Rows(
    data.defaultAcls,
    [h3Oid, oid0, (x) => ["r", "S", "f", "T", "n"].includes(x), h3Acl],
    (row) => [BigInt(row[0]), BigInt(row[1]), row[2]]
  );
  h3Require(
    data.defaultAcls.every(
      (row) =>
        row[0] !== identity.oid &&
        (row[1] === "0" || schemas.has(row[1])) &&
        (row[3] === null || row[3].every((acl) => !["0", identity.oid].includes(acl[1])))
    )
  );
  return {
    kind,
    identity,
    tls: true,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    memberships: [],
    ownedSchemas: [],
    ownedRelations: [],
    databasePrivileges: { connect: true, create: false, temporary: false },
    publicSchemaPrivileges: { usage: true, create: false },
    migrationTablePrivileges: {
      select: after,
      insert: false,
      update: false,
      delete: false,
      truncate: false,
      references: false,
      trigger: false,
      maintain: false,
      grantOptions: [],
      columnPrivileges: []
    },
    pgControlSystem: {
      functionOid: data.controlFunction[0],
      signature: "pg_catalog.pg_control_system()",
      execute: true
    },
    otherUserRelationPrivileges: [],
    privilegeInventory: capture.value.stdout,
    selectReadback
  };
}
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
