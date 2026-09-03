#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCustodyComplete,
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const forbiddenOwnerFact =
  /(?:aggregate|final-gate|release|terminal).*(?:status|passed)|(?:status|passed).*(?:aggregate|final-gate|release|terminal)/iu;

function exitError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function validateAs(schemaId, value, code) {
  try {
    validateContract(schemaId, value);
  } catch (error) {
    throw exitError(code, { cause: error?.code });
  }
}

function digestSet(value, result = new Set()) {
  if (typeof value === "string" && digestPattern.test(value)) result.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => digestSet(entry, result));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => digestSet(entry, result));
  }
  return result;
}

function assertRepositoryObservations(observations, aggregateProof) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw exitError("S1_EXIT_REPOSITORY_OBSERVATION_MISSING");
  }
  const allowed = digestSet(aggregateProof);
  const ids = new Set();
  return observations.map((observation) => {
    if (
      observation?.schemaVersion !== "s1-repository-observation.v1" ||
      typeof observation.observationId !== "string" ||
      observation.observationId.length === 0 ||
      ids.has(observation.observationId) ||
      observation.sourceSha !== aggregateProof.sourceSha ||
      observation.repositoryContractDigest !== aggregateProof.contracts.repositoryContractDigest ||
      !["EVIDENCED", "PENDING"].includes(observation.status) ||
      !Number.isFinite(Date.parse(observation.observedAt))
    ) {
      throw exitError("S1_EXIT_REPOSITORY_OBSERVATION_MISMATCH");
    }
    ids.add(observation.observationId);
    if (
      observation.status === "EVIDENCED" &&
      (!Array.isArray(observation.evidenceDigests) || observation.evidenceDigests.length === 0)
    ) {
      throw exitError("S1_EXIT_CONTROL_EVIDENCE_MISSING", {
        controlId: observation.observationId
      });
    }
    if (
      !Array.isArray(observation.evidenceDigests) ||
      observation.evidenceDigests.some((digest) => !allowed.has(digest))
    ) {
      throw exitError("S1_EXIT_CONTROL_EVIDENCE_NOT_SELECTED", {
        controlId: observation.observationId
      });
    }
    return Object.freeze({ ...observation, evidenceDigests: [...observation.evidenceDigests] });
  });
}

function assertOwnerAttestations(records, aggregateProof, producedAt) {
  if (!Array.isArray(records)) throw exitError("S1_EXIT_OWNER_ATTESTATION_INVALID");
  const allowed = digestSet(aggregateProof);
  return records.map(({ attestation, custodyReceipt } = {}) => {
    if (
      attestation?.schemaVersion !== "s1-owner-attestation.v1" ||
      typeof attestation.attestationId !== "string" ||
      typeof attestation.owner !== "string" ||
      attestation.owner.length === 0 ||
      attestation.subject?.sourceSha !== aggregateProof.sourceSha ||
      typeof attestation.subject?.controlId !== "string" ||
      attestation.subject.controlId.length === 0 ||
      !Array.isArray(attestation.subject.evidenceDigests) ||
      attestation.subject.evidenceDigests.length === 0 ||
      attestation.subject.evidenceDigests.some((digest) => !allowed.has(digest)) ||
      !Array.isArray(attestation.facts) ||
      attestation.facts.length === 0 ||
      !Number.isFinite(Date.parse(attestation.validFrom)) ||
      !Number.isFinite(Date.parse(attestation.notAfter))
    ) {
      throw exitError("S1_EXIT_OWNER_ATTESTATION_MISMATCH");
    }
    const at = Date.parse(producedAt);
    if (Date.parse(attestation.validFrom) > at || Date.parse(attestation.notAfter) < at) {
      throw exitError("S1_EXIT_OWNER_ATTESTATION_EXPIRED");
    }
    if (
      attestation.facts.some(
        ({ factId, value }) => forbiddenOwnerFact.test(factId ?? "") || value === "PASSED"
      )
    ) {
      throw exitError("S1_EXIT_OWNER_ATTESTATION_SCOPE_FORBIDDEN");
    }
    try {
      validateContract("custody-receipt.v1", custodyReceipt);
      assertCustodyComplete(custodyReceipt, sha256Canonical(attestation));
    } catch (error) {
      throw exitError("S1_EXIT_OWNER_ATTESTATION_CUSTODY_INVALID", {
        cause: error?.code
      });
    }
    return Object.freeze({
      controlId: attestation.subject.controlId,
      attestationDigest: sha256Canonical(attestation),
      custodyReceiptDigest: sha256Canonical(custodyReceipt),
      evidenceDigests: [...attestation.subject.evidenceDigests]
    });
  });
}

export function generateS1ExitEvidence(input) {
  if (Object.hasOwn(input ?? {}, "aggregateProofDigest")) {
    throw exitError("S1_EXIT_PREBUILT_IDENTITY_FORBIDDEN");
  }
  if (
    Object.hasOwn(input ?? {}, "s1ExitEvidence") ||
    Object.hasOwn(input ?? {}, "exitEvidence") ||
    input?.schemaVersion === "s1-exit-evidence.v1"
  ) {
    throw exitError("S1_EXIT_PREBUILT_EVIDENCE_FORBIDDEN");
  }
  validateAs(
    "release-aggregate-proof.v1",
    input?.aggregateProof,
    "S1_EXIT_AGGREGATE_PROOF_INVALID"
  );
  if (!Number.isFinite(Date.parse(input?.producedAt))) {
    throw exitError("S1_EXIT_PRODUCED_AT_INVALID");
  }
  const repositoryObservations = assertRepositoryObservations(
    input.repositoryObservations,
    input.aggregateProof
  );
  const ownerAttestations = assertOwnerAttestations(
    input.ownerAttestations,
    input.aggregateProof,
    input.producedAt
  );
  if (
    !input.findings ||
    !["p0", "p1", "p2"].every(
      (key) =>
        Array.isArray(input.findings[key]) &&
        input.findings[key].every((value) => typeof value === "string" && value.length > 0)
    )
  ) {
    throw exitError("S1_EXIT_FINDINGS_INVALID");
  }

  const controls = [
    ...repositoryObservations.map((observation) => ({
      controlId: observation.observationId,
      source: "repository",
      status: observation.status,
      evidenceDigests: [...observation.evidenceDigests]
    })),
    ...ownerAttestations.map((attestation) => ({
      controlId: attestation.controlId,
      source: "owner-attestation",
      status: "EVIDENCED",
      evidenceDigests: [attestation.attestationDigest, attestation.custodyReceiptDigest]
    }))
  ].sort((left, right) => left.controlId.localeCompare(right.controlId));
  if (new Set(controls.map(({ controlId }) => controlId)).size !== controls.length) {
    throw exitError("S1_EXIT_CONTROL_DUPLICATE");
  }

  const evidence = {
    schemaVersion: "s1-exit-evidence.v1",
    terminalStatus: "CHECKPOINT_EVIDENCED",
    aggregateProofDigest: sha256Canonical(input.aggregateProof),
    sourceSha: input.aggregateProof.sourceSha,
    repositoryContractDigest: input.aggregateProof.contracts.repositoryContractDigest,
    workflowRun: { ...input.aggregateProof.workflowRun },
    repositoryObservationsDigest: sha256Canonical(repositoryObservations),
    ownerAttestations,
    controls,
    findings: {
      p0: [...input.findings.p0],
      p1: [...input.findings.p1],
      p2: [...input.findings.p2]
    },
    producedAt: input.producedAt
  };
  validateAs("s1-exit-evidence.v1", evidence, "S1_EXIT_CONTRACT_INVALID");
  return Object.freeze(JSON.parse(canonicalJson(evidence)));
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runGenerateS1ExitCli(argv) {
  const inputFile = argument(argv, "--input-file");
  const outputFile = argument(argv, "--output-file");
  if (argv.length !== 4 || !inputFile || !outputFile) {
    throw exitError("S1_EXIT_ARGUMENT_REQUIRED");
  }
  const input = JSON.parse(await readFile(path.resolve(inputFile), "utf8"));
  const evidence = generateS1ExitEvidence(input);
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await writeFile(path.resolve(outputFile), canonicalJson(evidence), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ evidenceDigest: sha256Canonical(evidence) })}\n`);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGenerateS1ExitCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? "S1_EXIT_GENERATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
