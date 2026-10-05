// Public verification of the fixed H1 result. No signing or cloud credentials.
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { buildH1CryptoUseProof } from "./snapshot-h1-data-proof.mjs";

const CODE = "H1_SNAPSHOT_PUBLICATION_REJECTED";
const NAMES = [
  "snapshot.enc",
  "encryption-envelope.json",
  "snapshot-proof.json",
  "data-result.json"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const requireThat = (value) => {
  if (!value) fail();
};
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

export function readPublicSnapshotJson(bytes) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1048576);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requireThat(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Buffer.from(canonicalJson(value)).equals(bytes)
    );
    return value;
  } catch {
    fail();
  }
}

function signature(domain, subject, value, signer) {
  assertKernelFrame(signer, ["issuer", "keyId", "publicKey"], CODE);
  assertKernelFrame(value, ["algorithm", "issuer", "keyId", "subjectDigest", "signature"], CODE);
  const key = createPublicKey(signer.publicKey);
  requireThat(
    key.asymmetricKeyType === "ed25519" &&
      sha256Bytes(key.export({ type: "spki", format: "der" })) === signer.keyId &&
      value.algorithm === "Ed25519" &&
      value.issuer === signer.issuer &&
      value.keyId === signer.keyId &&
      value.subjectDigest === sha256Canonical(subject) &&
      typeof value.signature === "string" &&
      /^[A-Za-z0-9+/]{86}==$/.test(value.signature) &&
      verify(
        null,
        Buffer.from(canonicalJson({ domain, subject })),
        key,
        Buffer.from(value.signature, "base64")
      )
  );
}

function expectedIdentity(value) {
  assertKernelFrame(
    value,
    ["releaseAttemptId", "snapshotRunId", "sourceSha", "dispatchAuthorizationDigest"],
    CODE
  );
  requireThat(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.releaseAttemptId
    ) &&
      /^[1-9][0-9]*$/.test(value.snapshotRunId) &&
      /^[0-9a-f]{40}$/.test(value.sourceSha) &&
      /^sha256:[0-9a-f]{64}$/.test(value.dispatchAuthorizationDigest)
  );
  return value;
}

export function verifyH1SnapshotData({ dataResultBytes, proofBytes, expected, signer }) {
  try {
    expectedIdentity(expected);
    const result = readPublicSnapshotJson(dataResultBytes),
      sealed = readPublicSnapshotJson(proofBytes);
    assertKernelFrame(sealed, ["proof", "dataResultDigest", "signature"], CODE);
    const subject = { proof: sealed.proof, dataResultDigest: sealed.dataResultDigest };
    signature("h1-snapshot-data-proof.v1", subject, sealed.signature, signer);
    requireThat(
      result.status === "DATA_PREPARED" && sealed.dataResultDigest === sha256Bytes(dataResultBytes)
    );
    const auth = result.cryptoAuthorization;
    requireThat(
      auth &&
        auth.issuer.issuerId === signer.issuer &&
        auth.releaseAttemptId === expected.releaseAttemptId &&
        auth.snapshotRunId === expected.snapshotRunId &&
        auth.sourceSha === expected.sourceSha &&
        auth.bindings.dispatchAuthorizationDigest === expected.dispatchAuthorizationDigest &&
        result.admission.releaseAttemptId === auth.releaseAttemptId &&
        result.admission.producerRun.runId === auth.snapshotRunId &&
        result.admission.producerRun.sourceSha === auth.sourceSha &&
        result.admission.dispatchAuthorizationDigest ===
          auth.bindings.dispatchAuthorizationDigest &&
        result.admission.adapterDigest === auth.bindings.adapterExecutableDigest &&
        result.terminalObservation.runningJobObservationDigest ===
          sha256Canonical(result.runningJobObservation)
    );
    const rebuilt = buildH1CryptoUseProof({
      authorization: auth,
      data: result.data,
      observation: result.executionObservation,
      terminal: result.terminalObservation,
      cleanup: result.cleanup,
      volume: result.volumeObservation
    });
    requireThat(same(rebuilt, sealed.proof));
    return snapshotKernelData({ result, sealed }, CODE);
  } catch {
    fail();
  }
}

export function prepareH1SnapshotObjects({
  dataResultBytes,
  proofBytes,
  ciphertext,
  expected,
  signer
}) {
  const verified = verifyH1SnapshotData({ dataResultBytes, proofBytes, expected, signer });
  const envelope = verified.result.data.envelope;
  requireThat(
    Buffer.isBuffer(ciphertext) &&
      ciphertext.length === envelope.ciphertextSizeBytes &&
      sha256Bytes(ciphertext) === envelope.ciphertextDigest
  );
  const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
  const bytes = [ciphertext, Buffer.from(canonicalJson(envelope)), proofBytes, dataResultBytes];
  return {
    ...verified,
    objects: NAMES.map((name, index) => ({
      key: prefix + name,
      bytes: Buffer.from(bytes[index]),
      contentDigest: sha256Bytes(bytes[index])
    }))
  };
}

export function verifyH1SnapshotPublication({ bytes, expected, signer }) {
  try {
    expectedIdentity(expected);
    const sealed = readPublicSnapshotJson(bytes);
    assertKernelFrame(sealed, ["publication", "signature"], CODE);
    const value = sealed.publication;
    assertKernelFrame(
      value,
      [
        "releaseAttemptId",
        "snapshotRunId",
        "sourceSha",
        "dispatchAuthorizationDigest",
        "writerArn",
        "writerIssuedAt",
        "writerExpiresAt",
        "cryptoExitedAt",
        "publishedAt",
        "objects"
      ],
      CODE
    );
    signature("h1-snapshot-publication.v1", value, sealed.signature, signer);
    requireThat(
      Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue) &&
        /^acs:ram::1457643390906675:(?:assumed-role|role)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
          value.writerArn
        ) &&
        Array.isArray(value.objects) &&
        value.objects.length === NAMES.length
    );
    const times = [
      value.cryptoExitedAt,
      value.writerIssuedAt,
      value.publishedAt,
      value.writerExpiresAt
    ].map((time) => {
      const n = Date.parse(time);
      requireThat(Number.isFinite(n) && new Date(n).toISOString() === time);
      return n;
    });
    requireThat(
      times[0] <= times[1] &&
        times[1] <= times[2] &&
        times[2] < times[3] &&
        times[3] - times[1] <= 900000
    );
    const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
    for (const [index, item] of value.objects.entries()) {
      assertKernelFrame(item, ["key", "digest", "sizeBytes", "requestId", "etag"], CODE);
      requireThat(
        item.key === prefix + NAMES[index] &&
          /^sha256:[a-f0-9]{64}$/.test(item.digest) &&
          Number.isSafeInteger(item.sizeBytes) &&
          item.sizeBytes > 0 &&
          item.sizeBytes <= (index === 0 ? 134217728 : 1048576) &&
          typeof item.requestId === "string" &&
          item.requestId.length > 0 &&
          (item.etag === null || (typeof item.etag === "string" && item.etag.length > 0))
      );
    }
    return snapshotKernelData(value, CODE);
  } catch {
    fail();
  }
}

// The last, signed diagnostics object is the publication marker. The reader
// must independently retrieve all objects; publisher PUT responses alone do
// not establish custody or completion of the GitHub producer run.
export async function readH1SnapshotPublication({ reader, expected, signer }) {
  expectedIdentity(expected);
  const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
  const marker = await reader.readPublicJson({ key: prefix + "diagnostics.redacted.json" });
  const publication = verifyH1SnapshotPublication({ bytes: marker.bytes, expected, signer });
  requireThat(
    publication.writerArn.replace(":role/", ":assumed-role/") ===
      marker.observation.expectedWriterArn
  );
  const observations = [marker.observation],
    documents = new Map();
  for (const object of publication.objects) {
    const request = { key: object.key, contentDigest: object.digest, sizeBytes: object.sizeBytes };
    if (object.key.endsWith("/snapshot.enc")) {
      observations.push(await reader.readback(request));
    } else {
      const value = await reader.readPublicJson({ key: object.key });
      requireThat(
        value.observation.get.digest === object.digest &&
          value.observation.get.sizeBytes === object.sizeBytes
      );
      documents.set(object.key.slice(prefix.length), value.bytes);
      observations.push(value.observation);
    }
  }
  const verified = verifyH1SnapshotData({
    dataResultBytes: documents.get("data-result.json"),
    proofBytes: documents.get("snapshot-proof.json"),
    expected,
    signer
  });
  const envelope = readPublicSnapshotJson(documents.get("encryption-envelope.json"));
  requireThat(
    same(envelope, verified.result.data.envelope) &&
      publication.cryptoExitedAt === verified.sealed.proof.cleanup.processExitedAt &&
      publication.objects[0].digest === envelope.ciphertextDigest &&
      publication.objects[0].sizeBytes === envelope.ciphertextSizeBytes &&
      observations.every(
        (x) =>
          same(x.bucket, marker.observation.bucket) && x.readerArn === marker.observation.readerArn
      )
  );
  return snapshotKernelData(
    {
      status: "READBACK_VERIFIED",
      publication,
      data: verified.result,
      proof: verified.sealed,
      observations,
      observedAt: new Date().toISOString()
    },
    CODE
  );
}
