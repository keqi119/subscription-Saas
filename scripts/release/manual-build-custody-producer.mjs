import {
  canonicalJson,
  custodyEvidence,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity } from "./verify-build-proof.mjs";

const REPOSITORY = "keqi119/subscription-Saas";
const WORKFLOW = ".github/workflows/docker-images.yml";
const SOURCE_REF = "refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";
const IDENTITY_KEYS = ["sourceSha", "repository", "workflowPath", "sourceRef", "runId", "runAttempt", "protectedEnvironment"];
const METADATA_KEYS = ["storeRef", "contentSizeBytes", "storedAt", "retainUntil"];
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function exactDataObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string" && expectedKeys.includes(key)) &&
    expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    });
}

function parseBytes(value, code) {
  if (!(value instanceof Uint8Array)) fail(code);
  const bytes = Buffer.from(value);
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { bytes, parsed };
  } catch {
    fail(code);
  }
}

function clock(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    fail("EVIDENCE_CUSTODY_CLOCK_INVALID");
  }
  return date;
}

function assertJobIdentity(identity, proof, material) {
  if (!exactDataObject(identity, IDENTITY_KEYS) ||
      !/^[0-9a-f]{40}$/u.test(identity.sourceSha) ||
      identity.repository !== REPOSITORY || identity.workflowPath !== WORKFLOW ||
      identity.sourceRef !== SOURCE_REF || identity.runAttempt !== 1 ||
      identity.protectedEnvironment !== "trusted-image-build" ||
      typeof identity.runId !== "string" || !/^[1-9][0-9]*$/u.test(identity.runId) ||
      !Number.isSafeInteger(Number(identity.runId)) ||
      identity.sourceSha !== proof.identity.sourceSha) {
    fail("MANUAL_BUILD_CUSTODY_IDENTITY_INVALID");
  }
  const runRef = `https://github.com/${REPOSITORY}/actions/runs/${identity.runId}`;
  if (proof.provenance.ciRunRef !== runRef || material.ciRunRef !== runRef ||
      material.images.some((image) => image.buildRunRef !== runRef)) {
    fail("MANUAL_BUILD_CUSTODY_IDENTITY_INVALID");
  }
  return runRef;
}

function proofAttestationRef(output, { proofDigest, sourceSha, runRef, earliest, latest }) {
  const code = "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID";
  // Only the future protected job's successful gh verification establishes
  // signatures. Here we independently bind that output, never a verified flag.
  if (!Array.isArray(output) || output.length !== 1) fail(code);
  const item = output[0];
  const result = item?.verificationResult;
  const cert = result?.signature?.certificate;
  const statement = result?.statement;
  const signer = `https://github.com/${REPOSITORY}/${WORKFLOW}@${SOURCE_REF}`;
  if (cert?.issuer !== ISSUER || cert?.subjectAlternativeName?.type !== "URI" ||
      cert.subjectAlternativeName.value !== signer || cert.buildSignerURI !== signer ||
      cert.buildSignerDigest !== sourceSha || cert.runnerEnvironment !== "github-hosted" ||
      cert.sourceRepositoryURI !== `https://github.com/${REPOSITORY}` ||
      cert.sourceRepositoryDigest !== sourceSha || cert.sourceRepositoryRef !== SOURCE_REF ||
      cert.buildConfigURI !== signer || cert.buildConfigDigest !== sourceSha ||
      cert.runInvocationURI !== `${runRef}/attempts/1` ||
      statement?._type !== "https://in-toto.io/Statement/v1" ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
      statement.subject[0]?.digest?.sha256 !== proofDigest.slice(7) ||
      !Array.isArray(result.verifiedTimestamps) || result.verifiedTimestamps.length === 0 ||
      !result.verifiedTimestamps.every((entry) =>
        typeof entry?.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) &&
        Date.parse(entry.timestamp) >= earliest && Date.parse(entry.timestamp) <= latest)) {
    fail(code);
  }
  const bundle = item.attestation?.bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      bundle.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" ||
      typeof bundle.dsseEnvelope.payload !== "string") fail(code);
  const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64");
  if (payload.toString("base64") !== bundle.dsseEnvelope.payload) fail(code);
  const { parsed } = parseBytes(payload, code);
  try {
    if (canonicalJson(parsed) !== canonicalJson(statement)) fail(code);
    // Download URL and proof's material-attestation reference confer no custody.
    return sha256Canonical(bundle);
  } catch {
    fail(code);
  }
}

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function assertMaterialMetadata(metadata, size, minimumRetainUntil) {
  if (!exactDataObject(metadata, METADATA_KEYS) ||
      typeof metadata.storeRef !== "string" || metadata.storeRef.length === 0 ||
      metadata.contentSizeBytes !== size ||
      !canonicalTimestamp(metadata.storedAt) || !canonicalTimestamp(metadata.retainUntil) ||
      Date.parse(metadata.retainUntil) < Date.parse(metadata.storedAt) + RETENTION_MS ||
      Date.parse(metadata.retainUntil) < minimumRetainUntil) {
    fail("MANUAL_BUILD_CUSTODY_MATERIAL_METADATA_INVALID");
  }
}

/** Internal protected-job function; no CLI, storage authority or gh invocation. */
export async function produceManualBuildCustody({
  proofBytes,
  materialBytes,
  verifiedProofAttestation,
  buildIdentity,
  storage,
  now = () => new Date(),
  createReceiptId
}) {
  const { bytes: proofRaw, parsed: proof } = parseBytes(proofBytes, "MANUAL_BUILD_CUSTODY_PROOF_RAW_INVALID");
  const { bytes: materialRaw, parsed: material } = parseBytes(materialBytes, "MANUAL_BUILD_CUSTODY_MATERIAL_RAW_INVALID");
  assertBuildIdentity({ proof, buildMaterialObservation: material });
  const runRef = assertJobIdentity(buildIdentity, proof, material);
  if (!Buffer.from(canonicalJson(proof)).equals(proofRaw)) {
    fail("MANUAL_BUILD_CUSTODY_PROOF_RAW_INVALID");
  }
  const proofDigest = sha256Bytes(proofRaw);
  if (proofDigest !== sha256Canonical(proof)) fail("MANUAL_BUILD_CUSTODY_PROOF_RAW_INVALID");
  const attestationRef = proofAttestationRef(verifiedProofAttestation, {
    proofDigest,
    sourceSha: buildIdentity.sourceSha,
    runRef,
    earliest: Date.parse(proof.provenance.generatedAt),
    latest: clock(now).getTime()
  });
  // Labels are an interface guard. Real role/client separation must be
  // established by the separately reviewed future storage binding.
  if (storage?.writerIdentity === "audit-reader") fail("MANUAL_BUILD_CUSTODY_STORAGE_INVALID");
  const receipt = await custodyEvidence({
    value: proof,
    policy: { owner: "release-engineering", readers: ["release", "qa", "security", "audit"],
      retentionDays: 90, expiryDisposition: "review" },
    storage, now, createReceiptId, attestationRef,
    receiptContract: "custody-receipt.retention90.v1"
  });

  // Preserve the material's original formatting; foundation already owns the
  // proof/receipt algorithm. Partial failure leaves all created objects intact.
  const contentDigest = sha256Bytes(materialRaw);
  const key = `evidence/${contentDigest.slice(7)}.json`;
  const requestedAt = clock(now);
  const minimumRetainUntil = Date.parse(receipt.retainUntil);
  const retainUntil = new Date(Math.max(requestedAt.getTime() + RETENTION_MS, minimumRetainUntil)).toISOString();
  const created = await storage.createOnly({
    key, bytes: materialRaw, contentDigest, requestedAt: requestedAt.toISOString(), retainUntil
  });
  if (created?.created !== true) fail("EVIDENCE_OVERWRITE_REFUSED");
  const createdFacts = Object.fromEntries(METADATA_KEYS.map((name) => [name, created[name]]));
  assertMaterialMetadata(createdFacts, materialRaw.length, minimumRetainUntil);
  const observed = await storage.readMetadata({ key, identity: "audit-reader" });
  assertMaterialMetadata(observed, materialRaw.length, minimumRetainUntil);
  if (METADATA_KEYS.some((name) => observed[name] !== createdFacts[name])) {
    fail("MANUAL_BUILD_CUSTODY_MATERIAL_METADATA_INVALID");
  }
  const readback = await storage.read({ key, identity: "audit-reader" });
  if (!(readback instanceof Uint8Array) || sha256Bytes(readback) !== contentDigest ||
      !Buffer.from(readback).equals(materialRaw)) {
    fail("MANUAL_BUILD_CUSTODY_MATERIAL_READBACK_INVALID");
  }
  return receipt;
}
