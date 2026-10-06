import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { produceManualBuildCustody } from "./manual-build-custody-producer.mjs";
import * as custodyProducer from "./manual-build-custody-producer.mjs";
import { fixture as expectedFixture } from "./manual-expected-schema-producer.test.mjs";

const repository = "keqi119/subscription-Saas";
const workflowPath = ".github/workflows/docker-images.yml";
const sourceSha = "1".repeat(40);
const generatedAt = "2026-09-02T16:00:00.000Z";
const storedAt = "2026-09-02T16:02:00.000Z";
const retainUntil = "2026-12-02T16:02:00.000Z";
const receiptId = "3ba3126f-f212-455b-b308-2f1d11f73b31";
const ciRunRef = `https://github.com/${repository}/actions/runs/2801`;
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const material = {
    schemaVersion: "build-material-observation.v1",
    sourceSha, checkoutRef: sourceSha, ciRunRef,
    repositoryContractDigest: digest("d"), migrationCatalogDigest: digest("e"),
    policyDigest: digest("f"), promotionEligibility: "trusted-candidate",
    images: ["api", "web", "runner"].map((name, index) => {
      const image = `ghcr.io/keqi119/subscription-${name}`;
      const imageDigest = digest(String(index + 1));
      return {
        name, image, platform: "linux/amd64", digest: imageDigest,
        sourceRevision: sourceSha,
        baseImageDigests: [{ image: "node:22-bookworm-slim", declaredDigest: digest("a"), digest: digest("b") }],
        builderName: "https://mobyproject.org/buildkit@v1",
        buildAttestationRef: `oci://${image}@${imageDigest}#provenance=${digest("c")}`,
        registrySubject: `${image}@${imageDigest}`, buildRunRef: ciRunRef
      };
    }),
    externalActions: [{ name: "actions/checkout", commitSha: "2".repeat(40) }],
    builder: { name: "https://mobyproject.org/buildkit@v1", provenanceRef: `build-material-attestations:${digest("4")}` },
    observedAt: generatedAt
  };
  const proof = createBuildProof({
    sourceSha, images: material.images,
    migrationCatalog: { digest: material.migrationCatalogDigest },
    repositoryContract: { digest: material.repositoryContractDigest },
    provenance: { generatedAt, ciRunRef, attestationRef: material.builder.provenanceRef,
      checkoutRef: sourceSha, buildMaterialObservation: material }
  });
  const proofBytes = Buffer.from(canonicalJson(proof));
  // Raw observation formatting must survive custody unchanged.
  const materialBytes = Buffer.from(`${JSON.stringify(material, null, 2)}\n`);
  const signer = `https://github.com/${repository}/${workflowPath}@refs/heads/main`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "build-proof.v1.json", digest: { sha256: sha256Bytes(proofBytes).slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1", predicate: {}
  };
  const verifiedProofAttestation = [{
    verificationResult: {
      signature: { certificate: {
        issuer: "https://token.actions.githubusercontent.com",
        subjectAlternativeName: { type: "URI", value: signer },
        buildSignerURI: signer, buildSignerDigest: sourceSha,
        runnerEnvironment: "github-hosted",
        sourceRepositoryURI: `https://github.com/${repository}`,
        sourceRepositoryDigest: sourceSha, sourceRepositoryRef: "refs/heads/main",
        buildConfigURI: signer, buildConfigDigest: sourceSha,
        runInvocationURI: `${ciRunRef}/attempts/1`
      } },
      statement, verifiedTimestamps: [{ timestamp: "2026-09-02T16:00:01.000Z" }]
    },
    attestation: {
      bundle_url: "https://example.invalid/unauthoritative-download",
      bundle: { dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(canonicalJson(statement)).toString("base64")
      } }
    }
  }];
  const objects = new Map();
  // Separate closures model writer CreateNew and audit reader Get/Head.
  // This offline fixture cannot establish real IAM or signature verification.
  const writer = {
    createOnly({ key, bytes }) {
      if (objects.has(key)) return { created: false };
      const metadata = { storeRef: `memory://private/${key}`, contentSizeBytes: bytes.length, storedAt, retainUntil };
      objects.set(key, { bytes: Buffer.from(bytes), metadata });
      return { created: true, ...metadata };
    }
  };
  const auditReader = {
    read({ key, identity }) {
      assert.equal(identity, "audit-reader");
      return objects.has(key) ? Buffer.from(objects.get(key).bytes) : undefined;
    },
    readMetadata({ key, identity }) {
      assert.equal(identity, "audit-reader");
      return objects.has(key) ? { ...objects.get(key).metadata } : undefined;
    }
  };
  return {
    proofBytes, materialBytes, verifiedProofAttestation,
    buildIdentity: { sourceSha, repository, workflowPath, sourceRef: "refs/heads/main",
      runId: "2801", runAttempt: 1, protectedEnvironment: "trusted-image-build" },
    storage: { trustPolicy: "immutable-content-addressed/v1", writerIdentity: "evidence-writer",
      auditReaderIdentity: "audit-reader", ...writer, ...auditReader },
    now: () => new Date("2026-09-02T16:03:00.000Z"),
    createReceiptId: () => receiptId, objects
  };
}

test("returns existing frozen retention90 receipt only after exact proof, receipt and raw material custody", async () => {
  const input = fixture();
  const receipt = await produceManualBuildCustody(input);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.schemaVersion, "custody-receipt.retention90.v1");
  assert.equal(receipt.contentDigest, sha256Bytes(input.proofBytes));
  assert.equal(receipt.attestationRef, sha256Canonical(input.verifiedProofAttestation[0].attestation.bundle));
  assert.notEqual(receipt.attestationRef, JSON.parse(input.proofBytes).provenance.attestationRef);
  assert.equal(receipt.owner, "release-engineering");
  assert.deepEqual(receipt.readers, ["release", "qa", "security", "audit"]);
  assert.equal(receipt.expiryDisposition, "review");
  assert.equal(receipt.uploadedAt, storedAt);
  assert.equal(receipt.retainUntil, retainUntil);
  assert.equal(input.objects.size, 3);
  assert.deepEqual(input.objects.get(`evidence/${sha256Bytes(input.proofBytes).slice(7)}.json`).bytes, input.proofBytes);
  assert.deepEqual(input.objects.get(`evidence/${sha256Bytes(input.materialBytes).slice(7)}.json`).bytes, input.materialBytes);
  assert.deepEqual(input.objects.get(`receipts/${receiptId}.json`).bytes, Buffer.from(canonicalJson(receipt)));
});

const certificate = (input) => input.verifiedProofAttestation[0].verificationResult.signature.certificate;

test("accepts current gh string SAN while preserving the exact workflow binding", async () => {
  const input = fixture();
  certificate(input).subjectAlternativeName = certificate(input).subjectAlternativeName.value;
  const receipt = await produceManualBuildCustody(input);
  assert.equal(receipt.contentDigest, sha256Bytes(input.proofBytes));
  assert.equal(input.objects.size, 3);
});

const materialKey = (input) => `evidence/${sha256Bytes(input.materialBytes).slice(7)}.json`;
const failures = [
  ["string SAN workflow differs", (i) => { certificate(i).subjectAlternativeName = certificate(i).subjectAlternativeName.value + "/other"; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["legacy SAN is not URI", (i) => { certificate(i).subjectAlternativeName.type = "DNS"; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["actual checkout differs", (i) => { i.buildIdentity.sourceSha = "9".repeat(40); }, "MANUAL_BUILD_CUSTODY_IDENTITY_INVALID"],
  ["identity has dispatch field", (i) => { i.buildIdentity.bucket = "caller"; }, "MANUAL_BUILD_CUSTODY_IDENTITY_INVALID"],
  ["certificate source differs", (i) => { certificate(i).sourceRepositoryDigest = "9".repeat(40); }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["certificate workflow differs", (i) => { certificate(i).buildConfigURI += "/other"; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["certificate runner is self hosted", (i) => { certificate(i).runnerEnvironment = "self-hosted"; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["certificate run differs", (i) => { certificate(i).runInvocationURI = `${ciRunRef}9/attempts/1`; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["certificate attempt differs", (i) => { certificate(i).runInvocationURI = `${ciRunRef}/attempts/2`; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["unverified item shape", (i) => { i.verifiedProofAttestation = [{ verified: true }]; }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["multiple result items", (i) => { i.verifiedProofAttestation.push(structuredClone(i.verifiedProofAttestation[0])); }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["bundle payload differs", (i) => { i.verifiedProofAttestation[0].attestation.bundle.dsseEnvelope.payload = Buffer.from('{}').toString('base64'); }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["subject digest differs", (i) => { i.verifiedProofAttestation[0].verificationResult.statement.subject[0].digest.sha256 = "9".repeat(64); }, "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID"],
  ["proof raw is noncanonical", (i) => { i.proofBytes = Buffer.concat([i.proofBytes, Buffer.from('\n')]); }, "MANUAL_BUILD_CUSTODY_PROOF_RAW_INVALID"],
  ["material identity differs", (i) => { const m = JSON.parse(i.materialBytes); m.checkoutRef = "9".repeat(40); i.materialBytes = Buffer.from(canonicalJson(m)); }, "BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH"],
  ["writer reused as reader", (i) => { i.storage.writerIdentity = "audit-reader"; }, "MANUAL_BUILD_CUSTODY_STORAGE_INVALID"],
  ["missing Head", (i) => { delete i.storage.readMetadata; }, "EVIDENCE_CUSTODY_INPUT_INVALID"],
  ["proof Get differs", (i) => { i.storage.read = () => Buffer.from('wrong'); }, "EVIDENCE_READBACK_DIGEST_MISMATCH"],
  ["material Get differs", (i) => { const read = i.storage.read; i.storage.read = (args) => args.key === materialKey(i) ? Buffer.from('wrong') : read(args); }, "MANUAL_BUILD_CUSTODY_MATERIAL_READBACK_INVALID"],
  ["short service retention", (i) => { const create = i.storage.createOnly; i.storage.createOnly = (args) => { const result = create(args); result.retainUntil = "2026-12-01T16:01:59.000Z"; i.objects.get(args.key).metadata.retainUntil = result.retainUntil; return result; }; }, "EVIDENCE_STORAGE_RECEIPT_INVALID"],
  ["receipt expires before proof", (i) => { const create = i.storage.createOnly; i.storage.createOnly = (args) => { const result = create(args); if (args.key.startsWith('receipts/')) { result.retainUntil = "2026-12-01T16:02:00.000Z"; i.objects.get(args.key).metadata.retainUntil = result.retainUntil; } return result; }; }, "EVIDENCE_STORAGE_RECEIPT_INVALID"],
  ["material expires before proof", (i) => { const create = i.storage.createOnly; i.storage.createOnly = (args) => { const result = create(args); if (args.key === materialKey(i)) { result.retainUntil = "2026-12-01T16:02:00.000Z"; i.objects.get(args.key).metadata.retainUntil = result.retainUntil; } return result; }; }, "MANUAL_BUILD_CUSTODY_MATERIAL_METADATA_INVALID"],
  ["material Head differs", (i) => { const head = i.storage.readMetadata; i.storage.readMetadata = (args) => args.key === materialKey(i) ? { ...head(args), storedAt: "2026-09-02T16:01:00.000Z" } : head(args); }, "MANUAL_BUILD_CUSTODY_MATERIAL_METADATA_INVALID"],
  ["material Head adds authority field", (i) => { const head = i.storage.readMetadata; i.storage.readMetadata = (args) => args.key === materialKey(i) ? { ...head(args), requestedAt: storedAt } : head(args); }, "MANUAL_BUILD_CUSTODY_MATERIAL_METADATA_INVALID"],
  ["material creation collision", (i) => { i.objects.set(materialKey(i), { bytes: Buffer.from('existing'), metadata: {} }); }, "EVIDENCE_OVERWRITE_REFUSED"]
];

for (const [name, mutate, code] of failures) {
  test(`refuses success when ${name}`, async () => {
    const input = fixture();
    mutate(input);
    await assert.rejects(produceManualBuildCustody(input), { code });
    if (name.startsWith("material ")) {
      // Later material failure preserves prior objects; no rollback or ID retry.
      assert.equal(input.objects.has(`receipts/${receiptId}.json`), name !== "material identity differs");
    }
  });
}

async function sameJobFixture(t, fault) {
  const expected = await expectedFixture(t, fault), base = fixture();
  const input = { ...base, ...expected.input, now: () => new Date(), objects: new Map() };
  const statement = input.verifiedProofAttestation[0].verificationResult.statement;
  statement.subject[0].digest.sha256 = sha256Bytes(input.proofBytes).slice(7);
  input.verifiedProofAttestation[0].attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(statement)).toString("base64");
  input.verifiedProofAttestationBytes = Buffer.from(`${JSON.stringify(input.verifiedProofAttestation)}\n`);
  const writes = [], evidenceReads = [];
  input.storage = {
    trustPolicy: "immutable-content-addressed/v1", writerIdentity: "memory-writer", auditReaderIdentity: "audit-reader",
    createOnly(args) {
      writes.push(args.key);
      if (input.objects.has(args.key)) return { created: false };
      const metadata = { storeRef: `memory://private/${args.key}`, contentSizeBytes: args.bytes.length,
        storedAt: args.requestedAt, retainUntil: new Date(Date.parse(args.requestedAt) + 210 * 86400000).toISOString() };
      input.objects.set(args.key, { bytes: Buffer.from(args.bytes), metadata });
      return { created: true, ...metadata };
    },
    readMetadata({ key, identity }) { assert.equal(identity, "audit-reader"); return { ...input.objects.get(key).metadata }; },
    read({ key, identity }) { assert.equal(identity, "audit-reader"); return Buffer.from(input.objects.get(key).bytes); },
    readWithEvidence({ key, identity }) {
      assert.equal(identity, "audit-reader"); evidenceReads.push(key);
      const object = input.objects.get(key), raws = new Map();
      const record = (operation) => { const raw = Buffer.from(canonicalJson({ operation, key, requestId: `${operation}-${evidenceReads.length}` })); raws.set(sha256Bytes(raw), raw); return raw; };
      const getEvidenceBytes = record("GetObject"), headEvidenceBytes = record("HeadObject"), aclEvidenceBytes = record("GetObjectAcl");
      const body = Buffer.from("native collector body"); raws.set(sha256Bytes(body), body);
      return { metadata: { ...object.metadata }, readbackAt: new Date().toISOString(), bytes: Buffer.from(object.bytes),
        getEvidenceBytes, headEvidenceBytes, aclEvidenceBytes, rawBlobs: raws };
    }
  };
  return { input, runProcess: expected.runProcess, writes, evidenceReads, calls: expected.calls };
}

test("same-job composition creates proof once and retains exact real two-reference subject closure", async (t) => {
  assert.equal(typeof custodyProducer.produceManualTrustedBuildInputs, "function");
  const f = await sameJobFixture(t);
  const output = await custodyProducer.produceManualTrustedBuildInputs(f.input, { runProcess: f.runProcess });
  const provenance = JSON.parse(output.expected.producerRecordBytes);
  assert.equal(provenance.references.length, 2);
  assert.notEqual(provenance.references[0].referenceRunId, provenance.references[1].referenceRunId);
  const subjects = new Map(output.expected.rawBlobs); subjects.set(sha256Bytes(output.expected.producerRecordBytes), output.expected.producerRecordBytes);
  assert.deepEqual(output.objects.map((o) => o.subject.digest), [...subjects.keys()].sort());
  assert.equal(f.writes.filter((k) => k === `evidence/${sha256Bytes(f.input.proofBytes).slice(7)}.json`).length, 1);
  assert.equal(f.evidenceReads.length, subjects.size);
  assert.equal(new Set(f.writes).size, f.writes.length);
  for (const o of output.objects) {
    assert.deepEqual(output.rawBlobs.get(o.subject.digest), subjects.get(o.subject.digest));
    for (const field of ["getEvidence", "headEvidence", "aclEvidence"]) {
      const raw = output.rawBlobs.get(o[field].digest); assert.equal(sha256Bytes(raw), o[field].digest); assert.equal(raw.length, o[field].bytes);
    }
    assert.equal(o.writerIdentity, "memory-writer"); assert.equal(o.auditReaderIdentity, "audit-reader");
  }
  assert.equal(output.receipt.schemaVersion, "custody-receipt.retention90.v1");
  const pending = JSON.parse(output.pendingBytes);
  assert.ok(pending.proofVerification, "actual proof verification raw must be retained");
  assert.deepEqual(output.rawBlobs.get(pending.proofVerification.digest), f.input.verifiedProofAttestationBytes);
  assert.equal("ownerId" in output, false);
});

for (const failure of ["collision", "uncertain", "audit-bytes", "audit-metadata", "reference-failure"]) {
  test(`same-job composition stops on ${failure} without publishing a root or recovering existence`, async (t) => {
    assert.equal(typeof custodyProducer.produceManualTrustedBuildInputs, "function");
    const f = await sameJobFixture(t, failure === "reference-failure" ? "reproduction" : undefined);
    const create = f.input.storage.createOnly, read = f.input.storage.readWithEvidence;
    f.input.storage.createOnly = (args) => {
      if (f.writes.length >= 3 && failure === "collision") { f.writes.push(args.key); return { created: false }; }
      if (f.writes.length >= 3 && failure === "uncertain") { create(args); throw Object.assign(new Error("uncertain"), { code: "MANUAL_BUILD_STORAGE_WRITE_FAILED" }); }
      return create(args);
    };
    f.input.storage.readWithEvidence = (args) => {
      const output = read(args);
      if (failure === "audit-bytes") output.bytes = Buffer.from("altered");
      if (failure === "audit-metadata") output.metadata.storedAt = generatedAt;
      return output;
    };
    const code = { collision: "EVIDENCE_OVERWRITE_REFUSED", uncertain: "MANUAL_BUILD_STORAGE_WRITE_FAILED",
      "audit-bytes": "MANUAL_TRUSTED_INPUT_READBACK_INVALID", "audit-metadata": "MANUAL_TRUSTED_INPUT_METADATA_INVALID",
      "reference-failure": "MANUAL_EXPECTED_SCHEMA_REPRODUCTION_FAILED" }[failure];
    await assert.rejects(custodyProducer.produceManualTrustedBuildInputs(f.input, { runProcess: f.runProcess }), { code });
    assert.equal(new Set(f.writes).size, f.writes.length);
    assert.ok(![...f.input.objects.values()].some((o) => o.bytes.includes(Buffer.from('"recordVersion":"manual-trusted-build-custody-root.v1"'))));
  });
}

async function finalizerFixture(t) {
  const f = await sameJobFixture(t), output = await custodyProducer.produceManualTrustedBuildInputs(f.input, { runProcess: f.runProcess });
  const verification = (raw) => {
    const attestation = structuredClone(f.input.verifiedProofAttestation), statement = attestation[0].verificationResult.statement;
    statement.subject[0].digest.sha256 = sha256Bytes(raw).slice(7);
    attestation[0].verificationResult.verifiedTimestamps[0].timestamp = new Date().toISOString();
    attestation[0].attestation.bundle.dsseEnvelope.payload = Buffer.from(canonicalJson(statement)).toString("base64");
    return Buffer.from(`${JSON.stringify(attestation)}\n`);
  };
  return { ...f, output, final: { pendingBytes: output.pendingBytes, pendingDigest: output.pendingDigest,
    rawBlobs: output.rawBlobs, verifiedAttestations: { receipt: verification(Buffer.from(canonicalJson(output.receipt))),
      producer: verification(output.expected.producerRecordBytes), script: verification(output.expected.scriptBytes) },
    buildIdentity: f.input.buildIdentity, storage: f.input.storage } };
}

test("same-job finalizer retains finite native and attestation raws once and creates root last", async (t) => {
  assert.equal(typeof custodyProducer.finalizeManualTrustedBuildInputs, "function");
  const f = await finalizerFixture(t), evidenceReads = f.evidenceReads.length, initialWrites = f.writes.length;
  const result = await custodyProducer.finalizeManualTrustedBuildInputs(f.final), root = JSON.parse(result.rootBytes);
  assert.equal(sha256Bytes(result.rootBytes), result.rootDigest);
  assert.equal(result.rootKey, f.writes.at(-1));
  assert.equal(new Set(f.writes).size, f.writes.length);
  assert.equal(f.evidenceReads.length, evidenceReads); // Ordinary Get/Head terminates custody closure.
  assert.ok(f.writes.length > initialWrites);
  assert.deepEqual(root.objects, f.output.objects);
  assert.equal(root.attestations.length, 3);
  assert.equal(root.support.some((o) => o.subject.digest === result.rootDigest), false);
  assert.equal(root.support.some((o) => root.objects.some((s) => s.subject.digest === o.subject.digest)), false);
  const retained = new Map([...root.created, ...root.support].map((o) => [o.subject.digest, o]));
  for (const subject of JSON.parse(f.output.pendingBytes).raws) {
    const facts = retained.get(subject.digest); assert.ok(facts);
    assert.deepEqual(f.input.objects.get(facts.key).bytes, f.output.rawBlobs.get(subject.digest));
  }
  for (const attestation of root.attestations) for (const field of ["verification", "bundle"]) {
    const facts = retained.get(attestation[field].digest); assert.ok(facts);
    assert.equal(sha256Bytes(f.input.objects.get(facts.key).bytes), attestation[field].digest);
  }
  assert.equal("ownerId" in root, false); assert.equal("profileDigest" in root, false); assert.equal(root.promotionEligible, false);
});

for (const failure of ["pending-switch", "missing-raw", "attestation-run", "reused-bytes", "reused-metadata", "support-collision", "support-uncertain"]) {
  test(`same-job finalizer rejects ${failure} and publishes no root`, async (t) => {
    assert.equal(typeof custodyProducer.finalizeManualTrustedBuildInputs, "function");
    const f = await finalizerFixture(t), initialWrites = f.writes.length, read = f.final.storage.read, head = f.final.storage.readMetadata, create = f.final.storage.createOnly;
    if (failure === "pending-switch") f.final.pendingDigest = digest("9");
    if (failure === "missing-raw") f.final.rawBlobs = new Map([...f.final.rawBlobs].slice(1));
    if (failure === "attestation-run") {
      const attestation = JSON.parse(f.final.verifiedAttestations.script);
      attestation[0].verificationResult.signature.certificate.runInvocationURI += "9";
      f.final.verifiedAttestations.script = Buffer.from(JSON.stringify(attestation));
    }
    f.final.storage.read = (args) => failure === "reused-bytes" ? Buffer.from("changed") : read(args);
    f.final.storage.readMetadata = (args) => failure === "reused-metadata" ? { ...head(args), storedAt: generatedAt } : head(args);
    f.final.storage.createOnly = (args) => {
      if (failure === "support-collision") { f.writes.push(args.key); return { created: false }; }
      if (failure === "support-uncertain") { create(args); throw Object.assign(new Error("uncertain"), { code: "MANUAL_BUILD_STORAGE_WRITE_FAILED" }); }
      return create(args);
    };
    const code = { "pending-switch": "MANUAL_TRUSTED_INPUT_PENDING_INVALID", "missing-raw": "MANUAL_TRUSTED_INPUT_PENDING_INVALID",
      "attestation-run": "MANUAL_BUILD_CUSTODY_ATTESTATION_INVALID", "reused-bytes": "MANUAL_TRUSTED_INPUT_READBACK_INVALID",
      "reused-metadata": "MANUAL_TRUSTED_INPUT_METADATA_INVALID", "support-collision": "EVIDENCE_OVERWRITE_REFUSED",
      "support-uncertain": "MANUAL_BUILD_STORAGE_WRITE_FAILED" }[failure];
    await assert.rejects(custodyProducer.finalizeManualTrustedBuildInputs(f.final), { code });
    assert.equal(new Set(f.writes).size, f.writes.length);
    assert.ok(![...f.input.objects.values()].some((o) => o.bytes.includes(Buffer.from('"recordVersion":"manual-trusted-build-custody-root.v1"'))));
    if (!failure.startsWith("support")) assert.equal(f.writes.length, initialWrites);
  });
}
