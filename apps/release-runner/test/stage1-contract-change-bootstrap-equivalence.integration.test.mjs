import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPlanDigest, sha256Canonical } from "@subscription-saas/release-foundation";

import { commandHandlers } from "../src/command-handlers.mjs";
import {
  applyContractChangeBootstrap,
  planContractChangeBootstrap,
  reconcileContractChangeBootstrap
} from "../src/commands/stage1-contract-change-bootstrap.mjs";
import { executeRegisteredCommand } from "../src/preflight.mjs";

import {
  applyContractChangeBootstrapPlan,
  buildContractChangeBootstrapPlan
} from "../../../scripts/stage1-contract-change-bootstrap-core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const SOURCE_SHA = "c".repeat(40);
const INPUT = Object.freeze({
  operationId: "25d422be-1036-470c-a844-fe24735222cf",
  attemptId: "49101a87-aece-4c51-9be0-30233466510b",
  runId: "56f4ad5b-d7d3-4682-a835-0659a961c413",
  baselineManifestIdentityDigest: digest("1"),
  baselineManifestDigest: digest("2"),
  databaseIdentityFingerprint: digest("3"),
  environmentClass: "ci-fresh",
  expectedSchemaDigest: digest("4"),
  featureFlags: {
    earlyTermination: false,
    extension: false,
    managedOther: false,
    vehicleSwap: false
  },
  generatedAt: "2026-09-02T09:00:00.000Z",
  postMigrationHead: "20260831010000_billing_maintenance_cycle_fact"
});

test("registers the ephemeral contract-change bootstrap handler", () => {
  const commandKey = "stage1.contract-change.bootstrap@1";
  if (!commandHandlers.has(commandKey)) {
    throw Object.assign(new Error(`RUNNER_HANDLER_MISSING:${commandKey}`), {
      code: `RUNNER_HANDLER_MISSING:${commandKey}`
    });
  }
  assert.equal(typeof commandHandlers.get(commandKey), "function");
});

test("matches the legacy BASE-segment, extension-detail and audit effects", async () => {
  const legacy = harness();
  const runner = harness();
  const legacyPlan = buildContractChangeBootstrapPlan(await legacy.loadRecords());
  await applyContractChangeBootstrapPlan(legacy.prisma, legacyPlan);
  const plan = await planContractChangeBootstrap(runner.context, INPUT);
  const observation = await applyContractChangeBootstrap(runner.context, {
    input: INPUT,
    planDigest: deterministicPlanDigest(plan)
  });

  assert.deepEqual(normalizedState(runner), normalizedState(legacy));
  assert.equal(
    observation.postconditions.every(({ status }) => status === "PASSED"),
    true
  );
  assert.equal(
    runner.statementLog.some((sql) => /\b(?:ALTER|CREATE|DROP)\b/iu.test(sql)),
    false
  );
});

test("rejects Staging before credential access or a source read", async () => {
  const subject = harness();
  await assert.rejects(
    () =>
      planContractChangeBootstrap(subject.context, {
        ...INPUT,
        environmentClass: "staging"
      }),
    { code: "RUNNER_ENVIRONMENT_PROHIBITED" }
  );
  assert.equal(subject.loadCount, 0);

  const invocation = prohibitedStagingInvocation();
  let secretReads = 0;
  let databaseConnections = 0;
  await assert.rejects(
    () =>
      executeRegisteredCommand({
        ...invocation,
        readCredential: async () => {
          secretReads += 1;
        },
        connectDatabase: async () => {
          databaseConnections += 1;
        }
      }),
    { code: "RUNNER_ENVIRONMENT_PROHIBITED" }
  );
  assert.equal(secretReads, 0);
  assert.equal(databaseConnections, 0);
});

test("rejects changed change-request versions before compatibility writes", async () => {
  const subject = harness();
  const plan = await planContractChangeBootstrap(subject.context, INPUT);
  subject.change.version += 1;
  await assert.rejects(
    () =>
      applyContractChangeBootstrap(subject.context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.deepEqual(normalizedState(subject), { audits: [], details: [], segments: [] });
});

test("marks an interrupted multi-transaction apply UNKNOWN and reconciles without duplicates", async () => {
  const subject = harness();
  const originalApply = subject.context.applyPlan;
  subject.context.applyPlan = async (...args) => {
    await originalApply(...args);
    throw new Error("INJECTED_PROCESS_LOSS_AFTER_CANDIDATE_COMMITS");
  };
  const plan = await planContractChangeBootstrap(subject.context, INPUT);
  const planDigest = deterministicPlanDigest(plan);
  await assert.rejects(
    () => applyContractChangeBootstrap(subject.context, { input: INPUT, planDigest }),
    (error) => error?.outcomeUnknown === true && error?.commitState === "committed-result-unproved"
  );
  const afterUnknown = normalizedState(subject);
  const result = await reconcileContractChangeBootstrap(subject.context, {
    input: INPUT,
    planDigest,
    approvedPlan: plan
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(normalizedState(subject), afterUnknown);
  assert.equal(subject.rows.size, 1);
  assert.equal(subject.details.size, 1);
  assert.equal(subject.audits.length, 1);
});

test("keeps incomplete source facts as a blocked deterministic plan", async () => {
  const subject = harness();
  subject.change.sourceSegmentId = null;
  const plan = await planContractChangeBootstrap(subject.context, INPUT);
  assert.equal(plan.identity.safeToApply, false);
  assert.ok(
    plan.identity.exceptions.some(({ code }) => code === "EXTENSION_DETAIL_SOURCE_INCOMPLETE")
  );
  await assert.rejects(
    () =>
      applyContractChangeBootstrap(subject.context, {
        input: INPUT,
        planDigest: deterministicPlanDigest(plan)
      }),
    { code: "CONTRACT_CHANGE_BOOTSTRAP_BLOCKED" }
  );
  assert.equal(subject.rows.size, 0);
  assert.equal(subject.details.size, 0);
});

function harness() {
  const order = orderRecord();
  const change = order.subscriptionChanges[0];
  const rows = new Map();
  const details = new Map();
  const audits = [];
  const statementLog = [];
  const subject = { order, change, rows, details, audits, statementLog, loadCount: 0 };
  const tx = {
    $queryRawUnsafe: async () => [],
    auditLog: {
      create: async ({ data }) => {
        audits.push(structuredClone(data));
        return data;
      }
    },
    subscriptionOrder: {
      findUnique: async ({ where }) =>
        where.id === order.id ? recordWithStoredFacts(subject) : null
    },
    subscriptionContractSegment: {
      createMany: async ({ data }) => {
        let count = 0;
        for (const value of data) {
          const key = `${value.orderId}:${value.sequenceNo}`;
          if (rows.has(key)) continue;
          rows.set(key, {
            id: `segment-${value.orderId}-${value.sequenceNo}`,
            ...structuredClone(value)
          });
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }) =>
        [...rows.values()].filter(({ orderId }) => where.orderId.in.includes(orderId))
    },
    subscriptionChangeOrder: {
      findUnique: async ({ where }) =>
        where.id === change.id
          ? { ...structuredClone(change), extensionDetail: details.get(change.id) ?? null }
          : null
    },
    subscriptionExtensionChangeDetail: {
      create: async ({ data }) => {
        const detail = { id: `detail-${data.changeOrderId}`, ...structuredClone(data) };
        details.set(data.changeOrderId, detail);
        return detail;
      },
      findUnique: async ({ where }) => details.get(where.changeOrderId) ?? null
    }
  };
  subject.prisma = {
    $transaction: async (operation) => {
      const before = normalizedState(subject);
      try {
        return await operation(tx);
      } catch (error) {
        restoreState(subject, before);
        throw error;
      }
    }
  };
  subject.loadRecords = async () => {
    subject.loadCount += 1;
    return [recordWithStoredFacts(subject)];
  };
  subject.context = {
    applyPlan: (...args) => applyContractChangeBootstrapPlan(...args),
    databaseIdentityFingerprint: INPUT.databaseIdentityFingerprint,
    loadRecords: subject.loadRecords,
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    prisma: subject.prisma,
    statementLog
  };
  return subject;
}

function recordWithStoredFacts(subject) {
  return {
    ...structuredClone(subject.order),
    contractSegments: [...subject.rows.values()].map(({ id, segmentType, sequenceNo }) => ({
      id,
      segmentType,
      sequenceNo
    })),
    subscriptionChanges: subject.order.subscriptionChanges.map((change) => ({
      ...structuredClone(change),
      extensionDetail: subject.details.get(change.id) ?? null
    }))
  };
}

function orderRecord() {
  return {
    contract: {
      contractSnapshot: { archivedDocument: "main-contract.pdf" },
      id: "contract-1",
      status: "ARCHIVED"
    },
    contractSegments: [],
    endDate: new Date("2027-03-03T00:00:00.000Z"),
    energyLimitCount: null,
    energyLimitKwh: 100,
    finalPlanSnapshot: { subscriptionPlan: { planNo: "PLAN-1" } },
    id: "order-1",
    mileageLimitKm: 1_500,
    monthlyFeeAmount: 88_000n,
    orderNo: "ORD-1",
    orderStatus: "ACTIVE",
    overMileageFeeAmount: 100n,
    productId: "product-1",
    productVersionId: "version-1",
    quoteSnapshot: { quoteNo: "QUOTE-1" },
    startDate: new Date("2026-03-03T00:00:00.000Z"),
    subscriptionChanges: [
      {
        changeType: "EXTENSION",
        extensionDetail: null,
        extensionMonths: 6,
        id: "change-1",
        priceOverrideApprovedAt: null,
        priceOverrideApprovedBy: null,
        priceOverrideReason: null,
        pricingMode: "CURRENT_VERSION",
        sourceSegmentId: "segment-base",
        status: "DRAFT",
        targetEndDate: new Date("2027-09-03T00:00:00.000Z"),
        targetStartDate: new Date("2027-03-04T00:00:00.000Z"),
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
        version: 1
      }
    ],
    subscriptionPeriods: [
      {
        endedAt: null,
        id: "period-1",
        startedAt: new Date("2026-03-03T01:00:00.000Z"),
        vehicleId: "vehicle-1"
      }
    ],
    vehicleId: "vehicle-1"
  };
}

function normalizedState(subject) {
  return {
    audits: structuredClone(subject.audits),
    details: [...subject.details.entries()].map(([key, value]) => [key, structuredClone(value)]),
    segments: [...subject.rows.entries()].map(([key, value]) => [key, structuredClone(value)])
  };
}

function restoreState(subject, state) {
  subject.audits.splice(0, subject.audits.length, ...structuredClone(state.audits));
  subject.details.clear();
  for (const [key, value] of state.details) subject.details.set(key, structuredClone(value));
  subject.rows.clear();
  for (const [key, value] of state.segments) subject.rows.set(key, structuredClone(value));
}

function prohibitedStagingInvocation() {
  const runnerDigest = digest("b");
  const buildProof = {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: Object.fromEntries(
        ["api", "web", "runner"].map((name) => [
          name,
          {
            name,
            registry: `ghcr.io/example/${name}`,
            platform: "linux/amd64",
            imageDigest: name === "runner" ? runnerDigest : digest("a"),
            sourceRevision: SOURCE_SHA
          }
        ])
      ),
      sourceSha: SOURCE_SHA,
      migrationCatalogDigest: digest("a"),
      repositoryContractDigest: digest("a")
    },
    provenance: {
      generatedAt: "2026-09-02T00:00:00.000Z",
      ciRunRef: "ci://1",
      attestationRef: "attestation://1",
      checkoutRef: SOURCE_SHA,
      baseImages: [{ name: "node", resolvedDigest: digest("a") }],
      materials: [{ name: "repository", reference: SOURCE_SHA }],
      registryResolutionEvidenceDigest: digest("a")
    }
  };
  const buildProofDigest = sha256Canonical(buildProof);
  const command = {
    commandId: "stage1.contract-change.bootstrap",
    commandVersion: "1",
    category: "repair",
    dataImpact: "controlled-dml",
    capabilityProfile: "repair",
    allowedEnvironments: ["ci-fresh", "ci-snapshot"],
    prohibitedEnvironments: ["staging", "production"],
    approvalMode: "ci-policy",
    allowedExecutionScopes: ["full-rc", "repair"],
    supports: { dryRun: true, apply: true, replay: true }
  };
  return {
    command,
    request: {
      actualRunnerDigest: runnerDigest,
      buildProof,
      buildProofDigest,
      capabilityProfile: "repair",
      environmentClass: "staging",
      executionScope: "repair",
      launchAttestation: {
        schemaVersion: "launch-attestation.v1",
        attestationId: "00000000-0000-4000-8000-000000000001",
        issuer: "trusted-ci",
        issuedAt: "2026-09-02T00:00:00.000Z",
        notAfter: "2026-09-02T01:00:00.000Z",
        sourceSha: SOURCE_SHA,
        buildProofDigest,
        runnerDigest,
        executionScope: "repair",
        environmentClass: "staging",
        targetPolicyDigest: digest("a"),
        secretReference: "secret://runner/repair",
        capability: "repair",
        commandId: command.commandId,
        commandVersion: command.commandVersion
      },
      phase: "dry-run",
      secretReference: "secret://runner/repair",
      target: {
        hostname: "staging-postgres",
        databaseName: "subscription_saas_staging",
        tlsMode: "require"
      }
    },
    policy: {
      allowedEnvironments: ["ci-fresh", "ci-snapshot", "staging"],
      allowedHosts: ["127.0.0.1", "staging-postgres"],
      databaseNamePattern: "^(s1ci_[0-9a-f]{24}|subscription_saas_staging)$",
      requiredTlsMode: "require",
      secretReferencePattern: "^secret://[a-z0-9][a-z0-9./_-]+$"
    }
  };
}
