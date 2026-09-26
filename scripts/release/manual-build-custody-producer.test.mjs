import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { produceManualBuildCustody } from "./manual-build-custody-producer.mjs";

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
const materialKey = (input) => `evidence/${sha256Bytes(input.materialBytes).slice(7)}.json`;
const failures = [
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
