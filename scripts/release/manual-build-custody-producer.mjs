import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  custodyEvidence,
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity } from "./verify-build-proof.mjs";
import { produceManualExpectedSchema } from "./manual-expected-schema-producer.mjs";

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
  if (cert?.issuer !== ISSUER ||
      !(cert.subjectAlternativeName === signer ||
        (cert.subjectAlternativeName?.type === "URI" && cert.subjectAlternativeName.value === signer)) ||
      cert.buildSignerURI !== signer ||
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
  createReceiptId = randomUUID
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

const INPUT_LIMIT = 1048576;
const ref = (raw) => ({ digest: sha256Bytes(raw), bytes: raw.length });
const evidenceKey = (digest) => `evidence/${digest.slice(7)}.json`;

function ownedRaw(raw) {
  if (!(raw instanceof Uint8Array) || raw.length > INPUT_LIMIT) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  return Buffer.from(raw);
}

function addOwned(raws, raw) {
  const copy = ownedRaw(raw), subject = ref(copy), existing = raws.get(subject.digest);
  if (existing && !existing.equals(copy)) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  raws.set(subject.digest, copy);
  return subject;
}

function mergeOwned(raws, source) {
  if (!(source instanceof Map) || source.size > 2048) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  for (const [digest, raw] of source) if (addOwned(raws, raw).digest !== digest) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
}

function atRef(raws, subject) {
  if (!exactDataObject(subject, ["digest", "bytes"]) || !/^sha256:[0-9a-f]{64}$/u.test(subject.digest) ||
      !Number.isSafeInteger(subject.bytes) || subject.bytes < 0 || subject.bytes > INPUT_LIMIT) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  const raw = raws.get(subject.digest);
  if (!raw || raw.length !== subject.bytes || sha256Bytes(raw) !== subject.digest) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  return raw;
}

function canonicalPrivate(value) {
  return ownedRaw(encodeManualJson(value));
}

function creationFacts(created, size, minimum) {
  const metadata = Object.fromEntries(METADATA_KEYS.map((name) => [name, created?.[name]]));
  try { assertMaterialMetadata(metadata, size, minimum); } catch { fail("MANUAL_TRUSTED_INPUT_METADATA_INVALID"); }
  return metadata;
}

function compareRead(metadata, bytes, original, raw, minimum, readbackAt) {
  try { assertMaterialMetadata(metadata, raw.length, minimum); } catch { fail("MANUAL_TRUSTED_INPUT_METADATA_INVALID"); }
  if (METADATA_KEYS.some((name) => metadata[name] !== original[name]) ||
      (readbackAt !== undefined && (!canonicalTimestamp(readbackAt) || Date.parse(metadata.storedAt) > Date.parse(readbackAt)))) {
    fail("MANUAL_TRUSTED_INPUT_METADATA_INVALID");
  }
  if (!(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(raw) || sha256Bytes(bytes) !== sha256Bytes(raw)) {
    fail("MANUAL_TRUSTED_INPUT_READBACK_INVALID");
  }
}

async function createRaw(storage, raw, now, minimum) {
  const subject = ref(raw), key = evidenceKey(subject.digest), requestedAt = clock(now);
  const retainUntil = new Date(Math.max(requestedAt.getTime() + RETENTION_MS, minimum)).toISOString();
  const created = await storage.createOnly({ key, bytes: Buffer.from(raw), contentDigest: subject.digest,
    requestedAt: requestedAt.toISOString(), retainUntil });
  if (created?.created !== true) fail("EVIDENCE_OVERWRITE_REFUSED");
  return { key, subject, metadata: creationFacts(created, raw.length, minimum) };
}

function provenanceSubjects(provenanceRaw, raws) {
  const { parsed } = parseBytes(provenanceRaw, "MANUAL_TRUSTED_INPUT_RAW_INVALID"), subjects = new Map();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (exactDataObject(value, ["digest", "bytes"])) {
      const raw = atRef(raws, value);
      if (subjects.has(value.digest)) return;
      subjects.set(value.digest, value);
      let parsedRaw;
      try { parsedRaw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return; }
      visit(parsedRaw); return;
    }
    for (const entry of Object.values(value)) visit(entry);
  }
  visit(parsed); subjects.set(sha256Bytes(provenanceRaw), ref(provenanceRaw));
  return [...subjects.values()].sort((a, b) => a.digest.localeCompare(b.digest));
}

/** Same protected invocation; only successful H2 writes can be reused. No import approval. */
export async function produceManualTrustedBuildInputs(input, { runProcess, now = input.now ?? (() => new Date()) } = {}) {
  const storage = input.storage, created = new Map(), rawBlobs = new Map();
  const proofVerificationRaw = ownedRaw(input.verifiedProofAttestationBytes), { parsed: proofVerification } = parseBytes(proofVerificationRaw, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID");
  if (canonicalJson(proofVerification) !== canonicalJson(input.verifiedProofAttestation)) fail("MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID");
  const capture = { ...storage, async createOnly(args) {
    const raw = ownedRaw(args.bytes), result = await storage.createOnly({ ...args, bytes: Buffer.from(raw) });
    if (result?.created === true) {
      if (created.has(args.key) || args.contentDigest !== sha256Bytes(raw)) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
      created.set(args.key, { key: args.key, subject: ref(raw), metadata: creationFacts(result, raw.length, 0) });
      addOwned(rawBlobs, raw);
    }
    return result;
  } };
  // Captured facts become eligible only after the complete existing H2 function returns.
  const receipt = await produceManualBuildCustody({ ...input, storage: capture, now });
  const expected = await produceManualExpectedSchema({ repoRoot: input.repoRoot, proofBytes: input.proofBytes,
    materialBytes: input.materialBytes, buildIdentity: input.buildIdentity }, { runProcess, now });
  mergeOwned(rawBlobs, expected.rawBlobs);
  const producerRecord = addOwned(rawBlobs, expected.producerRecordBytes), subjects = provenanceSubjects(expected.producerRecordBytes, rawBlobs);
  if (subjects.length !== expected.rawBlobs.size + (expected.rawBlobs.has(producerRecord.digest) ? 0 : 1)) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
  const minimum = Date.parse(receipt.retainUntil), objects = [];
  for (const subject of subjects) {
    const raw = atRef(rawBlobs, subject), key = evidenceKey(subject.digest);
    let facts = created.get(key);
    if (facts) {
      if (facts.subject.digest !== subject.digest || facts.subject.bytes !== raw.length) fail("MANUAL_TRUSTED_INPUT_RAW_INVALID");
    } else { facts = await createRaw(storage, raw, now, minimum); created.set(key, facts); }
    const readback = await storage.readWithEvidence({ key, identity: "audit-reader" });
    compareRead(readback?.metadata, readback?.bytes, facts.metadata, raw, minimum, readback?.readbackAt);
    if (Date.parse(readback.readbackAt) > clock(now).getTime()) fail("MANUAL_TRUSTED_INPUT_METADATA_INVALID");
    mergeOwned(rawBlobs, readback.rawBlobs);
    const getEvidence = addOwned(rawBlobs, readback.getEvidenceBytes), headEvidence = addOwned(rawBlobs, readback.headEvidenceBytes), aclEvidence = addOwned(rawBlobs, readback.aclEvidenceBytes);
    objects.push({ subject, storeRef: facts.metadata.storeRef, writerIdentity: storage.writerIdentity,
      auditReaderIdentity: "audit-reader", storedAt: facts.metadata.storedAt, retainUntil: facts.metadata.retainUntil,
      readbackAt: readback.readbackAt, getEvidence, headEvidence, aclEvidence });
  }
  const receiptRaw = addOwned(rawBlobs, canonicalPrivate(receipt)), materialRaw = addOwned(rawBlobs, input.materialBytes);
  const proofVerificationRef = addOwned(rawBlobs, proofVerificationRaw);
  const pending = { recordVersion: "manual-trusted-build-custody-pending.v1", buildIdentity: { ...input.buildIdentity },
    receiptRaw, materialRaw, producerRecord, proofVerification: proofVerificationRef, objects, created: [...created.values()].sort((a, b) => a.key.localeCompare(b.key)),
    raws: [...rawBlobs].map(([, raw]) => ref(raw)).sort((a, b) => a.digest.localeCompare(b.digest)) };
  const pendingBytes = canonicalPrivate(pending);
  return { receipt, expected, objects, rawBlobs, pendingBytes, pendingDigest: sha256Bytes(pendingBytes) };
}

/** Finite closure ends in ordinary audit-reader reads; only the last successful read publishes a locator. */
export async function finalizeManualTrustedBuildInputs({ pendingBytes, pendingDigest, rawBlobs: suppliedRaws,
  verifiedAttestations, buildIdentity, storage, now = () => new Date() }) {
  const pendingRaw = ownedRaw(pendingBytes), { parsed: pending } = parseBytes(pendingRaw, "MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  if (sha256Bytes(pendingRaw) !== pendingDigest || !canonicalPrivate(pending).equals(pendingRaw) ||
      !exactDataObject(pending, ["recordVersion", "buildIdentity", "receiptRaw", "materialRaw", "producerRecord", "proofVerification", "objects", "created", "raws"]) ||
      pending.recordVersion !== "manual-trusted-build-custody-pending.v1" ||
      canonicalJson(pending.buildIdentity) !== canonicalJson(buildIdentity)) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  const rawBlobs = new Map(); mergeOwned(rawBlobs, suppliedRaws);
  if (!Array.isArray(pending.raws) || pending.raws.length !== rawBlobs.size) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  for (let i = 0; i < pending.raws.length; i++) {
    atRef(rawBlobs, pending.raws[i]);
    if (i > 0 && pending.raws[i].digest <= pending.raws[i - 1].digest) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  }
  const receiptRaw = atRef(rawBlobs, pending.receiptRaw), receipt = JSON.parse(receiptRaw),
    provenanceRaw = atRef(rawBlobs, pending.producerRecord), provenance = JSON.parse(provenanceRaw),
    proofRaw = atRef(rawBlobs, provenance.proofRaw), proof = JSON.parse(proofRaw), material = JSON.parse(atRef(rawBlobs, pending.materialRaw));
  assertBuildIdentity({ proof, buildMaterialObservation: material });
  const runRef = assertJobIdentity(buildIdentity, proof, material), minimum = Date.parse(receipt.retainUntil), subjects = provenanceSubjects(provenanceRaw, rawBlobs);
  if (!canonicalPrivate(receipt).equals(receiptRaw) || receipt.contentDigest !== sha256Bytes(proofRaw) ||
      !canonicalTimestamp(receipt.retainUntil) || provenance.sourceSha !== buildIdentity.sourceSha || provenance.buildProofDigest !== sha256Bytes(proofRaw) ||
      canonicalJson(provenance.ci) !== canonicalJson({ repository: buildIdentity.repository, workflowPath: buildIdentity.workflowPath,
        sourceRef: buildIdentity.sourceRef, runId: buildIdentity.runId, runAttempt: 1, runnerClass: "github-hosted" })) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  const proofVerification = JSON.parse(atRef(rawBlobs, pending.proofVerification));
  if (proofAttestationRef(proofVerification, { proofDigest: sha256Bytes(proofRaw), sourceSha: buildIdentity.sourceSha, runRef,
    earliest: Date.parse(proof.provenance.generatedAt), latest: clock(now).getTime() }) !== receipt.attestationRef) fail("MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID");
  if (!Array.isArray(pending.objects) || !Array.isArray(pending.created) ||
      canonicalJson(pending.objects.map((o) => o.subject)) !== canonicalJson(subjects)) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  const created = new Map(), expectedKeys = new Set([...subjects.map((s) => evidenceKey(s.digest)), evidenceKey(pending.materialRaw.digest), `receipts/${receipt.receiptId}.json`]);
  for (const facts of pending.created) {
    if (!exactDataObject(facts, ["key", "subject", "metadata"]) || !exactDataObject(facts.metadata, METADATA_KEYS) || created.has(facts.key) || !expectedKeys.has(facts.key) ||
        (facts.key !== evidenceKey(facts.subject.digest) && (facts.key !== `receipts/${receipt.receiptId}.json` || facts.subject.digest !== pending.receiptRaw.digest))) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
    creationFacts(facts.metadata, atRef(rawBlobs, facts.subject).length, minimum);
    if (Date.parse(facts.metadata.storedAt) > clock(now).getTime()) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
    created.set(facts.key, facts);
  }
  if (created.size !== expectedKeys.size) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
  for (const object of pending.objects) {
    if (!exactDataObject(object, ["subject", "storeRef", "writerIdentity", "auditReaderIdentity", "storedAt", "retainUntil", "readbackAt", "getEvidence", "headEvidence", "aclEvidence"])) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
    const facts = created.get(evidenceKey(object.subject.digest));
    if (object.writerIdentity !== storage.writerIdentity || object.auditReaderIdentity !== "audit-reader" ||
        ["storeRef", "storedAt", "retainUntil"].some((k) => object[k] !== facts.metadata[k]) || !canonicalTimestamp(object.readbackAt) ||
        Date.parse(object.storedAt) > Date.parse(object.readbackAt) || Date.parse(object.readbackAt) > clock(now).getTime()) fail("MANUAL_TRUSTED_INPUT_PENDING_INVALID");
    for (const field of ["getEvidence", "headEvidence", "aclEvidence"]) atRef(rawBlobs, object[field]);
  }
  if (!exactDataObject(verifiedAttestations, ["receipt", "producer", "script"])) fail("MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID");
  const attestations = [];
  for (const [name, subject, earliest] of [["receipt", pending.receiptRaw, receipt.uploadedAt], ["producer", pending.producerRecord, provenance.generatedAt], ["script", provenance.expectedScript, provenance.generatedAt]]) {
    const raw = ownedRaw(verifiedAttestations[name]), { parsed } = parseBytes(raw, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"),
      bundleDigest = proofAttestationRef(parsed, { proofDigest: subject.digest, sourceSha: buildIdentity.sourceSha, runRef, earliest: Date.parse(earliest), latest: clock(now).getTime() }),
      bundle = addOwned(rawBlobs, canonicalPrivate(parsed[0].attestation.bundle));
    if (bundle.digest !== bundleDigest) fail("MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID");
    attestations.push({ subject, verification: addOwned(rawBlobs, raw), bundle });
  }
  async function reopen(facts, raw) {
    const metadata = await storage.readMetadata({ key: facts.key, identity: "audit-reader" }), bytes = await storage.read({ key: facts.key, identity: "audit-reader" });
    compareRead(metadata, bytes, facts.metadata, raw, minimum);
  }
  // Every reused creation fact is independently re-read. Existence cannot populate this map.
  // Workers claim unique keys once; on failure they stop claiming and drain in-flight IO.
  const retained = new Map();
  const tasks = [], existingDigests = new Set();
  for (const facts of created.values()) {
    tasks.push({ digest: facts.subject.digest, facts, raw: atRef(rawBlobs, facts.subject) });
    existingDigests.add(facts.subject.digest);
  }
  for (const [digest, raw] of [...rawBlobs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!existingDigests.has(digest)) tasks.push({ digest, raw });
  }
  let next = 0, stopped = false, firstFailure;
  async function worker() {
    while (!stopped && next < tasks.length) {
      const task = tasks[next++];
      try {
        const facts = task.facts ?? await createRaw(storage, task.raw, now, minimum);
        await reopen(facts, task.raw);
        retained.set(task.digest, facts);
      } catch (error) {
        if (!stopped) { stopped = true; firstFailure = error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, () => worker()));
  if (stopped) throw firstFailure;
  const subjectDigests = new Set(subjects.map((s) => s.digest)), root = {
    recordVersion: "manual-trusted-build-custody-root.v1", buildIdentity: { ...buildIdentity }, pendingDigest,
    receiptRaw: pending.receiptRaw, materialRaw: pending.materialRaw, producerRecord: pending.producerRecord, proofVerification: pending.proofVerification,
    objects: pending.objects, created: pending.created, attestations,
    support: [...retained.values()].filter((f) => !subjectDigests.has(f.subject.digest)).sort((a, b) => a.subject.digest.localeCompare(b.subject.digest)),
    recordedAt: clock(now).toISOString(), promotionEligible: false
  };
  const rootBytes = canonicalPrivate(root), facts = await createRaw(storage, rootBytes, now, minimum);
  await reopen(facts, rootBytes);
  return { rootBytes, rootDigest: facts.subject.digest, rootKey: facts.key };
}
