import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  custodyEvidence,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { trustedLaunchRunner } from "../../../scripts/release/trusted-launch-runner.mjs";
import { createReadOnceCredentialReader } from "./credential-file.mjs";
import {
  executeDatabaseTestEnvelope,
  executeFinalDatabaseManifest
} from "./database-test-entrypoint.mjs";
import { createDatabaseRuntimeAdapter } from "./database-runtime-adapter.mjs";
import { runnerError } from "./error-codes.mjs";
import { createPostgresConnector } from "./postgres-connector.mjs";
import { resolveRunnerReference } from "./reference-paths.mjs";

export { resolveRunnerReference } from "./reference-paths.mjs";

const postgresConnector = createPostgresConnector();

async function connectProductionDatabase(input) {
  const database = await postgresConnector(input);
  return createDatabaseRuntimeAdapter({
    database,
    credential: input.credential,
    target: input.target,
    repoRoot: process.cwd()
  });
}

function assertFileWithin(file, root) {
  const absolute = path.resolve(file);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
  }
  return absolute;
}

function createAppendOnlyExecutionJournal(file) {
  return Object.freeze({
    trustPolicy: "append-only-execution-state/v1",
    async append(entry) {
      const line = `${canonicalJson(entry)}\n`;
      await appendFile(file, line, { encoding: "utf8", flag: "a" });
      const readback = await readFile(file, "utf8");
      if (!readback.endsWith(line)) throw runnerError("EXECUTION_JOURNAL_UNAVAILABLE");
      return Object.freeze({
        accepted: true,
        stateDigest: entry.stateDigest,
        readbackDigest: entry.stateDigest
      });
    }
  });
}

function createMonotonicCheckpoint(file) {
  async function entries() {
    try {
      const text = await readFile(file, "utf8");
      return text
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
  return Object.freeze({
    trustPolicy: "append-only-monotonic/v1",
    async read(policyId) {
      const values = await entries();
      return values.filter((entry) => entry.policyId === policyId).at(-1);
    },
    async writeMonotonic(next) {
      const values = await entries();
      const current = values.filter((entry) => entry.policyId === next.policyId).at(-1);
      if (
        current &&
        (next.sequence < current.sequence ||
          (next.sequence === current.sequence && next.artifactDigest !== current.artifactDigest))
      ) {
        return Object.freeze({ accepted: false });
      }
      const line = `${canonicalJson(next)}\n`;
      await appendFile(file, line, { encoding: "utf8", flag: "a" });
      const readback = await readFile(file, "utf8");
      if (!readback.endsWith(line))
        throw runnerError("APPROVAL_REVOCATIONS_CHECKPOINT_UNAVAILABLE");
      return Object.freeze({ accepted: true });
    }
  });
}

async function readIntegrityBoundJson(reference, digest, roots) {
  const value = JSON.parse(await readFile(resolveRunnerReference(reference, roots), "utf8"));
  if (sha256Canonical(value) !== digest) {
    throw runnerError("RUNNER_LAUNCH_ARTIFACT_DIGEST_MISMATCH");
  }
  return value;
}

function createEnvelopeAttestationVerifier(entries = []) {
  const claimsByDigest = new Map(
    entries.map(({ attestationDigest, claims }) => [
      attestationDigest,
      Object.freeze({ ...claims })
    ])
  );
  if (claimsByDigest.size !== entries.length) {
    throw runnerError("RUNNER_ATTESTATION_CLAIMS_DUPLICATE");
  }
  return Object.freeze({
    trustPolicy: "github-artifact-attestation/v1",
    async verify(attestation) {
      const claims = claimsByDigest.get(sha256Canonical(attestation));
      if (!claims) throw runnerError("ARTIFACT_ATTESTATION_INVALID");
      return claims;
    }
  });
}

function createAttestedRevocationClient(history, attestationVerifier) {
  if (
    !history ||
    typeof history !== "object" ||
    !Array.isArray(history.runs) ||
    history.runs.length === 0
  ) {
    throw runnerError("APPROVAL_REVOCATIONS_UNAVAILABLE");
  }
  const runs = history.runs.map((entry) => ({
    runNumber: entry.runNumber,
    runId: String(entry.runId),
    runAttempt: entry.runAttempt
  }));
  const byRunId = new Map(history.runs.map((entry) => [String(entry.runId), entry]));
  return Object.freeze({
    attestationVerifier,
    async listSuccessfulWorkflowRuns() {
      return { runs, nextCursor: null };
    },
    async downloadRunArtifact({ runId }) {
      const entry = byRunId.get(String(runId));
      if (!entry) throw runnerError("APPROVAL_REVOCATIONS_UNAVAILABLE");
      return {
        artifact: entry.artifact,
        attestation: entry.attestation,
        custodyReceipt: entry.custodyReceipt
      };
    }
  });
}

function safeEvidencePath(root, key) {
  const absolute = path.resolve(root, ...String(key).split("/"));
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runnerError("RUNNER_REFERENCE_FORBIDDEN");
  }
  return absolute;
}

function createCreateOnlyCustodyWriter({ root, policy, now, attestationRef }) {
  const storage = Object.freeze({
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "release-runner",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      const file = safeEvidencePath(root, key);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, bytes, { flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") throw runnerError("EVIDENCE_OVERWRITE_REFUSED");
        throw error;
      }
      const readback = await readFile(file);
      return Object.freeze({
        created: true,
        storeRef: `evidence-file:///evidence/${key}`,
        contentSizeBytes: readback.byteLength,
        storedAt: requestedAt,
        retainUntil
      });
    },
    async read({ key }) {
      return readFile(safeEvidencePath(root, key));
    }
  });
  return async (value) =>
    custodyEvidence({
      value,
      policy,
      storage,
      now,
      createReceiptId: randomUUID,
      attestationRef
    });
}

export function createRuntimeAdapters({
  roots = {
    launch: "/run/launch",
    secrets: "/run/secrets",
    evidence: "/evidence"
  },
  trustedLaunch = trustedLaunchRunner,
  connectDatabase = connectProductionDatabase,
  executeDatabaseManifest = (input) =>
    executeFinalDatabaseManifest({ ...input, connectDatabase: postgresConnector })
} = {}) {
  if (typeof trustedLaunch !== "function") {
    throw runnerError("RUNNER_TRUSTED_ADAPTER_MISSING", { adapter: "trustedLaunch" });
  }
  const credentialReader = createReadOnceCredentialReader({ allowedRoot: roots.secrets });
  return Object.freeze({
    trustPolicy: "runner-runtime-adapters/v1",
    async readEnvelope(file) {
      return JSON.parse(await readFile(assertFileWithin(file, roots.launch), "utf8"));
    },
    async runDatabaseTests(envelope) {
      return executeDatabaseTestEnvelope({
        envelope,
        roots,
        readCredential: credentialReader,
        executeManifest: executeDatabaseManifest
      });
    },
    async launch({ commandKey, request, envelope }) {
      const custodyPolicy = await readIntegrityBoundJson(
        envelope.custodyPolicyReference,
        envelope.custodyPolicyDigest,
        roots
      );
      const attestationVerifier = createEnvelopeAttestationVerifier(
        envelope.trustedAttestationClaims
      );
      const approvalRecord = envelope.approvalRecordReference
        ? await readIntegrityBoundJson(
            envelope.approvalRecordReference,
            envelope.approvalRecordDigest,
            roots
          )
        : undefined;
      const approvalAttestation = envelope.approvalAttestationReference
        ? await readIntegrityBoundJson(
            envelope.approvalAttestationReference,
            envelope.approvalAttestationDigest,
            roots
          )
        : undefined;
      const approvalCustodyReceipt = envelope.approvalCustodyReceiptReference
        ? await readIntegrityBoundJson(
            envelope.approvalCustodyReceiptReference,
            envelope.approvalCustodyReceiptDigest,
            roots
          )
        : undefined;
      const revocationHistory = envelope.revocationHistoryReference
        ? await readIntegrityBoundJson(
            envelope.revocationHistoryReference,
            envelope.revocationHistoryDigest,
            roots
          )
        : undefined;
      const commandDependencyArtifacts = envelope.commandDependencyArtifactsReference
        ? await readIntegrityBoundJson(
            envelope.commandDependencyArtifactsReference,
            envelope.commandDependencyArtifactsDigest,
            roots
          )
        : undefined;
      const journalFile = resolveRunnerReference(envelope.journalReference, roots);
      const checkpointFile = resolveRunnerReference(envelope.revocationCheckpointReference, roots);
      return trustedLaunch({
        commandKey,
        request,
        approvalRecord,
        approvalAttestation,
        approvalAttestationVerifier: attestationVerifier,
        approvalCustodyReceipt,
        githubClient: revocationHistory
          ? createAttestedRevocationClient(revocationHistory, attestationVerifier)
          : undefined,
        executionJournal: createAppendOnlyExecutionJournal(journalFile),
        revocationCheckpointStore: createMonotonicCheckpoint(checkpointFile),
        readCredential: async (reference) => {
          const credential = await credentialReader(reference);
          if (credential.capabilityProfile !== request.capabilityProfile) {
            throw runnerError("RUNNER_CAPABILITY_CREDENTIAL_MISMATCH");
          }
          return credential;
        },
        connectDatabase,
        credentialFileReference: resolveRunnerReference(envelope.capabilitySecretReference, roots),
        commandDependencyArtifacts,
        custody: createCreateOnlyCustodyWriter({
          root: roots.evidence,
          policy: custodyPolicy,
          now: () => new Date(),
          attestationRef: request.launchAttestation.attestationId
        })
      });
    }
  });
}
