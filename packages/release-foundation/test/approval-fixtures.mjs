import { sha256Canonical } from "../src/digest.mjs";

export const digest = (character) => `sha256:${character.repeat(64)}`;
export const now = new Date("2026-09-02T08:00:00.000Z");

export function approvalPolicy() {
  return {
    schemaVersion: "approval-policy.v1",
    policyId: "s1-release-operations",
    repository: "keqi119/subscription-Saas",
    approvalModes: ["ci-policy", "human"],
    authorities: {
      "ci-policy": {
        issuer: "https://token.actions.githubusercontent.com",
        workflowPath: ".github/workflows/release-operation-approval.yml",
        workflowRef: "refs/heads/main",
        environment: "release",
        allowedSubjects: ["repo:keqi119/subscription-Saas:ref:refs/heads/main"]
      },
      human: {
        issuer: "https://token.actions.githubusercontent.com",
        workflowPath: ".github/workflows/release-operation-approval.yml",
        workflowRef: "refs/heads/main",
        environment: "s1-database-operation-approval",
        allowedSubjects: ["team:release-approvers"]
      }
    },
    maximumLifetimeSeconds: 3600,
    permittedOperations: [
      {
        approvalMode: "ci-policy",
        commandId: "schema.migrate",
        commandVersion: "1",
        environmentClass: "ci-fresh",
        dataImpact: "ddl"
      },
      {
        approvalMode: "human",
        commandId: "repair.execute",
        commandVersion: "1",
        environmentClass: "staging",
        dataImpact: "controlled-dml"
      }
    ],
    revocationSource: {
      repository: "keqi119/subscription-Saas",
      workflowPath: ".github/workflows/release-approval-revocations.yml",
      workflowRef: "refs/heads/main",
      artifactNamePrefix: "approval-revocations-",
      attestationIssuer: "https://token.actions.githubusercontent.com",
      maximumPublicationDelaySeconds: 1800,
      maximumArtifactLifetimeSeconds: 3600,
      minimumWorkflowRunNumber: 10,
      checkpointArtifactDigest: digest("9")
    },
    custody: {
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retentionDays: 180,
      expiryDisposition: "review"
    }
  };
}

export function approvalRecord(policy, overrides = {}) {
  const record = {
    schemaVersion: "approval-record.v1",
    approvalId: "98fa300a-bf12-4ac8-854a-b60dd70cdd17",
    approvalMode: "ci-policy",
    authority: {
      issuer: policy.authorities["ci-policy"].issuer,
      subject: policy.authorities["ci-policy"].allowedSubjects[0],
      repository: policy.repository,
      workflowPath: policy.authorities["ci-policy"].workflowPath,
      workflowRef: policy.authorities["ci-policy"].workflowRef,
      environment: policy.authorities["ci-policy"].environment
    },
    issuedAt: "2026-09-02T07:55:00.000Z",
    notAfter: "2026-09-02T08:55:00.000Z",
    bindings: {
      buildProofDigest: digest("a"),
      baselineManifestIdentityDigest: digest("b"),
      baselineManifestDigest: digest("c"),
      databaseIdentityDigest: digest("d"),
      commandId: "schema.migrate",
      commandVersion: "1",
      executionScope: "migration-schema",
      operationId: "operation-approval-1",
      inputDigest: digest("e"),
      planDigest: digest("f"),
      approvalPolicyDigest: sha256Canonical(policy)
    }
  };
  return {
    ...record,
    ...overrides,
    authority: { ...record.authority, ...(overrides.authority ?? {}) },
    bindings: { ...record.bindings, ...(overrides.bindings ?? {}) }
  };
}

export function approvalAttestation(record, overrides = {}) {
  return {
    issuer: record.authority.issuer,
    subject: record.authority.subject,
    repository: record.authority.repository,
    workflowPath: record.authority.workflowPath,
    workflowRef: record.authority.workflowRef,
    environment: record.authority.environment,
    subjectDigest: sha256Canonical(record),
    ...overrides
  };
}

export function trustedAttestationVerifier(overrides = {}) {
  return {
    trustPolicy: "github-artifact-attestation/v1",
    async verify(envelope) {
      return { ...envelope };
    },
    ...overrides
  };
}

export function revocationArtifact(policy, overrides = {}) {
  return {
    schemaVersion: "approval-revocations.v1",
    issuer: policy.revocationSource.attestationIssuer,
    repository: policy.revocationSource.repository,
    workflowPath: policy.revocationSource.workflowPath,
    workflowRef: policy.revocationSource.workflowRef,
    workflowRunId: "5012",
    runAttempt: 1,
    policyDigest: sha256Canonical(policy),
    sequence: 12,
    previousArtifactDigest: digest("9"),
    issuedAt: "2026-09-02T07:50:00.000Z",
    notAfter: "2026-09-02T08:50:00.000Z",
    revocations: [],
    ...overrides
  };
}

export function revocationAttestation(artifact, overrides = {}) {
  return {
    issuer: artifact.issuer,
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    workflowRef: artifact.workflowRef,
    workflowRunId: artifact.workflowRunId,
    runAttempt: artifact.runAttempt,
    subjectDigest: sha256Canonical(artifact),
    ...overrides
  };
}

export function custodyReceipt(value, overrides = {}) {
  const uploadedAt = "2026-09-02T07:50:00.000Z";
  const contentDigest = sha256Canonical(value);
  return {
    schemaVersion: "custody-receipt.v1",
    receiptId: "86a44ae9-287a-4457-ac85-a0866625543c",
    contentDigest,
    contentSizeBytes: 100,
    storeRef: `artifact://release/${contentDigest.slice(7)}`,
    uploadedAt,
    readbackAt: uploadedAt,
    readbackDigest: contentDigest,
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retainUntil: "2027-03-01T07:50:00.000Z",
    expiryDisposition: "review",
    attestationRef: `attestation://release/${contentDigest.slice(7)}`,
    ...overrides
  };
}
